#!/usr/bin/env node
// Operator access to the accounts table (CLA-316), through `wrangler d1 execute --remote`.
//
//   pnpm --silent --filter @okie/edge users:export production [--opted-in] > users.csv
//   pnpm --silent --filter @okie/edge users:delete production --github-id 123
//   pnpm --silent --filter @okie/edge users:delete production --email someone@example.com
//   pnpm --silent --filter @okie/edge requests:export production [--all] > requests.csv
//   pnpm --silent --filter @okie/edge requests:status production --id 7 --status published
//
// Credentials: `wrangler login` (OAuth), like deploy.mjs: CLOUDFLARE_API_TOKEN is removed from wrangler's
// env. The CSV goes to stdout, everything else to stderr (use `pnpm --silent` so pnpm's banner stays out).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deleteOutputUnreadableMessage, deleteSql, exportSql, parseUsersArgs, REQUEST_COLUMNS, requestStatusSql, requestsSql, toCsv, wranglerRows } from './usersCore.mjs';

const API_TOKEN = 'CLOUDFLARE_API_TOKEN';
const args = parseUsersArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(args.error);
  process.exit(2);
}

const env = { ...process.env };
if (env[API_TOKEN]) {
  delete env[API_TOKEN];
  console.error(`note: ignoring ${API_TOKEN} so wrangler uses your \`wrangler login\` session`);
}

const sql = args.command === 'export' ? exportSql(args.optedIn)
  : args.command === 'requests' ? requestsSql(args.all)
    : args.command === 'request-status' ? requestStatusSql(args.id, args.status, new Date().toISOString())
      : deleteSql('githubId' in args ? { githubId: args.githubId } : { email: args.email });
// No shell: the statement is one argv entry.
const result = spawnSync('pnpm', ['exec', 'wrangler', 'd1', 'execute', 'USERS_DB', '--env', args.env, '--remote', '--json', '--command', sql], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 256 * 1024 * 1024,
});
if (result.status !== 0) {
  console.error(`wrangler d1 execute failed (exit ${result.status ?? 'signal'})`);
  process.exit(result.status ?? 1);
}
let rows;
try {
  rows = wranglerRows(result.stdout);
} catch (error) {
  console.error(`could not read wrangler's output: ${error instanceof Error ? error.message : String(error)}`);
  if (args.command === 'delete') {
    // wrangler's output holds query results only (no credentials): show it so the operator can see what happened.
    console.error(deleteOutputUnreadableMessage(result.stdout));
  }
  process.exit(1);
}
if (args.command === 'export') {
  process.stdout.write(toCsv(rows));
  console.error(`${rows.length} account(s) exported from ${args.env}${args.optedIn ? ' (opted in to product updates)' : ''}`);
} else if (args.command === 'requests') {
  process.stdout.write(toCsv(rows, REQUEST_COLUMNS));
  console.error(`${rows.length} ${args.all ? '' : 'open '}scan request(s) exported from ${args.env}`);
} else if (args.command === 'request-status') {
  const [row] = rows;
  console.log(row ? `scan request ${row.id} (${row.owner}/${row.repo}) is now ${row.status} on ${args.env}` : `no scan request ${args.id} on ${args.env}`);
  if (!row) process.exit(1);
} else {
  console.log(`deleted ${rows.length} account(s) from ${args.env}`);
}
