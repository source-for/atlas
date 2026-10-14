import { createWriteStream, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { slug } from "./ids.js";
import { scrubGithubTokens } from "./redact.js";
import { scanExecFileSync, scanWorkDir } from "./scan-env.js";
import { detachSymlinks, ScanSizeLimitError, type SkippedTreeEntries } from "./source-tree.js";
import { extractTarball, TarExtractError, type TarExtractLimits, type TarRejectionReason } from "./tar-extract.js";

export { TAR_EXTRACT_LIMITS, TarExtractError, type TarExtractLimits, type TarRejectionReason } from "./tar-extract.js";

/**
 * A parsed `gh:owner/repo[@ref]` source. `ref` may be a branch, tag, or SHA and can
 * itself contain `/` (e.g. `release/1.x`); it is everything after the first `@`.
 * `dirSlug` is the per-repo output directory name (`<owner>__<repo>`, both slugified),
 * kept URL/filesystem-safe so the web app can select a scanned repo by slug.
 */
export interface GithubSourceRef {
  owner: string;
  repo: string;
  ref?: string;
  dirSlug: string;
}

/** The default cap on a downloaded tarball (uncompressed transfer). Clear error above it. */
export const DEFAULT_MAX_TARBALL_BYTES = 150 * 1024 * 1024;

/** A distinct error type so the CLI can print acquisition failures without a stack trace. */
export class GithubAcquisitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAcquisitionError";
  }
}

/** True for a `gh:owner/repo[...]` source string (vs a local path). */
export function isGithubSource(source: string): boolean {
  return source.startsWith("gh:");
}

/**
 * Parses `gh:owner/repo`, `gh:owner/repo@ref`. Owner/repo are the GitHub-legal
 * `[A-Za-z0-9._-]` sets; ref is free-form (branch/tag/sha). Returns undefined for a
 * non-`gh:` or malformed source so the caller can fall back to local-path scanning.
 */
export function parseGithubSource(source: string): GithubSourceRef | undefined {
  if (!isGithubSource(source)) return undefined;
  const match = /^gh:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:@(.+))?$/.exec(source.trim());
  if (!match) return undefined;
  const [, owner, repo, ref] = match;
  const dirSlug = `${slug(owner!)}__${slug(repo!)}`;
  return { owner: owner!, repo: repo!, ...(ref ? { ref } : {}), dirSlug };
}

export function repoApiPath(owner: string, repo: string): string {
  return `/repos/${owner}/${repo}`;
}

export function commitApiPath(owner: string, repo: string, ref: string): string {
  return `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`;
}

export function tarballUrl(owner: string, repo: string, sha: string): string {
  return `https://codeload.github.com/${owner}/${repo}/tar.gz/${sha}`;
}

/** The immutable commit identity resolved from a ref, feeding the snapshot pin. */
export interface ResolvedCommit {
  sha: string;
  /** ISO-8601 committer date, input-derived (never wall-clock) — the determinism anchor. */
  generatedAt: string;
  treeSha: string;
}

/**
 * Interprets a GitHub `/commits/{ref}` response into the pin fields. Pure and total:
 * throws a clear error on any missing field so a malformed/HTML response can never
 * silently yield an empty pin. `committer.date` (not author date) mirrors the local
 * pin's `git show %cI`, normalized through `Date` so both paths format identically.
 */
export function interpretCommitResponse(json: unknown): ResolvedCommit {
  const record = json as {
    sha?: unknown;
    commit?: { committer?: { date?: unknown }; author?: { date?: unknown }; tree?: { sha?: unknown } };
  };
  const sha = typeof record.sha === "string" ? record.sha : undefined;
  const rawDate = record.commit?.committer?.date ?? record.commit?.author?.date;
  const date = typeof rawDate === "string" ? rawDate : undefined;
  const treeSha = typeof record.commit?.tree?.sha === "string" ? record.commit.tree.sha : undefined;
  if (!sha || !date || !treeSha) {
    throw new GithubAcquisitionError("GitHub commit response missing sha/date/tree — not a valid public repo commit.");
  }
  return { sha, generatedAt: new Date(date).toISOString(), treeSha };
}

/** Extracts `default_branch` from a `/repos/{o}/{r}` response. */
export function interpretRepoResponse(json: unknown): string {
  const branch = (json as { default_branch?: unknown }).default_branch;
  if (typeof branch !== "string" || !branch) {
    throw new GithubAcquisitionError("GitHub repository response missing default_branch — repo not found or private.");
  }
  return branch;
}

/** True when GitHub's repo payload explicitly marks the tree public. */
export function githubRepoIsPublic(json: unknown): boolean {
  return (json as { private?: unknown }).private === false;
}

/** True when GitHub's repo payload says the tree is private (authenticated visibility). */
export function githubRepoIsPrivate(json: unknown): boolean {
  return (json as { private?: unknown }).private === true;
}

export type GithubJsonResult =
  | { ok: true; json: unknown }
  | { ok: false; status: number; rateLimited: boolean; message: string };

/**
 * Transport for GitHub reads. Injected in tests to exercise resolution offline
 * against recorded fixtures. Production constructors:
 * - `createAnonymousGithubClient` — HTTPS only, no operator `gh` (test-double / public trees)
 * - `createBearerGithubClient` — HTTPS Bearer token, no operator `gh` (hosted OAuth/App)
 * - `createDefaultGithubClient` — anonymous HTTPS, then `gh` CLI fallback (operator CLI)
 */
export interface GithubClient {
  getJson(apiPath: string): Promise<GithubJsonResult>;
  /** Downloads the repo tarball at `sha` into `destFile`; returns bytes written. */
  downloadTarball(owner: string, repo: string, sha: string, destFile: string, maxBytes: number): Promise<number>;
}

/** Optional `fetch` injection so tests can fail closed without hitting the network. */
export interface GithubClientOptions {
  fetch?: typeof fetch;
}

/** Authenticated tarball at a SHA. Token stays on the Authorization header, never the URL. */
export function authenticatedTarballUrl(owner: string, repo: string, sha: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/tarball/${sha}`;
}

function ghAvailable(): boolean {
  try {
    scanExecFileSync("gh", "gh", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function ghApiJson(apiPath: string): unknown {
  const endpoint = apiPath.replace(/^\//, "");
  const out = scanExecFileSync("gh", "gh", ["api", endpoint], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out);
}

function ghDownloadTarball(owner: string, repo: string, sha: string, maxBytes: number): Buffer {
  return scanExecFileSync("gh", "gh", ["api", `repos/${owner}/${repo}/tarball/${sha}`], {
    encoding: "buffer",
    maxBuffer: maxBytes + 1,
  });
}

const GITHUB_HEADERS = {
  // GitHub requires a User-Agent; Accept pins the v3 JSON media type. Operator
  // `gh` auth is only used by `createDefaultGithubClient` (CLI). Hosted Bearer
  // tokens are passed explicitly — never read from `GITHUB_TOKEN` / `GH_TOKEN`.
  "User-Agent": "okie-scan",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

function jsonHeaders(token: string | undefined): Record<string, string> {
  if (!token) return { ...GITHUB_HEADERS };
  return { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` };
}

function tarballRequest(
  owner: string,
  repo: string,
  sha: string,
  token: string | undefined,
): { url: string; headers: Record<string, string> } {
  if (!token) {
    return { url: tarballUrl(owner, repo, sha), headers: { "User-Agent": GITHUB_HEADERS["User-Agent"] } };
  }
  return {
    url: authenticatedTarballUrl(owner, repo, sha),
    headers: {
      "User-Agent": GITHUB_HEADERS["User-Agent"],
      Accept: GITHUB_HEADERS.Accept,
      "X-GitHub-Api-Version": GITHUB_HEADERS["X-GitHub-Api-Version"],
      Authorization: `Bearer ${token}`,
    },
  };
}

function isRateLimited(status: number, headers: Headers): boolean {
  if (status === 429) return true;
  return status === 403 && headers.get("x-ratelimit-remaining") === "0";
}

function resolveFetch(options: GithubClientOptions | undefined): typeof fetch {
  return options?.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

function createGithubClient(options: GithubClientOptions & { allowGhFallback: boolean; token?: string }): GithubClient {
  const fetchImpl = resolveFetch(options);
  const allowGhFallback = options.allowGhFallback;
  const token = options.token;
  const accessLabel = token ? "authenticated access" : "anonymous access";

  return {
    async getJson(apiPath) {
      let httpStatus = 0;
      let httpRateLimited = false;
      let httpMessage = "GitHub API request failed (network error).";
      try {
        const response = await fetchImpl(`https://api.github.com${apiPath}`, { headers: jsonHeaders(token) });
        if (response.ok) return { ok: true, json: await response.json() };
        httpStatus = response.status;
        httpRateLimited = isRateLimited(response.status, response.headers);
        httpMessage = httpRateLimited
          ? `GitHub API rate limit reached for ${accessLabel}.`
          : `GitHub API request failed (status ${httpStatus}).`;
      } catch {
        httpStatus = 0;
      }
      // Operator CLI only: fall back to `gh` for rate-limits, auth walls, private-repo
      // 404s, or a network hiccup. The HTTP server path must not take this branch.
      if (allowGhFallback && ghAvailable()) {
        try {
          return { ok: true, json: ghApiJson(apiPath) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, status: httpStatus || 502, rateLimited: httpRateLimited, message: `gh api failed: ${scrubGithubTokens(message)}` };
        }
      }
      return {
        ok: false,
        status: httpStatus || 502,
        rateLimited: httpRateLimited,
        message: allowGhFallback && httpRateLimited
          ? "GitHub API rate limit reached for anonymous access and the gh CLI is not available (install/auth `gh`)."
          : httpMessage,
      };
    },

    async downloadTarball(owner, repo, sha, destFile, maxBytes) {
      const request = tarballRequest(owner, repo, sha, token);
      try {
        const response = await fetchImpl(request.url, { headers: request.headers });
        if (response.ok && response.body) {
          const declared = Number(response.headers.get("content-length") ?? "");
          if (Number.isFinite(declared) && declared > maxBytes) {
            throw new GithubAcquisitionError(tooBigMessage(declared, maxBytes));
          }
          return await streamToFileWithCap(response.body, destFile, maxBytes);
        }
        const rateLimited = isRateLimited(response.status, response.headers);
        const fallbackWorthy = rateLimited || response.status === 403 || response.status === 404;
        if (!fallbackWorthy || !allowGhFallback) {
          throw new GithubAcquisitionError(
            rateLimited
              ? `GitHub tarball download rate-limited for ${accessLabel}.`
              : `Tarball download failed (status ${response.status}).`,
          );
        }
      } catch (error) {
        if (error instanceof GithubAcquisitionError) throw error;
        if (!allowGhFallback) {
          throw new GithubAcquisitionError(token ? "Could not download tarball with authenticated access." : "Could not download tarball anonymously.");
        }
        // network error on the CLI path — try gh below
      }
      if (allowGhFallback && ghAvailable()) {
        const buffer = ghDownloadTarball(owner, repo, sha, maxBytes);
        if (buffer.length > maxBytes) throw new GithubAcquisitionError(tooBigMessage(buffer.length, maxBytes));
        await pipeline(Readable.from(buffer), createWriteStream(destFile));
        return buffer.length;
      }
      throw new GithubAcquisitionError(
        allowGhFallback
          ? "Could not download tarball anonymously and the gh CLI is not available."
          : token
            ? "Could not download tarball with authenticated access."
            : "Could not download tarball anonymously.",
      );
    },
  };
}

/**
 * HTTPS-only GitHub client. Never shells out to `gh`, never reads `GITHUB_TOKEN`
 * / `GH_TOKEN`. Hosted unauthenticated POST is denied before this constructor;
 * the test-double identity still uses this client for public trees.
 * Private repos (GitHub 404 without a token that can read them) fail closed.
 */
export function createAnonymousGithubClient(options: GithubClientOptions = {}): GithubClient {
  return createGithubClient({ ...options, allowGhFallback: false });
}

/**
 * HTTPS Bearer client for a hosted GitHub OAuth / App token. Never shells out
 * to `gh`, never reads operator env tokens. The token is an argument — it must
 * not be taken from `process.env` or a request URL.
 */
export function createBearerGithubClient(token: string, options: GithubClientOptions = {}): GithubClient {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("createBearerGithubClient requires a GitHub token");
  return createGithubClient({ ...options, allowGhFallback: false, token: trimmed });
}

/** Operator CLI client: anonymous HTTPS first, `gh` CLI fallback for auth/limits. */
export function createDefaultGithubClient(options: GithubClientOptions = {}): GithubClient {
  return createGithubClient({ ...options, allowGhFallback: true });
}

function tooBigMessage(bytes: number, maxBytes: number): string {
  return `Tarball is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${(maxBytes / 1024 / 1024).toFixed(0)} MB cap (raise with --max-tarball-mb).`;
}

async function streamToFileWithCap(body: ReadableStream<Uint8Array>, destFile: string, maxBytes: number): Promise<number> {
  let total = 0;
  const capper = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) {
        callback(new GithubAcquisitionError(tooBigMessage(total, maxBytes)));
        return;
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]), capper, createWriteStream(destFile));
  } catch (error) {
    rmSync(destFile, { force: true });
    throw error instanceof GithubAcquisitionError ? error : new GithubAcquisitionError(`Tarball download failed: ${scrubGithubTokens(String(error))}`);
  }
  return total;
}

/**
 * Resolves a `gh:` ref to an immutable commit: default branch when no ref is given,
 * then the commit's SHA + committer date + tree SHA. Distinguishes not-found (bad
 * owner/repo/ref) from rate-limited so the CLI can print an actionable message.
 */
export async function resolveGithubCommit(src: GithubSourceRef, client: GithubClient): Promise<ResolvedCommit> {
  let ref = src.ref;
  if (!ref) {
    const repoResult = await client.getJson(repoApiPath(src.owner, src.repo));
    if (!repoResult.ok) throw acquisitionError(src, repoResult, "repository");
    ref = interpretRepoResponse(repoResult.json);
  }
  const commitResult = await client.getJson(commitApiPath(src.owner, src.repo, ref));
  if (!commitResult.ok) throw acquisitionError(src, commitResult, `ref “${ref}”`);
  return interpretCommitResponse(commitResult.json);
}

function acquisitionError(src: GithubSourceRef, result: { status: number; rateLimited: boolean; message: string }, what: string): GithubAcquisitionError {
  if (result.rateLimited) return new GithubAcquisitionError(result.message);
  if (result.status === 404) {
    return new GithubAcquisitionError(`GitHub ${what} not found for ${src.owner}/${src.repo} (check the owner/repo/ref, or that the repo is public).`);
  }
  // Name what failed: "ref “x” could not be resolved on GitHub (status 422)" rather than a bare status line.
  if (result.status > 0 && /^GitHub API request failed \(status \d+\)\.$/.test(result.message)) {
    return new GithubAcquisitionError(what.startsWith("ref ") ? `${what} could not be resolved on GitHub for ${src.owner}/${src.repo} (status ${result.status}).` : `could not read the ${what} ${src.owner}/${src.repo} on GitHub (status ${result.status}).`);
  }
  return new GithubAcquisitionError(result.message);
}

/** An acquired, extracted tree ready to scan, plus a cleanup that discards the temp dir. */
export interface AcquiredTree {
  /** Absolute path to the extracted repository root (the tarball's single top-level dir). */
  root: string;
  /** The temporary directory holding the tarball and `root`; removed by `cleanup`. */
  checkoutRoot: string;
  /** Escaping / dangling / looping symlinks removed after extraction (in-repo links are kept); see detachSymlinks. */
  skipped: SkippedTreeEntries;
  cleanup: () => void;
}

/**
 * A tarball was refused as a whole by the hardened extractor (unsafe path, link or
 * special entry, collision, write-through-symlink, or malformed archive). Nothing
 * from it is used; the temp dir is discarded. `reason` is the extractor's code.
 */
export class TarballRejectedError extends GithubAcquisitionError {
  readonly reason: TarRejectionReason;
  constructor(cause: TarExtractError) {
    super(`Refused the GitHub tarball: ${cause.message}.`);
    this.name = "TarballRejectedError";
    this.reason = cause.reason;
  }
}

/**
 * Downloads the tarball at `sha` into a fresh temp dir, extracts it, and returns the
 * repository root. Ephemeral by contract: the caller scans then calls `cleanup()`;
 * nothing long-lived is kept (the pin's commit/tree SHA is the identity). Extraction
 * uses the in-process {@link extractTarball} (never the host `tar`): the whole archive
 * is validated before anything is written, into a private (0700) temp dir that is
 * removed on any error. Over-limit archives throw {@link ScanSizeLimitError}
 * (bounds: {@link TAR_EXTRACT_LIMITS}, overridable via `extractLimits`).
 */
export async function acquireGithubTree(
  src: GithubSourceRef,
  sha: string,
  client: GithubClient,
  maxBytes = DEFAULT_MAX_TARBALL_BYTES,
  extractLimits: Partial<TarExtractLimits> = {},
): Promise<AcquiredTree> {
  const workDir = mkdtempSync(join(scanWorkDir(), "okie-scan-gh-"));
  const cleanup = () => rmSync(workDir, { recursive: true, force: true });
  try {
    const tarPath = join(workDir, "repo.tar.gz");
    await client.downloadTarball(src.owner, src.repo, sha, tarPath, maxBytes);
    const extractDir = join(workDir, "tree");
    mkdirSync(extractDir, { mode: 0o700 });
    let root: string;
    try {
      // GitHub archives contain a single top-level dir (`{owner}-{repo}-{sha}`); the extractor enforces it.
      root = (await extractTarball(tarPath, extractDir, extractLimits)).root;
    } catch (error) {
      if (error instanceof TarExtractError) throw new TarballRejectedError(error);
      if (error instanceof ScanSizeLimitError) throw error;
      throw new GithubAcquisitionError(`Failed to extract tarball: ${scrubGithubTokens(String(error))}`);
    }
    const skipped = detachSymlinks(root);
    return { root, checkoutRoot: workDir, skipped, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
