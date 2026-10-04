// scripts/deploy.mjs's logic, with Node's side effects passed in (no Node imports, so the edge tests run it
// in workerd with fakes). deploy.mjs only wires the real fs/child_process/process into runDeploy.

/**
 * Whether deploy.mjs applies the remote USERS_DB migrations before `wrangler deploy`: always, except for a
 * `--dry-run` (which must never touch the remote database).
 * @param {string[]} extraArgs  the wrangler args after the environment name
 */
export function appliesRemoteMigrations(extraArgs) {
  return !extraArgs.includes('--dry-run');
}

/**
 * The marker for unfilled or unconfirmed legal copy (PRIVACY_COPY_PENDING in apps/web/src/privacyPage.ts):
 * the bare tag and the `: <what to do>` form both start with it.
 */
export const PRIVACY_PENDING_MARKER = ['[pending', 'owner'].join(' ');
export const PRIVACY_PENDING_MESSAGE = 'privacy copy has an unfilled placeholder (apps/web/src/privacyPage.ts)';

/** The legal pages' sources (repo-relative) searched for the marker, in order, with the word the refusal uses. */
export const LEGAL_COPY_FILES = [
  { path: 'apps/web/src/privacyPage.ts', label: 'privacy' },
  { path: 'apps/web/src/termsPage.ts', label: 'terms' },
];

/**
 * Why `target` must not deploy, or undefined. Production refuses while a legal page's source (privacy, then
 * terms) still contains the pending marker; staging may deploy with it (and nothing is read for it).
 * @param {string} target
 * @param {(path: string) => string} readSource  the text of a repo-relative path
 */
export function deployBlockedReason(target, readSource) {
  if (target !== 'production') return undefined;
  for (const file of LEGAL_COPY_FILES) {
    if (readSource(file.path).includes(PRIVACY_PENDING_MARKER)) return `${file.label} copy has an unfilled placeholder (${file.path})`;
  }
  return undefined;
}

export const ENVIRONMENTS = ['staging', 'production'];
export const API_TOKEN = 'CLOUDFLARE_API_TOKEN';

/** Keep command progress/errors visible while removing credentials before they reach logs. */
function redactD1Output(value, secretEnv, depth = 0) {
  let output = String(value ?? '');
  // Replace literal and JSON-escaped environment secrets, including the ignored API token.
  const secrets = Object.entries(secretEnv)
    .filter(([name, value]) => value && value.length >= 8 && /token|secret|password|credential|authorization|api[_-]?key/i.test(name))
    .flatMap(([, value]) => [value, JSON.stringify(value).slice(1, -1)])
    .sort((a, b) => b.length - a.length);
  // Wrangler may embed a serialized JSON payload inside a quoted JSON string.
  // Decode string literals before matching fields, then preserve their encoding in the log.
  if (depth < 4) output = output.replace(/"(?:\\[\s\S]|[^"\\])*"/g, literal => {
    try {
      const decoded = JSON.parse(literal);
      const redacted = redactD1Output(decoded, secretEnv, depth + 1);
      return redacted === decoded ? literal : JSON.stringify(redacted);
    } catch { return literal; }
  });
  // Quoted values may contain escaped quotes or span lines. Consume the whole value first.
  const credential = /((?:["']?(?:[\w-]*(?:token|secret|password|credential|api[_-]?key)[\w-]*|authorization)["']?)\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[^\s,;}]+)/gi;
  output = output.replace(credential, '$1[REDACTED]');
  output = output.replace(/(\bauthorization\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]');
  output = output.replace(/\bBearer\s+[^\s"',;}]+/gi, 'Bearer [REDACTED]');
  for (const secret of secrets) output = output.split(secret).join('[REDACTED]');
  return output;
}

/**
 * Deploy the edge Worker; returns the process exit code. Every side effect goes through `deps`, so a test
 * can prove what runs (and what never runs) for each target and flag.
 * @param {{
 *   argv: string[],
 *   env: Record<string, string | undefined>,
 *   edgeDir: string,
 *   repoRoot: string,
 *   readFile: (path: string) => string,
 *   exists: (path: string) => boolean,
 *   spawn: (command: string, args: string[], options: { cwd: string, env: Record<string, string | undefined>, stdio: unknown }) => { status: number | null, stdout?: unknown, stderr?: unknown },
 *   sleep: (milliseconds: number) => void,
 *   log: (message: string) => void,
 *   error: (message: string) => void,
 * }} deps  argv is process.argv (target at [2], extra wrangler args after it)
 * @returns {number}
 */
export function runDeploy(deps) {
  const { argv, edgeDir, repoRoot, readFile, exists, spawn, log, error } = deps;
  const target = argv[2];
  if (!ENVIRONMENTS.includes(target)) {
    error(`usage: deploy.mjs <${ENVIRONMENTS.join('|')}> [extra wrangler args]`);
    return 2;
  }
  const extraArgs = argv.slice(3);
  const env = { ...deps.env };
  if (env[API_TOKEN]) {
    delete env[API_TOKEN];
    log(`note: ignoring ${API_TOKEN} so wrangler uses your \`wrangler login\` session`);
  }
  const dryRun = !appliesRemoteMigrations(extraArgs);
  // Production never ships unfilled privacy copy (CLA-316); staging may. A dry run only warns: it deploys nothing.
  const blocked = deployBlockedReason(target, path => readFile(`${repoRoot}${path}`));
  if (blocked && !dryRun) {
    error(`refusing to deploy ${target}: ${blocked}`);
    return 1;
  }
  if (blocked) log(`warning: a real deploy to ${target} would be refused: ${blocked}`);
  if (!exists(`${repoRoot}apps/web/dist/index.html`)) {
    error('apps/web/dist is missing; run `pnpm build` first');
    return 1;
  }
  // Classify raw D1 output internally; emit redacted progress and errors for every attempt.
  const runD1 = (args, label) => {
    const execute = () => {
      const result = spawn('pnpm', ['exec', 'wrangler', 'd1', ...args, 'USERS_DB', '--env', target, '--remote',
        ...(label === 'preflight' ? ['--command', 'SELECT 1'] : [])], {
        cwd: edgeDir,
        env: { ...env, CI: 'true' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = redactD1Output(result.stdout, deps.env);
      const stderr = redactD1Output(result.stderr, deps.env);
      if (stdout) log(stdout);
      if (stderr) error(stderr);
      return result;
    };
    let result = execute();
    const output = `${String(result.stdout ?? '')}\n${String(result.stderr ?? '')}`;
    if (result.status !== 0 && /\bcode["']?\s*[:=]?\s*7403\b/i.test(output)) {
      log(`USERS_DB ${label} returned code 7403; waiting 5 seconds before one retry (OAuth refresh).`);
      deps.sleep(5000);
      result = execute();
    }
    return result.status ?? 1;
  };
  if (dryRun) log('--dry-run: skipping the remote USERS_DB preflight and migrations');
  else {
    log(`checking USERS_DB access on ${target} (remote D1; OAuth refresh)`);
    const preflight = runD1(['execute'], 'preflight');
    if (preflight !== 0) {
      error('USERS_DB preflight failed; not deploying. Check your `wrangler login` session.');
      return preflight;
    }
    log(`applying USERS_DB migrations to ${target} (remote D1)`);
    const migrations = runD1(['migrations', 'apply'], 'migrations');
    if (migrations !== 0) {
      error('USERS_DB migrations failed; not deploying. See docs/deploy/cloudflare-runbook.md (Sign-in).');
      return migrations;
    }
  }
  log(`deploying sourcefor-atlas to ${target} (Worker + sleeping Node container; OAuth login, account from wrangler.jsonc)`);
  const result = spawn('pnpm', ['exec', 'wrangler', 'deploy', '--env', target, ...extraArgs], {
    cwd: edgeDir,
    env,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    error('deploy failed. First deploy on a fresh account: 10063 = no workers.dev subdomain yet (open Workers & Pages in the dashboard once); 100117 = the custom-domain hostname already has DNS records (delete them first). See docs/deploy/cloudflare-runbook.md.');
  }
  return result.status ?? 1;
}
