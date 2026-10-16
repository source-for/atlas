import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  regenerateScanManifest,
  scanGithubRepository,
  stableJson,
  githubRepoIsPublic,
  repoApiPath,
  type EmittedPackets,
  type GithubClient,
  type GithubSourceRef,
  type ScanArtifacts,
} from "@okie/scan";
import type { JobRunner, ScanJob, ScanJobEnrichment } from "./jobs.js";
import { createEnricher } from "./enrichment.js";
import { githubClientForAccess } from "./githubAccess.js";
import {
  clampEnrichmentBudget,
  GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE,
  type GlobalEnrichmentSpend,
} from "./globalSpend.js";
import {
  createLlmGatewayClient,
  enrichmentModelId,
  enrichmentProviderLabel,
  hasLlmCredentials,
  isUsableModelId,
  redactGatewayErrorText,
  resolveEnrichmentBudget,
  resolveLlmGatewayConfig,
  type LlmGatewayConfig,
  type LlmGatewayLocalConfig,
} from "./llmGateway.js";
import { publishedEnrichmentStatus, type PublishedEnrichmentStatus } from "./publishedEnrichmentStatus.js";

export type EnrichmentHook = (packets: EmittedPackets) => Promise<ReadonlyMap<string, unknown>>;

export interface ScanServiceOptions {
  /** Directory holding per-repo scan slots + index.json (the served scan root). */
  scanRoot: string;
  maxTarballBytes?: number;
  /**
   * "auto" / "force": enrich when an LLM provider is opted in with OKIE_LLM_API_KEY (CLA-606: "force",
   * i.e. OKIE_SCAN_ENRICH=1, never enables egress by itself); "off": deterministic only.
   */
  enrich?: "auto" | "force" | "off";
  /** Env dict for gateway resolution (tests). Defaults to process.env. */
  env?: NodeJS.Dict<string>;
  /** The resolved LLM config (main.ts passes the one that honours `--llm-provider`). Default: resolved from `env`. */
  llm?: LlmGatewayConfig;
  /** Non-secret local overlay (base URL / model id). */
  llmLocal?: LlmGatewayLocalConfig;
  /** Injectable enrichment factory (tests). Returning undefined skips enrichment. */
  enricherFactory?: (onProgress: (note: string) => void) => EnrichmentHook | undefined;
  /**
   * Process-wide token/$ ceiling across GitHub users (CLA-38). When exhausted,
   * enrichment is skipped and the deterministic atlas stays live.
   */
  globalSpend?: GlobalEnrichmentSpend;
  /**
   * GitHub transport override for tests. Production uses per-job
   * `job.githubAccess` via `githubClientForAccess` — HTTPS Bearer for OAuth/App,
   * HTTPS-only for the loopback test-double, never `gh`, never env tokens.
   */
  githubClient?: GithubClient;
  log?: (line: string) => void;
}

/** Writes published scan artifacts (overview `story.json`, catalog `stories.json`, enrichment report) into the repo's scan slot. */
function publishArtifacts(scanRoot: string, dirSlug: string, artifacts: ScanArtifacts): void {
  const out = join(scanRoot, dirSlug);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "extraction.json"), stableJson(artifacts.extraction));
  writeFileSync(join(out, "snapshot.json"), stableJson(artifacts.snapshot));
  writeFileSync(join(out, "view.json"), stableJson(artifacts.view));
  writeFileSync(join(out, "story.json"), stableJson(artifacts.story));
  writeFileSync(join(out, "stories.json"), stableJson(artifacts.catalog));
  writeFileSync(join(out, "scene.json"), stableJson(artifacts.scene));
  writeFileSync(join(out, "timeline.json"), stableJson(artifacts.timeline));
  const reportPath = join(out, "enrichment-report.json");
  if (artifacts.enrichmentReport) {
    writeFileSync(reportPath, stableJson(artifacts.enrichmentReport));
  } else if (existsSync(reportPath)) {
    unlinkSync(reportPath);
  }
  const manifest = regenerateScanManifest(scanRoot);
  writeFileSync(join(scanRoot, "index.json"), stableJson(manifest));
}

/** Secret-free skip/reject sidecar for the published atlas (CLA-75). Absent when enrichment never ran. */
function publishEnrichmentStatus(
  scanRoot: string,
  dirSlug: string,
  status: PublishedEnrichmentStatus | undefined,
): void {
  const out = join(scanRoot, dirSlug);
  const path = join(out, "enrichment-status.json");
  if (!status) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path, stableJson(status));
}

function skipNote(config: LlmGatewayConfig): string {
  // "no LLM credentials" is what publishedEnrichmentStatus classifies as `no-key`.
  return `no LLM credentials configured (${config.offReason ?? "no provider"})`;
}

const EMPTY_MODEL_NOTE = "empty model id; enrichment not started";

/** CLA-606: "force" (OKIE_SCAN_ENRICH=1) never enables egress by itself; it needs the provider opt-in and key too. */
function shouldAttemptEnrichment(config: LlmGatewayConfig): boolean {
  return hasLlmCredentials(config);
}

/** Provider host + model id when enrichment was attempted. Never a key or URL. */
function enrichmentIdentity(config: LlmGatewayConfig): Pick<ScanJobEnrichment, "modelId" | "provider"> {
  const modelId = enrichmentModelId(config);
  const provider = enrichmentProviderLabel(config);
  return {
    ...(modelId ? { modelId } : {}),
    ...(provider ? { provider } : {}),
  };
}

/**
 * Default factory for the live enricher. It skips (in both modes) unless an LLM provider is opted in
 * with OKIE_LLM_API_KEY (CLA-606), so the deterministic atlas still publishes. The OpenAI-compatible
 * client is constructed here for a gateway provider (with the configured per-request timeout) and
 * packet HTTP POSTs each bounded packet to `chatCompletions`; the `anthropic` provider gets its key and
 * base URL passed explicitly. The hook still runs only inside `scanGithubRepository`'s checkout window.
 */
export function createDefaultEnricherFactory(
  _mode: "auto" | "force",
  env: NodeJS.Dict<string> = process.env,
  local: LlmGatewayLocalConfig = {},
  globalSpend?: GlobalEnrichmentSpend,
  resolved?: LlmGatewayConfig,
): (onProgress: (note: string) => void) => EnrichmentHook | undefined {
  return onProgress => {
    const config = resolved ?? resolveLlmGatewayConfig(env, local);
    if (!hasLlmCredentials(config)) return undefined;
    if (!isUsableModelId(config.modelId)) {
      return async () => {
        throw new Error(EMPTY_MODEL_NOTE);
      };
    }
    try {
      const budget = clampEnrichmentBudget(resolveEnrichmentBudget(env), globalSpend);
      const gateway = createLlmGatewayClient(config, { timeoutMs: budget.requestTimeoutMs });
      const globalCap = Boolean(
        globalSpend && (globalSpend.cap.maxTokens !== undefined || globalSpend.cap.maxDollars !== undefined),
      );
      return createEnricher({
        onProgress,
        modelId: config.modelId,
        budget,
        ...(globalSpend ? {
          onUsage: usage => globalSpend.record(usage),
          budgetExhausted: () => globalSpend.isExhausted(),
        } : {}),
        ...(globalCap ? { maxConcurrent: 1 } : {}),
        ...(gateway ? { gateway } : {}),
        ...(config.keySource === "anthropic" && config.apiKey ? { anthropic: { apiKey: config.apiKey, baseUrl: config.baseUrl } } : {}),
      });
    } catch {
      return undefined;
    }
  };
}

/**
 * The worker body for one paste-a-repo job, staged per the embed-hosting design:
 * the DETERMINISTIC atlas publishes first (instant gratification — the atlas URL
 * is live the moment stage "publishing" completes), then enrichment runs as an
 * async upgrade against the SAME pinned commit and republishes. An enrichment
 * failure downgrades gracefully: the job still completes with the deterministic
 * atlas and carries the failure note.
 */
export function createScanJobRunner(options: ScanServiceOptions): JobRunner {
  const log = options.log ?? (() => {});
  const enrichMode = options.enrich ?? "auto";
  const env = options.env ?? process.env;
  const llmLocal = options.llmLocal ?? {};
  const globalSpend = options.globalSpend;
  const enricherFactory = options.enricherFactory
    ?? (enrichMode === "off" ? () => undefined : createDefaultEnricherFactory(enrichMode, env, llmLocal, globalSpend, options.llm));
  const githubClientOverride = options.githubClient;
  const llmConfig = (): LlmGatewayConfig => options.llm ?? resolveLlmGatewayConfig(env, llmLocal);
  const redact = (line: string): string => redactGatewayErrorText(line, llmConfig().apiKey);

  const clientForJob = (job: ScanJob): GithubClient => {
    if (githubClientOverride) return githubClientOverride;
    if (job.githubAccess) return githubClientForAccess(job.githubAccess);
    throw new Error("hosted scan requires GitHub sign-in");
  };

  const rejectPrivateHostedTree = async (client: GithubClient, job: ScanJob): Promise<void> => {
    if (!job.githubAccess) return;
    const result = await client.getJson(repoApiPath(job.owner, job.repo));
    if (!result.ok || !githubRepoIsPublic(result.json)) {
      throw new Error("Could not confirm that repository is public. Private trees stay closed until the GitHub App can read them.");
    }
  };

  return async (job, update) => {
    try {
      const source: GithubSourceRef = {
        owner: job.owner,
        repo: job.repo,
        ...(job.ref ? { ref: job.ref } : {}),
        dirSlug: job.slug,
      };
      const scanOptions = {
        client: clientForJob(job),
        // CLA-88: same L4 surface as `okie-scan` without `--public-api` (every
        // top-level declaration). `--public-api` stays a CLI opt-in.
        codeSurface: "all" as const,
        ...(options.maxTarballBytes ? { maxTarballBytes: options.maxTarballBytes } : {}),
      };

      update({ stage: "scanning" });
      log(redact(`${job.id}: scanning gh:${job.owner}/${job.repo}${job.ref ? `@${job.ref}` : ""}`));
      await rejectPrivateHostedTree(scanOptions.client, job);
      const deterministic = await scanGithubRepository(source, scanOptions);
      update({
        stage: "publishing",
        commitSha: deterministic.commitSha,
        entityCount: deterministic.artifacts.snapshot.entities.length,
        relationCount: deterministic.artifacts.snapshot.relations.length,
      });
      publishArtifacts(options.scanRoot, job.slug, deterministic.artifacts);
      update({ atlasReady: true });
      log(redact(`${job.id}: deterministic atlas published (${deterministic.artifacts.snapshot.entities.length} entities @ ${deterministic.commitSha.slice(0, 12)})`));

      const writeHonesty = (
        state: ScanJobEnrichment["state"],
        note?: string,
        report?: { results?: ReadonlyArray<{ accepted?: boolean }> },
      ): void => {
        publishEnrichmentStatus(
          options.scanRoot,
          job.slug,
          publishedEnrichmentStatus({ state, ...(note ? { note } : {}), ...(report ? { report } : {}) }),
        );
      };

      if (enrichMode === "off") {
        update({ enrichment: { state: "skipped", note: "enrichment disabled" } });
        writeHonesty("skipped", "enrichment disabled");
        return;
      }

      const config = llmConfig();
      const identity = enrichmentIdentity(config);
      if (shouldAttemptEnrichment(config) && !isUsableModelId(config.modelId)) {
        update({
          enrichment: { state: "failed", note: EMPTY_MODEL_NOTE, ...identity },
        });
        writeHonesty("failed", EMPTY_MODEL_NOTE);
        log(redact(`${job.id}: enrichment failed (${EMPTY_MODEL_NOTE}); deterministic atlas stands`));
        return;
      }

      const enricher = enricherFactory(note => log(redact(`${job.id}: ${note}`)));
      if (!enricher) {
        const note = skipNote(config);
        update({
          enrichment: {
            state: "skipped",
            note,
          },
        });
        writeHonesty("skipped", note);
        return;
      }

      if (globalSpend?.isExhausted()) {
        update({
          enrichment: { state: "skipped", note: GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE },
        });
        writeHonesty("skipped", GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE);
        log(redact(`${job.id}: ${GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE}; deterministic atlas stands`));
        return;
      }

      update({ stage: "enriching", enrichment: { state: "running", ...identity } });
      try {
        // Pin the enrichment pass to the exact commit the deterministic pass
        // resolved, so both passes describe one tree and the republish is a pure
        // upgrade of the same sha (never a silent version bump mid-job).
        const enriched = await scanGithubRepository(
          { ...source, ref: deterministic.commitSha },
          { ...scanOptions, enrichWithPackets: enricher },
        );
        publishArtifacts(options.scanRoot, job.slug, enriched.artifacts);
        const report = enriched.artifacts.enrichmentReport;
        update({
          entityCount: enriched.artifacts.snapshot.entities.length,
          relationCount: enriched.artifacts.snapshot.relations.length,
          enrichment: {
            state: "complete",
            ...identity,
            enrichedContainers: report?.enrichedContainers.length ?? 0,
            ...(report && report.results.some(result => !result.accepted)
              ? { note: `${report.results.filter(result => !result.accepted).length} scope(s) rejected by the gate; they stay deterministic` }
              : {}),
          },
        });
        writeHonesty("complete", undefined, report);
        log(redact(`${job.id}: enriched atlas republished (${report?.enrichedContainers.length ?? 0} containers)`));
      } catch (error) {
        // The deterministic atlas is already live — record the downgrade, don't fail the job.
        const note = redact(error instanceof Error ? error.message : String(error));
        update({
          enrichment: {
            state: "failed",
            ...identity,
            note,
          },
        });
        writeHonesty("failed", note);
        log(redact(`${job.id}: enrichment failed (${note}); deterministic atlas stands`));
      }
    } catch (error) {
      throw new Error(redact(error instanceof Error ? error.message : String(error)));
    }
  };
}
