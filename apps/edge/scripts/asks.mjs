#!/usr/bin/env node
// Operator view and reset of one account's daily Ask count (CLA-539).
//
//   pnpm --silent --filter @okie/edge asks:show production --github-id 123
//   pnpm --silent --filter @okie/edge asks:reset production --github-id 123
//   pnpm --silent --filter @okie/edge asks:show local --github-id 0 [--port 4196]   # against `wrangler dev`
//
// The count lives in the budget Durable Object, out of wrangler's reach, so this runs in two steps:
//   1. write a one-time grant (the SHA-256 of a fresh random token, the action, the account, an expiry two
//      minutes ahead) into USERS_DB through `wrangler d1 execute`;
//   2. POST the token to <origin>/api/operator/ask-usage, which deletes the grant as it accepts it.
//
// Credentials: `wrangler login` (OAuth), like users.mjs: CLOUDFLARE_API_TOKEN is removed from wrangler's env.
// Staging is behind Cloudflare Access: the request carries the `atlas-staging-smoke` service token from
// STAGING_ACCESS_CLIENT_ID / STAGING_ACCESS_CLIENT_SECRET (environment or the repo-root .env), as smoke.mjs does.
// The grant token goes to the one fixed origin only, redirects are never followed, and it is never printed.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ASK_ACTIONS, askUsageRequest, GRANT_TTL_MS, grantSql, newGrantToken, OPERATOR_ASK_USAGE_PATH, operatorOrigin, parseAsksArgs, readAskUsageResult, sha256Hex, wranglerD1Args } from './asksCore.mjs';
import { accessHeaders, redactHeaderValues, smokeRequester } from './smokeAccess.mjs';
import { wranglerRows } from './usersCore.mjs';

const API_TOKEN = 'CLOUDFLARE_API_TOKEN';
const args = parseAsksArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(args.error);
  process.exit(2);
}

let access = { headers: {} };
if (args.env === 'staging') {
  const dotenv = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(dotenv)) process.loadEnvFile(dotenv); // never overrides variables already set
  access = accessHeaders('staging', process.env);
  if (access.error) {
    console.error(`asks: ${access.error}`);
    process.exit(1);
  }
}

const env = { ...process.env };
if (env[API_TOKEN]) {
  delete env[API_TOKEN];
  console.error(`note: ignoring ${API_TOKEN} so wrangler uses your \`wrangler login\` session`);
}

const token = newGrantToken();
const action = ASK_ACTIONS[args.command];
const now = Date.now();
const sql = grantSql({
  tokenHash: await sha256Hex(token),
  action,
  accountId: args.githubId,
  createdAt: new Date(now).toISOString(),
  expiresAt: new Date(now + GRANT_TTL_MS).toISOString(),
});
// The statement holds the token's hash, never the token.
const result = spawnSync('pnpm', wranglerD1Args(args.env, sql), {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  env,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
  maxBuffer: 16 * 1024 * 1024,
});
if (result.status !== 0) {
  console.error(`wrangler d1 execute failed (exit ${result.status ?? 'signal'}); no request was sent`);
  process.exit(result.status ?? 1);
}
try {
  wranglerRows(result.stdout);
} catch (error) {
  console.error(`could not read wrangler's output (${error instanceof Error ? error.message : String(error)}); no request was sent`);
  process.exit(1);
}

const secrets = { ...access.headers, token };
const origin = operatorOrigin(args.env, args.port);
try {
  const send = smokeRequester({ origin, headers: access.headers });
  const response = await send(OPERATOR_ASK_USAGE_PATH, 'POST', askUsageRequest({ token, action, accountId: args.githubId }));
  const outcome = readAskUsageResult(args, response.status, await response.text());
  if (!outcome.ok) {
    console.error(redactHeaderValues(outcome.message, secrets));
    process.exit(1);
  }
  console.log(redactHeaderValues(outcome.lines.join('\n'), secrets));
} catch (error) {
  const hint = args.env === 'local' ? ' (is `wrangler dev` running there?)' : '';
  console.error(`asks: no answer from ${origin}${hint}: ${redactHeaderValues(error instanceof Error ? error.message : String(error), secrets)}`);
  process.exit(1);
}
