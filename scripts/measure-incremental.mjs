#!/usr/bin/env node
// CLA-271 incremental re-scan measurement. Drives the real operator runner in-process against a scratch store:
// a full baseline run at commit A (published), then incremental runs at B, C, D… in order. After each step the draft
// is published when it is fully accepted (the auto-publish gate); otherwise the next step continues from the newest
// draft (the baseline chain). Prints, per step: commit-caused dirty and carried scope counts, requests, cost, scan ms,
// enrichment ms, per-level enrichment spans (leaf/container/system) and the enrichment critical path (first leaf start →
// last system end), total wall ms and the reuse ratio.
//
//   node scripts/measure-incremental.mjs --repo <local git checkout> --from <rev A> --to <rev B>[,<rev C>,…]
//        [--live] [--scan-root <empty scratch dir>] [--depth component|code] [--name owner/repo] [--json <out.json>]
//
// Dry-run is the default: a fake gateway (no network, no key, no spend). Only an explicit --live uses the configured
// gateway (--llm-provider <name> or OKIE_LLM_PROVIDER + OKIE_LLM_API_KEY; --dotenv / OKIE_DOTENV=1 loads the repo-root
// .env; okie.local.json; OKIE_LLM_OPERATOR_* budget caps): that is a LIVE, paid run.
// The store is always a scratch directory: a fresh temp dir by default, never $OKIE_SCAN_ROOT; an existing operator
// store is refused. rust-analyzer SCIP indexes are cached inside that scratch store (<store>/cache/rust-scip), as the
// operator runner does. Requires a built server (`pnpm --filter @okie/server build`).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const server = join(repoRoot, 'apps/server/dist');
if (!existsSync(join(server, 'operatorRunner.js'))) throw new Error('Build the server first: pnpm --filter @okie/server build');
const arg = name => { const index = process.argv.indexOf(`--${name}`); return index < 0 ? undefined : process.argv[index + 1]; };
const live = process.argv.includes('--live');
const repo = arg('repo'); const from = arg('from'); const toList = arg('to');
if (!repo || !from || !toList) throw new Error('Usage: --repo <git checkout> --from <rev A> --to <rev B>[,<rev C>,…] [--live]');
const depth = arg('depth');
if (depth !== undefined && depth !== 'component' && depth !== 'code') throw new Error('--depth must be component or code');
if (depth) process.env.OKIE_LLM_ENRICH_DEPTH = depth;
const scanRoot = resolve(arg('scan-root') ?? mkdtempSync(join(tmpdir(), 'okie-measure-incremental-')));
if (existsSync(join(scanRoot, 'operator-v1', 'state.json'))) throw new Error(`Refusing an existing operator store at ${scanRoot}; pass an empty scratch --scan-root`);
const [owner, name] = (arg('name') ?? `local/${basename(resolve(repo))}`).toLowerCase().split('/');
if (!owner || !name) throw new Error('--name must be owner/repo');

const requireServer = createRequire(join(repoRoot, 'apps/server/package.json'));
const { scanRepository } = await import(requireServer.resolve('@okie/scan'));
const { OperatorStore } = await import(join(server, 'operatorStore.js'));
const { OperatorPublicationService } = await import(join(server, 'operatorPublication.js'));
const { createOperatorRunner, rustIndexCacheDir } = await import(join(server, 'operatorRunner.js'));
const { autoPublishGate, startIncrementalRun } = await import(join(server, 'operatorIncremental.js'));
const { OperatorWorkflow } = await import(join(server, 'operatorWorkflow.js'));
const { createLlmGatewayClient, ignoredGenericLlmEnvNotice, llmProviderArg, loadOperatorDotenv, resolveLlmGatewayConfig, resolveLlmGatewayLocalConfig } = await import(join(server, 'llmGateway.js'));

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const shaA = git('rev-parse', from);
const chain = toList.split(',').map(value => value.trim()).filter(Boolean).map(rev => git('rev-parse', rev));

/** Fake gateway: a valid reply citing the scope's first allowed evidence ref; no cost. */
const fakeGateway = { modelId: 'fake/dry-run', async chatCompletions(body) {
  const scope = JSON.parse(String(body.messages[1].content)).scope;
  return { json: { choices: [{ message: { content: JSON.stringify({ summary: `Dry-run note for ${scope.name}.`, keyPoints: ['Start at the entry point.', 'Watch the edges.'], evidence: scope.allowedEvidence.slice(0, 1) }) } }] }, usage: { promptTokens: Math.ceil(JSON.stringify(body).length / 4), completionTokens: 40, totalTokens: Math.ceil(JSON.stringify(body).length / 4) + 40, costUsd: 0 } };
} };
let gatewayConfig;
if (live) {
  loadOperatorDotenv(repoRoot);
  gatewayConfig = resolveLlmGatewayConfig(process.env, resolveLlmGatewayLocalConfig(repoRoot), llmProviderArg(process.argv.slice(2)));
  const notice = ignoredGenericLlmEnvNotice(process.env);
  if (notice) console.error(notice);
  // The operator runner only uses an OpenAI-compatible gateway: `anthropic` (or no opt-in) would measure nothing.
  if (!createLlmGatewayClient(gatewayConfig)) {
    const why = gatewayConfig.offReason ?? `provider ${gatewayConfig.provider} has no OpenAI-compatible gateway`;
    throw new Error(`--live needs an OpenAI-compatible gateway: ${why} (use --llm-provider openrouter|openai-compatible with OKIE_LLM_API_KEY; --dotenv loads the repo-root .env)`);
  }
}

const store = new OperatorStore(scanRoot); const publications = new OperatorPublicationService(store);
const access = { kind: 'unauthenticated' };
/** Scan wall time of the most recent scan (the runner scans once per run). */
let lastScanMs = 0;
const runner = createOperatorRunner({
  store, publication: publications,
  ...(live ? { gatewayConfig } : { gateway: fakeGateway }),
  githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }),
  resolveCommit: async source => git('rev-parse', source.ref ?? 'HEAD'),
  scan: async (source, options) => {
    const started = Date.now();
    const artifacts = scanRepository(resolve(repo), { revision: source.ref ?? 'HEAD', repositorySlug: `${owner}-${name}`, analysisMode: 'full', codeSurface: 'all', rustIndexCacheDir: options.rustIndexCacheDir ?? rustIndexCacheDir(store) });
    lastScanMs = Date.now() - started;
    return { commitSha: artifacts.snapshot.commitSha, artifacts };
  },
});
const repositoryId = `repo:${owner}/${name}`;
const workflow = new OperatorWorkflow({ store, publications, enqueue() {} });

function spend(runId) {
  const state = store.snapshot(); const drafts = new Set(state.drafts.filter(draft => draft.runId === runId).map(draft => draft.draftRevisionId));
  const attempts = state.attempts.filter(attempt => drafts.has(attempt.draftRevisionId));
  const cost = attempts.reduce((total, attempt) => total + (attempt.usage?.measuredCostUsd ?? attempt.usage?.estimatedCostUsd ?? 0), 0);
  const tokens = attempts.reduce((total, attempt) => total + (attempt.usage?.inputTokens ?? 0) + (attempt.usage?.outputTokens ?? 0), 0);
  return { requests: attempts.length, accepted: attempts.filter(attempt => attempt.state === 'accepted').length, failed: attempts.filter(attempt => attempt.state === 'failed').length, costUsd: Number(cost.toFixed(6)), tokens };
}
/**
 * Per-level enrichment timing of a run from its attempt rows: each level (leaf = component/code, then container, then
 * system) spans its first attempt start to its last attempt end; the critical path runs from the first leaf start to
 * the last system end (the reduce is sequential by level).
 */
function levelTiming(runId) {
  const state = store.snapshot(); const drafts = new Set(state.drafts.filter(draft => draft.runId === runId).map(draft => draft.draftRevisionId));
  const attempts = state.attempts.filter(attempt => drafts.has(attempt.draftRevisionId) && attempt.kind !== 'scan' && attempt.kind !== 'judgment');
  const level = scopeId => scopeId.startsWith('system:') ? 'system' : scopeId.startsWith('container:') ? 'container' : 'leaf';
  const span = rows => rows.length ? Math.max(...rows.map(row => row.updatedAt)) - Math.min(...rows.map(row => row.createdAt)) : 0;
  const by = name => attempts.filter(attempt => level(attempt.scopeId) === name);
  return { leafMs: span(by('leaf')), containerMs: span(by('container')), systemMs: span(by('system')), criticalMs: span(attempts) };
}
/** Publishes a fully accepted draft over the current publication; returns whether it did. */
function publishIfAccepted(draftRevisionId, coverage, acknowledge = false) {
  if (!acknowledge && !autoPublishGate(coverage)) return false;
  const current = publications.currentPublication(repositoryId);
  const result = publications.publishDraft({ repositoryId, draftRevisionId, ...(current ? { expectedCurrentVersionId: current.versionId } : {}), coverage, ...(acknowledge ? { acknowledgeCoverage: true } : {}) });
  if (!result.ok) throw new Error(`Could not publish ${draftRevisionId}: ${result.reason}`);
  return true;
}

const steps = [];
const fullStarted = Date.now();
const full = store.createRun({ idempotencyKey: `measure-${Date.now()}`, source: { repositoryId, owner, repo: name, slug: `${owner}__${name}`, ref: shaA } }).run;
await runner.enqueue({ kind: 'run', runId: full.runId, githubAccess: access });
const baselineRun = store.snapshot().runs.find(run => run.runId === full.runId);
if (baselineRun.state !== 'awaiting_review') throw new Error(`Baseline run ended ${baselineRun.state}: ${baselineRun.error ?? ''}`);
const baselineDetail = workflow.draftDetail(baselineRun.draftRevisionId);
publishIfAccepted(baselineRun.draftRevisionId, baselineDetail.draft.coverage, true);
const fullWall = Date.now() - fullStarted;
const baseline = { step: 'baseline', commit: shaA, wallMs: fullWall, scanMs: lastScanMs, enrichMs: fullWall - lastScanMs, coverage: baselineDetail.draft.coverage, published: true, ...spend(full.runId), ...levelTiming(full.runId) };

for (const sha of chain) {
  const started = Date.now(); lastScanMs = 0;
  const result = await startIncrementalRun({ store, publications, enqueue: job => runner.enqueue(job) }, { repositoryId, ref: sha, trigger: 'script', githubAccess: access });
  const wallMs = Date.now() - started;
  if (result.status !== 'started') { steps.push({ step: sha.slice(0, 7), commit: sha, status: result.status, wallMs }); continue; }
  const run = store.snapshot().runs.find(value => value.runId === result.runId);
  if (!run.draftRevisionId) { steps.push({ step: sha.slice(0, 7), commit: sha, status: run.state, error: run.error, wallMs }); continue; }
  const detail = workflow.draftDetail(run.draftRevisionId);
  const changelog = detail.changelog;
  const inCap = changelog.counts.dirty + changelog.counts.stale + changelog.counts.reused;
  const published = publishIfAccepted(run.draftRevisionId, detail.draft.coverage);
  steps.push({
    step: sha.slice(0, 7), commit: sha, baselineCommit: run.incremental.baseline.commitSha, state: run.state, wallMs, scanMs: lastScanMs, enrichMs: Math.max(0, wallMs - lastScanMs),
    dirty: changelog.counts.dirty, carried: changelog.counts.carried ?? 0, stale: changelog.counts.stale, ...levelTiming(run.runId), chainSteps: changelog.chain?.length ?? 0, reused: changelog.counts.reused, inCapScopes: inCap,
    reuseRatio: inCap ? Number((changelog.counts.reused / inCap).toFixed(4)) : 0,
    hashCheck: changelog.hashCheck, coverage: detail.draft.coverage, published, ...spend(run.runId),
    counts: changelog.counts, summary: changelog.summary,
  });
}

const report = { mode: live ? 'live' : 'dry-run', scanRoot, rustIndexCacheDir: rustIndexCacheDir(store), depth: process.env.OKIE_LLM_ENRICH_DEPTH ?? 'component', baseline, steps };
const pad = (value, width) => String(value ?? '').padStart(width);
const rows = [baseline, ...steps].map(step => [step.step === 'baseline' ? `${step.commit.slice(0, 7)} (full)` : step.step, step.dirty ?? '-', step.carried ?? '-', step.requests ?? '-', step.costUsd !== undefined ? step.costUsd.toFixed(4) : '-', step.scanMs ?? '-', step.enrichMs ?? '-', step.leafMs !== undefined ? `${step.leafMs}/${step.containerMs}/${step.systemMs}` : '-', step.criticalMs ?? '-', step.wallMs, step.reuseRatio !== undefined ? step.reuseRatio.toFixed(3) : '-', step.status ?? (step.published ? 'published' : step.state ?? '')]);
const header = ['step', 'dirty', 'carried', 'requests', 'cost $', 'scan ms', 'enrich ms', 'leaf/cont/sys ms', 'critical ms', 'total ms', 'reuse', 'result'];
const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => String(row[column]).length)));
console.log([header, ...rows].map(row => row.map((cell, column) => column === 0 ? String(cell).padEnd(widths[0]) : pad(cell, widths[column])).join('  ')).join('\n'));
console.log(`\nmode ${report.mode}; store ${scanRoot}; depth ${report.depth}`);
const output = arg('json'); if (output) writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
