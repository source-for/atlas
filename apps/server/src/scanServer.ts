import { createSourceService, isSourceScanPath, SourceRequestError } from "./scanSource.js";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { HOSTED_SCAN_AUTH_ERROR, resolveScanGithubAccess, scanQuotaKey } from "./githubAccess.js";
import type { GithubAuthService } from "./githubOAuth.js";
import { LOGIN_PATH } from "./githubOAuth.js";
import { createSubmitLimiter, toPublicJob, type ScanJob, type ScanJobQueue } from "./jobs.js";
import { clientAddressKey, exemptFromIpWindow, type TrustedProxy } from "./clientAddress.js";
import { parseGithubSource } from "@okie/scan";
import { healthzBody, type EnrichMode } from "./localDefaults.js";
import { answerAskQuestion, askGatewayConnected, HOSTED_ASK_AUTH_ERROR, publicAskStatus } from "./ask.js";
import {
  ASK_THREAD_PATH,
  askAtlasIdentityFromSearch,
  createAskThreadStore,
  emptyPublicAskThread,
  persistAskTurn,
  publicAskThread,
  sanitizeAskAtlasIdentity,
  sanitizeCitationDetails,
  type AskThreadStore,
} from "./askThreads.js";
import { redactGatewayErrorText, redactGatewayText, type GatewayUsage, type LlmGatewayConfig } from "./llmGateway.js";
import { normalizeRepoInput } from "./repoUrl.js";
import {
  isExcerptScanPath,
  isNeighborhoodScanPath,
  serveExcerptPacket,
  serveNeighborhoodPacket,
} from "./scanNeighborhood.js";
import { resolvePublishedScanFile, resolvePublicationScanFile } from "./scanObjects.js";
import { handleOperatorApi, type OperatorApiOptions } from "./operatorApi.js";
import { automationBodyLimit, automationPreflight, handleIncrementalAutomation, INCREMENTAL_CRON_PATH, INCREMENTAL_WEBHOOK_PATH } from "./operatorIncrementalTriggers.js";
import { readArtifactScopes } from "./operatorWorkflow.js";
import { MAX_BLOCK_PLAN_REQUEST_BYTES, type BlockPlanService } from "./blockPlans.js";
import { createAskCorpusSource, sanitizeAskSlug, type AskCorpusLocation, type AskCorpusSource } from "./askRetrieval.js";
import { ASK_BUSY_ERROR, createAskRetrievalWorker, resolveAskWorkerEnv, type AskRetrievalWorker } from "./askWorker.js";
import type { OperatorPublicationService } from "./operatorPublication.js";
import type { OperatorStore } from "./operatorStore.js";

/**
 * CLA-266 server modes. `default`: the operator's machine (OAuth, operator workflow, scan submit, incremental
 * automation). `public-readonly`: the stateless container behind the edge Worker — anonymous Ask (no threads),
 * block plans and the `/scan/*` read surface over a mirrored published store; everything else is 404.
 */
export type ServerMode = "default" | "public-readonly";

/** OKIE_SERVER_MODE: unset/empty → `default`; an unknown value fails closed (throws) rather than guessing. */
export function resolveServerMode(env: NodeJS.Dict<string> = process.env): ServerMode {
  const raw = env.OKIE_SERVER_MODE?.trim() ?? "";
  if (raw === "" || raw === "default") return "default";
  if (raw === "public-readonly") return "public-readonly";
  throw new Error("OKIE_SERVER_MODE must be `default` or `public-readonly`");
}

/** The publication read side the `/scan/*`, Ask corpus and block-plan paths need (operator store or its mirror). */
export interface PublishedReadSource {
  publications: OperatorPublicationService;
  store: OperatorStore;
}

interface ScanHttpCommonOptions {
  scanRoot: string;
  llm: LlmGatewayConfig;
  enrich: EnrichMode;
  bind: string;
  threads?: AskThreadStore;
  sourceFetch?: typeof fetch;
  /** CLA-149 Jev block planner (`POST /api/block-plan`); absent → the route answers `unavailable`. */
  blockPlans?: BlockPlanService;
  /** CLA-265 whole-atlas Ask corpus locator; default locates published snapshots like `/scan/*` (stat only). */
  askCorpus?: AskCorpusSource;
  /** CLA-304 Ask retrieval worker (parses, indexes and searches off the request thread); default one persistent worker. */
  askRetrieval?: AskRetrievalWorker;
  /** Per-account Ask rate limit (CLA-265); default ASK_REQUESTS_PER_WINDOW per 10 minutes. */
  allowAsk?: (key: string) => boolean;
  /**
   * Per-IP Ask rate limit (CLA-304, socket address only, loopback exempt); default OKIE_ASK_PER_IP_WINDOW
   * (else ASK_REQUESTS_PER_IP_WINDOW) per 10 minutes.
   */
  allowAskIp?: (key: string) => boolean;
  /** CLA-266: trusted proxy for the client address (OKIE_TRUSTED_PROXY); default none (the socket address). */
  trustedProxy?: TrustedProxy | undefined;
}

export interface ScanHttpOptions extends ScanHttpCommonOptions {
  mode?: "default";
  queue: ScanJobQueue;
  allowSubmit: (key: string) => boolean;
  auth: GithubAuthService;
  operator?: OperatorApiOptions;
}

export interface PublicReadonlyHttpOptions extends ScanHttpCommonOptions {
  mode: "public-readonly";
  published: PublishedReadSource;
  /**
   * Published-mirror hook: materialise a slug (and a pinned version) before a read names it. Must never throw and
   * must never fall back to another version; a miss leaves the read to answer its normal closed 404.
   */
  ensurePublished?: (slug: string, versionId?: string, hint?: { commitSha?: string }) => Promise<void>;
}

/** Default POST /api/ask budget per signed-in account per 10 minutes. */
export const ASK_REQUESTS_PER_WINDOW = 30;
/** Default POST /api/ask budget per socket address per 10 minutes (checked before the body is read). */
export const ASK_REQUESTS_PER_IP_WINDOW = 60;

/** OKIE_ASK_PER_IP_WINDOW: Ask requests per non-loopback socket address per 10 minutes (default 60). */
export function resolveAskPerIpWindow(env: NodeJS.Dict<string> = process.env): number {
  const value = Number.parseInt(env.OKIE_ASK_PER_IP_WINDOW ?? "", 10);
  return Number.isSafeInteger(value) && value >= 1 ? value : ASK_REQUESTS_PER_IP_WINDOW;
}
/** Seconds a refused ("busy") Ask should wait before retrying. */
const ASK_BUSY_RETRY_AFTER_SECONDS = 5;
/** CLA-149 Jev block planner: public, bounded, off unless OKIE_JEV_BLOCK_PLANNER=on. */
export const BLOCK_PLAN_PATH = "/api/block-plan";

function sendJson(response: ServerResponse, status: number, body: unknown, pretty = true, headers: Record<string, string> = {}): void {
  const text = `${pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body)}\n`;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(text);
}

function operatorRepositoryForSlug(operator: PublishedReadSource | undefined, slug: string | undefined): string | undefined {
  return slug && operator ? operator.publications.repositoryIdForSlug(slug) : undefined;
}

async function readRawBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage, maxBytes = 16 * 1024): Promise<unknown> {
  return JSON.parse((await readRawBody(request, maxBytes)).toString("utf8")) as unknown;
}

/** Serves one published scan object; the scan root is the only readable tree. */
function serveScanObject(scanRoot: string, pathname: string, response: ServerResponse, operator?: PublishedReadSource, versionId?: string): void {
  const slug = pathname.split("/")[2];
  const repositoryId = operatorRepositoryForSlug(operator, slug);
  const target = operator ? resolvePublicationScanFile({ scanRoot, pathname, ...(repositoryId ? { repositoryId } : {}), ...(versionId ? { versionId } : {}), publications: operator.publications, store: operator.store }) : resolvePublishedScanFile(scanRoot, pathname);
  if (!target) {
    sendJson(response, 404, { error: "not found" });
    return;
  }
  if (pathname.endsWith("/operator-explanations.json") && operator && repositoryId) {
    const publication = operator.publications.currentPublication(repositoryId);
    const artifact = versionId ? operator.publications.artifactForVersion(repositoryId, versionId) : publication && operator.publications.artifactForVersion(repositoryId, publication.versionId);
    if (!artifact) { sendJson(response, 404, { error: "not found" }); return; }
    sendJson(response, 200, { versionId: versionId ?? publication?.versionId, explanations: readArtifactScopes(operator.store, artifact.artifactRevisionId) }, false);
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    // The per-slug layout is mutable (a rescan republishes in place), so scan
    // objects revalidate; the immutable sha-pinned layout is the hosted v-next.
    "cache-control": "no-cache",
  });
  createReadStream(target).pipe(response);
}

function askAuthDenied(): Record<string, unknown> {
  return {
    error: HOSTED_ASK_AUTH_ERROR,
    auth: { required: true, loginPath: LOGIN_PATH },
  };
}

export const HOSTED_BLOCK_PLAN_AUTH_ERROR = "Sign in with GitHub to get planned Overview block orders. The default order stays public.";

/** Cost headers the edge Worker settles its daily Ask dollar ledger from (public-readonly mode only). */
export const ASK_COST_HEADER = "x-okie-ask-cost-usd";
export const ASK_TOKENS_HEADER = "x-okie-ask-tokens";
/** CLA-472: set on a public-readonly Ask reply that has no answer and no reported model usage; the edge gives the
 * account's daily Ask back. */
export const ASK_OUTCOME_HEADER = "x-okie-ask-outcome";

function askUsageHeaders(usage: GatewayUsage | undefined): Record<string, string> {
  if (!usage) return {};
  return {
    ...(usage.costUsd !== undefined && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? { [ASK_COST_HEADER]: String(usage.costUsd) } : {}),
    ...(Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0 ? { [ASK_TOKENS_HEADER]: String(Math.round(usage.totalTokens)) } : {}),
  };
}

/** `/scan/<slug>/<file>` → slug (the scan-root slot `/scan/<file>` has none). */
function scanPathSlug(pathname: string): string | undefined {
  const parts = pathname.split("/");
  return parts.length === 4 && parts[1] === "scan" && parts[2] ? parts[2] : undefined;
}

/**
 * Default-mode-only routes, consulted before everything else: OAuth/session (`auth.handle`), CLA-271 incremental
 * automation, and the operator API. True when the request was answered.
 */
async function handleOperatorRoutes(options: ScanHttpOptions, request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
  const pathname = url.pathname;
  if (await options.auth.handle(request, response, url)) return true;

  if (options.operator && (pathname === INCREMENTAL_WEBHOOK_PATH || pathname === INCREMENTAL_CRON_PATH)) {
    // CLA-271: no session here; each route checks its own secret. Method, configuration, cron token and a declared
    // oversize are decided before the body is read (404 when unconfigured); the webhook signature is over the raw body.
    const preflight = automationPreflight(options.operator.incremental, request, pathname);
    if (preflight !== "read") { if (preflight) sendJson(response, preflight.status, preflight.body); return true; }
    let raw: Buffer;
    try { raw = await readRawBody(request, automationBodyLimit(pathname)); } catch { sendJson(response, 413, { error: "request body too large" }); return true; }
    const result = await handleIncrementalAutomation(options.operator.incremental, request, pathname, raw);
    if (result) { sendJson(response, result.status, result.body); return true; }
  }

  if (options.operator && pathname.startsWith("/api/operator")) {
    let body: unknown;
    if (request.method === "POST") { try { body = await readJsonBody(request); } catch { sendJson(response, 400, { error: "Expected JSON body" }); return true; } }
    const result = await handleOperatorApi(options.operator, request, pathname, body);
    if (result) {
      const bundle = typeof result.body === "object" && result.body !== null ? (result.body as { bundle?: unknown }).bundle : undefined;
      if (pathname.endsWith("/bundle") && typeof bundle === "string" && result.status === 200) { response.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(bundle); return true; }
      sendJson(response, result.status, result.body); return true;
    }
  }
  return false;
}

export type ScanHttpHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

export function createScanHttpHandler(options: ScanHttpOptions): ScanHttpHandler {
  return createHandler(options);
}

/** CLA-266 container surface: see `ServerMode`. */
export function createPublicReadonlyHttpHandler(options: PublicReadonlyHttpOptions): ScanHttpHandler {
  return createHandler(options);
}

function createHandler(options: ScanHttpOptions | PublicReadonlyHttpOptions): ScanHttpHandler {
  const { scanRoot, llm, enrich, bind, trustedProxy } = options;
  // Default mode keeps its full options; public-readonly has no auth, queue, operator API or automation.
  const full = options.mode === "public-readonly" ? undefined : options;
  const reader: PublishedReadSource | undefined = options.mode === "public-readonly" ? options.published : options.operator;
  const ensurePublished = options.mode === "public-readonly" ? options.ensurePublished : undefined;
  const ensure = async (slug: string | undefined, versionId?: string | null, commitSha?: string | null): Promise<void> => {
    if (!ensurePublished || !slug) return;
    try { await ensurePublished(slug, versionId ?? undefined, commitSha ? { commitSha } : undefined); } catch { /* a miss answers the read's closed 404 */ }
  };
  const clientKey = (request: IncomingMessage): string => clientAddressKey(request, trustedProxy);
  const sourceService = createSourceService(options.sourceFetch, reader ? input => {
    const operator = reader;
    const slug = input.pathname.split("/")[2];
    const repositoryId = operatorRepositoryForSlug(operator, slug);
    return repositoryId ? resolvePublicationScanFile({ ...input, repositoryId, publications: operator.publications, store: operator.store }) : undefined;
  } : undefined);
  const threads = options.threads ?? createAskThreadStore();
  const allowAsk = options.allowAsk ?? createSubmitLimiter(ASK_REQUESTS_PER_WINDOW);
  const allowAskIp = options.allowAskIp ?? createSubmitLimiter(resolveAskPerIpWindow());
  const askCorpus = options.askCorpus ?? createAskCorpusSource({
    scanRoot,
    ...(reader ? { publications: reader.publications, store: reader.store } : {}),
  });
  // Spawned lazily on the first retrieval; unref'd while idle.
  const askRetrieval = options.askRetrieval ?? createAskRetrievalWorker(resolveAskWorkerEnv());

  function publicJob(job: ScanJob): Record<string, unknown> {
    return toPublicJob(job, text => redactGatewayErrorText(text, llm.apiKey));
  }

  return async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    if (full) { if (await handleOperatorRoutes(full, request, response, url)) return; }

    if (request.method === "GET" && pathname === "/api/ask") {
      sendJson(response, 200, publicAskStatus(llm));
      return;
    }

    if (request.method === "GET" && pathname === ASK_THREAD_PATH) {
      const session = full?.auth.sessionFromRequest(request);
      if (full && !session) {
        sendJson(response, 401, askAuthDenied());
        return;
      }
      const atlas = askAtlasIdentityFromSearch(url.searchParams);
      if (!atlas) {
        sendJson(response, 400, { error: "Ask thread needs atlas identity {owner, repo, commitSha}." });
        return;
      }
      // Public-readonly: no identity, so no persisted thread (the web client keeps its turns locally).
      const thread = session ? threads.get(session.userId, atlas) : undefined;
      sendJson(response, 200, { thread: thread ? publicAskThread(thread) : emptyPublicAskThread(atlas) });
      return;
    }

    if (request.method === "POST" && pathname === "/api/ask") {
      // Public-readonly Ask is anonymous: no session, no account window, no persisted thread.
      const session = full?.auth.sessionFromRequest(request);
      if (full && !session) {
        sendJson(response, 401, askAuthDenied());
        return;
      }
      // CLA-266: every public-readonly answer that made no gateway call reports a zero cost, so the edge releases the
      // estimate it reserved; after a gateway call the header carries the reported cost (absent when unreported).
      // CLA-472: a reply without an answer is marked so the edge returns the account's daily Ask; a gateway call that
      // reported usage is not (the model did the work).
      const unanswered: Record<string, string> = full ? {} : { [ASK_OUTCOME_HEADER]: "unanswered" };
      const noCost: Record<string, string> = full ? {} : { [ASK_COST_HEADER]: "0", ...unanswered };
      // Account window first, then the per-IP window, both before the 48 KB body is read. A malformed or unanswerable
      // request therefore spends the account's quota too (deliberate: it is the caller's own budget). Only requests the
      // account window admits count against the IP window, so one account cannot lock everyone out; loopback addresses
      // (the dev / hosting proxy, where every caller shares one address) are exempt, and the account window plus worker
      // admission are the controls there. CLA-266: with a trusted proxy the address is the real client (never exempt).
      if (session && !allowAsk(`ask:${session.userId}`)) { sendJson(response, 429, { error: "Too many questions from this account; try again in a few minutes." }); return; }
      if (!exemptFromIpWindow(request, trustedProxy) && !allowAskIp(`ask-ip:${clientKey(request)}`)) { sendJson(response, 429, { error: "Too many questions from this address; try again in a few minutes." }, true, noCost); return; }
      let body: unknown;
      try {
        body = await readJsonBody(request, 48 * 1024);
      } catch {
        sendJson(response, 400, { error: "Expected a JSON body: {\"question\": \"...\", \"packets\": [...], \"atlas\": {\"owner\": \"...\", \"repo\": \"...\", \"commitSha\": \"...\"}}" }, true, noCost);
        return;
      }
      const record = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
      const atlas = sanitizeAskAtlasIdentity(record.atlas);
      if (!atlas) {
        sendJson(response, 400, { error: "Ask needs atlas identity {owner, repo, commitSha}." }, true, noCost);
        return;
      }
      // Cheap checks: never locate a snapshot or wake the retrieval worker for a request that cannot be answered.
      if (!askGatewayConnected(llm)) { sendJson(response, 200, { connected: false }, true, noCost); return; }
      if (typeof record.question !== "string" || !record.question.trim()) { sendJson(response, 200, { connected: true, error: "Ask needs a question." }, true, noCost); return; }
      const slug = sanitizeAskSlug((record.atlas as Record<string, unknown>).slug);
      // The atlas's commit: a mirror whose current version is on another commit re-reads latest.json first.
      await ensure(slug || parseGithubSource(`gh:${atlas.owner}/${atlas.repo}`)?.dirSlug.toLowerCase(), undefined, atlas.commitSha);
      let locations: AskCorpusLocation[];
      try { locations = askCorpus.locate({ ...(slug !== undefined ? { slug } : {}), owner: atlas.owner, repo: atlas.repo, commitSha: atlas.commitSha }); } catch { locations = []; }
      const ticket = locations.length ? askRetrieval.admit(locations, atlas.commitSha) : undefined;
      if (ticket === "busy") { sendJson(response, 429, { error: ASK_BUSY_ERROR }, true, { ...noCost, "retry-after": String(ASK_BUSY_RETRY_AFTER_SECONDS) }); return; }
      let result: Awaited<ReturnType<typeof answerAskQuestion>>;
      let usage: GatewayUsage | undefined;
      let gatewayCalled = false;
      try {
        // The request thread never parses, indexes or searches a snapshot: retrieval runs on the worker.
        result = await answerAskQuestion(llm, body, { ...(ticket ? { retrieve: query => ticket.run(query) } : {}), systemNames: [atlas.repo], onGatewayCall: () => { gatewayCalled = true; }, onUsage: value => { usage = value; } });
      } finally { ticket?.release(); }
      // CLA-266: the edge settles its Ask dollar ledger from these (public-readonly only). No gateway call → 0; a call
      // with unreported cost → no cost header (the edge keeps its estimate).
      const costHeaders = full ? {} : gatewayCalled ? askUsageHeaders(usage) : { [ASK_COST_HEADER]: "0" };
      if (result.connected && "answer" in result && result.answer && !session) {
        const answer = redactGatewayText(result.answer, llm.apiKey);
        sendJson(response, 200, { ...result, answer, citationDetails: sanitizeCitationDetails(result.citationDetails, llm.apiKey) }, true, costHeaders);
        return;
      }
      if (result.connected && "answer" in result && result.answer && session) {
        const question = typeof record.question === "string" ? record.question : "";
        const answer = redactGatewayText(result.answer, llm.apiKey);
        const citationDetails = sanitizeCitationDetails(result.citationDetails, llm.apiKey);
        const thread = persistAskTurn(threads, session.userId, atlas, {
          question,
          answer,
          citations: result.citations,
          scopeIds: result.scopeIds,
          citationDetails,
          retrieval: result.retrieval,
        }, llm.apiKey);
        sendJson(response, 200, { ...result, answer, citationDetails, thread: publicAskThread(thread) });
        return;
      }
      sendJson(response, 200, result, true, { ...costHeaders, ...(usage ? {} : unanswered) });
      return;
    }

    if (request.method === "POST" && pathname === BLOCK_PLAN_PATH) {
      if (!options.blockPlans?.config.enabled) { sendJson(response, 200, { state: "unavailable", reason: "disabled" }, false); return; }
      // CLA-304: signed-in callers only (public-readonly: anonymous, per-IP window only); the per-IP (and per-account)
      // window is decided before the body is read.
      const session = full?.auth.sessionFromRequest(request);
      if (full && !session) { sendJson(response, 401, { error: HOSTED_BLOCK_PLAN_AUTH_ERROR, auth: { required: true, loginPath: LOGIN_PATH } }, false); return; }
      const ip = clientKey(request);
      const refused = options.blockPlans.admit(ip, session?.userId);
      if (refused) { sendJson(response, refused.status, refused.body, false); return; }
      let body: unknown;
      try { body = await readJsonBody(request, MAX_BLOCK_PLAN_REQUEST_BYTES); } catch { sendJson(response, 400, { error: "Expected a JSON block plan request." }, false); return; }
      const scan = typeof body === "object" && body !== null ? (body as { scan?: unknown }).scan : undefined;
      const planSlug = typeof scan === "object" && scan !== null ? (scan as { slug?: unknown }).slug : undefined;
      if (typeof planSlug === "string") await ensure(planSlug);
      const result = await options.blockPlans.handleAdmitted(body, ip);
      sendJson(response, result.status, result.body, false);
      return;
    }

    if (full && request.method === "POST" && pathname === "/api/scans") {
      const { auth, allowSubmit, queue } = full;
      if (full.operator) { sendJson(response, 403, { error: "use operator workflow" }); return; }
      const session = auth.sessionFromRequest(request);
      const access = resolveScanGithubAccess({
        ...(session ? { session } : {}),
        headers: {
          authorization: request.headers.authorization,
          cookie: request.headers.cookie,
        },
      });
      if (access.kind !== "github") {
        sendJson(response, 401, {
          error: HOSTED_SCAN_AUTH_ERROR,
          auth: { required: true, loginPath: LOGIN_PATH },
        });
        return;
      }
      if (!allowSubmit(scanQuotaKey(access)) || !allowSubmit(`ip:${clientKey(request)}`)) {
        sendJson(response, 429, { error: "Too many scans from this account; try again in a few minutes." });
        return;
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch {
        sendJson(response, 400, { error: "Expected a JSON body: {\"url\": \"https://github.com/owner/repo\"}" });
        return;
      }
      const input = typeof body === "object" && body !== null ? (body as { url?: unknown }).url : undefined;
      const parsed = typeof input === "string" ? normalizeRepoInput(input) : undefined;
      if (!parsed) {
        sendJson(response, 422, {
          error: "That doesn't look like a public GitHub repository. Try https://github.com/owner/repo, owner/repo, or gh:owner/repo@ref.",
        });
        return;
      }
      const { job, deduped } = queue.submit({
        owner: parsed.owner,
        repo: parsed.repo,
        ...(parsed.ref ? { ref: parsed.ref } : {}),
        slug: parsed.dirSlug,
        githubAccess: access,
      });
      sendJson(response, deduped ? 200 : 202, { job: publicJob(job), deduped });
      return;
    }

    if (full && request.method === "GET" && pathname.startsWith("/api/scans/")) {
      if (full.operator) { sendJson(response, 404, { error: "not found" }); return; }
      const job = full.queue.get(decodeURIComponent(pathname.slice("/api/scans/".length)));
      if (!job) {
        sendJson(response, 404, { error: "no such scan job" });
        return;
      }
      sendJson(response, 200, { job: publicJob(job) });
      return;
    }

    if (full && request.method === "GET" && pathname === "/api/scans") {
      if (full.operator) { sendJson(response, 404, { error: "not found" }); return; }
      sendJson(response, 200, { jobs: full.queue.list().slice(0, 50).map(publicJob) });
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/scan/")) await ensure(scanPathSlug(pathname), url.searchParams.get("version"), url.searchParams.get("commit"));

    if (request.method === "GET" && isSourceScanPath(pathname)) {
      try {
        const source = await sourceService(scanRoot, pathname, url.searchParams);
        sendJson(response, 200, source, false);
      }
      catch (error) { sendJson(response, error instanceof SourceRequestError ? error.status : 502, { error: error instanceof SourceRequestError ? error.message : 'Historical source unavailable.' }); }
      return;
    }

    if (request.method === "GET" && isNeighborhoodScanPath(pathname)) {
      const slug = pathname.split("/")[2]; const repositoryId = operatorRepositoryForSlug(reader, slug);
      const packet = serveNeighborhoodPacket(scanRoot, { pathname, searchParams: url.searchParams, ...(repositoryId && reader ? { repositoryId, publications: reader.publications, store: reader.store } : {}) });
      if (!packet) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      sendJson(response, 200, packet, false);
      return;
    }

    if (request.method === "GET" && isExcerptScanPath(pathname)) {
      const slug = pathname.split("/")[2]; const repositoryId = operatorRepositoryForSlug(reader, slug);
      const packet = serveExcerptPacket(scanRoot, { pathname, searchParams: url.searchParams, ...(repositoryId && reader ? { repositoryId, publications: reader.publications, store: reader.store } : {}) });
      if (!packet) {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      sendJson(response, 200, packet, false);
      return;
    }

    if (request.method === "GET" && pathname.startsWith("/scan/")) {
      serveScanObject(scanRoot, pathname, response, reader, url.searchParams.get("version") ?? undefined);
      return;
    }

    if (request.method === "GET" && (pathname === "/healthz" || (full && pathname === "/"))) {
      sendJson(response, 200, healthzBody({ enrich, bind }));
      return;
    }

    sendJson(response, 404, { error: "not found" });
  };
}

export function createScanHttpServer(options: ScanHttpOptions | PublicReadonlyHttpOptions) {
  const handle = createHandler(options);
  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const raw = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: redactGatewayErrorText(raw, options.llm.apiKey) });
    });
  });
}
