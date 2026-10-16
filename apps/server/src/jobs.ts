import { isIPv6 } from "node:net";
import { scrubProviderIdentifiers } from "@okie/scan";
import type { ScanGithubAccess } from "./githubAccess.js";

export type ScanJobStage =
  | "queued"
  | "scanning"
  | "publishing"
  | "enriching"
  | "complete"
  | "failed";

export type EnrichmentState = "pending" | "running" | "complete" | "skipped" | "failed";

export interface ScanJobEnrichment {
  state: EnrichmentState;
  enrichedContainers?: number;
  note?: string;
  /** Configured model id when enrichment was attempted. Never the API key. */
  modelId?: string;
  /** Safe provider host packets were sent to. Never a URL, never a key. */
  provider?: string;
}

export interface ScanJob {
  id: string;
  slug: string;
  owner: string;
  repo: string;
  ref?: string;
  stage: ScanJobStage;
  createdAt: number;
  updatedAt: number;
  /** True once the deterministic trio is on disk — the atlas URL is live from here. */
  atlasReady: boolean;
  commitSha?: string;
  entityCount?: number;
  relationCount?: number;
  enrichment: ScanJobEnrichment;
  error?: string;
  /** Hosted GitHub identity. Never copied by toPublicJob. */
  githubAccess?: ScanGithubAccess;
}

export interface ScanJobRequest {
  owner: string;
  repo: string;
  ref?: string;
  slug: string;
  githubAccess?: ScanGithubAccess;
}

export type JobRunner = (
  job: ScanJob,
  update: (patch: Partial<ScanJob>) => void,
) => Promise<void>;

export interface ScanJobQueue {
  /** Enqueues a scan, or returns the already-active job for the same repo@ref. */
  submit(request: ScanJobRequest): { job: ScanJob; deduped: boolean };
  get(id: string): ScanJob | undefined;
  list(): ScanJob[];
  /** Resolves when the queue drains (tests). */
  idle(): Promise<void>;
}

/**
 * In-process FIFO scan queue, one job at a time — a scan is CPU-bound (TypeScript
 * parsing over the whole tree), so concurrency would only trade latency between
 * jobs. Durability is intentionally NOT here: the published trio + manifest on
 * disk are the durable output (re-submitting after a restart is idempotent by
 * scan determinism), and job rows are ephemeral progress reporting.
 */
export function createScanJobQueue(
  runJob: JobRunner,
  now: () => number = () => Date.now(),
): ScanJobQueue {
  const jobs = new Map<string, ScanJob>();
  const pending: ScanJob[] = [];
  let running: ScanJob | undefined;
  let counter = 0;
  let drained: (() => void) | undefined;

  const dedupeKey = (value: { slug: string; ref?: string }): string =>
    `${value.slug}@${value.ref ?? "HEAD"}`;

  const activeByKey = (): Map<string, ScanJob> => {
    const active = new Map<string, ScanJob>();
    for (const job of [running, ...pending]) {
      if (job) active.set(dedupeKey(job), job);
    }
    return active;
  };

  const pump = (): void => {
    if (running) return;
    const next = pending.shift();
    if (!next) {
      drained?.();
      drained = undefined;
      return;
    }
    running = next;
    const update = (patch: Partial<ScanJob>): void => {
      Object.assign(next, patch, { updatedAt: now() });
    };
    update({ stage: "scanning" });
    void runJob(next, update)
      .then(() => {
        if (next.stage !== "failed") update({ stage: "complete" });
      })
      .catch((error: unknown) => {
        const raw = error instanceof Error ? error.message : String(error);
        update({
          stage: "failed",
          error: scrubProviderIdentifiers(raw),
        });
      })
      .finally(() => {
        running = undefined;
        pump();
      });
  };

  return {
    submit(request) {
      const existing = activeByKey().get(dedupeKey(request));
      if (existing) return { job: existing, deduped: true };
      counter += 1;
      const job: ScanJob = {
        id: `job-${counter}-${request.slug}`,
        slug: request.slug,
        owner: request.owner,
        repo: request.repo,
        ...(request.ref ? { ref: request.ref } : {}),
        stage: "queued",
        createdAt: now(),
        updatedAt: now(),
        atlasReady: false,
        enrichment: { state: "pending" },
        ...(request.githubAccess ? { githubAccess: request.githubAccess } : {}),
      };
      jobs.set(job.id, job);
      pending.push(job);
      queueMicrotask(pump);
      return { job, deduped: false };
    },
    get: id => jobs.get(id),
    list: () => [...jobs.values()].sort((left, right) => right.createdAt - left.createdAt),
    idle: () =>
      new Promise(resolve => {
        if (!running && pending.length === 0) resolve();
        else drained = resolve;
      }),
  };
}

/**
 * Wire-facing job row. `redact` runs on `error` and `enrichment.note` so a
 * tokenized gateway URL or echoed key cannot leave via GET /api/scans.
 * Provider/model id are already non-secret by construction.
 */
export function toPublicJob(
  job: ScanJob,
  redact: (text: string) => string = text => text,
): Record<string, unknown> {
  const note = job.enrichment.note ? redact(job.enrichment.note) : undefined;
  const enrichment: Record<string, unknown> = { state: job.enrichment.state };
  if (job.enrichment.enrichedContainers !== undefined) {
    enrichment.enrichedContainers = job.enrichment.enrichedContainers;
  }
  if (note) enrichment.note = note;
  if (job.enrichment.modelId) {
    const modelId = redact(job.enrichment.modelId);
    if (modelId === job.enrichment.modelId) enrichment.modelId = modelId;
  }
  if (job.enrichment.provider) {
    const provider = redact(job.enrichment.provider);
    if (provider === job.enrichment.provider && !/https?:\/\//i.test(provider) && !provider.includes("@")) {
      enrichment.provider = provider;
    }
  }
  return {
    id: job.id,
    slug: job.slug,
    owner: job.owner,
    repo: job.repo,
    ...(job.ref ? { ref: job.ref } : {}),
    stage: job.stage,
    atlasReady: job.atlasReady,
    ...(job.commitSha ? { commitSha: job.commitSha } : {}),
    ...(job.entityCount !== undefined ? { entityCount: job.entityCount } : {}),
    ...(job.relationCount !== undefined ? { relationCount: job.relationCount } : {}),
    enrichment,
    ...(job.error ? { error: redact(job.error) } : {}),
    atlasPath: `/r/${job.owner}/${job.repo}`,
    fixtureParam: `scan:${job.slug}`,
  };
}

/**
 * Fixed-window per-key limiter for the submit endpoint — enough to keep one
 * misbehaving client from monopolizing the single scan worker; not a DDoS story.
 * Bounded and fail-closed (CLA-304): when `maxKeys` windows are tracked, expired
 * windows are swept; if every tracked window is still live, a NEW key is refused
 * (a live window is never evicted, so flooding fresh keys cannot reset anyone's
 * count). Known keys keep working.
 */
export function createSubmitLimiter(
  maxPerWindow = 5,
  windowMs = 10 * 60 * 1000,
  now: () => number = () => Date.now(),
  maxKeys = 10_000,
): (key: string) => boolean {
  return createFixedWindowLimiter({ maxPerWindow, windowMs, now, maxKeys });
}

/** The fail-closed fixed-window limiter behind `createSubmitLimiter` (also the block planner's per-IP windows). */
export function createFixedWindowLimiter(options: { maxPerWindow: number; windowMs: number; now?: () => number; maxKeys: number }): (key: string) => boolean {
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, { startedAt: number; count: number }>();
  return key => {
    const max = options.maxPerWindow;
    const current = windows.get(key);
    const at = now();
    if (current && at - current.startedAt < options.windowMs) {
      if (current.count >= max) return false;
      current.count += 1;
      return true;
    }
    if (current) windows.delete(key);
    if (windows.size >= options.maxKeys) {
      for (const [other, window] of windows) if (at - window.startedAt >= options.windowMs) windows.delete(other);
      if (windows.size >= options.maxKeys) return false;
    }
    windows.set(key, { startedAt: at, count: 1 });
    return true;
  };
}

/**
 * Rate-limit key for a socket address (CLA-304): an IPv4-mapped IPv6 address is its IPv4 address, and
 * IPv6 addresses are grouped by /64 (one host usually owns a whole /64, so per-address keys would let it
 * fill a limiter with junk keys). Anything else is returned as is.
 */
export function clientIpKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
  if (mapped) return mapped[1]!;
  if (isIPv6(address)) {
    const [head = "", tail = ""] = address.toLowerCase().split("::");
    const left = head ? head.split(":") : [];
    const right = address.includes("::") ? (tail ? tail.split(":") : []) : [];
    const groups = address.includes("::") ? [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right] : left;
    return `${groups.slice(0, 4).map(group => (Number.parseInt(group, 16) || 0).toString(16)).join(":")}::/64`;
  }
  return address;
}

/** Loopback socket addresses (127.0.0.0/8, ::1, ::ffff:127.*): the local dev/hosting proxy. */
export function isLoopbackAddress(address: string): boolean {
  const v4 = clientIpKey(address);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4) || address === "::1" || /^0{0,4}(:0{0,4}){6}:0{0,3}1$/.test(address);
}
