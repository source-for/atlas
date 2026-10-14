import {
  PUBLIC_SCAN_FILES,
  isPublishedSlug,
  isPublishedVersionId,
  publishedIndexKey,
  publishedLatestKey,
  publishedManifestKey,
  publishedPackIndexKey,
  publishedPackKey,
  publishedPublicFileKey,
  type PublishedPackEncoding,
  type PublishedPackName,
} from '../../server/src/publishedStoreLayout';
import { proxyTo, type Backend } from './backend';
import { allowedByRateLimit } from './guards';
import type { EdgeEnv } from './env';
import { IMMUTABLE_CACHE_CONTROL, LATEST_CACHE_CONTROL, jsonResponse, notFoundJson } from './http';
import { handleSourceRoute } from './source';

/**
 * Public `/scan/*` surface served from R2 (CLA-266), mirroring apps/server's routes:
 *
 *   /scan/index.json                         → atlas/v1/index.json                          (60 s)
 *   /scan/<slug>/<PUBLIC_SCAN_FILES>         → versions/<v>/public/<file>                    (immutable when ?version=, else 60 s;
 *                                                                                             an absent OPTIONAL_SCAN_FILES sidecar → 204)
 *   /scan/<slug>/neighborhood.json?focus=    → range slice of packs/neighborhood.pack       (miss → 404, or the container
 *                                                                                             when one is bound; excerpts=1 → 404)
 *   /scan/<slug>/excerpt.json?entity=        → range slice of packs/excerpt.pack            (miss → 404, never wakes the container)
 *   /scan/<slug>/source.json                 → source.ts (GitHub raw via the Cache API, allowlisted by packs/source-paths.json)
 *
 * Packs are `identity` or `gzip` (each entry its own gzip member): a gzip slice is sent as is with
 * `Content-Encoding: gzip` when the client accepts gzip, else inflated at the edge. Slices carry a weak ETag
 * (`packSliceEtag`) and answer a matching `If-None-Match` with 304, so a return visit after the 60 s window
 * revalidates instead of re-downloading.
 *
 * `<v>` is `?version=` (validated) or the slug's `latest.json`. Nothing under `private/` is reachable:
 * file names come only from the PUBLIC_SCAN_FILES allowlist and keys are built by the layout module.
 */

export const VERSION_HEADER = 'x-okie-published-version';
/** Public files the web client loads as optional (`fetchOptionalScanJson`): absent → 204, never 404. */
export const OPTIONAL_SCAN_FILES: readonly string[] = ['stories.json', 'enrichment-report.json', 'enrichment-status.json'];
const MAX_FOCUS_ID_LENGTH = 512;
const PACK_INDEX_CACHE_LIMIT = 32;

/** Byte-for-byte apps/server/src/scanNeighborhood.ts `sanitizeFocusId` (an invalid id is "no focus"). */
export function sanitizeFocusId(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const id = raw.trim();
  if (!id || id.length > MAX_FOCUS_ID_LENGTH) return undefined;
  if (id.includes('..') || id.includes('/') || id.includes('\\') || /[\u0000-\u001f\u007f]/.test(id)) return undefined;
  return id;
}

type PackEntries = Record<string, [number, number]>;
type PackIndex = { encoding: PublishedPackEncoding; entries: PackEntries };

/**
 * Parsed pack indexes of immutable versions, per isolate (small LRU). Only successful parses are
 * cached: a missing or unparsable index is re-read next time (no negative caching), so a pack uploaded
 * after a first miss is picked up.
 */
const packIndexCache = new Map<string, PackIndex>();

/** Test seam. */
export function resetPackIndexCache(): void {
  packIndexCache.clear();
}

async function packIndex(bucket: R2Bucket, slug: string, versionId: string, pack: PublishedPackName): Promise<PackIndex | undefined> {
  const cacheKey = `${slug}/${versionId}/${pack}`;
  const hit = packIndexCache.get(cacheKey);
  if (hit) {
    packIndexCache.delete(cacheKey);
    packIndexCache.set(cacheKey, hit);
    return hit;
  }
  const object = await bucket.get(publishedPackIndexKey(slug, versionId, pack));
  if (!object) return undefined;
  let index: PackIndex | undefined;
  try {
    const parsed = await object.json<{ entries?: unknown; encoding?: unknown }>();
    const encoding = parsed?.encoding === undefined ? 'identity' : parsed.encoding;
    if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null && !Array.isArray(parsed.entries)
      && (encoding === 'identity' || encoding === 'gzip')) {
      index = { encoding, entries: parsed.entries as PackEntries };
    }
  } catch {
    index = undefined;
  }
  if (!index) return undefined;
  packIndexCache.set(cacheKey, index);
  while (packIndexCache.size > PACK_INDEX_CACHE_LIMIT) packIndexCache.delete(packIndexCache.keys().next().value!);
  return index;
}

/** True when `Accept-Encoding` allows gzip (a `q=0` refusal counts as not accepted). */
export function acceptsGzip(request: Request): boolean {
  const header = request.headers.get('accept-encoding');
  if (!header) return false;
  let gzip: number | undefined;
  let star: number | undefined;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().toLowerCase().split(';');
    const name = rawName?.trim();
    const qParam = params.map(param => param.trim()).find(param => param.startsWith('q='));
    const q = qParam === undefined ? 1 : Number(qParam.slice(2));
    const weight = Number.isFinite(q) ? q : 0;
    if (name === 'gzip' || name === 'x-gzip') gzip = weight;
    else if (name === '*') star = weight;
  }
  return (gzip ?? star ?? 0) > 0;
}

function validEntry(entry: unknown): entry is [number, number] {
  return Array.isArray(entry) && entry.length === 2
    && Number.isSafeInteger(entry[0]) && Number.isSafeInteger(entry[1]) && entry[0] >= 0 && entry[1] > 0;
}

type ResolvedVersion = { versionId: string; pinned: boolean };

/** `?version=` (must be a valid id) else the slug's `latest.json`; undefined = 404. */
async function resolveVersion(bucket: R2Bucket, slug: string, requested: string | null): Promise<ResolvedVersion | undefined> {
  if (requested !== null) return isPublishedVersionId(requested) ? { versionId: requested, pinned: true } : undefined;
  const latest = await bucket.get(publishedLatestKey(slug));
  if (!latest) return undefined;
  try {
    const pointer = await latest.json<{ versionId?: unknown }>();
    return typeof pointer.versionId === 'string' && isPublishedVersionId(pointer.versionId)
      ? { versionId: pointer.versionId, pinned: false }
      : undefined;
  } catch {
    return undefined;
  }
}

function versionHeaders(version: ResolvedVersion): Record<string, string> {
  return {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': version.pinned ? IMMUTABLE_CACHE_CONTROL : LATEST_CACHE_CONTROL,
    [VERSION_HEADER]: version.versionId,
    'access-control-allow-origin': '*',
  };
}

/** True when `latest.json` exists for the slug — the edge's definition of "a public atlas". */
export async function isPublishedAtlas(bucket: R2Bucket, slug: string): Promise<boolean> {
  if (!isPublishedSlug(slug)) return false;
  return (await bucket.head(publishedLatestKey(slug))) !== null;
}

async function serveObject(request: Request, bucket: R2Bucket, key: string, headers: Record<string, string>): Promise<Response> {
  if (request.method === 'HEAD') {
    const head = await bucket.head(key);
    if (!head) return notFoundJson();
    return new Response(null, { status: 200, headers: { ...headers, etag: head.httpEtag, 'content-length': String(head.size) } });
  }
  const object = await bucket.get(key, { onlyIf: request.headers });
  if (!object) return notFoundJson();
  if (!('body' in object)) return new Response(null, { status: 304, headers: { ...headers, etag: object.httpEtag } });
  return new Response(object.body, { status: 200, headers: { ...headers, etag: object.httpEtag } });
}

/**
 * How the Worker turns a pack entry into a response body (range read; gzip member sent as is or inflated). Bump it
 * whenever that transformation changes, so a browser holding bytes from an older Worker never gets a 304 for them.
 */
export const PACK_SLICE_SERVING_FORMAT = 's1';

/**
 * CLA-584: the validator of a pack slice. A version's pack is written once and never rewritten (publishBuiltVersion
 * refuses a different manifest under an existing version id), so the served bytes are fixed by the version, the pack,
 * the entry (key and its byte range), the response encoding and how the Worker transforms the slice. Weak: a CDN
 * may re-encode the body, and a weak validator is all `If-None-Match` needs.
 */
export async function packSliceEtag(input: {
  slug: string;
  versionId: string;
  pack: PublishedPackName;
  key: string;
  entry: [number, number];
  encoding: 'gzip' | 'identity';
}): Promise<string> {
  const material = [PACK_SLICE_SERVING_FORMAT, input.slug, input.versionId, input.pack, input.key, input.entry[0], input.entry[1], input.encoding].join('\n');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(material)));
  const hex = Array.from(digest.slice(0, 12), byte => byte.toString(16).padStart(2, '0')).join('');
  return `W/"${PACK_SLICE_SERVING_FORMAT}-${input.encoding === 'gzip' ? 'gz' : 'id'}-${hex}"`;
}

/** Weak comparison (RFC 9110 §13.1.2): true when `If-None-Match` lists `etag` (or `*`). */
export function ifNoneMatchHits(request: Request, etag: string): boolean {
  const header = request.headers.get('if-none-match');
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, '');
  const wanted = opaque(etag);
  return header.split(',').some(tag => tag.trim() === '*' || opaque(tag) === wanted);
}

async function servePackSlice(
  request: Request,
  bucket: R2Bucket,
  slug: string,
  version: ResolvedVersion,
  pack: PublishedPackName,
  key: string,
): Promise<Response | undefined> {
  const index = await packIndex(bucket, slug, version.versionId, pack);
  const entries = index?.entries;
  const entry = entries && Object.prototype.hasOwnProperty.call(entries, key) ? entries[key] : undefined;
  if (!index || !validEntry(entry)) return undefined;
  const gzipped = index.encoding === 'gzip';
  const sendCompressed = gzipped && acceptsGzip(request);
  const etag = await packSliceEtag({ slug, versionId: version.versionId, pack, key, entry, encoding: sendCompressed ? 'gzip' : 'identity' });
  const headers: Record<string, string> = { ...versionHeaders(version), etag };
  if (gzipped) headers.vary = 'Accept-Encoding';
  // Before the range read: the client already holds exactly these bytes.
  if (ifNoneMatchHits(request, etag)) return new Response(null, { status: 304, headers });
  if (sendCompressed) headers['content-encoding'] = 'gzip';
  // An inflated body's length is unknown up front; identity and pass-through gzip know it exactly.
  if (!gzipped || sendCompressed) headers['content-length'] = String(entry[1]);
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  const object = await bucket.get(publishedPackKey(slug, version.versionId, pack), { range: { offset: entry[0], length: entry[1] } });
  if (!object) return undefined;
  if (!gzipped) return new Response(object.body, { status: 200, headers });
  // `encodeBody: "manual"`: the bytes already are the gzip member; workerd must not re-compress them.
  if (sendCompressed) return new Response(object.body, { status: 200, headers, encodeBody: 'manual' });
  return new Response(object.body.pipeThrough(new DecompressionStream('gzip')), { status: 200, headers });
}

export type ScanRouteContext = {
  bucket: R2Bucket;
  /** undefined = no container bound (browse-only deploy): pack misses 404. */
  backend: Backend | undefined;
  env: Pick<EdgeEnv, 'ASK_RATE_LIMITER'>;
  waitUntil(promise: Promise<unknown>): void;
  /** Upstream fetch for source.json (GitHub raw); defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Cache API store (defaults to `caches.default`); undefined disables edge caching. */
  cache?: Cache;
};

/** Rate-limit bucket for container-bound `/scan` GETs (pack misses), separate from Ask / block-plan. */
export const SCAN_MISS_BUCKET = 'scan-miss';

async function answer(request: Request, url: URL, context: ScanRouteContext, cache: Cache | undefined): Promise<Response> {
  const { bucket, backend } = context;
  const parts = url.pathname.slice('/scan/'.length).split('/');
  if (parts.length === 1 && parts[0] === 'index.json') {
    return serveObject(request, bucket, publishedIndexKey(), {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': LATEST_CACHE_CONTROL,
      'access-control-allow-origin': '*',
    });
  }
  if (parts.length !== 2) return notFoundJson();
  const [slug, file] = parts as [string, string];
  if (!isPublishedSlug(slug)) return notFoundJson();

  if (file === 'source.json') {
    if (request.method === 'HEAD') return notFoundJson();
    return handleSourceRoute(slug, url, async requested => (await resolveVersion(bucket, slug, requested))?.versionId, {
      bucket,
      fetch: context.fetch ?? ((input, init) => fetch(input, init)),
      cache,
      waitUntil: context.waitUntil,
      origin: url.origin,
    });
  }

  const isNeighborhood = file === 'neighborhood.json';
  const isExcerpt = file === 'excerpt.json';
  if (!isNeighborhood && !isExcerpt && !PUBLIC_SCAN_FILES.includes(file)) return notFoundJson();

  const version = await resolveVersion(bucket, slug, url.searchParams.get('version'));
  if (!version) return notFoundJson();

  if (isExcerpt) {
    const entity = sanitizeFocusId(url.searchParams.get('entity'));
    if (!entity) return notFoundJson();
    return (await servePackSlice(request, bucket, slug, version, 'excerpt', entity)) ?? notFoundJson();
  }

  if (isNeighborhood) {
    // Excerpt-bearing packets are never precomputed and the web client never asks for them.
    if (url.searchParams.get('excerpts') === '1') return notFoundJson();
    const focus = sanitizeFocusId(url.searchParams.get('focus')) ?? '';
    const slice = await servePackSlice(request, bucket, slug, version, 'neighborhood', focus);
    if (slice) return slice;
    // Pack miss. Browse-only (no container): 404. With a container: only for a published atlas, under
    // its own per-IP bucket, pinned to the same version.
    if (!backend || !(await isPublishedAtlas(bucket, slug))) return notFoundJson();
    const clientIp = request.headers.get('cf-connecting-ip')?.trim() || 'unknown';
    if (!(await allowedByRateLimit(context.env, SCAN_MISS_BUCKET, clientIp))) {
      return jsonResponse(429, { error: 'Too many requests; try again shortly.' }, { 'retry-after': '60' });
    }
    const params = new URLSearchParams(url.search);
    params.set('version', version.versionId);
    return proxyTo(backend, request, url.pathname, `?${params.toString()}`);
  }

  const served = await serveObject(request, bucket, publishedPublicFileKey(slug, version.versionId, file), versionHeaders(version));
  if (served.status === 404 && OPTIONAL_SCAN_FILES.includes(file)
    && (await bucket.head(publishedManifestKey(slug, version.versionId))) !== null) {
    // An optional sidecar this (existing) version was published without: an empty answer, not a 404
    // (which the browser logs as a console error on every atlas load). Stable for a pinned version.
    const { 'content-type': _type, ...headers } = versionHeaders(version);
    return new Response(null, { status: 204, headers });
  }
  return served;
}

function defaultCache(): Cache | undefined {
  return typeof caches === 'undefined' ? undefined : (caches as unknown as { default: Cache }).default;
}

/** `/scan/*`: GET/HEAD only. Version-pinned GETs go through the Cache API (their bytes never change). */
export async function handleScanRoute(request: Request, context: ScanRouteContext): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return notFoundJson();
  const url = new URL(request.url);
  const cache = 'cache' in context ? context.cache : defaultCache();
  // Pack slices vary by Accept-Encoding and are one R2 range read anyway: only whole files are cached.
  const packRoute = /\/(?:neighborhood|excerpt|source)\.json$/.test(url.pathname);
  const cacheable = cache !== undefined && method === 'GET' && url.searchParams.has('version') && !packRoute
    && !request.headers.has('if-none-match') && !request.headers.has('range');
  if (cacheable) {
    const cached = await cache.match(request.url);
    if (cached) return cached;
  }
  const response = await answer(request, url, context, cache);
  // 204 = an optional sidecar a pinned version was published without; versions are immutable (publish
  // writes the manifest last and never rewrites one), so that answer is as stable as a 200.
  if (cacheable && (response.status === 200 || response.status === 204) && response.headers.get('cache-control') === IMMUTABLE_CACHE_CONTROL
    && !response.headers.has('vary')) {
    context.waitUntil(cache.put(request.url, response.clone()));
  }
  return response;
}
