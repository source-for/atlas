#!/usr/bin/env node
// Deploy the edge Worker to `staging` or `production` (CLA-266).
//
//   pnpm --filter @okie/edge deploy:staging
//   pnpm --filter @okie/edge deploy:production
//
// Credentials: `wrangler login` (OAuth). The account comes from `account_id` in wrangler.jsonc (or the
// OAuth session); nothing is read from .env. CLOUDFLARE_API_TOKEN is removed from wrangler's env when
// present, because a token overrides the OAuth login. The browse-only launch has no container, so no
// Docker is needed; it requires a built apps/web/dist (`pnpm build`). Pending USERS_DB (D1) migrations
// are applied to the target first; the deploy stops if that fails. Production refuses while the privacy
// copy has an unfilled placeholder (a `--dry-run` only warns).
//
// All of the logic is runDeploy in deployCore.mjs (tested with fakes in apps/edge/test/users.test.ts);
// this file only passes it the real process, filesystem and child_process.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runDeploy } from './deployCore.mjs';

process.exit(runDeploy({
  argv: process.argv,
  env: process.env,
  edgeDir: fileURLToPath(new URL('..', import.meta.url)),
  repoRoot: fileURLToPath(new URL('../../..', import.meta.url)),
  readFile: path => readFileSync(path, 'utf8'),
  exists: existsSync,
  spawn: spawnSync,
  sleep: milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds),
  log: message => console.log(message),
  error: message => console.error(message),
}));
