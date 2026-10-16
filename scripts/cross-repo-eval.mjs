#!/usr/bin/env node
// CLA-289 cross-repo evaluation: one command that fetches, scans, enriches (within a budget), checks
// claims, asks and captures Overview blocks for the pinned corpus in fixtures/cross-repo-eval/manifest.json,
// recording compact results in fixtures/cross-repo-eval/runs/<slug>.json for offline replay.
//
//   node scripts/cross-repo-eval.mjs <fetch|scan|enrich|claims|ask|blocks|report|all> [options]
//
//   --repos a,b             manifest slugs (default: every repo)
//   --work <dir>            scratch dir OUTSIDE the repo (default: $TMPDIR/okie-cross-repo-eval)
//   --mirror <dir>          fetch from <dir>/<owner>_<repo> instead of GitHub (SHA still verified)
//   --live                  allow paid calls (gateway for enrich/ask, Jev for claims/blocks). Never in CI.
//                           The gateway also needs --llm-provider <name> (or OKIE_LLM_PROVIDER) and OKIE_LLM_API_KEY;
//                           --dotenv (or OKIE_DOTENV=1) loads the repo-root .env (CLA-606).
//   --fake                  enrich/claims with a deterministic fake gateway/Jev (free; results stay in --work)
//   --max-dollars 3         ticket cap for this invocation (default 3, never above 3; spend.json is shared)
//   --per-repo-dollars 0.15 enrichment dollar cap per repo (OKIE_LLM_OPERATOR_MAX_DOLLARS)
//   --per-repo-requests 64  enrichment request cap per repo (OKIE_LLM_OPERATOR_MAX_REQUESTS)
//   --repo-concurrency 4    repos processed at once in this process (git/scan steps still run one at a time)
//   --max-concurrent 32     in-flight enrichment requests per repo (own rate limiter per repo: 429s back off + retry)
//   --ask-concurrent 16     in-flight Ask requests per repo (claim checks stay sequential: the product runs one batch at a time)
//   --jev-dollars 0.05      claim-check dollar cap per repo (OKIE_JEV_MAX_DOLLARS; each request reserves $0.003)
//   --jev-requests 32       claim-check request cap per repo (OKIE_JEV_MAX_REQUESTS; ~1 request per explained scope)
//   --sample K              enrich a sampled subtree: top-K components per container (by relation degree, ties by
//                           id) in a local sampled commit, so containers + system still reduce; explanations are
//                           overlaid onto the full-scan snapshot for Ask/blocks. Default: the whole scan.
//   --sample-single N       K for atlases with a single container (default: K)
//   --skip-enrich a,b       record "skipped: scanner-blind" instead of enriching these repos
//   --price-per-mtok in/out gateway USD per 1M input/output tokens; required with --live when the configured
//                           model is not in the known pricing table (the worst-case constants were fitted to one model)
//   --force                 let ask/blocks replace recorded paid answers / Jev orders made over a different corpus
//   --replay                ask/blocks/claims make no calls and write nothing; `report` recomputes metrics
//
// Live spend: one live process at a time (O_EXCL lock next to spend.json, ledger re-read under it). Each paid
// request reserves its worst case in-process before it is sent and settles to the actual cost afterwards, so
// parallel repos can never overshoot --max-dollars together (a reservation waits while others hold the budget,
// and is refused only when it could not fit even with nothing else in flight).
//
// Two phases: every synchronous step (git fetch/prepare, scans, the sampled commit + its scan) runs for all
// repos BEFORE any paid stage starts, so a long scan never blocks the event loop while another repo has
// paid requests in flight (they could time out with their spend unsettled). Paid stages never scan or run git.
//
// Requires a built server + scan package (`pnpm --filter @okie/server build`). Secrets come from `.env`
// (loaded only with --live) and are never printed. CI replays: apps/server/src/crossRepoEval.test.ts.
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const evalDir = join(repoRoot, 'fixtures/cross-repo-eval');
const server = rel => import(pathToFileURL(join(repoRoot, 'apps/server/dist', rel)).href);
const core = await server('crossRepoEval.js');
const { askRequestSha256 } = await server('askEval.js');
const { scanRepository, stableJson } = await import(pathToFileURL(join(repoRoot, 'packages/scan/dist/index.js')).href);

// ---------------------------------------------------------------------------
// Arguments

const argv = process.argv.slice(2);
const stage = argv[0];
const STAGES = ['fetch', 'scan', 'enrich', 'claims', 'ask', 'blocks', 'report', 'all'];
if (!STAGES.includes(stage)) { console.error(`usage: node scripts/cross-repo-eval.mjs <${STAGES.join('|')}> [--repos a,b] [--work dir] [--live|--fake] [--max-dollars 3] [--replay]`); process.exit(2); }
const option = name => { const at = argv.indexOf(`--${name}`); if (at < 0) return undefined; const value = argv[at + 1]; if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`); return value; };
const flag = name => argv.includes(`--${name}`);
const number = (name, fallback) => { const raw = option(name); if (raw === undefined) return fallback; const value = Number(raw); if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number`); return value; };
const live = flag('live');
const fake = flag('fake');
const replay = flag('replay');
if (live && fake) throw new Error('pass at most one of --live and --fake');
if (replay && (live || fake)) throw new Error('--replay makes no calls; drop --live/--fake');
const maxDollars = core.effectiveCapUsd(option('max-dollars') === undefined ? undefined : Number(option('max-dollars')));
const perRepoDollars = number('per-repo-dollars', 0.15);
const perRepoRequests = Math.floor(number('per-repo-requests', 64));
const maxConcurrent = Math.floor(number('max-concurrent', 32));
const askConcurrent = Math.floor(number('ask-concurrent', 16));
const repoConcurrency = Math.floor(number('repo-concurrency', 4));
const force = flag('force');
const priceOverride = option('price-per-mtok') === undefined ? undefined : (() => { const [input, output] = option('price-per-mtok').split('/').map(Number); return { input, output }; })();
const jevDollars = number('jev-dollars', 0.05);
const jevRequests = Math.floor(number('jev-requests', 32));
const sampleK = option('sample') === undefined ? undefined : Math.floor(number('sample', 5));
const sampleSingle = option('sample-single') === undefined ? sampleK : Math.floor(number('sample-single', 30));
const skipEnrich = new Set((option('skip-enrich') ?? '').split(',').filter(Boolean));
const work = resolve(option('work') ?? join(tmpdir(), 'okie-cross-repo-eval'));
if (work === resolve(repoRoot) || work.startsWith(resolve(repoRoot) + sep)) throw new Error('--work must be outside the repository (sources are never fetched into it)');
const mirror = option('mirror') ? resolve(option('mirror')) : undefined;

const manifest = core.loadManifest(evalDir);
const wanted = option('repos')?.split(',').filter(Boolean);
if (wanted?.some(slug => !manifest.repos.some(repo => repo.slug === slug))) throw new Error(`--repos names an unknown slug (known: ${manifest.repos.map(repo => repo.slug).join(', ')})`);
const repos = manifest.repos.filter(repo => !wanted || wanted.includes(repo.slug));

// ---------------------------------------------------------------------------
// Files

/**
 * 2-space JSON, but arrays of primitives and flat objects (every value a primitive or an array of primitives:
 * claim rows, block candidates, sections without symbols) stay on one line, so run files stay small and
 * diffable. Same value semantics as JSON.stringify (undefined object members dropped, undefined in arrays -> null).
 */
function compactJson(value) {
  const isPrimitive = item => item === null || typeof item !== 'object';
  const flat = item => isPrimitive(item) || (Array.isArray(item) && item.every(isPrimitive));
  const one = item => item === undefined || typeof item === 'function' ? 'null' : JSON.stringify(item);
  const format = (item, indent) => {
    if (item && typeof item.toJSON === 'function') item = item.toJSON();
    if (isPrimitive(item)) return one(item);
    const inner = `${indent}  `;
    if (Array.isArray(item)) {
      if (!item.length) return '[]';
      if (item.every(isPrimitive)) return `[${item.map(one).join(', ')}]`;
      return `[\n${item.map(entry => inner + format(entry, inner)).join(',\n')}\n${indent}]`;
    }
    const entries = Object.entries(item).filter(([, entry]) => entry !== undefined && typeof entry !== 'function');
    if (!entries.length) return '{}';
    if (entries.every(([, entry]) => flat(entry))) return `{ ${entries.map(([key, entry]) => `${JSON.stringify(key)}: ${format(entry, inner)}`).join(', ')} }`;
    return `{\n${entries.map(([key, entry]) => `${inner}${JSON.stringify(key)}: ${format(entry, inner)}`).join(',\n')}\n${indent}}`;
  };
  return `${format(value, '')}\n`;
}
const readJson = (path, fallback) => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
const runPath = slug => join(evalDir, 'runs', `${slug}.json`);
const loadRun = repo => { const run = readJson(runPath(repo.slug), core.emptyRun(repo)); return run.commitSha === repo.commitSha ? run : core.emptyRun(repo); };
const saveRun = run => { if (replay) return; mkdirSync(join(evalDir, 'runs'), { recursive: true }); writeFileSync(runPath(run.slug), compactJson(run)); };
const labelsFor = slug => readJson(join(evalDir, 'labels', `${slug}.json`), undefined);
const repoDir = repo => join(work, 'repos', core.checkoutName(repo));
const artifactDir = (repo, kind) => join(work, 'artifacts', repo.slug, kind);
const scrubPaths = text => String(text).split(work).join('<work>').split(repoRoot).join('<repo>/');

/**
 * spend.json: every live stage appends actual $ as it goes, so an interrupted run still records what it spent.
 * Live processes hold an O_EXCL lock for their lifetime and re-read the ledger under it (`lockSpend`).
 */
const spendPath = join(evalDir, 'spend.json');
const lockPath = `${spendPath}.lock`;
const spend = {
  ledger: readJson(spendPath, core.emptySpendLedger()),
  /** In-process worst-case reservations of requests/stages in flight. */
  reserved: 0,
  waiters: [],
  /**
   * Reserves `usd` before a paid request/stage: waits while other in-flight reservations hold the budget,
   * refuses when it could not fit even with nothing else reserved. Returns a handle that settles actual
   * spend against the reservation and releases the rest.
   */
  async reserve(usd, what) {
    for (;;) {
      const verdict = core.admitSpend(this.ledger, this.reserved + usd, maxDollars);
      if (verdict.ok) break;
      if (this.reserved <= 1e-12) throw new Error(`refusing ${what}: ${verdict.reason}`);
      await new Promise(resolveWait => this.waiters.push(resolveWait));
    }
    this.reserved += usd;
    const book = this;
    return {
      held: usd,
      settle(stageName, slug, actualUsd, estimated) {
        book.add(stageName, slug, actualUsd, estimated);
        const drop = Math.min(this.held, actualUsd); this.held -= drop; book.release(drop);
      },
      release() { book.release(this.held); this.held = 0; },
    };
  },
  release(usd) { this.reserved = Math.max(0, this.reserved - usd); for (const wake of this.waiters.splice(0)) wake(); },
  /** Adds to this session's entry for (stage, slug). */
  add(stageName, slug, usd, estimated, requests = 1, note) {
    const at = new Date().toISOString();
    const entries = [...this.ledger.entries];
    const index = entries.findIndex(entry => entry.session === SESSION && entry.stage === stageName && entry.slug === slug);
    const prior = index >= 0 ? entries[index] : { at, session: SESSION, stage: stageName, slug, usd: 0, estimated: false, requests: 0 };
    const next = { ...prior, at, usd: Math.round((prior.usd + usd) * 1e7) / 1e7, estimated: prior.estimated || estimated, requests: prior.requests + requests, ...(note ? { note } : {}) };
    if (index >= 0) entries[index] = next; else entries.push(next);
    this.ledger = { ...this.ledger, entries };
    writeFileSync(spendPath, compactJson(this.ledger));
  },
};
const SESSION = new Date().toISOString();

function lockSpend() {
  let fd;
  try { fd = openSync(lockPath, 'wx'); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const holder = readFileSync(lockPath, 'utf8').trim();
    throw new Error(`spend ledger is locked by another live run (${relative(repoRoot, lockPath)}: ${holder || 'no pid'}); wait for it, or delete the lock if that process is gone`);
  }
  writeFileSync(fd, `pid ${process.pid} since ${SESSION}\n`); closeSync(fd);
  process.on('exit', () => rmSync(lockPath, { force: true }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
  spend.ledger = readJson(spendPath, core.emptySpendLedger());
}

let secrets = [];
function loadLive() {
  if (!live) return;
  const { loadOperatorDotenv } = llm;
  loadOperatorDotenv(repoRoot);
  secrets = [process.env.OKIE_LLM_API_KEY, process.env.OPENROUTER_API_KEY, process.env.OPENAI_API_KEY, process.env.JEV_API].filter(Boolean);
}
const redact = text => secrets.reduce((out, secret) => out.split(secret).join('[redacted]'), llm.redactGatewayErrorText(scrubPaths(text)));
const llm = await server('llmGateway.js');
const { LlmRateLimiter } = await server('llmRateLimiter.js');
const isRateLimit = error => llm.classifyLlmGatewayFailure(error) === 'rate_limit' || /\b429\b|rate.?limit/i.test(String(error?.message ?? error));
/** Per-repo limiter (the runner's default is one process-wide limiter per provider, which parallel repos would share). */
const repoLimiter = concurrency => new LlmRateLimiter({ ...llm.resolveLlmRateLimitConfig(), maxConcurrent: concurrency });

// ---------------------------------------------------------------------------
// Git: shallow fetch of the pinned SHA + one deterministic evalPrepare commit

const git = (dir, args, options = {}) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
/** Harness provenance, read once before anything is written: HEAD + whether tracked harness sources differ from it. */
const HARNESS = (() => {
  const harnessSha = git(repoRoot, ['rev-parse', 'HEAD']);
  const harnessDirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=no', '--', 'scripts', 'apps', 'packages', 'crates', 'package.json', 'pnpm-lock.yaml']) !== '';
  return { harnessSha, harnessDirty };
})();
const hasCommit = (dir, sha) => { try { return git(dir, ['cat-file', '-t', sha]) === 'commit'; } catch { return false; } };

function fetchRepo(repo) {
  const dir = repoDir(repo);
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, '.git'))) git(dir, ['init', '-q']);
  const started = performance.now();
  if (!hasCommit(dir, repo.commitSha)) {
    const source = mirror ? join(mirror, core.checkoutName(repo)) : repo.url;
    git(dir, ['fetch', '-q', '--depth', '1', '--no-tags', source, repo.commitSha]);
  }
  const resolved = git(dir, ['rev-parse', '--verify', `${repo.commitSha}^{commit}`]);
  if (resolved !== repo.commitSha) throw new Error(`${repo.slug}: fetched ${resolved}, pinned ${repo.commitSha}`);
  git(dir, ['update-ref', 'refs/eval/pinned', repo.commitSha]);
  const fetchMs = Math.round(performance.now() - started);
  let prepared;
  if (repo.evalPrepare) {
    // One local derivative commit with fixed identity + the pinned committer date: the prepared SHA is deterministic.
    const before = git(dir, ['ls-tree', '-r', '--full-tree', repo.commitSha]).split('\n').filter(Boolean);
    const drop = new Set();
    for (const line of before) {
      const file = line.slice(line.indexOf('\t') + 1);
      if (repo.evalPrepare.dropSymlinks && line.startsWith('120000 ')) drop.add(file);
      for (const path of repo.evalPrepare.dropPaths ?? []) if (file === path || file.startsWith(`${path}/`)) drop.add(file);
    }
    const message = `CLA-289 evalPrepare (eval-only): ${JSON.stringify({ dropSymlinks: repo.evalPrepare.dropSymlinks ?? false, dropPaths: repo.evalPrepare.dropPaths ?? [] })}`;
    prepared = derivativeCommit(repo, repo.commitSha, [...drop], 'refs/eval/prepared', message);
    console.log(`${repo.slug}: pinned ${repo.commitSha.slice(0, 12)} verified (${fetchMs} ms); evalPrepare dropped ${drop.size} path(s) -> ${prepared.slice(0, 12)}`);
    return { preparedCommitSha: prepared, droppedPaths: drop.size };
  }
  console.log(`${repo.slug}: pinned ${repo.commitSha.slice(0, 12)} verified (${fetchMs} ms)`);
  return { droppedPaths: 0 };
}

/** One local commit on top of `base` without `paths`, fixed identity + `base`'s committer date (deterministic SHA). */
function derivativeCommit(repo, base, paths, ref, message) {
  const dir = repoDir(repo);
  const index = join(dir, '.git', 'eval-derivative-index');
  rmSync(index, { force: true });
  const env = { ...process.env, GIT_INDEX_FILE: index };
  git(dir, ['read-tree', base], { env });
  if (paths.length) git(dir, ['--literal-pathspecs', 'rm', '--cached', '-q', '--ignore-unmatch', '--pathspec-from-file=-'], { env, input: paths.join('\n') });
  const tree = git(dir, ['write-tree'], { env });
  const date = git(dir, ['show', '-s', '--format=%cI', base]);
  const identity = { GIT_AUTHOR_NAME: 'okie-eval', GIT_AUTHOR_EMAIL: 'eval@okie.invalid', GIT_COMMITTER_NAME: 'okie-eval', GIT_COMMITTER_EMAIL: 'eval@okie.invalid', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const commit = git(dir, ['commit-tree', tree, '-p', base, '-m', message], { env: { ...process.env, ...identity } });
  git(dir, ['update-ref', ref, commit]);
  rmSync(index, { force: true });
  return commit;
}

// ---------------------------------------------------------------------------
// Scan: as-is outcome at the pin first, then the prepared commit

function scanAt(repo, revision) {
  const started = performance.now();
  try {
    const artifacts = scanRepository(repoDir(repo), { revision, analysisMode: 'full', codeSurface: 'all' });
    const outcome = core.scanOutcome(revision, Math.round(performance.now() - started), artifacts.snapshot, repo.language);
    // Acquisition/discovery limitations (skipped symlinks/submodules, testdata/ exclusion): CLA-299.
    if (artifacts.analysis?.limitations?.length) outcome.limitations = artifacts.analysis.limitations;
    return { artifacts, outcome };
  } catch (error) {
    const message = scrubPaths(error instanceof Error ? error.message : String(error)).split('\n').slice(0, 4).join('\n').slice(0, 600);
    return { outcome: { revision, ok: false, ms: Math.round(performance.now() - started), error: message } };
  }
}

function writeScanArtifacts(repo, artifacts) {
  const dir = artifactDir(repo, 'scan');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'snapshot.json'), stableJson(artifacts.snapshot));
}

const scanned = new Map();
function scanStage(repo, run) {
  if (!hasCommit(repoDir(repo), repo.commitSha)) throw new Error(`${repo.slug}: not fetched (run fetch first)`);
  const asIs = scanAt(repo, repo.commitSha);
  const preparedSha = repo.evalPrepare ? git(repoDir(repo), ['rev-parse', '--verify', 'refs/eval/prepared']) : undefined;
  const prepared = preparedSha ? scanAt(repo, preparedSha) : undefined;
  const usable = prepared ?? asIs;
  run.scan = { provenance: HARNESS, asIs: asIs.outcome, ...(prepared ? { prepared: prepared.outcome } : {}) };
  if (usable.artifacts) { writeScanArtifacts(repo, usable.artifacts); scanned.set(repo.slug, { artifacts: usable.artifacts, commitSha: preparedSha ?? repo.commitSha }); }
  const line = outcome => outcome.ok ? `ok ${outcome.entities} entities (${outcome.kinds.container ?? 0} containers, ${outcome.kinds.component ?? 0} components, ${outcome.kinds.code ?? 0} code) in ${outcome.ms} ms` : `FAILED in ${outcome.ms} ms: ${outcome.error.split('\n')[0]}`;
  console.log(`${repo.slug}: as-is ${line(asIs.outcome)}${prepared ? `; prepared ${line(prepared.outcome)}` : ''}`);
}

function scannedArtifacts(repo) {
  if (scanned.has(repo.slug)) return scanned.get(repo.slug);
  const preparedSha = repo.evalPrepare ? git(repoDir(repo), ['rev-parse', '--verify', 'refs/eval/prepared']) : undefined;
  const result = scanAt(repo, preparedSha ?? repo.commitSha);
  if (!result.artifacts) throw new Error(`${repo.slug}: scan failed: ${result.outcome.error}`);
  const value = { artifacts: result.artifacts, commitSha: preparedSha ?? repo.commitSha };
  scanned.set(repo.slug, value);
  return value;
}

/**
 * Ask/blocks corpus: the live-enriched export when present ("sampled-enriched" when a sampled pass was
 * overlaid onto the full scan), else the deterministic scan (fake enrichment never lands here).
 */
function corpus(repo) {
  for (const dir of [artifactDir(repo, 'enriched'), artifactDir(repo, 'scan')]) {
    if (!existsSync(join(dir, 'snapshot.json'))) continue;
    const snapshot = JSON.parse(readFileSync(join(dir, 'snapshot.json'), 'utf8'));
    const sidecarPath = join(dir, 'operator-explanations.json');
    const sidecar = existsSync(sidecarPath) ? JSON.parse(readFileSync(sidecarPath, 'utf8')) : undefined;
    const kind = dir.endsWith('scan') ? 'scan' : sidecar?.sample ? 'sampled-enriched' : 'enriched';
    return { kind, snapshot, sidecar };
  }
  throw new Error(`${repo.slug}: no scan in ${work} (run scan first)`);
}

/** Paid work recorded over another corpus (e.g. the enriched export went missing from --work) is never dropped silently. */
function guardCorpusChange(repo, what, priorCorpus, paid, kind) {
  if (!paid || priorCorpus === undefined || priorCorpus === kind || force) return;
  throw new Error(`${repo.slug}: would drop ${paid} recorded paid ${what} made over the ${priorCorpus} corpus, because this pass sees the ${kind} corpus (is the enriched export missing from ${relative(repoRoot, work) || work}?); pass --force to replace them`);
}

// ---------------------------------------------------------------------------
// Enrichment through the real operator runner

/** Deterministic fake gateway: a valid v3 explanation citing the first allowed ref; synthetic cost from body size (tokens ≈ bytes / 4, 600 output tokens). */
function fakeGateway(stats) {
  return {
    modelId: 'fake/cross-repo-eval', baseUrl: 'https://fake.invalid/v1',
    async chatCompletions(body) {
      const bytes = Buffer.byteLength(JSON.stringify(body));
      const message = JSON.parse(String(body.messages[1].content));
      const scope = message.scope; const ref = scope.allowedEvidence.find(item => item.startLine) ?? scope.allowedEvidence[0];
      stats.requests += 1; stats.bytes.push(bytes);
      const summary = `${scope.name} is a ${scope.kind} in this repository.`;
      const content = { summary, keyPoints: [{ text: `Start reading ${scope.name} from its first source file.`, evidence: [ref] }, `It has ${message.children.length} explained children.`], evidence: [ref], summaryClaims: [{ text: summary, evidence: [ref] }] };
      const promptTokens = Math.ceil(bytes / 4);
      return { json: { choices: [{ message: { content: JSON.stringify(content) } }] }, usage: { promptTokens, completionTokens: 600, totalTokens: promptTokens + 600, costUsd: promptTokens * core.GATEWAY_INPUT_USD_PER_TOKEN + 600 * core.GATEWAY_OUTPUT_USD_PER_TOKEN } };
    },
  };
}

/** Live gateway wrapper: asks the gateway for cost (`usage.include`), estimates cost when none is reported (so dollar caps still bite), books spend per response. */
function liveGateway(client, slug, stageName, stats, hold) {
  return {
    modelId: client.modelId, baseUrl: client.baseUrl,
    async chatCompletions(body) {
      let result;
      try { result = await client.chatCompletions({ ...body, usage: { include: true } }); } catch (error) { if (isRateLimit(error)) stats.rateLimited += 1; throw error; }
      const { usd, estimated } = core.usageUsd(result.usage, gatewayPrice);
      stats.requests += 1; stats.bytes.push(Buffer.byteLength(JSON.stringify(body))); if (estimated) stats.estimated = true;
      hold.settle(stageName, slug, usd, estimated);
      return estimated && result.usage ? { ...result, usage: { ...result.usage, costUsd: usd } } : result;
    },
  };
}

/** Gateway price for reservations/estimates: set by `resolveLivePrice` (known model table or --price-per-mtok). */
let gatewayPrice = core.DEFAULT_GATEWAY_PRICE;
function resolveLivePrice(stages) {
  if (!live || !stages.some(name => name === 'enrich' || name === 'ask')) return;
  const config = llm.resolveLlmGatewayConfig(process.env, llm.resolveLlmGatewayLocalConfig(repoRoot), llm.llmProviderArg(argv));
  gatewayPrice = core.resolveGatewayPrice(config.modelId, priceOverride);
}
const { createOperatorBudgetLedger } = await server('operatorBudget.js');

/**
 * Synchronous half of enrichment (scan phase): the full scan and, with --sample, the sampled commit + its
 * scan. Runs before any paid stage; `enrichStage` only reads the result.
 */
const enrichPrepared = new Map();
function prepareEnrich(repo) {
  if ((!live && !fake) || skipEnrich.has(repo.slug)) return;
  const started = performance.now();
  const full = scannedArtifacts(repo);
  let { artifacts, commitSha } = full;
  let scope = { mode: 'full' };
  if (sampleK !== undefined) {
    const sample = core.sampleComponents(full.artifacts.snapshot, sampleK, sampleSingle);
    const sampledCommitSha = derivativeCommit(repo, full.commitSha, sample.dropPaths, 'refs/eval/sampled', `CLA-289 sampled enrichment (eval-only): top ${sample.perContainer} components per container by relation degree`);
    const sampled = scanAt(repo, sampledCommitSha);
    if (!sampled.artifacts) throw new Error(`${repo.slug}: sampled scan failed: ${sampled.outcome.error}`);
    const fullIds = new Set(full.artifacts.snapshot.entities.map(entity => entity.id));
    const foreign = sampled.artifacts.snapshot.entities.filter(entity => !fullIds.has(entity.id)).length;
    if (foreign) console.warn(`${repo.slug}: ${foreign} sampled entities have no id in the full scan; their explanations will not surface in Ask/blocks`);
    artifacts = sampled.artifacts; commitSha = sampledCommitSha;
    scope = { mode: 'sampled', k: sampleK, ...(sampleSingle !== sampleK ? { singleContainerK: sampleSingle } : {}), componentsSampled: sampled.artifacts.snapshot.entities.filter(entity => entity.kind === 'component').length, componentsFull: sample.componentsFull, containers: sample.containers, droppedFiles: sample.dropPaths.length, sampledCommitSha, parentsFromSample: true, overlaidOnFullScan: true };
    console.log(`${repo.slug}: sampled ${scope.componentsSampled}/${scope.componentsFull} components (${sample.perContainer} per container, ${sample.dropPaths.length} files dropped) -> ${sampledCommitSha.slice(0, 12)}`);
  }
  enrichPrepared.set(repo.slug, { full, artifacts, commitSha, scope, ms: Math.round(performance.now() - started) });
}

async function enrichStage(repo, run) {
  if (!live && !fake) { console.log(`${repo.slug}: enrich skipped (pass --live, or --fake for a free dry run)`); return 'skipped'; }
  if (skipEnrich.has(repo.slug)) {
    const kinds = (run.scan?.prepared ?? run.scan?.asIs)?.kinds ?? {};
    const reason = `skipped: scanner-blind (${repo.language ?? 'unknown language'}; the scanner extracts only TypeScript/JavaScript/Rust, and the scan has ${kinds.component ?? 0} components and ${kinds.code ?? 0} code entities)`;
    if (live) { run.enrichmentSkipped = { reason }; delete run.enrichment; }
    console.log(`${repo.slug}: enrichment ${reason}`);
    return 'skipped';
  }
  const prepared = enrichPrepared.get(repo.slug);
  if (!prepared) throw new Error(`${repo.slug}: enrichment was not prepared (scan/sample phase)`);
  const { full, artifacts, commitSha, scope } = prepared;
  const [owner, name] = repo.repository.split('/');
  const caps = { maxRequests: perRepoRequests, maxTokens: 4_000_000, maxDollars: perRepoDollars, maxConcurrent };
  Object.assign(process.env, { OKIE_LLM_OPERATOR_MAX_REQUESTS: String(caps.maxRequests), OKIE_LLM_OPERATOR_MAX_TOKENS: String(caps.maxTokens), OKIE_LLM_OPERATOR_MAX_DOLLARS: String(caps.maxDollars), OKIE_LLM_MAX_CONCURRENT: String(caps.maxConcurrent), OKIE_LLM_ENRICH_DEPTH: 'component' });
  const stats = { requests: 0, bytes: [], estimated: false, rateLimited: 0 };
  let gateway; let gatewayConfig; let globalMaxDollars; let hold;
  if (live) {
    // The runner's dollar cap admits at $0, so it can overshoot by the in-flight requests: reserve that too,
    // and give the runner the rest as its global cap.
    const overshoot = caps.maxConcurrent * core.perRequestWorstUsd(gatewayPrice);
    const reservation = Math.min(caps.maxRequests * core.perRequestWorstUsd(gatewayPrice), caps.maxDollars + overshoot);
    gatewayConfig = llm.resolveLlmGatewayConfig(process.env, llm.resolveLlmGatewayLocalConfig(repoRoot), llm.llmProviderArg(argv));
    const client = llm.createLlmGatewayClient(gatewayConfig, { timeoutMs: llm.resolveOperatorEnrichmentBudget().requestTimeoutMs });
    if (!client) throw new Error('No OpenAI-compatible gateway key configured (see .env key names).');
    hold = await spend.reserve(reservation, `${repo.slug} enrichment (worst case $${reservation.toFixed(3)})`);
    gateway = liveGateway(client, repo.slug, 'enrich', stats, hold);
    globalMaxDollars = Math.max(0.0001, Math.min(caps.maxDollars, reservation - overshoot));
  } else {
    gateway = fakeGateway(stats);
    globalMaxDollars = maxDollars;
  }
  const globalLedger = createOperatorBudgetLedger({ maxRequests: Number.MAX_SAFE_INTEGER, maxTokens: Number.MAX_SAFE_INTEGER, maxDollars: globalMaxDollars });
  const root = join(work, live ? 'operator' : 'operator-fake', repo.slug);
  mkdirSync(root, { recursive: true });
  let result;
  try { result = await core.runCrossRepoEnrichment({ root, source: { owner, repo: name, slug: repo.slug }, commitSha, artifacts, mode: live ? 'live' : 'fake', gateway, ...(gatewayConfig ? { gatewayConfig } : {}), globalLedger, rateLimiter: repoLimiter(caps.maxConcurrent), caps: { ...caps, globalMaxDollars: Math.round(globalMaxDollars * 1e4) / 1e4 }, depth: 'component', scope, provenance: HARNESS, price: gatewayPrice }); } finally { hold?.release(); }
  // Committed runs never carry secrets or local paths.
  if (result.record.error) result.record.error = redact(result.record.error);
  if (result.record.failures) result.record.failures = result.record.failures.map(failure => ({ ...failure, error: redact(failure.error) }));
  if (live) result.record.rateLimited = stats.rateLimited;
  const bytes = [...stats.bytes].sort((a, b) => a - b);
  const requestBytes = { requests: stats.requests, total: bytes.reduce((sum, value) => sum + value, 0), max: bytes.at(-1) ?? 0, p50: bytes[Math.floor(bytes.length / 2)] ?? 0 };
  writeFileSync(join(root, 'eval-run.json'), compactJson({ runId: result.runId, mode: result.record.mode, requestBytes, record: result.record }));
  const r = result.record;
  const kinds = Object.entries(r.byKind).map(([kind, row]) => `${kind} ${row.accepted}/${row.total - row.belowCap}${row.failed ? ` (${row.failed} failed)` : ''}${row.notRun ? ` (${row.notRun} not run)` : ''}`).join(', ');
  console.log(`${repo.slug}: ${r.mode} enrichment ${r.runState}/${r.stopped ?? '-'}${r.ledger ? ` (ledger ${r.ledger})` : ''}: ${r.requests} requests, $${r.costUsd.toFixed(4)}${r.costEstimated ? ' (estimated)' : ''}, ${r.ms} ms; ${kinds}; system explained: ${r.systemExplained}; request bytes p50 ${requestBytes.p50}, max ${requestBytes.max}; 429s ${stats.rateLimited}${r.error ? `; error: ${r.error}` : ''}`);
  if (live) {
    run.enrichment = r;
    delete run.enrichmentSkipped;
    if (result.snapshot && result.sidecar) {
      const dir = artifactDir(repo, 'enriched');
      mkdirSync(dir, { recursive: true });
      // A sampled pass is overlaid onto the full-scan snapshot: explanation rows are keyed by entity id,
      // and every sampled id is a full-scan id, so Ask/blocks see the whole atlas plus the sampled prose.
      writeFileSync(join(dir, 'snapshot.json'), scope.mode === 'sampled' ? stableJson(full.artifacts.snapshot) : result.snapshot);
      writeFileSync(join(dir, 'operator-explanations.json'), scope.mode === 'sampled' ? stableJson({ ...JSON.parse(result.sidecar), sample: scope }) : result.sidecar);
    }
  }
}

// ---------------------------------------------------------------------------
// Claim checks (CLA-145) over the enriched draft

async function claimsStage(repo, run) {
  if (replay) return 'skipped';
  if (!live && !fake) { console.log(`${repo.slug}: claims skipped (pass --live, or --fake after a --fake enrich)`); return 'skipped'; }
  const root = join(work, live ? 'operator' : 'operator-fake', repo.slug);
  const meta = readJson(join(root, 'eval-run.json'), undefined);
  if (!meta) { console.log(`${repo.slug}: claims skipped (no ${live ? 'live' : 'fake'} enrichment in ${work})`); return 'skipped'; }
  Object.assign(process.env, { OKIE_JEV_CLAIM_CHECKS: 'on', OKIE_JEV_MAX_DOLLARS: String(jevDollars), OKIE_JEV_MAX_REQUESTS: String(jevRequests), OKIE_JEV_MAX_TOKENS: String(jevRequests * 81_920) });
  const config = llm.resolveClaimCheckConfig();
  const limits = { maxRequests: config.maxRequests, maxTokens: config.maxTokens, maxDollars: config.maxDollars, maxConcurrent: 1, timeoutMs: config.timeoutMs };
  const { createJevProvider, JEV_MODEL } = await server('operatorJudgments.js');
  let provider; let hold; let rateLimited = 0;
  if (live) {
    // Each Jev request reserves $0.003 in the product ledger; reserve the same here and give the product
    // ledger exactly that as its global cap. Spend is booked at the token estimate (`estimated: true`).
    const reservation = Math.min(limits.maxDollars, limits.maxRequests * core.JEV_RESERVATION_USD_PER_REQUEST);
    const real = createJevProvider(process.env);
    if (!real) throw new Error('JEV_API is not configured');
    hold = await spend.reserve(reservation, `${repo.slug} claim checks`);
    provider = { modelId: real.modelId, async evaluate(...args) { let reply; try { reply = await real.evaluate(...args); } catch (error) { if (isRateLimit(error)) rateLimited += 1; throw error; } const usd = reply.usage.measuredCostUsd ?? (reply.usage.inputTokens ?? 0) * core.JEV_INPUT_USD_PER_TOKEN; hold.settle('claims', repo.slug, usd, reply.usage.measuredCostUsd === undefined); return reply; } };
  } else {
    provider = { modelId: JEV_MODEL, async evaluate(request) {
      const answers = Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'choice', choice: 'supports', confidence: 0.9, probabilities: { supports: 0.9, contradicts: 0.05, insufficient: 0.05 } }]));
      return { json: { model: JEV_MODEL, answers }, usage: { inputTokens: Math.ceil(Buffer.byteLength(JSON.stringify(request)) / 4) } };
    } };
  }
  const globalLedger = createOperatorBudgetLedger({ maxRequests: Number.MAX_SAFE_INTEGER, maxTokens: Number.MAX_SAFE_INTEGER, maxDollars: live ? hold.held : maxDollars });
  let record;
  try { record = await core.runCrossRepoClaimChecks({ root, runId: meta.runId, mode: live ? 'live' : 'fake', provider, limits, globalLedger, provenance: HARNESS }); } finally { hold?.release(); }
  const rates = core.claimRates(record.rows);
  console.log(`${repo.slug}: ${record.mode} claim checks ${record.outcome}${record.stopped ? `/${record.stopped}` : ''}: ${rates.checked} claims (${rates.judged} judged), ${record.requests} requests, $${record.costUsd.toFixed(5)}${record.costEstimated ? ' (token estimate)' : ''}, product-reservation-equivalent $${record.reservationEquivalentUsd.toFixed(3)}; ${JSON.stringify(rates.byState)}`);
  if (live) run.claims = { ...record, rateLimited };
}

// ---------------------------------------------------------------------------
// Ask: retrieval (free) + AFTER answers (live)

async function askStage(repo, run) {
  const labels = labelsFor(repo.slug);
  if (!labels) { console.log(`${repo.slug}: ask skipped (no labels)`); return 'skipped'; }
  if (replay) return 'skipped';
  const { buildAskIndex } = await server('askRetrieval.js');
  const { kind, snapshot, sidecar } = corpus(repo);
  guardCorpusChange(repo, 'Ask answers', run.ask?.corpus, run.ask?.questions.filter(item => item.answer).length ?? 0, kind);
  const index = buildAskIndex(snapshot, sidecar);
  const signals = core.repoSignals(snapshot, repo.language);
  const systemNames = [repo.repository.split('/')[1]];
  const prior = run.ask && run.ask.corpus === kind ? run.ask : undefined;
  const table = new core.PathTable(prior?.paths ?? []);
  let client; let modelId; let limiter;
  if (live) {
    const config = llm.resolveLlmGatewayConfig(process.env, llm.resolveLlmGatewayLocalConfig(repoRoot), llm.llmProviderArg(argv));
    client = llm.createLlmGatewayClient(config, { timeoutMs: 120_000 });
    if (!client) throw new Error('No OpenAI-compatible gateway key configured (see .env key names).');
    modelId = config.modelId;
    limiter = repoLimiter(askConcurrent);
  }
  // Retrieval is free and synchronous: record every question first, then answer them concurrently.
  const items = labels.questions.map(question => {
    const { recorded, context } = core.recordQuestion(snapshot, index, question, signals, table, systemNames);
    const previous = prior?.questions.find(item => item.id === question.id && item.question === question.question && item.selectedId === question.selection.selectedId)?.answer;
    const bodyFor = model => core.askBody(model, index, question.question, context);
    if (!live && previous) {
      // Keep a recorded answer only while the request it answered is unchanged.
      if (askRequestSha256(bodyFor(previous.modelId)) === previous.requestSha256) recorded.answer = previous;
      else console.warn(`${repo.slug}: ${question.id}: recorded answer is stale (request changed); re-record with --live`);
    }
    return { question, recorded, context, bodyFor };
  });
  let rateLimited = 0;
  // `sections` are only needed to replay a recorded answer.
  const provenance = live ? { provenance: HARNESS, modelId, caps: { maxConcurrent: askConcurrent, byteBudget: core.DEFAULT_ASK_BYTE_BUDGET } } : { provenance: HARNESS, ...(prior?.modelId ? { modelId: prior.modelId } : {}), ...(prior?.caps ? { caps: prior.caps } : {}) };
  const record = () => ({ ...provenance, recordedAt: new Date().toISOString(), corpus: kind, entityCount: index.documents.length, systemNames, paths: table.paths, ...(live ? { rateLimited } : {}), questions: items.map(({ recorded }) => recorded.answer ? recorded : (({ sections: _sections, ...rest }) => rest)(recorded)) });
  if (live) {
    await pool(items, askConcurrent, async ({ recorded, context, bodyFor }) => {
      const body = bodyFor(modelId);
      const hold = await spend.reserve(core.worstCaseRequestUsd(body, gatewayPrice), `${repo.slug} ask ${recorded.id}`);
      try {
        const started = performance.now();
        const result = await limiter.run(async () => { try { return await client.chatCompletions({ ...body, usage: { include: true } }); } catch (error) { if (isRateLimit(error)) rateLimited += 1; throw error; } });
        const { usd, estimated } = core.usageUsd(result.usage, gatewayPrice);
        hold.settle('ask', repo.slug, usd, estimated);
        recorded.answer = core.recordAnswer({ modelId, body, context, content: contentOf(result.json), ...(result.usage ? { usage: result.usage } : {}), ms: Math.round(performance.now() - started), table });
      } finally { hold.release(); }
      // Written after every live answer so an interrupted run keeps what it paid for.
      run.ask = record(); saveRun(run);
    });
  }
  run.ask = record();
  const expected = new Map(labels.questions.map(question => [question.id, question.expectedFiles]));
  const recall = items.map(({ recorded }) => core.recallAtK(expected.get(recorded.id), [...recorded.ranked, ...recorded.packets].map(at => table.paths[at])));
  console.log(`${repo.slug}: ask retrieval over ${kind} corpus (${index.documents.length} entities): ${items.length} questions, mean recall@full ${(recall.reduce((a, b) => a + b, 0) / Math.max(1, recall.length)).toFixed(2)}${live ? `, ${items.filter(item => item.recorded.answer).length} answers recorded, 429s ${rateLimited}` : ''}`);
}
function contentOf(json) {
  const content = json?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content : JSON.stringify(content ?? '');
}

// ---------------------------------------------------------------------------
// Blocks: capture candidates (web composer + server derivation), default order, optional Jev order

/** Candidate previews are labeler context only (replay never reads them): about 200 characters is enough. */
const PREVIEW_CHARS = 200;
const clipPreview = text => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text);

let web;
function webComposer() { web ??= buildWebComposer(); return web; }
async function buildWebComposer() {
  const { build } = await import(pathToFileURL(join(repoRoot, 'node_modules/esbuild/lib/main.js')).href);
  const out = join(work, 'esbuild', 'compose.mjs');
  mkdirSync(join(work, 'esbuild'), { recursive: true });
  await build({
    stdin: { contents: "export { composeOverviewBlocks, usesBlockOverview } from './apps/web/src/blocks/composeBlocks';\nexport { DEFAULT_PLAN_BUDGET } from './apps/web/src/blocks/blockPlanner';\nexport { buildContextualOverview } from './apps/web/src/inspector/contextualOverview';\n", resolveDir: repoRoot, loader: 'ts', sourcefile: 'cross-repo-eval-entry.ts' },
    bundle: true, platform: 'node', format: 'esm', outfile: out, loader: { '.css': 'empty' }, logLevel: 'warning',
  });
  return import(pathToFileURL(out).href);
}

async function blocksStage(repo, run) {
  if (replay) return 'skipped';
  const composer = await webComposer();
  const { buildBlockPlanIndex, blockPlanJob, parseBlockPlanRequest } = await server('blockPlans.js');
  const { kind, snapshot, sidecar } = corpus(repo);
  guardCorpusChange(repo, 'Jev block orders', run.blocks?.corpus, run.blocks?.nodes.filter(node => node.jev).length ?? 0, kind);
  const explanations = new Map((sidecar?.explanations ?? []).map(row => [row.scopeId, row.content ?? row.explanation]));
  const names = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
  const facts = buildBlockPlanIndex(snapshot, sidecar ?? {});
  const labels = labelsFor(repo.slug);
  const useful = core.usefulOverviewNodes(snapshot, 5);
  const ids = [...new Set([...useful, ...(labels?.overviews ?? []).map(overview => overview.nodeId)])].filter(id => facts.has(id));
  // The planner's scan identity only allows [A-Za-z0-9_-] slugs (rubygems.org has a dot).
  const scan = { slug: repo.slug.replace(/[^A-Za-z0-9_-]/g, '-'), versionId: `cross-repo-eval-${kind}` };
  const jobs = [];
  const nodes = ids.map(id => {
    const nodeFacts = facts.get(id);
    const overview = composer.buildContextualOverview(snapshot, id);
    const composed = composer.composeOverviewBlocks({ overview, explanation: explanations.get(id), entityName: entityId => names.get(entityId) });
    const request = parseBlockPlanRequest({ scan, nodeId: id, node: { kind: nodeFacts.kind }, context: 'overview', budget: { maxBlocks: composer.DEFAULT_PLAN_BUDGET.maxBlocks }, candidates: composed.planInput.candidates.map(({ id: blockId, type }) => ({ id: blockId, type })) });
    if (request.error) throw new Error(`${id}: ${request.error}`);
    const built = blockPlanJob(request.request, nodeFacts);
    if (built.error) throw new Error(`${id}: ${built.error}`);
    jobs.push({ nodeId: built.job.nodeId, name: built.job.name, kind: built.job.kind, size: built.job.size, maxBlocks: built.job.budget.maxBlocks, candidates: built.job.candidates });
    const priorNode = run.blocks?.corpus === kind ? run.blocks.nodes.find(node => node.nodeId === id) : undefined;
    const candidates = built.job.candidates.map(candidate => ({ id: candidate.id, type: candidate.type, preview: clipPreview(candidate.preview) }));
    const unchanged = priorNode && JSON.stringify(priorNode.candidates) === JSON.stringify(candidates);
    return { nodeId: id, name: built.job.name, kind: built.job.kind, candidates, defaultOrder: composed.plan.order, ...(unchanged && priorNode.jev ? { jev: priorNode.jev } : {}) };
  });
  // Jev plans only the labeled nodes (one request each): agreement is only measurable against a hand order.
  const labeledIds = new Set((labels?.overviews ?? []).map(overview => overview.nodeId));
  const planJobs = jobs.filter(job => labeledIds.has(job.nodeId));
  let jevModelId;
  if (live && planJobs.length) {
    const { createJevProvider } = await server('operatorJudgments.js');
    const { runBlockPlanEvaluation } = await server('blockPlanEvaluation.js');
    const provider = createJevProvider(process.env);
    if (!provider) throw new Error('JEV_API is not configured');
    jevModelId = provider.modelId;
    const capUsd = Math.round(planJobs.length * core.JEV_RESERVATION_USD_PER_REQUEST * 1e6) / 1e6;
    const hold = await spend.reserve(capUsd, `${repo.slug} Jev block planner (${planJobs.length} nodes)`);
    let rows;
    try { rows = await runBlockPlanEvaluation({ fixture: { origin: 'cross-repo-eval', scan, nodes: planJobs }, provider, maxDollars: capUsd }); } finally { hold.release(); }
    for (const row of rows) {
      const node = nodes.find(item => item.nodeId === row.nodeId);
      node.jev = { ...(row.jevOrder ? { order: row.jevOrder } : {}), ...(row.omitted?.length ? { omitted: row.omitted } : {}), ...(row.unavailable ? { unavailable: redact(row.unavailable).slice(0, 200) } : {}), ...(row.inputTokens !== undefined ? { inputTokens: row.inputTokens } : {}), ...(row.estimatedCostUsd !== undefined ? { estimatedCostUsd: row.estimatedCostUsd } : {}), ...(row.latencyMs !== undefined ? { latencyMs: row.latencyMs } : {}) };
      if (row.latencyMs !== undefined) spend.add('blocks', repo.slug, row.estimatedCostUsd ?? 0, true); // after the pass: the whole pass was reserved
    }
  }
  const planned = nodes.some(node => node.jev);
  const jevMeta = live && planJobs.length ? { jevModelId: jevModelId ?? 'unknown', caps: { maxDollars: Math.round(planJobs.length * core.JEV_RESERVATION_USD_PER_REQUEST * 1e6) / 1e6, requests: planJobs.length } } : planned && run.blocks?.corpus === kind ? { ...(run.blocks.jevModelId ? { jevModelId: run.blocks.jevModelId } : {}), ...(run.blocks.caps ? { caps: run.blocks.caps } : {}) } : {};
  run.blocks = { provenance: HARNESS, ...jevMeta, corpus: kind, nodes };
  // Labeler sheet: useful nodes only, candidates shuffled, no default order.
  mkdirSync(join(work, 'blocks'), { recursive: true });
  const sheet = {
    repository: repo.repository, commitSha: repo.commitSha, corpus: kind,
    howTo: 'Order each node\'s candidate ids from most to least useful for a newcomer (omit useless ones) and copy { nodeId, order, note } into labels overviews. Candidates are shuffled on purpose.',
    nodes: nodes.filter(node => useful.includes(node.nodeId)).map(node => ({ nodeId: node.nodeId, name: node.name, kind: node.kind, candidates: core.shuffledIds(node.candidates.map(candidate => candidate.id), `${repo.slug}:${node.nodeId}`).map(id => node.candidates.find(candidate => candidate.id === id)) })),
  };
  writeFileSync(join(work, 'blocks', `${repo.slug}.json`), compactJson(sheet));
  console.log(`${repo.slug}: blocks over ${kind} corpus: ${nodes.length} node(s) [${nodes.map(node => `${node.nodeId} ${node.candidates.length}`).join('; ')}]${live ? `, Jev planned ${nodes.filter(node => node.jev?.order).length}` : ''}; sheet ${relative(work, join(work, 'blocks', `${repo.slug}.json`))}`);
}

// ---------------------------------------------------------------------------
// Report

const counts = map => Object.entries(map ?? {}).map(([key, value]) => `${key} ${value}`).join(', ') || '-';
function fmt(value, digits = 2) { return value === null || value === undefined ? '-' : typeof value === 'number' ? value.toFixed(digits) : String(value); }
function report() {
  const metrics = core.computeMetrics(core.loadManifest(evalDir), core.loadLabels(evalDir), core.loadRuns(evalDir));
  if (!replay) writeFileSync(join(evalDir, 'metrics.json'), compactJson(metrics));
  const table = (header, rows) => [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');
  console.log('\n### Scan\n');
  console.log(table(['repo', 'as-is', 'as-is ms', 'prepared', 'prepared ms', 'entities', 'containers', 'components', 'median depth'], metrics.repos.filter(repo => repo.scan).map(repo => {
    const { asIs, prepared, signals } = repo.scan;
    return [repo.slug, asIs.ok ? 'ok' : `FAIL: ${asIs.error?.split('\n')[0].slice(0, 60)}`, asIs.ms, prepared ? (prepared.ok ? 'ok' : 'FAIL') : '(same)', prepared?.ms ?? '-', (prepared ?? asIs).entities ?? '-', signals?.containers ?? '-', signals?.components ?? '-', signals?.medianDepth ?? '-'];
  })));
  const labeled = metrics.repos.filter(repo => repo.labels);
  if (labeled.length) {
    console.log('\n### Label status (rejected items are not scored)\n');
    console.log(table(['repo', 'questions', 'questions by status', 'overviews', 'overviews by status'], labeled.map(repo => [repo.slug, repo.labels.questions, counts(repo.labels.byStatus), repo.labels.overviews, counts(repo.labels.overviewsByStatus)])));
  }
  console.log('\n### Ask retrieval (family means; recall@full = sections + selected-scope packets)\n');
  console.log(table(['repo', 'corpus', 'questions', 'stale', 'recall@5', 'recall@10', 'recall@full', 'expected files in atlas', 'mean bytes'], metrics.repos.filter(repo => repo.retrieval).map(repo => [repo.slug, repo.retrieval.corpus ?? '-', repo.retrieval.questions, repo.retrieval.stale, fmt(repo.retrieval.recall5), fmt(repo.retrieval.recall10), fmt(repo.retrieval.recallFull), fmt(repo.retrieval.indexedExpected), fmt(repo.retrieval.meanBytes, 0)])));
  const o = metrics.overall;
  console.log(`\noverall: ${o.retrieval.questions} questions, recall@5 ${fmt(o.retrieval.recall5)}, @10 ${fmt(o.retrieval.recall10)}, @full ${fmt(o.retrieval.recallFull)}, expected files present in atlas ${fmt(o.retrieval.indexedExpected)} (pooled family means); per-repo mean over ${o.retrieval.perRepoMean.repos} repos: recall@5 ${fmt(o.retrieval.perRepoMean.recall5)}, @10 ${fmt(o.retrieval.perRepoMean.recall10)}, @full ${fmt(o.retrieval.perRepoMean.recallFull)}`);
  console.log(table(['category', 'questions', 'recall@full'], Object.entries(o.retrieval.byCategory).map(([category, row]) => [category, row.questions, fmt(row.recallFull)])));
  console.log('\n### Adaptive retrieval budgets (offline; product default unchanged)\n');
  console.log(table(['variant', 'rule', 'recall@full', 'mean bytes', 'helps in', 'hurts in'], Object.entries(metrics.adaptive).map(([name, row]) => [name, row.description, fmt(row.recallFull), fmt(row.meanBytes, 0), row.helpsIn.join(', ') || '-', row.hurtsIn.join(', ') || '-'])));
  const answered = metrics.repos.filter(repo => repo.answers);
  if (answered.length) {
    console.log('\n### Ask answers (AFTER prompt)\n');
    console.log(table(['repo', 'answered', 'cited recall', 'citation precision', 'invalid', 'declined', 'correct', '$'], answered.map(repo => [repo.slug, repo.answers.answered, fmt(repo.answers.citedRecall), fmt(repo.answers.citationPrecision), fmt(repo.answers.invalidRate), fmt(repo.answers.declinedRate), fmt(repo.answers.correctness), fmt(repo.answers.costUsd, 4)])));
    const a = o.answers;
    console.log(`\noverall (pooled family means): ${a.answered} answers, cited recall ${fmt(a.citedRecall)}, citation precision ${fmt(a.citationPrecision)}, invalid ${fmt(a.invalidRate)}, declined ${fmt(a.declinedRate)}, correct ${fmt(a.correctness)}; per-repo mean over ${a.perRepoMean.repos} repos: cited recall ${fmt(a.perRepoMean.citedRecall)}, precision ${fmt(a.perRepoMean.citationPrecision)}, declined ${fmt(a.perRepoMean.declinedRate)}, correct ${fmt(a.perRepoMean.correctness)}`);
  }
  const blocks = metrics.repos.filter(repo => repo.blocks);
  if (blocks.length) {
    console.log('\n### Block order vs hand order\n');
    console.log('tau / top1 / top3 on the candidates both orders share; top1 real = the actually first rendered block equals the hand order\'s first; omitted = rendered blocks the labeler left out; dropped = hand-kept blocks the order does not render (sums over nodes)\n');
    const cells = row => [fmt(row.tau), fmt(row.top1), fmt(row.top3), fmt(row.top1Unrestricted), String(row.omittedRendered ?? ''), String(row.keptDropped ?? '')];
    const header = ['repo', 'labeled', 'default tau', 'default top1', 'default top3', 'default top1 real', 'default omitted', 'default dropped', 'Jev nodes', 'Jev tau', 'Jev top1', 'Jev top3', 'Jev top1 real', 'Jev omitted', 'Jev dropped'];
    const ob = o.blocks;
    console.log(table(header, [
      ...blocks.map(repo => [repo.slug, repo.blocks.labeled, ...cells(repo.blocks.default), `${repo.blocks.jev.nodes}${repo.blocks.jev.unavailable ? ` (+${repo.blocks.jev.unavailable} unavailable)` : ''}`, ...cells(repo.blocks.jev)]),
      ['**overall (pooled nodes)**', ob.labeled, ...cells(ob.default), ob.jevNodes, ...cells(ob.jev)],
      [`**per-repo mean (${ob.perRepoMean.repos})**`, '', ...cells(ob.perRepoMean.default), '', ...cells(ob.perRepoMean.jev)],
    ]));
  }
  const claims = metrics.repos.filter(repo => repo.claims);
  if (claims.length) {
    console.log('\n### Claim checks\n');
    console.log('rates over judged claims (= checked − unavailable); $ booked = Jev token estimate, reservation-eq = $0.003 per request as the product ledger reserves\n');
    console.log(table(['repo', 'claims', 'judged', 'unavailable', 'insufficient-context', 'insufficient (Jev)', 'supported', '$ booked', '$ reservation-eq'], claims.map(repo => [repo.slug, repo.claims.checked, repo.claims.judged, fmt(repo.claims.unavailableRate), fmt(repo.claims.insufficientContextRate), fmt(repo.claims.insufficientRate), fmt(repo.claims.supportedRate), fmt(repo.claims.costUsd, 5), fmt(repo.claims.reservationEquivalentUsd, 3)])));
    const c = o.claims;
    console.log('\ninsufficient-context by product reason (code rows) and unavailable by reason (Jev batches):\n');
    console.log(table(['repo', 'insufficient-context by reason', 'unavailable by reason'], claims.map(repo => [repo.slug, counts(repo.claims.insufficientContextByReason), counts(repo.claims.unavailableByReason)])));
    console.log(`\noverall (pooled rows): insufficient-context ${counts(c.insufficientContextByReason)}; unavailable ${counts(c.unavailableByReason)}`);
    console.log(`\noverall (pooled rows): ${c.checked} claims, ${c.judged} judged, unavailable ${fmt(c.unavailableRate)}, insufficient-context ${fmt(c.insufficientContextRate)}, insufficient ${fmt(c.insufficientRate)}, supported ${fmt(c.supportedRate)}`);
  }
  const costs = metrics.repos.filter(repo => repo.cost?.enrichMs !== undefined);
  if (costs.length) {
    console.log('\n### Enrichment\n');
    console.log(table(['repo', 'scope', 'ms', '$', 'requests', 'accepted', 'failed', 'failures by class', 'not run', 'system explained'], costs.map(repo => [repo.slug, repo.cost.enrichScope ?? '-', repo.cost.enrichMs, fmt(repo.cost.enrichUsd, 4), repo.cost.enrichRequests, repo.cost.enrichAccepted, repo.cost.enrichFailed, counts(repo.cost.enrichFailuresByClass), repo.cost.enrichNotRun, repo.cost.systemExplained])));
  }
  const skipped = metrics.repos.filter(repo => repo.cost?.enrichSkipped);
  for (const repo of skipped) console.log(`${repo.slug}: ${repo.cost.enrichSkipped}`);
  const timed = metrics.repos.filter(repo => repo.cost?.stageMs);
  if (timed.length) {
    console.log('\n### Wall time per stage (s, last pass; repos may have run in parallel)\n');
    const names = ['fetch', 'scan', 'enrich', 'claims', 'ask', 'blocks'];
    const secs = ms => ms === undefined ? '-' : (ms / 1000).toFixed(1);
    const conc = value => value === undefined ? '-' : String(value);
    console.log(table(['repo', ...names, 'total', 'maxConcurrent (enrich/claims/ask, recorded)', '429s (enrich/claims/ask)'], [
      ...timed.map(repo => [repo.slug, ...names.map(name => secs(repo.cost.stageMs[name])), secs(Object.values(repo.cost.stageMs).reduce((a, b) => a + b, 0)), `${conc(repo.cost.enrichMaxConcurrent)}/${conc(repo.cost.claimsMaxConcurrent)}/${conc(repo.cost.askMaxConcurrent)}`, repo.cost.rateLimited ? `${repo.cost.rateLimited.enrich}/${repo.cost.rateLimited.claims}/${repo.cost.rateLimited.ask}` : '-']),
      ['**total**', ...names.map(name => secs(o.stageMs[name])), secs(o.stageMs.total), '', String(o.rateLimited)],
    ]));
  }
  console.log(`\nrecorded live spend: $${core.spentUsd(spend.ledger).toFixed(4)} of $${spend.ledger.capUsd} (enrich $${fmt(o.spendUsd.enrich, 4)}, ask $${fmt(o.spendUsd.ask, 4)}, Jev $${fmt(o.spendUsd.jev, 4)} booked at the token estimate; product-reservation-equivalent $${fmt(o.spendUsd.jevReservationEquivalent, 3)})`);
}

// ---------------------------------------------------------------------------

/** Runs `worker` over `items` with at most `limit` in flight. */
async function pool(items, limit, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (next < items.length) { const at = next; next += 1; await worker(items[at], at); } }));
}

const PAID_RECORDS = { enrich: 'enrichment', claims: 'claims', ask: 'ask', blocks: 'blocks' };

/**
 * When a repo's evalPrepare is retired from the manifest (CLA-299: the scanner now handles the tree as-is), paid
 * records made over the old prepared commit are kept, not re-bought; `paidStagesCorpus` says which commit they saw.
 */
function retirePreparedCorpus(repo, run) {
  if (repo.evalPrepare || !run.preparedCommitSha || run.paidStagesCorpus) return;
  const stages = Object.keys(PAID_RECORDS).filter(name => run[PAID_RECORDS[name]] !== undefined);
  if (!stages.length) return;
  run.paidStagesCorpus = { preparedCommitSha: run.preparedCommitSha, evalPrepare: run.evalPrepare, stages, note: 'Recorded over the CLA-289 eval-prepared commit, before its evalPrepare was retired; re-running a listed stage drops it here.' };
}

function clearRetiredStage(run, name) {
  if (!run.paidStagesCorpus) return;
  run.paidStagesCorpus.stages = run.paidStagesCorpus.stages.filter(stage => stage !== name);
  if (!run.paidStagesCorpus.stages.length) delete run.paidStagesCorpus;
}

const SYNC_STAGES = new Set(['fetch', 'scan']);

async function main() {
  mkdirSync(work, { recursive: true });
  if (live) lockSpend();
  loadLive();
  const stages = stage === 'all' ? [...core.STAGE_NAMES] : stage === 'report' ? [] : [stage];
  resolveLivePrice(stages);
  const runs = new Map(repos.map(repo => [repo.slug, loadRun(repo)]));
  const record = (repo, name, ms) => { const run = runs.get(repo.slug); run.stageMs = { ...run.stageMs, [name]: ms }; };

  // Phase 1 (synchronous, one repo at a time): git + scans + the sampled commit/scan. Nothing paid runs yet.
  for (const repo of repos) {
    const run = runs.get(repo.slug);
    for (const name of stages.filter(item => SYNC_STAGES.has(item) || item === 'enrich')) {
      const started = performance.now();
      try {
        if (name === 'fetch') {
          const prepared = fetchRepo(repo);
          retirePreparedCorpus(repo, run);
          if (prepared.preparedCommitSha) run.preparedCommitSha = prepared.preparedCommitSha; else delete run.preparedCommitSha;
          if (repo.evalPrepare) run.evalPrepare = { ...repo.evalPrepare, droppedPaths: prepared.droppedPaths }; else delete run.evalPrepare;
        }
        if (name === 'scan') scanStage(repo, run);
        if (name === 'enrich') prepareEnrich(repo);
        if (SYNC_STAGES.has(name)) record(repo, name, Math.round(performance.now() - started));
      } catch (error) {
        console.error(`${repo.slug}: ${name} failed: ${redact(error instanceof Error ? error.message : String(error))}`);
      }
      saveRun(run);
    }
    scanned.delete(repo.slug);
  }

  // Phase 2 (async, repo pool): paid stages only; they never scan or run git.
  const paid = stages.filter(item => !SYNC_STAGES.has(item));
  let refused;
  await pool(repos, repoConcurrency, async repo => {
    const run = runs.get(repo.slug);
    for (const name of paid) {
      if (refused) return;
      const started = performance.now();
      try {
        let outcome;
        if (name === 'enrich') outcome = await enrichStage(repo, run);
        if (name === 'claims') outcome = await claimsStage(repo, run);
        if (name === 'ask') outcome = await askStage(repo, run);
        if (name === 'blocks') outcome = await blocksStage(repo, run);
        // Fake passes stay in --work, so their timing does too. Enrichment includes its scan-phase preparation.
        if (outcome !== 'skipped' && !fake && !replay) clearRetiredStage(run, name);
        if (outcome !== 'skipped' && !(fake && (name === 'enrich' || name === 'claims'))) record(repo, name, Math.round(performance.now() - started) + (name === 'enrich' ? enrichPrepared.get(repo.slug)?.ms ?? 0 : 0));
      } catch (error) {
        console.error(`${repo.slug}: ${name} failed: ${redact(error instanceof Error ? error.message : String(error))}`);
        if (/^refusing /.test(error?.message ?? '')) refused = error;
      }
      saveRun(run);
    }
    enrichPrepared.delete(repo.slug);
  });
  if (refused) throw refused;
  if (stage === 'report' || stage === 'all' || replay) report();
}

main().catch(error => { console.error(redact(error instanceof Error ? error.message : String(error))); process.exit(1); });
