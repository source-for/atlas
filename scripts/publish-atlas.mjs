#!/usr/bin/env node
// CLA-266: publish one repository's CURRENT operator publication to the published-atlas R2 store.
//
//   pnpm publish:atlas --repo owner/name --env staging|production|local [--scan-root <dir>] [--dry-run [--out <dir>]]
//                      [--persist-to <dir>] [--license-override <SPDX id or expression>] [--yes]
//   pnpm publish:atlas --repo owner/name --env <env> --set-latest <versionId> [--out <dir>] [--persist-to <dir>] [--yes]
//   pnpm publish:atlas --env <env> --backfill-names [--dry-run [--out <dir>]] [--persist-to <dir>] [--backup <file>] [--yes]
//   pnpm publish:atlas --env <env> --backfill-meta [--dry-run [--out <dir>]] [--persist-to <dir>] [--backup <file>] [--yes]
//   pnpm publish:atlas --env <env> --backfill-cards [--dry-run [--out <dir>]] [--preview <dir>] [--persist-to <dir>] [--backup <file>] [--yes]
//
// Reads the operator store read-only (never takes its lock, never writes). Looks up the upstream licence (GitHub
// licence API at the pinned commit, unauthenticated), then uploads version files, gzip packs and source-paths.json,
// then manifest.json, then latest.json, then index.json (merged with the existing remote index). `--set-latest` is the
// rollback: it points latest.json + index.json at a version already in the store and uploads nothing else.
// `--backfill-names` (CLA-318, one-off) fills GitHub's owner/repo casing (`ownerLogin`/`repoName`) on index.json rows that
// lack it and rewrites index.json only (no new versions); `--dry-run` alone reads the env's index and reports, `--dry-run
// --out <dir>` runs against a directory store instead.
// `--backfill-meta` (CLA-269) looks up every index.json row on GitHub and fills or refreshes its description and language
// (and, from the same response, ownerLogin/repoName), with the same flags, dry-run modes and concurrency safety; it too
// rewrites index.json only. Before either backfill writes, the current index.json bytes are saved to a local file and read
// back (a mismatch aborts before the write): `--backup <file>` (relative to the directory you ran pnpm from), else
// `backfill-backup-<env>-<UTC timestamp>.json` in that directory, or beside the `--out` directory with `--dry-run --out`
// (never inside the store, never overwritten); the path is logged. A plain `--dry-run` reads through a read-only client.
// Both stop looking up at GitHub's first 403/429 or `x-ratelimit-remaining: 0` and write only what was resolved; after the
// write they read index.json back and warn if it is not what they wrote (a concurrent publish).
// CLA-319 share cards: a publish also renders the version's structure card (apps/web/src/atlasStructureCard.ts, bundled
// for Node with esbuild at startup) and uploads it as `versions/<v>/card-<renderer>.png` with the other version objects
// (not in manifest.json), only when GitHub's owner/repo casing was found (a card is permanent). A bundle failure, a
// failed pixel self-check (stale package build, locale), or a render failure only warns and the publish goes ahead
// without a card (`/og` then serves the generated card); for `--backfill-cards` the first two are fatal.
// `--backfill-cards` renders the card of every index.json row's version that has none for the current renderer, from the
// version's stored public snapshot.json/view.json (rows with GitHub's casing only: run --backfill-names first), and puts
// only those card keys (never overwrites a card on a completed version, never deletes, never
// touches index.json/latest.json/manifests); run it before deploying a Worker that reads a new renderer key. Same dry-run modes as the other backfills; every rendered PNG is also saved
// under `--preview <dir>` (default: a new temp directory, logged) to look at. Before its first write it saves index.json
// like the other backfills (a record of which versions were carded).
// Remote envs use the `wrangler login` OAuth session; the account is apps/edge/wrangler.jsonc `account_id`
// (CLOUDFLARE_ACCOUNT_ID overrides it when set);
// API tokens are stripped from the wrangler child. Prints keys and sizes only — never environment values.
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadStructureCardRenderer } from "./structure-card-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(repoRoot, "apps/server/dist");

function usage(message) {
  if (message) process.stderr.write(`publish:atlas: ${message}\n`);
  process.stderr.write("usage: pnpm publish:atlas --repo owner/name --env staging|production|local [--scan-root <dir>] [--dry-run [--out <dir>]] [--persist-to <dir>] [--license-override <SPDX id or expression>] [--yes]\n");
  process.stderr.write("       pnpm publish:atlas --repo owner/name --env staging|production|local --set-latest <versionId> [--dry-run --out <dir>] [--persist-to <dir>] [--yes]\n");
  process.stderr.write("       pnpm publish:atlas --env staging|production|local --backfill-names|--backfill-meta [--dry-run [--out <dir>]] [--persist-to <dir>] [--backup <file>] [--yes]\n");
  process.stderr.write("       pnpm publish:atlas --env staging|production|local --backfill-cards [--dry-run [--out <dir>]] [--preview <dir>] [--persist-to <dir>] [--backup <file>] [--yes]\n");
  process.exit(2);
}

let args;
try {
  args = parseArgs({
    options: {
      repo: { type: "string" },
      env: { type: "string" },
      "scan-root": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      out: { type: "string" },
      "persist-to": { type: "string" },
      "license-override": { type: "string" },
      "set-latest": { type: "string" },
      "backfill-names": { type: "boolean", default: false },
      "backfill-meta": { type: "boolean", default: false },
      "backfill-cards": { type: "boolean", default: false },
      preview: { type: "string" },
      backup: { type: "string" },
      yes: { type: "boolean", default: false },
    },
    strict: true,
  }).values;
} catch (error) {
  usage(error instanceof Error ? error.message : String(error));
}

if (!existsSync(join(dist, "publishAtlas.js"))) {
  process.stderr.write("publish:atlas: apps/server is not built. Run `pnpm --filter @okie/server build` first.\n");
  process.exit(1);
}
const publish = await import(pathToFileURL(join(dist, "publishAtlas.js")).href);

if ([args["backfill-names"], args["backfill-meta"], args["backfill-cards"]].filter(Boolean).length > 1) usage("pass one of --backfill-names, --backfill-meta and --backfill-cards (--backfill-meta also fills missing names)");
const backfill = args["backfill-meta"] ? "--backfill-meta" : args["backfill-names"] ? "--backfill-names" : args["backfill-cards"] ? "--backfill-cards" : undefined;
if (args.preview !== undefined && backfill !== "--backfill-cards") usage("--preview applies to --backfill-cards only");
if (backfill) {
  if (args.repo !== undefined || args["set-latest"] !== undefined || args["license-override"] !== undefined || args["scan-root"] !== undefined) usage(`${backfill} works on the whole index: no --repo, --set-latest, --license-override or --scan-root`);
  if (args.out !== undefined && !args["dry-run"]) usage(`${backfill} --out <dir> needs --dry-run (without it the backfill writes to the env's bucket, never to --out)`);
} else {
  if (!args.repo) usage("--repo owner/name is required");
  if (args.backup !== undefined) usage("--backup applies to --backfill-names / --backfill-meta / --backfill-cards only");
}
if (!publish.isPublishEnv(args.env)) usage("--env must be staging, production or local");
if (args.env === "production" && !args["dry-run"] && !args.yes) usage("production publishes (and --set-latest, --backfill-names, --backfill-meta, --backfill-cards) need an explicit --yes");
if (args["persist-to"] && args.env !== "local") usage("--persist-to only applies to --env local");
const rollback = args["set-latest"];
if (rollback !== undefined && args["license-override"] !== undefined) usage("--license-override does not apply to --set-latest");
if (rollback !== undefined && args["dry-run"] && !args.out) usage("--set-latest --dry-run needs --out <dir> (the directory store to roll back)");

// The repo-root .env (publish/wrangler credentials), loaded unconditionally as before CLA-606, which made the server's
// load opt-in. Never overrides variables already set; values stay in process.env and reach the wrangler child by name only.
if (existsSync(join(repoRoot, ".env"))) process.loadEnvFile(join(repoRoot, ".env"));

const scanRoot = resolve(args["scan-root"] ?? process.env.OKIE_SCAN_ROOT ?? join(repoRoot, "fixtures/scan"));
const log = line => process.stdout.write(`[publish:atlas] ${line}\n`);
const fail = error => {
  process.stderr.write(`publish:atlas: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
};
const mb = bytes => `${(bytes / 1e6).toFixed(1)} MB`;

/**
 * CLA-319: the structure card renderer (scripts/structure-card-bundle.mjs bundles apps/web/src/atlasStructureCard.ts),
 * after its pixel self-check: the reference card rendered here must match STRUCTURE_CARD_REFERENCE_SHA256, or cards
 * rendered now are not the `r<N>` cards and none may be stored. Returns `{ renderer }` or `{ problem }`; `strict`
 * (`--backfill-cards`) turns a problem into a failure, a publish goes ahead without a card.
 */
async function structureCardRenderer({ strict }) {
  let loaded;
  try {
    loaded = await loadStructureCardRenderer(repoRoot);
  } catch (error) {
    const problem = `could not bundle the structure card renderer (${error instanceof Error ? error.message : String(error)}); run pnpm install and \`pnpm --filter './packages/*' build\``;
    if (strict) fail(new Error(problem));
    return { problem };
  }
  const check = loaded.selfCheck();
  if (!check.ok) {
    const problem = `the structure card self-check failed: the reference card renders sha256 ${check.sha256}, not ${check.expected} (renderer ${check.version}). `
      + "Likely a stale workspace build (rebuild: `pnpm --filter './packages/*' build`), an uncommitted renderer change without a STRUCTURE_CARD_RENDERER_VERSION bump, or a runtime/locale difference (run under the repo's Node 22 with the default locale)";
    if (strict) fail(new Error(problem));
    return { problem };
  }
  log(`structure card renderer ${loaded.version} (self-check ok)`);
  return { renderer: { version: loaded.version, render: loaded.render } };
}

function storeClient({ readEnvOnDryRun = false } = {}) {
  if (args["dry-run"] && (args.out || !readEnvOnDryRun)) {
    const out = resolve(args.out ?? mkdtempSync(join(tmpdir(), "okie-publish-dry-")));
    log(`dry run: objects under ${out}`);
    return publish.createDirectoryStoreClient(out);
  }
  let childEnv;
  try {
    const result = publish.wranglerChildEnv(args.env);
    childEnv = result.env;
    if (result.ignored.length) log(`ignoring ${result.ignored.join(", ")} from the environment/.env: wrangler uses your \`wrangler login\` session`);
  } catch (error) { fail(error); }
  return publish.createWranglerStoreClient({
    env: args.env,
    ...(args["persist-to"] ? { persistTo: args["persist-to"] } : {}),
    run: publish.pnpmWranglerRunner(repoRoot),
    childEnv,
  });
}

if (backfill) {
  // A plain --dry-run reads the env's index.json (read-only) and writes nothing; --dry-run --out uses that directory store.
  const write = !args["dry-run"] || Boolean(args.out);
  const mode = args["dry-run"] ? (args.out ? "dry run, directory store" : "dry run, read only") : args.env;
  // Backups resolve against the directory pnpm was run from (INIT_CWD), not the repo root the script runs in.
  const backup = publish.fileIndexBackup({
    env: args.env,
    base: process.env.INIT_CWD ?? process.cwd(),
    ...(args.backup !== undefined ? { backup: args.backup } : {}),
    ...(args.out !== undefined ? { out: resolve(args.out) } : {}),
  });
  const client = storeClient({ readEnvOnDryRun: true });
  const input = { client: write ? client : publish.readOnlyStoreClient(client), write, backup, log: line => log(`  ${line}`) };
  const warnUnverified = result => {
    if (!result.wrote || result.verified) return;
    process.stderr.write(`publish:atlas: WARNING: index.json changed under this backfill (a concurrent publish may have been overwritten). Check it now; the previous index.json is ${result.backupPath ? `saved at ${result.backupPath}` : "not backed up"}.\n`);
  };
  try {
    if (backfill === "--backfill-cards") {
      const { renderer: structureCard } = await structureCardRenderer({ strict: true });
      const previewDir = resolve(process.env.INIT_CWD ?? process.cwd(), args.preview ?? mkdtempSync(join(tmpdir(), "okie-card-preview-")));
      log(`backfill share cards card-${structureCard.version}.png (bucket ${publish.PUBLISH_BUCKETS[args.env]}, ${mode}); previews under ${previewDir}`);
      const result = await publish.backfillPublishedCards({ ...input, structureCard, previewDir });
      log(`done: ${result.rendered} rendered, ${result.written} written, ${result.skippedExisting} already had a card (kept), ${result.failed} failed${result.backupPath ? `; index.json saved to ${result.backupPath}` : ""}; previews under ${previewDir}`);
      if (result.failed > 0) process.exitCode = 1;
    } else if (backfill === "--backfill-meta") {
      log(`backfill GitHub description/language (and names) in index.json (bucket ${publish.PUBLISH_BUCKETS[args.env]}, ${mode})`);
      const result = await publish.backfillPublishedMeta(input);
      log(`done: ${result.updated} updated, ${result.upToDate} up to date, ${result.failed} unchanged after a failed lookup, ${result.skipped} skipped, ${result.notReached} not reached (rate limit); index.json ${result.wrote ? "rewritten" : "not written"}${result.backupPath ? `; previous index.json saved to ${result.backupPath}` : ""}`);
      warnUnverified(result);
    } else {
      log(`backfill GitHub names in index.json (bucket ${publish.PUBLISH_BUCKETS[args.env]}, ${mode})`);
      const result = await publish.backfillPublishedNames(input);
      log(`done: ${result.filled} filled, ${result.alreadySet} already set, ${result.failed} unchanged after a failed lookup, ${result.notReached} not reached (rate limit); index.json ${result.wrote ? "rewritten" : "not written"}${result.backupPath ? `; previous index.json saved to ${result.backupPath}` : ""}`);
      warnUnverified(result);
    }
  } catch (error) { fail(error); }
  process.exit(process.exitCode ?? 0);
}

if (rollback !== undefined) {
  log(`${args.repo}: set latest → ${rollback} (bucket ${publish.PUBLISH_BUCKETS[args.env]}, ${args["dry-run"] ? "dry run" : args.env})`);
  try {
    const result = await publish.setPublishedLatest({ repo: args.repo, versionId: rollback, client: storeClient(), log });
    log(`done: ${result.slug} now points at ${result.versionId}; ${result.objects.length} objects written`);
  } catch (error) { fail(error); }
  process.exit(0);
}

// A renderer problem never blocks a publish: it goes ahead without a share card (/og serves the generated one).
const { renderer: structureCard, problem: cardProblem } = await structureCardRenderer({ strict: false });
if (cardProblem) log(`WARNING: ${cardProblem}; publishing without a share card (--backfill-cards can add it later)`);
let built;
try {
  built = await publish.preparePublishedVersion({ scanRoot, repo: args.repo, log, ...(structureCard ? { structureCard } : {}), ...(args["license-override"] !== undefined ? { licenseOverride: args["license-override"] } : {}) });
} catch (error) { fail(error); }
const { stats } = built;
log(`${args.repo} → ${built.slug}@${built.versionId} (bucket ${publish.PUBLISH_BUCKETS[args.env]}, ${args["dry-run"] ? "dry run" : args.env})`);
log(`licence ${built.manifest.license.spdxId}${built.manifest.license.url ? ` (${built.manifest.license.url})` : " (operator override)"}`);
log(built.githubNames?.ok ? `GitHub names ${built.githubNames.ownerLogin}/${built.githubNames.repoName}` : `GitHub names not recorded (${built.githubNames?.reason ?? "no lookup"}); the index row keeps the stored owner/repo`);
log(built.card && "key" in built.card ? `share card ${built.card.key} (${built.card.bytes.byteLength} bytes)` : `no share card (${built.card?.error ?? (cardProblem ? "renderer unavailable" : "not rendered")}); /og serves the generated card`);
log(`built in ${Math.round(stats.buildMs)} ms (packs ${Math.round(stats.packMs)} ms)`);
log(`  neighborhood pack: ${stats.neighborhoodEntries} entries, ${mb(stats.neighborhoodRawBytes)} raw → ${mb(stats.neighborhoodPackBytes)} gzip`);
log(`  excerpt pack: ${stats.excerptEntries} entries, ${mb(stats.excerptRawBytes)} raw → ${mb(stats.excerptPackBytes)} gzip`);
for (const object of built.objects) log(`  ${object.key} ${object.bytes.byteLength} bytes`);

try {
  const result = await publish.publishBuiltVersion(built, storeClient(), log);
  const total = result.objects.reduce((sum, object) => sum + object.bytes, 0);
  log(`done: version ${result.version}; ${result.objects.length} objects written (${total} bytes)`);
} catch (error) { fail(error); }
