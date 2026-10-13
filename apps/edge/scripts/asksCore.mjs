// Operator helpers for an account's daily Ask count (CLA-539). Pure (no Node imports) so the edge tests run
// them in workerd; scripts/asks.mjs is the CLI that writes the grant through wrangler and calls the Worker.
//
// The count lives in the AtlasBudget Durable Object, which wrangler cannot query. The CLI therefore writes a
// one-time grant into USERS_DB (only the token's SHA-256; see migrations/0003_operator_grants.sql) and sends the
// token to POST /api/operator/ask-usage (src/operator.ts), which deletes the grant as it accepts it.

export const ASK_TARGETS = ['staging', 'production', 'local'];
export const ASK_ACTIONS = { show: 'ask-show', reset: 'ask-reset' };
export const ASK_ORIGINS = { staging: 'https://staging.sourcefor.dev', production: 'https://sourcefor.dev' };
export const DEFAULT_LOCAL_PORT = 4196;
export const OPERATOR_ASK_USAGE_PATH = '/api/operator/ask-usage';
/** How long a grant lives: long enough for wrangler to write it and the request to land. */
export const GRANT_TTL_MS = 2 * 60 * 1000;
/** The per-account daily allowance (USER_DAILY_ASKS in src/budget.ts). */
export const DAILY_ASKS = 5;

// The same rule as the budget's `admit`.
const GITHUB_ID = /^(?:0|[1-9][0-9]*)$/;
const PORT = /^[1-9][0-9]{0,4}$/;
const TOKEN = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const ASKS_USAGE = [
  'usage:',
  '  asks.mjs show <staging|production> --github-id <N>    the account\'s Ask count for today (UTC)',
  '  asks.mjs reset <staging|production> --github-id <N>   give the account its five Asks for today back',
  '  asks.mjs <show|reset> local --github-id <N> [--port <P>]',
  `                                                        the same against \`wrangler dev\` (default port ${DEFAULT_LOCAL_PORT})`,
].join('\n');

/**
 * @param {string[]} argv  arguments after the script name
 * @returns {{ command: 'show' | 'reset', env: string, githubId: string, port?: number } | { error: string }}
 */
export function parseAsksArgs(argv) {
  const [command, env, ...rest] = argv;
  if (command !== 'show' && command !== 'reset') return { error: ASKS_USAGE };
  if (!ASK_TARGETS.includes(env ?? '')) return { error: `unknown environment ${JSON.stringify(env ?? '')}\n${ASKS_USAGE}` };
  if (rest.length % 2 !== 0) return { error: ASKS_USAGE };
  const flags = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if ((flag !== '--github-id' && flag !== '--port') || flags.has(flag)) return { error: ASKS_USAGE };
    flags.set(flag, rest[index + 1]);
  }
  const githubId = flags.get('--github-id');
  if (githubId === undefined) return { error: ASKS_USAGE };
  if (!GITHUB_ID.test(githubId) || !Number.isSafeInteger(Number(githubId))) return { error: 'the GitHub id must be a non-negative integer' };
  if (env !== 'local') return flags.has('--port') ? { error: `--port is for the local target only\n${ASKS_USAGE}` } : { command, env, githubId };
  const port = flags.get('--port') ?? String(DEFAULT_LOCAL_PORT);
  if (!PORT.test(port) || Number(port) > 65535) return { error: 'the port must be between 1 and 65535' };
  return { command, env, githubId, port: Number(port) };
}

/**
 * Where the request goes: one of the two fixed sites, or the loopback `wrangler dev`.
 * @param {string} env
 * @param {number} [port]
 */
export function operatorOrigin(env, port = DEFAULT_LOCAL_PORT) {
  if (env === 'local') {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
    return `http://127.0.0.1:${port}`;
  }
  if (!Object.hasOwn(ASK_ORIGINS, env)) throw new Error('unknown environment');
  return ASK_ORIGINS[env];
}

/** 32 random bytes, hex. */
export function newGrantToken() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** @param {string} text */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The INSERT for one grant. Every value is checked against its exact shape before it is quoted; the token itself
 * never appears, only its hash.
 * @param {{ tokenHash: string, action: string, accountId: string, createdAt: string, expiresAt: string }} grant
 */
export function grantSql({ tokenHash, action, accountId, createdAt, expiresAt }) {
  if (!TOKEN.test(tokenHash)) throw new Error('invalid token hash');
  if (!Object.values(ASK_ACTIONS).includes(action)) throw new Error('invalid action');
  if (typeof accountId !== 'string' || !GITHUB_ID.test(accountId) || !Number.isSafeInteger(Number(accountId))) throw new Error('invalid GitHub id');
  if (!ISO.test(createdAt) || !ISO.test(expiresAt)) throw new Error('invalid timestamp');
  return `INSERT INTO operator_grants (token_hash, action, account_id, expires_at, created_at) VALUES ('${tokenHash}', '${action}', '${accountId}', '${expiresAt}', '${createdAt}');`;
}

/**
 * `pnpm` arguments that run one statement on USERS_DB: the deployed database for staging/production, the on-disk
 * one `wrangler dev` uses for local. No shell: the statement is one argv entry.
 * @param {string} env
 * @param {string} sql
 */
export function wranglerD1Args(env, sql) {
  if (!ASK_TARGETS.includes(env)) throw new Error('unknown environment');
  const where = env === 'local' ? ['--env=', '--local'] : ['--env', env, '--remote'];
  return ['exec', 'wrangler', 'd1', 'execute', 'USERS_DB', ...where, '--json', '--command', sql];
}

/**
 * The request's own headers and body (the caller adds the Access headers for staging).
 * @param {{ token: string, action: string, accountId: string }} request
 */
export function askUsageRequest({ token, action, accountId }) {
  if (!TOKEN.test(token)) throw new Error('invalid token');
  return { headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action, accountId }) };
}

const count = value => Number.isSafeInteger(value) && value >= 0;

/**
 * What the CLI prints for the Worker's answer. Built from the parsed numbers only, never from the raw response.
 * @param {{ command: 'show' | 'reset', env: string, githubId: string }} args
 * @param {number} status
 * @param {string} text  the response body
 * @returns {{ ok: true, lines: string[] } | { ok: false, message: string }}
 */
export function readAskUsageResult(args, status, text) {
  const again = `Run asks:${args.command} again for a fresh grant.`;
  if (status === 404) {
    return { ok: false, message: `${args.env} answered 404: the grant was not accepted (unknown, expired or already used), or this Worker does not have the operator route yet. ${again}` };
  }
  if (status === 503) return { ok: false, message: `${args.env} answered 503: the Ask budget is unavailable right now. Nothing was changed. ${again}` };
  let body;
  try { body = JSON.parse(text); } catch { body = undefined; }
  if (status !== 200 || !body || typeof body !== 'object') return { ok: false, message: `${args.env} answered ${status} with an unexpected body. ${again}` };
  if (body.result === 'unknown-account') return { ok: false, message: `no account with GitHub id ${args.githubId} on ${args.env}; nothing was changed` };
  const complete = body.result === 'ok' && body.action === ASK_ACTIONS[args.command] && body.accountId === args.githubId
    && typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
    && count(body.requests) && count(body.refunds) && count(body.openAdmissions)
    && (args.command === 'show' || count(body.requestsBefore));
  if (!complete) return { ok: false, message: `${args.env} answered 200 with an unexpected body. ${again}` };
  const lines = [`account ${args.githubId} on ${args.env}, UTC day ${body.day}`];
  if (args.command === 'reset') lines.push(`  reset: Asks counted ${body.requestsBefore} -> ${body.requests}`);
  lines.push(
    `  Asks counted today: ${body.requests} of ${DAILY_ASKS}`,
    `  Asks given back for unanswered replies: ${body.refunds}`,
    `  Asks in flight (admitted, not settled): ${body.openAdmissions}`,
  );
  return { ok: true, lines };
}
