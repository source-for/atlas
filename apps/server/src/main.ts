import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MAX_TARBALL_BYTES } from "@okie/scan";
import { createGithubAuthService } from "./githubOAuth.js";
import { createGlobalEnrichmentSpend, resolveGlobalEnrichmentCap } from "./globalSpend.js";
import { createScanJobQueue, createSubmitLimiter } from "./jobs.js";
import { resolveListenHost } from "./localDefaults.js";
import {
  describeLlmStartup,
  createLlmGatewayClient,
  ignoredGenericLlmEnvNotice,
  llmProviderArg,
  loadOperatorDotenv,
  resolveLlmGatewayConfig,
  resolveLlmGatewayLocalConfig,
  resolveOperatorEnrichmentBudget,
} from "./llmGateway.js";
import { createScanHttpServer, resolveServerMode } from "./scanServer.js";
import { createPublicReadonlyRuntime } from "./publicReadonly.js";
import { resolveTrustedProxy } from "./clientAddress.js";
import { createScanJobRunner } from "./scanService.js";
import { resolveOperatorGithubIds } from "./operatorAccess.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { killScanChildren } from "./scanWorker.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import { createBlockPlanReplayStore, createBlockPlanService, publicationBlockPlanSource, resolveBlockPlannerConfig } from "./blockPlans.js";
import { createJevProvider } from "./operatorJudgments.js";
import { createIncrementalAutomation, resolveIncrementalTriggerConfig } from "./operatorIncrementalTriggers.js";
import type { OperatorWorkflowJob } from "./operatorWorkflow.js";

/**
 * Paste-a-repo scan process used by the hosted public atlas (CLA-30):
 *
 *   GET  /api/auth/github          start GitHub OAuth (CSRF state cookie)
 *   GET  /api/auth/github/callback OAuth callback (state must match)
 *   GET  /api/auth/me              public identity, never a token
 *   POST /api/scans {url}          GitHub session required → enqueue a worker job
 *   GET  /api/scans/:id            job status with stage + enrichment progress
 *   GET  /api/scans                recent jobs (dev visibility)
 *   GET  /api/ask                  { connected } — gateway key present, never the key
 *   GET  /api/ask/thread           GitHub session required — that user's turns for owner/repo@sha
 *   POST /api/ask                  GitHub session required → one-shot Q&A; persist thread
 *   POST /api/block-plan           CLA-149 Jev Overview block order (off unless OKIE_JEV_BLOCK_PLANNER=on)
 *   GET  /scan/*                   published trio objects, neighborhood packets, excerpts, index.json
 *
 * Public atlas *views* are the web app's `/r/<owner>/<repo>` URLs (no login wall).
 * Docs-site oEmbed (`GET /oembed?url=`) is served by the web origin, not here.
 * Vite proxies /api and /scan here during `pnpm dev`. This process binds loopback
 * by default (CLA-17). Hosted scan requires GitHub sign-in (or a loopback test
 * double). GitHub reads are HTTPS Bearer (OAuth) or HTTPS-only (test-double) —
 * never operator `gh` (CLA-18/30). State on disk (the scan root) is the durable
 * output; job rows are ephemeral progress.
 *
 * CLA-266: OKIE_SERVER_MODE=public-readonly is the container behind the edge Worker (see publicReadonly.ts): only
 * Ask, the block planner, GET /scan/* and /healthz, over published atlases mirrored from OKIE_PUBLISHED_STORE_URL.
 *
 * CLA-606: LLM egress is opt-in. `--llm-provider <openrouter|openai-compatible|anthropic|off>` (or
 * OKIE_LLM_PROVIDER) plus OKIE_LLM_API_KEY; generic provider keys are ignored. Repo-root `.env` is loaded
 * only with `--dotenv` (or OKIE_DOTENV=1).
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../../..");
const argv = process.argv.slice(2);
const dotenvLoaded = loadOperatorDotenv(repoRoot, argv);
const mode = resolveServerMode();
const port = Number.parseInt(process.env.OKIE_SERVER_PORT ?? "4180", 10);
const bind = resolveListenHost();

const log = (line: string): void => {
  process.stdout.write(`[okie-server] ${line}\n`);
};

// A misconfigured provider stops the server here, before it listens.
let llmLocal: ReturnType<typeof resolveLlmGatewayLocalConfig>;
let llm: ReturnType<typeof resolveLlmGatewayConfig>;
try {
  llmLocal = resolveLlmGatewayLocalConfig(repoRoot);
  llm = resolveLlmGatewayConfig(process.env, llmLocal, llmProviderArg(argv));
} catch (error) {
  process.stderr.write(`[okie-server] LLM configuration error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

/** The LLM state, once per start in both modes: the ignored-names notice (only when one is set), .env hint, one state line. */
function logLlmStartup(line: string): void {
  const notice = ignoredGenericLlmEnvNotice(process.env);
  if (notice) log(notice);
  if (!dotenvLoaded && existsSync(join(repoRoot, ".env"))) log("repo-root .env not loaded (pass --dotenv or set OKIE_DOTENV=1 to load it)");
  log(line);
}

if (mode === "public-readonly") startPublicReadonly(); else startDefault();

function startPublicReadonly(): void {
  const runtime = createPublicReadonlyRuntime({ env: process.env, llm, bind, log });
  runtime.server.listen(port, bind, () => {
    log(`listening on http://${bind}:${port} (public-readonly; trusted proxy ${resolveTrustedProxy() ?? "none"})`);
    log(`published store: ${runtime.mirror ? "mirrored" : "none (OKIE_PUBLISHED_STORE_URL unset)"}`);
    logLlmStartup(describeLlmStartup(llm, { serverMode: "public-readonly" }));
  });
  if (runtime.mirror) {
    const mirror = runtime.mirror;
    void mirror.sync().then(() => { log(`published mirror ready: ${mirror.stats().slugs.length} atlas(es)`); mirror.start(); });
  }
}

function startDefault(): void {
  const scanRoot = process.env.OKIE_SCAN_ROOT
    ? resolve(process.env.OKIE_SCAN_ROOT)
    : join(repoRoot, "fixtures/scan");
  const enrich = process.env.OKIE_SCAN_ENRICH === "0"
    ? "off"
    : process.env.OKIE_SCAN_ENRICH === "1"
      ? "force"
      : "auto";

  const auth = createGithubAuthService({ env: process.env, bind });
  const globalSpend = createGlobalEnrichmentSpend(resolveGlobalEnrichmentCap());
  const queue = createScanJobQueue(createScanJobRunner({
    scanRoot,
    enrich,
    llmLocal,
    llm,
    maxTarballBytes: DEFAULT_MAX_TARBALL_BYTES,
    globalSpend,
    log,
  }));
  const allowSubmit = createSubmitLimiter();
  const operatorStore = new OperatorStore(scanRoot);
  const operatorPublication = new OperatorPublicationService(operatorStore, scanRoot);
  const operatorGlobalBudget = createOperatorBudgetLedger({
    maxRequests: Number.MAX_SAFE_INTEGER,
    maxTokens: globalSpend.cap.maxTokens ?? Number.MAX_SAFE_INTEGER,
    maxDollars: globalSpend.cap.maxDollars ?? Number.MAX_SAFE_INTEGER,
  }, { store: operatorStore, runId: "global-operator-enrichment" });
  const operatorGateway = createLlmGatewayClient(llm, { timeoutMs: resolveOperatorEnrichmentBudget().requestTimeoutMs });
  // Raw gateway + global ledger: the runner reserves global then per-run budget before
  // an attempt row exists, and wraps only the raw client in the 429 limiter.
  const operatorRunner = createOperatorRunner({
    store: operatorStore, publication: operatorPublication, gatewayConfig: llm, globalLedger: operatorGlobalBudget,
    ...(operatorGateway ? { gateway: operatorGateway } : {}),
  });

  const operatorEnqueue = (input: OperatorWorkflowJob): void => {
    operatorStore.updateRun(input.runId, { state: "queued" });
    void Promise.resolve().then(() => operatorRunner.enqueue(input)).catch(() => {
      operatorStore.updateRun(input.runId, { state: "failed", error: "Operator job failed; review the recorded attempts." });
    });
  };
  // CLA-271 incremental re-scans: cron (OKIE_INCREMENTAL_CRON_TOKEN) and GitHub push webhook (OKIE_GITHUB_WEBHOOK_SECRET)
  // are off unless configured; the operator "Update to latest commit" route is always available to operators.
  const incrementalAutomation = createIncrementalAutomation({ config: resolveIncrementalTriggerConfig(process.env), store: operatorStore, publications: operatorPublication, enqueue: operatorEnqueue });

  // CLA-149 Jev block planner: off unless OKIE_JEV_BLOCK_PLANNER=on. CLA-304: signed-in callers only, and every Jev
  // request is admitted by the planner's OWN durable ledger (OKIE_JEV_PLANNER_MAX_*, run id `jev-block-planner` in the
  // operator store, so a restart never resets it). It never touches the operator global ledger: a public caller cannot
  // drain operator enrichment budget.
  const blockPlannerConfig = resolveBlockPlannerConfig();
  const blockPlans = createBlockPlanService({
    config: blockPlannerConfig,
    provider: blockPlannerConfig.enabled ? createJevProvider() : undefined,
    source: publicationBlockPlanSource(operatorPublication, operatorStore),
    plannerLedger: createOperatorBudgetLedger({
      maxRequests: blockPlannerConfig.maxRequests,
      maxTokens: Number.MAX_SAFE_INTEGER,
      maxDollars: blockPlannerConfig.maxDollars,
    }, { store: operatorStore, runId: "jev-block-planner" }),
    replay: createBlockPlanReplayStore(join(scanRoot, "block-plans")),
    log,
  });

  const server = createScanHttpServer({
    blockPlans,
    queue,
    allowSubmit,
    auth,
    scanRoot,
    llm,
    enrich,
    bind,
    operator: {
      auth,
      allowedGithubIds: resolveOperatorGithubIds(process.env),
      publicOrigin: process.env.OKIE_PUBLIC_ORIGIN ?? "http://localhost:4173",
      store: operatorStore,
      publications: operatorPublication,
      ...(globalSpend.cap.maxDollars !== undefined || globalSpend.cap.maxTokens !== undefined ? { globalBudget: { ...(globalSpend.cap.maxDollars !== undefined ? { maxDollars: globalSpend.cap.maxDollars } : {}), ...(globalSpend.cap.maxTokens !== undefined ? { maxTokens: globalSpend.cap.maxTokens } : {}), ledger: operatorGlobalBudget } } : {}),
      enqueue: operatorEnqueue,
      incremental: incrementalAutomation,
    },
    trustedProxy: resolveTrustedProxy(),
  });

  server.listen(port, bind, () => {
    const authMode = auth.config.oauthConfigured
      ? "GitHub OAuth"
      : auth.config.testDouble
        ? "loopback GitHub test-double"
        : "GitHub OAuth unconfigured";
    log(`listening on http://${bind}:${port} (loopback default; ${authMode}; no operator gh)`);
    log(`scan root: ${scanRoot}`);
    logLlmStartup(describeLlmStartup(llm, { serverMode: "default", scanEnrich: enrich }));
    log(`incremental: cron ${incrementalAutomation.config.cronToken ? "on" : "off"}, webhook ${incrementalAutomation.config.webhookSecret ? "on" : "off"}, auto-publish ${incrementalAutomation.config.autoPublish ? "on" : "off"}`);
  });
}

// CLA-305: scan children run in their own process groups; never let one outlive the server. The scanWorker module
// also kills them on 'exit'; a signal would otherwise end the server without running exit handlers. After cleanup the
// handler is gone and the signal is re-raised, so the process still dies of it (default action, correct exit status).
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  const onSignal = () => { killScanChildren(); process.removeListener(signal, onSignal); process.kill(process.pid, signal); };
  process.once(signal, onSignal);
}
