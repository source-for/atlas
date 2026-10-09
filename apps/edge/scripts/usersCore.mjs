// Operator helpers for the USERS_DB accounts table (CLA-316). Pure (no Node imports) so the edge tests
// run them in workerd; scripts/users.mjs is the CLI that runs the SQL through wrangler.
//
// Inputs are validated before they reach SQL: a GitHub id must be a plain non-negative integer and an
// email must match a strict pattern (no quotes, spaces or semicolons); the email is still SQL-escaped.

export const ENVIRONMENTS = ['staging', 'production'];

export const EXPORT_COLUMNS = [
  'github_id',
  'github_login',
  'email',
  'email_verified',
  'created_at',
  'last_sign_in_at',
  'privacy_version',
  'product_updates_opt_in',
  'product_updates_changed_at',
];

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,63}$/;
const GITHUB_ID = /^(0|[1-9]\d{0,15})$/;

export const USAGE = [
  'usage:',
  '  users.mjs export <staging|production> [--opted-in]      CSV of accounts on stdout',
  '  users.mjs delete <staging|production> --github-id <N>   delete one account',
  '  users.mjs delete <staging|production> --email <address> delete the account(s) with that email',
].join('\n');

/**
 * @param {string[]} argv  arguments after the script name
 * @returns {{ command: 'export', env: string, optedIn: boolean }
 *   | { command: 'delete', env: string, githubId: number }
 *   | { command: 'delete', env: string, email: string }
 *   | { error: string }}
 */
export function parseUsersArgs(argv) {
  const [command, env, ...rest] = argv;
  if (command !== 'export' && command !== 'delete') return { error: USAGE };
  if (!ENVIRONMENTS.includes(env ?? '')) return { error: `unknown environment ${JSON.stringify(env ?? '')}\n${USAGE}` };
  if (command === 'export') {
    if (rest.length === 0) return { command, env, optedIn: false };
    if (rest.length === 1 && rest[0] === '--opted-in') return { command, env, optedIn: true };
    return { error: USAGE };
  }
  if (rest.length !== 2) return { error: USAGE };
  const [flag, value] = rest;
  if (flag === '--github-id') {
    if (!GITHUB_ID.test(value) || !Number.isSafeInteger(Number(value))) return { error: 'the GitHub id must be a non-negative integer' };
    return { command, env, githubId: Number(value) };
  }
  if (flag === '--email') {
    if (!EMAIL.test(value)) return { error: 'that does not look like an email address' };
    return { command, env, email: value };
  }
  return { error: USAGE };
}

/** A SQL string literal ('' doubles a quote). */
export function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** @param {boolean} optedIn  only rows that opted in to product updates and have an email */
export function exportSql(optedIn) {
  const where = optedIn ? ' WHERE product_updates_opt_in = 1 AND email IS NOT NULL' : '';
  return `SELECT ${EXPORT_COLUMNS.join(', ')} FROM users${where} ORDER BY github_id;`;
}

/**
 * The account's scan requests (CLA-455) go first, in the same `wrangler d1 execute` call, as the account
 * page's delete does; only the users DELETE returns rows, so the count is still accounts.
 * @param {string} where  a validated users WHERE clause
 */
function withScanRequests(where) {
  return `DELETE FROM scan_requests WHERE github_id IN (SELECT github_id FROM users WHERE ${where}); DELETE FROM users WHERE ${where} RETURNING github_id;`;
}

/** @param {{ githubId: number } | { email: string }} target */
export function deleteSql(target) {
  if ('githubId' in target) {
    if (!Number.isSafeInteger(target.githubId) || target.githubId < 0) throw new Error('invalid GitHub id');
    return withScanRequests(`github_id = ${target.githubId}`);
  }
  if (!EMAIL.test(target.email)) throw new Error('invalid email');
  return withScanRequests(`lower(email) = lower(${sqlString(target.email)})`);
}

/**
 * The result rows of `wrangler d1 execute --json` (an array with one entry per statement).
 * @param {string} stdout
 * @returns {Array<Record<string, unknown>>}
 */
export function wranglerRows(stdout) {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error('wrangler did not print JSON');
  const parsed = JSON.parse(stdout.slice(start));
  if (!Array.isArray(parsed)) throw new Error('unexpected wrangler JSON');
  const rows = [];
  for (const statement of parsed) {
    if (statement && statement.success === false) throw new Error('the D1 statement failed');
    if (statement && Array.isArray(statement.results)) rows.push(...statement.results);
  }
  return rows;
}

/**
 * What users.mjs prints when a DELETE ran but its output could not be read: the rows may be gone, and
 * wrangler's raw output (query results only, no credentials) shows what happened.
 * @param {string} stdout
 */
export function deleteOutputUnreadableMessage(stdout) {
  return `the DELETE may still have run: rows may have been deleted. wrangler printed:\n${stdout}`;
}

/** One CSV field: quoted when needed; a leading = + - @ tab or CR is prefixed with ' (spreadsheet formula injection). */
export function csvField(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} [columns]
 */
export function toCsv(rows, columns = EXPORT_COLUMNS) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map(column => csvField(row[column])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}
