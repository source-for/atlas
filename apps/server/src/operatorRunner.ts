import { createAnonymousGithubClient, resolveGithubCommit, scanGithubRepository, stableJson, portableAtlasFromScan, type GithubClient, type GithubSourceRef, type ScanArtifacts } from "@okie/scan";
import { join } from "node:path";
import { serializePortableAtlas, type ArchitectureSnapshot } from "@okie/architecture";
import { githubRepoIsPublic, repoApiPath } from "@okie/scan";
import { scanInWorker } from "./scanWorker.js";
import type { ScanGithubAccess } from "./githubAccess.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import { createOperatorBudgetLedger, type OperatorBudgetLedger } from "./operatorBudget.js";
import { runOperatorEnrichment, type OperatorAdmission, type OperatorEnrichmentGateway, type OperatorEnrichmentScope, type OperatorEnrichmentStore, type OperatorExplanation } from "./operatorEnrichment.js";
import { createLlmGatewayClient, isOpenRouterProvider, resolveOperatorLeafReasoning, resolveLlmGatewayConfig, resolveLlmModelId, resolveLlmRateLimitConfig, resolveOperatorEnrichmentBudget, resolveOperatorEnrichmentDepth, safeGatewayProvider, type GatewayUsage, type LlmGatewayConfig } from "./llmGateway.js";
import { avgCost } from "./operatorWorkflow.js";
import { rateLimitedGateway, sharedLlmRateLimiter, type LlmRateLimiter } from "./llmRateLimiter.js";
import { githubClientForAccess } from "./githubAccess.js";
import { belowEnrichmentCap, coverageFor, legacyEnrichmentCap, sidecarState, type OperatorEnrichmentCap, type OperatorSidecarScopeState } from "./operatorContracts.js";
import { createJevProvider, runOperatorJudgments, type JudgmentLimits, type JudgmentOutcome, type JudgmentProvider, type JudgmentRequest } from "./operatorJudgments.js";
import { runSectionProfile } from "./sectionProfiles.js";
import { CLAIM_CHECK_STALE_SKIP, claimReasonText, runClaimChecks } from "./claimChecks.js";
import { resolveClaimCheckConfig } from "./llmGateway.js";
import { operatorScopeFacts, operatorScopesFromSnapshot } from "./operatorFacts.js";
import { runIncremental } from "./operatorIncremental.js";

export interface OperatorRunnerScan { commitSha: string; artifacts: ScanArtifacts; }
export interface OperatorRunnerDeps { store: OperatorStore; publication: OperatorPublicationService; githubClient?(access: ScanGithubAccess): GithubClient; scan?(source: GithubSourceRef, options: { client: GithubClient; analysisMode: "full"; codeSurface: "all"; rustIndexCacheDir?: string }): Promise<OperatorRunnerScan>; gateway?: OperatorEnrichmentGateway; gatewayConfig?: LlmGatewayConfig; judgmentProvider?: JudgmentProvider | null; judgmentLimits?: Partial<JudgmentLimits>; /** Test seam; defaults to the process-wide limiter for the gateway's provider. */ rateLimiter?: LlmRateLimiter; /** Process-wide operator spend ledger (OKIE_LLM_GLOBAL_*), reserved before the run ledger. */ globalLedger?: OperatorBudgetLedger; /** Test seam: pause before a transport retry (default TRANSPORT_RETRY_DELAY_MS). */ transportRetryDelayMs?: number; /** CLA-271: resolve a ref (absent = default branch) to a commit SHA; default GitHub commits API. */ resolveCommit?(source: GithubSourceRef, client: GithubClient): Promise<string>; }
export interface OperatorRunner { profile(input: { runId: string; draftRevisionId: string; scopeId: string }, signal?: AbortSignal): ReturnType<typeof runSectionProfile>; judge(request: JudgmentRequest, signal?: AbortSignal): Promise<JudgmentOutcome>; enqueue(input: { kind: "run" | "retry" | "refresh" | "claim-checks" | "incremental"; runId: string; githubAccess: ScanGithubAccess; draftRevisionId?: string; scopeIds?: string[]; /** Batch retry: re-reduce affected ancestors in the same pass (CLA-258). */ batch?: boolean; /** Internal audit label for refresh's (and an incremental run's) targeted retry execution. */ attemptKind?: "retry" | "refresh" | "incremental" }): Promise<void>; }

function persistedUsage(usage?: GatewayUsage) {
  return usage ? {
    inputTokens: usage.promptTokens ?? Math.max(0, usage.totalTokens - (usage.completionTokens ?? 0)),
    outputTokens: usage.completionTokens ?? 0,
    ...(usage.costUsd !== undefined ? { measuredCostUsd: usage.costUsd } : {}),
  } : undefined;
}

export { coverageFor, sidecarState, type OperatorSidecarScopeState } from "./operatorContracts.js";

/** Durable completion record for an enrichment pass (CLA-258); counts are the installed draft's coverage. */
/** This pass's own provider cost (sum of its attempts' reported cost); absent when no attempt reported one. */
function passCost(attempts: readonly { usage?: GatewayUsage }[]): { costUsd?: number } {
  const costs = attempts.map(attempt => attempt.usage?.costUsd).filter((value): value is number => value !== undefined);
  return costs.length ? { costUsd: costs.reduce((total, value) => total + value, 0) } : {};
}
function finishedDetail(kind: "run" | "retry", stopped: string, coverage: ReturnType<typeof coverageFor>, startedAt: number, extra: Record<string, number | string> = {}): Record<string, string | number> {
  return { kind, stopped, accepted: coverage.accepted, failed: coverage.failed, notRun: coverage.notRun, belowCap: coverage.belowCap, inScope: coverage.total - coverage.belowCap, durationMs: Math.max(0, Date.now() - startedAt), ...extra };
}

/**
 * Durable ledger admission, called by runOperatorEnrichment before it creates an
 * attempt row: the global ledger (if any) reserves first, then the run ledger.
 * A refusal at either step releases what was already reserved and creates no
 * row. Both reservations precede network I/O and are settled exactly once with
 * the real usage. Rate-limit retries live below this layer (in the limiter
 * around the raw gateway), so they never touch a ledger.
 */
/** CLA-271: operator scans share a content-addressed rust-analyzer SCIP cache under the store root. */
export function rustIndexCacheDir(store: OperatorStore): string { return join(store.root, "cache", "rust-scip"); }

function ledgerAdmission(store: OperatorStore, runId: string, budget: ReturnType<typeof resolveOperatorEnrichmentBudget>, global?: OperatorBudgetLedger) {
  const ledger = createOperatorBudgetLedger({ maxRequests: budget.maxScopes, maxTokens: budget.maxTokens, maxDollars: budget.maxDollars }, { store, runId });
  /** Which ledger refused last; the run-level cap inside runOperatorEnrichment also counts as "run". */
  const state: { refusedBy?: "global" | "run" } = {};
  return Object.assign(({ body }: { body: Record<string, unknown> }): OperatorAdmission | false => {
    const maxOutputTokens = typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens) ? Math.max(0, Math.floor(body.max_tokens)) : 0;
    const size = Buffer.byteLength(JSON.stringify(body), "utf8") + maxOutputTokens;
    const globalId = global?.reserve(size);
    if (global && !globalId) { state.refusedBy = "global"; return false; }
    let requestId: string | undefined;
    try { requestId = ledger.reserve(size); } catch (error) { if (globalId) global!.release(globalId); throw error; }
    if (!requestId) { if (globalId) global!.release(globalId); state.refusedBy = "run"; return false; }
    return { settle: (usage?: GatewayUsage, estimate?: { estimatedCostUsd: number }) => { const settled = { ...(persistedUsage(usage) ?? {}), ...(estimate && usage?.costUsd === undefined ? { estimatedCostUsd: estimate.estimatedCostUsd } : {}) }; try { ledger.settle(requestId, settled); } finally { if (globalId) global!.settle(globalId, settled); } } };
  }, { refusedBy: () => state.refusedBy ?? "run" });
}

/** Gateway hostname from the client's own baseUrl, else the config; never a URL or key. */
/** The run's average cost per attempt (measured, else estimated): the estimate for a call whose body dropped (CLA-264). */
function runAverageCostUsd(store: OperatorStore, runId: string): number | undefined {
  const state = store.snapshot(); const drafts = new Set(state.drafts.filter(draft => draft.runId === runId).map(draft => draft.draftRevisionId));
  return avgCost(state.attempts.filter(attempt => drafts.has(attempt.draftRevisionId))).avgCostPerScopeUsd;
}

function gatewayProvider(raw: OperatorEnrichmentGateway, config: LlmGatewayConfig | undefined): string {
  const baseUrl = (raw as { baseUrl?: unknown }).baseUrl;
  return (typeof baseUrl === "string" ? safeGatewayProvider(baseUrl) : undefined) ?? (config ? safeGatewayProvider(config.baseUrl) : undefined) ?? "unconfigured";
}

/** Raw gateway → per-provider limiter (429 backoff, in-flight cap). Budget admission sits above it. */
function limitedGateway(raw: OperatorEnrichmentGateway, config: LlmGatewayConfig | undefined, override?: LlmRateLimiter): OperatorEnrichmentGateway {
  return rateLimitedGateway(raw, override ?? sharedLlmRateLimiter(gatewayProvider(raw, config), resolveLlmRateLimitConfig()));
}

/** OKIE_LLM_REASONING_LEAVES=off only changes requests to OpenRouter; every other gateway keeps its default. */
function leafReasoningFor(raw: OperatorEnrichmentGateway | undefined, config: LlmGatewayConfig | undefined): "provider-default" | "off" {
  return raw && resolveOperatorLeafReasoning() === "off" && isOpenRouterProvider(gatewayProvider(raw, config)) ? "off" : "provider-default";
}


/** The public artifact files of one scan (every draft revision carries them unchanged). */
function publicArtifactFiles(source: { owner: string; repo: string }, artifacts: ScanArtifacts): Record<string, string> {
  return { "atlas.okie.json": serializePortableAtlas(portableAtlasFromScan(artifacts, `https://github.com/${source.owner}/${source.repo}`)), "extraction.json": stableJson(artifacts.extraction), "snapshot.json": stableJson(artifacts.snapshot), "view.json": stableJson(artifacts.view), "scene.json": stableJson(artifacts.scene), "story.json": stableJson(artifacts.story), "stories.json": stableJson(artifacts.catalog), "timeline.json": stableJson(artifacts.timeline) };
}

/**
 * Operator scans read public repositories only. A failed read is reported as such (status, rate limit), never as
 * "not public"; "repository is not public" is kept for a successful read of a private repository.
 */
export async function assertPublicRepository(client: GithubClient, owner: string, repo: string): Promise<void> {
  const result = await client.getJson(repoApiPath(owner, repo));
  if (!result.ok) throw new Error(result.rateLimited ? `could not read the repository on GitHub: rate limited (status ${result.status}). Try again after the rate limit resets.` : `could not read the repository on GitHub (status ${result.status}${result.status === 404 ? ": not found, or not public" : ""}).`);
  if (!githubRepoIsPublic(result.json)) throw new Error("repository is not public");
}

/** Controller seam: full committed scans create immutable drafts only; publication is never called here (except CLA-271's opt-in incremental auto-publish). */
export function createOperatorRunner(deps: OperatorRunnerDeps): OperatorRunner {
  // CLA-606: one LLM config for the whole runner. main.ts injects the one it resolved with the CLI --llm-provider; only a
  // runner built without it (tests, scripts) falls back to the env, and the model id fallback never re-resolves the provider.
  const gatewayConfig = (): LlmGatewayConfig => deps.gatewayConfig ?? resolveLlmGatewayConfig();
  const configuredModelId = (): string => deps.gatewayConfig?.modelId ?? resolveLlmModelId();
  // The scan seam: a test `scan`, else inline with an injected client, else (production) a child process (CLA-305) so
  // the synchronous analysis never blocks the server's event loop and never sees its secrets. Cancelling the run kills it.
  const scanSource = async (source: GithubSourceRef, client: GithubClient, access: ScanGithubAccess, runId: string): Promise<OperatorRunnerScan> => {
    const options = { analysisMode: "full" as const, codeSurface: "all" as const, rustIndexCacheDir: rustIndexCacheDir(deps.store) };
    if (deps.scan) return deps.scan(source, { client, ...options });
    if (deps.githubClient) return scanGithubRepository(source, { client, ...options });
    const cancel = new AbortController();
    const poll = setInterval(() => { if (deps.store.isCancelled(runId)) cancel.abort(); }, 1000);
    // Each scan's extracted tree and scratch live in a private per-scan dir under the scanner work root (CLA-305,
    // scanWorkDir: never inside okie's own Cargo workspace or a world-writable /tmp).
    try { return await scanInWorker({ source, access, options }, { signal: cancel.signal }); } finally { clearInterval(poll); }
  };
  const runner: OperatorRunner = {
    async profile(input, signal) {
      // Opt-in scan enrichment only. Existing scans and portable atlases need no provider.
      const provider = deps.judgmentProvider === undefined ? createJevProvider() : deps.judgmentProvider;
      return runSectionProfile({ store: deps.store, publication: deps.publication, ...input, ...(provider ? { provider } : {}), ...(deps.judgmentLimits ? { limits: deps.judgmentLimits } : {}), ...(signal ? { signal } : {}) });
    },
    async judge(request, signal) {
      // No default consumer: deterministic scans and GLM generation never call Jev.
      // Null explicitly disables the provider even if a server key exists.
      const provider = deps.judgmentProvider === undefined ? createJevProvider() : deps.judgmentProvider;
      return runOperatorJudgments({ store: deps.store, publication: deps.publication, request, ...(provider ? { provider } : {}), ...(deps.judgmentLimits ? { limits: deps.judgmentLimits } : {}), ...(signal ? { signal } : {}) });
    },
    async enqueue(input) {
    const run = deps.store.snapshot().runs.find(value => value.runId === input.runId); if (!run) throw new Error("unknown operator run");
    if (input.kind === "incremental") {
      // CLA-271: re-scan at the new commit, carry reused explanations over, then one batch retry pass on the dirty set.
      const rawGateway = deps.gateway ?? createLlmGatewayClient(gatewayConfig(), { timeoutMs: resolveOperatorEnrichmentBudget().requestTimeoutMs });
      await runIncremental({
        store: deps.store, publication: deps.publication,
        // Cron and webhook triggers carry no session: public repositories are read anonymously (never operator `gh`).
        client: access => deps.githubClient ? deps.githubClient(access) : access.kind === "unauthenticated" ? createAnonymousGithubClient() : githubClientForAccess(access),
        resolveCommit: async (source, client) => { await assertPublicRepository(client, source.owner, source.repo); return deps.resolveCommit ? deps.resolveCommit(source, client) : (await resolveGithubCommit(source, client)).sha; },
        scan: (source, client) => scanSource(source, client, input.githubAccess, input.runId),
        publicFiles: artifacts => publicArtifactFiles(run.source, artifacts),
        defaultCap: resolveOperatorEnrichmentDepth,
        hashModel: () => ({ modelId: rawGateway?.modelId ?? configuredModelId(), leafReasoning: leafReasoningFor(rawGateway, deps.gatewayConfig) }),
        retry: job => runner.enqueue({ kind: "retry", attemptKind: "incremental", batch: true, githubAccess: input.githubAccess, ...job }),
      }, run, input.githubAccess);
      return;
    }
    if (input.kind !== "run" && run.draftRevisionId !== input.draftRevisionId) {
      deps.store.appendEvent({ runId: run.runId, type: "draft.conflict", detail: { reason: "stale_retry_base", ...(input.draftRevisionId ? { draftRevisionId: input.draftRevisionId } : {}) } });
      // Nothing will execute: release the run from the API's "queued" mark.
      if (run.state === "queued") deps.store.updateRun(run.runId, { state: "awaiting_review" });
      return;
    }
    /** Retry/refresh execution is visible as "running" (the API's 409 guard covers it); a cancellation is never overwritten. */
    const markRunning = () => { if (!deps.store.isCancelled(run.runId)) deps.store.updateRun(run.runId, { state: "running" }); };
    if (input.kind === "claim-checks") {
      // CLA-145: report-only Jev claim checks through the same seam as retry: visible as "running",
      // cancellable, one installed revision per pass, and back to awaiting_review afterwards.
      const config = resolveClaimCheckConfig();
      const provider = deps.judgmentProvider === undefined ? createJevProvider() : deps.judgmentProvider ?? undefined;
      markRunning();
      // Lets the operator UI say "Checking claims…" instead of enrichment progress while this pass runs.
      deps.store.appendEvent({ runId: run.runId, type: "claim_checks.started", detail: { ...(input.scopeIds ? { scopes: input.scopeIds.length } : {}) } });
      let result: Awaited<ReturnType<typeof runClaimChecks>>;
      try {
        result = await runClaimChecks({ store: deps.store, publication: deps.publication, runId: run.runId, draftRevisionId: input.draftRevisionId!, ...(input.scopeIds ? { scopeIds: input.scopeIds } : {}), ...(provider ? { provider } : {}), limits: { maxRequests: config.maxRequests, maxTokens: config.maxTokens, maxDollars: config.maxDollars, maxConcurrent: 1, timeoutMs: config.timeoutMs }, ...(deps.globalLedger ? { globalLedger: deps.globalLedger } : {}), enabled: config.enabled, runnerOwned: true });
      } catch (error) { result = { state: "unavailable", file: error instanceof Error ? error.message : "claim checks" }; }
      if (result.state === "cancelled" || deps.store.isCancelled(run.runId)) { deps.store.appendEvent({ runId: run.runId, type: "claim_checks.finished", detail: { stopped: "cancelled", message: "Claim checks were cancelled; nothing was installed." } }); return; }
      const counts: Record<string, number> = {};
      if (result.state === "accepted") for (const row of result.rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
      const skipped = result.state === "accepted" || result.state === "stale" ? result.skipped.length : 0;
      const message = result.state === "disabled" ? "Claim checks were not run: they are off on this server (OKIE_JEV_CLAIM_CHECKS)."
        : result.state === "no-claims" ? "Claim checks were not run: no selected scope has a claim mapping."
        : result.state === "stale" ? `Claim checks were not run: ${CLAIM_CHECK_STALE_SKIP}`
        : result.state === "conflict" ? "Claim checks were not installed: the revision changed during the pass."
        : result.state === "unavailable" || result.state === "corrupt" ? `Claim checks failed: ${result.state} ${result.file}.`
        : result.stopped === "limit" ? `Claim checks stopped: ${claimReasonText(result.ledger === "global" ? "global-budget" : "run-budget")} Remaining claims are marked unavailable.`
        : result.stopped === "unavailable" ? `Claim checks were not judged: ${claimReasonText("no-provider")} Code checks were recorded.`
        : result.stopped === "failed" ? "Some claim-check requests failed or timed out; those claims are marked unavailable. Re-check to try again."
        : skipped ? `Claim checks finished; ${skipped} stale scope${skipped === 1 ? " was" : "s were"} skipped (${CLAIM_CHECK_STALE_SKIP.toLowerCase()})` : undefined;
      // Outcome messages live on the event, never on run.error: a report-only pass must not clear or overwrite an
      // enrichment error the operator still needs to see.
      deps.store.appendEvent({ runId: run.runId, type: "claim_checks.finished", detail: { stopped: result.state === "accepted" ? result.stopped ?? "complete" : result.state, ...(result.state === "accepted" ? { installed: result.installed, requests: result.requests, replayed: result.replayed, claims: result.rows.length, ...(result.ledger ? { ledger: result.ledger } : {}) } : {}), ...(skipped ? { skipped } : {}), ...(message ? { message } : {}), ...counts } });
      deps.store.updateRun(run.runId, { state: "awaiting_review" });
      return;
    }
    if (input.kind === "refresh") {
      // CLA-264: one batch pass over the stale scopes (the retry path's pool, admission and install), so ancestors shared by
      // several refreshed scopes re-reduce once and one revision is installed, instead of one retry (and revision) per scope.
      const draft = deps.store.snapshot().drafts.find(value => value.draftRevisionId === input.draftRevisionId && value.runId === run.runId);
      if (!draft) throw new Error("refresh requires draft");
      const sidecar = JSON.parse(deps.store.readArtifactFile(draft.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; stale?: boolean }> };
      const stale = new Set(sidecar.scopes.filter(scope => scope.stale).map(scope => scope.scopeId));
      const scopeIds = [...new Set(input.scopeIds ?? [])].filter(scopeId => stale.has(scopeId));
      if (!scopeIds.length) { if (!deps.store.isCancelled(run.runId)) deps.store.updateRun(run.runId, { state: "awaiting_review" }); return; }
      await runner.enqueue({ ...input, kind: "retry", attemptKind: "refresh", scopeIds, batch: true });
      return;
    }
    if (input.kind === "retry") {
      const startedAt = Date.now();
      const draft = deps.store.snapshot().drafts.find(value => value.draftRevisionId === input.draftRevisionId && value.runId === run.runId); const requested = [...new Set(input.scopeIds ?? [])];
      if (!draft || !requested.length) throw new Error("retry requires draft and scope");
      const artifact = deps.store.snapshot().artifacts.find(value => value.artifactRevisionId === draft.artifactRevisionId)!;
      const sidecar = JSON.parse(deps.store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!.toString()) as { maxKind?: OperatorEnrichmentCap; scopes: Array<{ scopeId: string; parentScopeId?: string; name: string; kind: OperatorEnrichmentScope["kind"]; stale?: boolean; /** CLA-271 overlay (claim re-check or moved evidence): never makes a parent stale. */ staleReason?: string; state?: OperatorSidecarScopeState; sourceRefs: Array<{ path: string; startLine?: number; endLine?: number }> }>; explanations: Array<{ scopeId: string; content: unknown; explanationVersionId?: string }> };
      const selectedIds = requested.filter(scopeId => sidecar.scopes.some(scope => scope.scopeId === scopeId)); const rawGateway = deps.gateway ?? createLlmGatewayClient(gatewayConfig(), { timeoutMs: resolveOperatorEnrichmentBudget().requestTimeoutMs });
      if (!selectedIds.length) { if (!deps.store.isCancelled(run.runId)) deps.store.updateRun(run.runId, { state: "awaiting_review" }); return; }
      markRunning();
      const single = selectedIds.length === 1 ? selectedIds[0]! : undefined;
      /** Error/event subject: the scope id for one target (unchanged CLA-134 wording), else a count. */
      const subject = single ?? `${selectedIds.length} scopes`; const verb = input.attemptKind === "refresh" ? "Refresh" : input.attemptKind === "incremental" ? "Update" : "Retry"; const subjectDetail = single ? { scopeId: single } : { scopes: selectedIds.length };
      // A recorded cap wins. A legacy (CLA-254) sidecar is treated as component-capped only when no code scope shows a
      // code-opt-in run (legacyEnrichmentCap); otherwise no scope is ever "below cap" and no maxKind is stamped.
      const recordedCap: OperatorEnrichmentCap | undefined = sidecar.maxKind === "code" || sidecar.maxKind === "component" ? sidecar.maxKind : undefined;
      const sidecarCap: OperatorEnrichmentCap | undefined = recordedCap ?? legacyEnrichmentCap(sidecar.scopes, new Set(sidecar.explanations.map(value => value.scopeId)));
      const capped = (kind: unknown) => sidecarCap !== undefined && belowEnrichmentCap(kind, sidecarCap);
      const budget = resolveOperatorEnrichmentBudget(); const gateway = rawGateway && limitedGateway(rawGateway, deps.gatewayConfig, deps.rateLimiter);
      const snapshot = JSON.parse(deps.store.readArtifactFile(artifact.artifactRevisionId, "snapshot.json")!.toString()) as ArchitectureSnapshot;
      const scopes: OperatorEnrichmentScope[] = sidecar.scopes.map(scope => {
        const entity = snapshot.entities.find(value => value.id === scope.scopeId);
        const { state: _state, ...definition } = scope;
        return { ...definition, facts: entity ? operatorScopeFacts(entity, snapshot.relations) : { relationships: [] }, allowedEvidence: scope.sourceRefs.map(ref => ({ entityId: scope.scopeId, path: ref.path, ...(ref.startLine ? { startLine: ref.startLine } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) })) };
      });
      const attempts = new Map<string, string>(); const acceptedContent = new Map<string, unknown>(); const acceptedVersionId = new Map<string, string>(); const acceptedInputHash = new Map<string, string>();
      const staleScopes = new Set<string>();
      // latestAttempt: a scope with a pinned explanation is passed up as accepted/stale even after a failed retry attempt on
      // this draft (a pass that changes nothing installs no revision, so such attempts stay on the current draft).
      const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { attempts.set(attempt.attemptId, deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: input.attemptKind ?? "retry", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash }).attemptId); }, async updateAttempt(id, patch) { const mapped = attempts.get(id); if (mapped) deps.store.updateAttempt(mapped, { state: patch.state === "accepted" ? "accepted" : patch.state === "cancelled" ? "cancelled" : "failed", ...(patch.usage ? { usage: persistedUsage(patch.usage)! } : {}), ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt(scope) { const previous = deps.store.listAttempts(draft.draftRevisionId, scope).at(-1); const sidecarScope = sidecar.scopes.find(value => value.scopeId === scope); const prior = sidecar.explanations.some(value => value.scopeId === scope) || acceptedContent.has(scope); const stale = !acceptedContent.has(scope) && Boolean(sidecarScope?.stale || staleScopes.has(scope) || previous?.stale); /* CLA-271: a scope accepted earlier in this pass is fresh input for its re-reduced parent, whatever the pass-start sidecar said. */ if (previous && previous.state !== "accepted" && !prior) return { attemptId: previous.attemptId, scopeId: scope, role: "owner", state: previous.state === "cancelled" ? "cancelled" : "failed", modelId: previous.modelId ?? "", inputHash: previous.inputHash ?? "", createdAt: previous.createdAt, updatedAt: previous.updatedAt }; if (!previous && !prior && sidecarScope?.state === "failed") return { attemptId: "sidecar", scopeId: scope, role: "owner", state: "failed", modelId: "", inputHash: "", createdAt: 0, updatedAt: 0 }; return prior ? { attemptId: previous?.attemptId ?? "sidecar", scopeId: scope, role: "owner", state: stale ? "stale" : "accepted", modelId: previous?.modelId ?? "", inputHash: previous?.inputHash ?? "", createdAt: previous?.createdAt ?? 0, updatedAt: previous?.updatedAt ?? 0 } : undefined; }, async putAcceptedExplanation(scope, explanation, attempt, inputHash) { acceptedContent.set(scope, explanation); const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId: scope, attemptId: attempts.get(attempt)!, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); acceptedVersionId.set(scope, row.explanationVersionId); acceptedInputHash.set(scope, inputHash); return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scope) { const prior = sidecar.explanations.find(value => value.scopeId === scope); return (acceptedContent.get(scope) ?? prior?.content) as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => staleScopes.add(id)); } };
      let result: Awaited<ReturnType<typeof runOperatorEnrichment>>;
      const admission = ledgerAdmission(deps.store, run.runId, budget, deps.globalLedger);
      // A batch (the API's `scopeIds` form) re-reduces affected ancestors in the same pass; the single `scopeId` form and refresh keep marking them stale.
      try { result = await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, ...(gateway ? { gateway } : {}), modelId: configuredModelId(), limits: { maxScopes: budget.maxScopes, maxTokens: budget.maxTokens, maxDollars: budget.maxDollars, maxConcurrent: resolveLlmRateLimitConfig().maxConcurrent }, maxKind: sidecarCap ?? "code", leafReasoning: leafReasoningFor(rawGateway, deps.gatewayConfig), admitRequest: admission, estimateDroppedCostUsd: () => runAverageCostUsd(deps.store, run.runId), ...(deps.transportRetryDelayMs !== undefined ? { transportRetryDelayMs: deps.transportRetryDelayMs } : {}), retryScopeIds: selectedIds, ...(input.batch ? { reReduceAncestors: true } : {}), cancelled: () => deps.store.isCancelled(run.runId) }); }
      catch (error) { deps.store.appendEvent({ runId: run.runId, type: "enrichment.retry_failed", detail: subjectDetail }); deps.store.updateRun(run.runId, { state: "awaiting_review", error: `${verb} of ${subject} failed: ${error instanceof Error ? error.message : String(error)}` }); return; }
      const attemptedIds = new Set(result.attempts.map(attempt => attempt.scopeId));
      const hadExplanation = new Set(sidecar.explanations.map(value => value.scopeId));
      /** Per selected scope: accepted in this pass, or attempted and failed (a previous explanation, if any, is kept). */
      const selectedOutcome = () => { const accepted = new Set(result.attempts.filter(attempt => attempt.state === "accepted").map(attempt => attempt.scopeId)); const failed = selectedIds.filter(scopeId => attemptedIds.has(scopeId) && !accepted.has(scopeId)); return { retryAccepted: selectedIds.filter(scopeId => accepted.has(scopeId)).length, retryFailed: failed.length, retryKept: failed.filter(scopeId => hadExplanation.has(scopeId)).length }; };
      const finishedEvent = (stopped: string, coverage: ReturnType<typeof coverageFor>, installed = true) => deps.store.appendEvent({ runId: run.runId, type: "enrichment.finished", detail: { ...finishedDetail("retry", stopped, coverage, startedAt, { ...(input.attemptKind === "incremental" ? { pass: "incremental" } : {}), selected: selectedIds.length, retried: selectedIds.filter(scopeId => attemptedIds.has(scopeId)).length, ...selectedOutcome(), ...passCost(result.attempts) }), installed } });
      const recordedScopes = () => sidecar.scopes.map(scope => ({ ...scope, state: sidecarState(sidecar.explanations.some(value => value.scopeId === scope.scopeId), false, scope.state, capped(scope.kind)) }));
      if (deps.store.isCancelled(run.runId)) { finishedEvent("cancelled", coverageFor(recordedScopes())); return; }
      // Nothing was attempted (budget refused or no gateway): no new draft and no persisted stale marks.
      if (!result.attempts.length && (result.stopped === "limit" || result.stopped === "unavailable")) {
        const limit = result.stopped === "limit";
        const ledger = admission.refusedBy();
        deps.store.appendEvent({ runId: run.runId, type: limit ? "enrichment.budget_refused" : "enrichment.unavailable", detail: { ...subjectDetail, ...(limit ? { ledger } : {}) } });
        deps.store.updateRun(run.runId, { state: "awaiting_review", error: !limit ? `${verb} of ${subject} was not run: no enrichment gateway is configured.` : ledger === "global" ? `${verb} of ${subject} was not run: the process-wide operator budget is exhausted. Raise the global operator limits (OKIE_LLM_GLOBAL_MAX_DOLLARS or its matching global cap) to retry.` : `${verb} of ${subject} was not run: this run's enrichment budget is exhausted. Raise OKIE_LLM_OPERATOR_MAX_REQUESTS (or the matching budget limit) to retry.` });
        return;
      }
      const files = Object.fromEntries(artifact.files.map(name => [name, deps.store.readArtifactFile(artifact.artifactRevisionId, name)!.toString()]));
      /** Every scope accepted in this pass (selected targets and re-reduced ancestors) gets its new immutable version. */
      const newlyAccepted = new Set(result.attempts.filter(attempt => attempt.state === "accepted" && acceptedContent.has(attempt.scopeId)).map(attempt => attempt.scopeId));
      const nextEntry = (scopeId: string) => ({ scopeId, content: acceptedContent.get(scopeId), ...(acceptedVersionId.has(scopeId) ? { explanationVersionId: acceptedVersionId.get(scopeId) } : {}), ...(acceptedInputHash.has(scopeId) ? { inputHash: acceptedInputHash.get(scopeId) } : {}) });
      const nextExplanations = sidecar.explanations.map(value => newlyAccepted.has(value.scopeId) ? nextEntry(value.scopeId) : value);
      for (const scopeId of newlyAccepted) if (!nextExplanations.some(value => value.scopeId === scopeId)) nextExplanations.push(nextEntry(scopeId));
      const explained = new Set(nextExplanations.map(value => value.scopeId));
      // A below-cap scope that was explicitly retried now has an attempt and counts as in scope; untouched ones stay "below cap".
      const nextScopes = sidecar.scopes.map(scope => ({ ...scope, state: sidecarState(explained.has(scope.scopeId), attemptedIds.has(scope.scopeId), scope.state, capped(scope.kind)), ...(staleScopes.has(scope.scopeId) ? { stale: true } : {}) }));
      // Freshness is judged against the next sidecar, children first, so a child refreshed in this same pass counts as fresh.
      const nextById = new Map(nextScopes.map(scope => [scope.scopeId, scope]));
      const depthOf = (scopeId: string) => { let depth = 0; let cursor = nextById.get(scopeId)?.parentScopeId; const seen = new Set<string>(); while (cursor && !seen.has(cursor)) { seen.add(cursor); depth += 1; cursor = nextById.get(cursor)?.parentScopeId; } return depth; };
      // A stale overlay with a CLA-271 reason (claim re-check, moved evidence) leaves the child's explanation text, the parent's input, unchanged.
      for (const scope of nextScopes) if (staleScopes.has(scope.scopeId) || newlyAccepted.has(scope.scopeId)) delete scope.staleReason;
      const hasUnfreshChild = (parentScopeId: string) => nextScopes.some(child => child.parentScopeId === parentScopeId && ((child.stale && !child.staleReason) || (() => { const latest = deps.store.listAttempts(draft.draftRevisionId, child.scopeId).at(-1); return latest !== undefined && (latest.stale || latest.state !== "accepted"); })()));
      for (const scopeId of [...newlyAccepted].sort((left, right) => depthOf(right) - depthOf(left))) { const scope = nextById.get(scopeId); if (scope && !hasUnfreshChild(scopeId)) scope.stale = false; }
      const nextSidecar = { ...sidecar, ...(sidecarCap ? { maxKind: sidecarCap } : {}), scopes: nextScopes, explanations: nextExplanations };
      files["operator-explanations.json"] = stableJson(nextSidecar);
      const coverage = coverageFor(nextScopes);
      const limitStop = result.stopped === "limit"; const ledger = limitStop ? admission.refusedBy() : undefined;
      const retried = selectedIds.filter(scopeId => attemptedIds.has(scopeId)).length;
      const outcome = selectedOutcome();
      // Honest run error: a budget stop and/or failed selected scopes (their previous explanations stay pinned).
      const errors = [
        ...(limitStop ? [`${verb === "Refresh" ? "Refreshed" : verb === "Update" ? "Updated" : "Retried"} ${retried} of ${selectedIds.length} selected scope${selectedIds.length === 1 ? "" : "s"}: stopped at the ${ledger === "global" ? "process-wide operator budget (OKIE_LLM_GLOBAL_*)" : "run budget (OKIE_LLM_OPERATOR_*)"}; ${selectedIds.length - retried} not run.`] : []),
        ...(outcome.retryFailed ? [`${verb}: ${outcome.retryFailed} of ${selectedIds.length} selected scope${selectedIds.length === 1 ? "" : "s"} failed${outcome.retryKept === outcome.retryFailed ? `; previous explanation${outcome.retryKept === 1 ? " was" : "s were"} kept.` : outcome.retryKept ? `; ${outcome.retryKept} previous explanation${outcome.retryKept === 1 ? " was" : "s were"} kept.` : "."}`] : []),
      ];
      const error = errors.length ? errors.join(" ") : undefined;
      // A pass that changed nothing (no new accepted content, no state or stale change) installs no new revision.
      const comparable = (state?: string) => state === undefined || state === "below cap" ? "not run" : state;
      const changed = newlyAccepted.size > 0 || nextScopes.some((scope, index) => comparable(scope.state) !== comparable(sidecar.scopes[index]!.state) || Boolean(scope.stale) !== Boolean(sidecar.scopes[index]!.stale));
      if (!changed) {
        deps.store.updateRun(run.runId, { state: "awaiting_review", error: error as never });
        if (limitStop) deps.store.appendEvent({ runId: run.runId, type: "enrichment.budget_reached", detail: { accepted: 0, attempted: result.attempts.length, ledger: ledger ?? "run", ...subjectDetail } });
        finishedEvent(result.stopped, coverageFor(recordedScopes()), false);
        return;
      }
      let installed = false; let conflict = false;
      deps.store.withExclusiveLock(() => {
        if (deps.store.snapshot().runs.find(value => value.runId === run.runId)?.draftRevisionId !== draft.draftRevisionId) { conflict = true; return; }
        const nextArtifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, ...(artifact.sourceCommitSha ? { sourceCommitSha: artifact.sourceCommitSha } : {}), files });
        const nextDraft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: nextArtifact.artifactRevisionId, coverage });
        deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: nextDraft.draftRevisionId, error: error as never }); installed = true;
      });
      if (!installed) { if (conflict) deps.store.appendEvent({ runId: run.runId, type: "draft.conflict", detail: { reason: "retry_compare_and_swap", draftRevisionId: draft.draftRevisionId } }); return; }
      if (limitStop) deps.store.appendEvent({ runId: run.runId, type: "enrichment.budget_reached", detail: { accepted: newlyAccepted.size, attempted: result.attempts.length, ledger: ledger ?? "run", ...subjectDetail } });
      finishedEvent(result.stopped, coverage);
      return;
    }
    if (input.kind !== "run") return;
    const startedAt = Date.now();
    // Cancelled while queued: never mark it running, scan or spend.
    if (deps.store.isCancelled(run.runId)) return;
    deps.store.updateRun(run.runId, { state: "running" });
    try {
      const client = (deps.githubClient ?? githubClientForAccess)(input.githubAccess); await assertPublicRepository(client, run.source.owner, run.source.repo);
      const scanned = await scanSource({ owner: run.source.owner, repo: run.source.repo, ...(run.source.ref ? { ref: run.source.ref } : {}), dirSlug: run.source.slug }, client, input.githubAccess, run.runId);
      if (deps.store.isCancelled(run.runId)) return;
      const artifacts = scanned.artifacts;
      // The cap in effect for this run is recorded in every sidecar so "below cap" never has to be guessed later.
      const maxKind = resolveOperatorEnrichmentDepth();
      const scopeDto = artifacts.snapshot.entities.map(entity => ({ scopeId: entity.id, ...(entity.parentId ? { parentScopeId: entity.parentId } : {}), name: entity.name, kind: entity.kind, sourceRefs: entity.sourceRefs }));
      const files: Record<string, string> = { ...publicArtifactFiles(run.source, artifacts), "operator-explanations.json": stableJson({ schemaVersion: 1, maxKind, scopes: scopeDto, explanations: [] }) };
      const artifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files });
      const draft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: coverageFor(scopeDto.map(scope => ({ ...scope, state: sidecarState(false, false, undefined, belowEnrichmentCap(scope.kind, maxKind)) }))) }); let activeDraftRevisionId = draft.draftRevisionId;
      const rawGateway = deps.gateway ?? createLlmGatewayClient(gatewayConfig(), { timeoutMs: resolveOperatorEnrichmentBudget().requestTimeoutMs });
      const budget = resolveOperatorEnrichmentBudget();
      const gateway = rawGateway && limitedGateway(rawGateway, deps.gatewayConfig, deps.rateLimiter);
        const scopes: OperatorEnrichmentScope[] = operatorScopesFromSnapshot(artifacts.snapshot);
        const attemptMap = new Map<string, string>();
        const adapter: OperatorEnrichmentStore = { async createAttempt(attempt) { const row = deps.store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: attempt.scopeId, kind: "enrichment", state: "running", modelId: attempt.modelId, inputHash: attempt.inputHash, taskId: attempt.attemptId }); attemptMap.set(attempt.attemptId, row.attemptId); }, async updateAttempt(id, patch) { const mapped = attemptMap.get(id); const usage = persistedUsage(patch.usage); if (mapped) deps.store.updateAttempt(mapped, { state: patch.state === "accepted" ? "accepted" : patch.state === "cancelled" ? "cancelled" : "failed", ...(usage ? { usage } : {}), ...(patch.error ? { error: patch.error } : {}) }); }, async latestAttempt(scopeId) { const row = deps.store.listAttempts(draft.draftRevisionId, scopeId).at(-1); return row ? { attemptId: row.attemptId, scopeId, role: "owner", state: row.state === "accepted" ? "accepted" : "failed", modelId: row.modelId ?? "", inputHash: row.inputHash ?? "", createdAt: row.createdAt, updatedAt: row.updatedAt } : undefined; }, async putAcceptedExplanation(scopeId, explanation, attemptId, inputHash) { const row = deps.store.putAcceptedExplanation({ draftRevisionId: draft.draftRevisionId, scopeId, attemptId: attemptMap.get(attemptId) ?? attemptId, inputHash, content: explanation, validation: { accepted: true, validator: "operator-enrichment/v1" } }); return { explanationVersionId: row.explanationVersionId }; }, async getAcceptedExplanation(scopeId) { const row = deps.store.getAcceptedExplanation(draft.draftRevisionId, scopeId); return row?.content as OperatorExplanation | undefined; }, async markStale(ids) { ids.forEach(id => deps.store.markScopeStale(draft.draftRevisionId, id)); } };
        const admission = ledgerAdmission(deps.store, run.runId, budget, deps.globalLedger);
        const enrichment = await runOperatorEnrichment({ draftRevisionId: draft.draftRevisionId, scopes, store: adapter, ...(gateway ? { gateway } : {}), modelId: configuredModelId(), limits: { maxScopes: budget.maxScopes, maxTokens: budget.maxTokens, maxDollars: budget.maxDollars, maxConcurrent: resolveLlmRateLimitConfig().maxConcurrent }, maxKind, leafReasoning: leafReasoningFor(rawGateway, deps.gatewayConfig), admitRequest: admission, estimateDroppedCostUsd: () => runAverageCostUsd(deps.store, run.runId), ...(deps.transportRetryDelayMs !== undefined ? { transportRetryDelayMs: deps.transportRetryDelayMs } : {}), cancelled: () => deps.store.isCancelled(run.runId) });
        const stateOf = (explained: ReadonlySet<string>, attempted: ReadonlySet<string>) => scopeDto.map(scope => ({ ...scope, state: sidecarState(explained.has(scope.scopeId), attempted.has(scope.scopeId), undefined, belowEnrichmentCap(scope.kind, maxKind)) }));
        if (deps.store.isCancelled(run.runId)) {
          // Cancellation installs no draft; the completion record still says what was known.
          const known = deps.store.snapshot(); const mine = (value: { draftRevisionId: string }) => value.draftRevisionId === draft.draftRevisionId;
          deps.store.appendEvent({ runId: run.runId, type: "enrichment.finished", detail: finishedDetail("run", "cancelled", coverageFor(stateOf(new Set(known.explanations.filter(mine).map(value => value.scopeId)), new Set(known.attempts.filter(mine).map(value => value.scopeId)))), startedAt, passCost(enrichment.attempts)) });
          return;
        }
        if (enrichment.stopped === "unavailable") deps.store.appendEvent({ runId: run.runId, type: "enrichment.unavailable", detail: { reason: "no enrichment gateway configured" } });
        // A limit stop still lands here: every accepted explanation is kept in the enriched draft.
        const state = deps.store.snapshot(); const explanations = state.explanations.filter(value => value.draftRevisionId === draft.draftRevisionId);
        const explained = new Set(explanations.map(value => value.scopeId)); const attempted = new Set(state.attempts.filter(value => value.draftRevisionId === draft.draftRevisionId).map(value => value.scopeId));
        const enrichedScopes = stateOf(explained, attempted);
        if (enrichment.stopped === "limit") deps.store.appendEvent({ runId: run.runId, type: "enrichment.budget_reached", detail: { accepted: explained.size, attempted: attempted.size, ledger: admission.refusedBy() } });
        const enrichedArtifact = deps.store.writeArtifactRevision({ repositoryId: run.source.repositoryId, sourceCommitSha: scanned.commitSha, files: { ...files, "operator-explanations.json": stableJson({ schemaVersion: 1, maxKind, scopes: enrichedScopes, explanations }) } });
        const enrichedCoverage = coverageFor(enrichedScopes);
        const enrichedDraft = deps.publication.createDraftRevision({ runId: run.runId, artifactRevisionId: enrichedArtifact.artifactRevisionId, coverage: enrichedCoverage });
        deps.store.appendEvent({ runId: run.runId, type: "enrichment.finished", detail: finishedDetail("run", enrichment.stopped, enrichedCoverage, startedAt, passCost(enrichment.attempts)) });
        activeDraftRevisionId = enrichedDraft.draftRevisionId;
        deps.store.updateRun(run.runId, { state: "running", draftRevisionId: enrichedDraft.draftRevisionId });
      deps.store.updateRun(run.runId, { state: "awaiting_review", draftRevisionId: activeDraftRevisionId, source: { ...run.source, commitSha: scanned.commitSha }, error: undefined as never });
    } catch (error) { deps.store.updateRun(run.runId, { state: "failed", error: error instanceof Error ? error.message : String(error) }); }
  } };
  return runner;
}
