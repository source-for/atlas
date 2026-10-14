import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import {
  PUBLISHED_INDEX_SCHEMA,
  PUBLISHED_LATEST_SCHEMA,
  PUBLISHED_PACK_INDEX_SCHEMA,
  PUBLISHED_SOURCE_PATHS_SCHEMA,
  publishedIndexKey,
  publishedLatestKey,
  publishedManifestKey,
  publishedPackIndexKey,
  publishedPackKey,
  publishedPrivateFileKey,
  publishedPublicFileKey,
  publishedSourcePathsKey,
  type PublishedPackEncoding,
  type PublishedPackName,
} from '../../server/src/publishedStoreLayout';
import type { Backend } from '../src/backend';
import type { EdgeEnv } from '../src/env';
import type { Guard } from '../src/guards';
import { handleEdgeRequest, type EdgeDeps } from '../src/index';
import { resetPublishedIndexCache } from '../src/publishedIndexCache';

export const edgeEnv = env as unknown as EdgeEnv;

/** Records every request the "container" sees. */
export function recordingBackend(respond: (request: Request) => Response | Promise<Response> = () => new Response('{"from":"backend"}\n', { headers: { 'content-type': 'application/json' } })) {
  const seen: Request[] = [];
  const backend: Backend = {
    origin: 'http://backend.test',
    fetch: async request => {
      seen.push(request.clone());
      return respond(request);
    },
  };
  return { backend, seen };
}

export type EdgeFetchOptions = {
  init?: RequestInit;
  /** Omitted → a recording backend; `undefined` explicitly → no backend (browse-only deploy). */
  backend?: Backend | undefined;
  guards?: readonly Guard[];
  now?: () => Date;
  env?: Partial<EdgeEnv>;
  fetch?: typeof fetch;
  cache?: Cache | undefined;
  /** Keep the per-isolate index.json cache from earlier requests (default: each request starts cold, as tests rewrite the bucket). */
  keepIndexCache?: boolean;
};

export async function edgeFetch(input: string | Request, options: EdgeFetchOptions = {}): Promise<Response> {
  const request = typeof input === 'string' ? new Request(new URL(input, 'http://127.0.0.1:4196'), options.init) : input;
  if (!options.keepIndexCache) resetPublishedIndexCache();
  const ctx = createExecutionContext();
  const deps: EdgeDeps = {
    backend: 'backend' in options ? options.backend : recordingBackend().backend,
    guards: options.guards ?? [],
    now: options.now ?? (() => new Date('2026-09-30T12:00:00Z')),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...('cache' in options ? { cache: options.cache } : {}),
  };
  const response = await handleEdgeRequest(request, { ...edgeEnv, ...options.env }, ctx, deps);
  await waitOnExecutionContext(ctx);
  return response;
}

export type SeedOptions = {
  slug: string;
  versionId: string;
  files?: Record<string, string>;
  privateFiles?: Record<string, string>;
  packs?: Partial<Record<PublishedPackName, Record<string, string>>>;
  /** Pack encoding written to the pack index (default identity; `null` = legacy index without the field). */
  packEncoding?: PublishedPackEncoding | null;
  sourcePaths?: { owner: string; repo: string; commitSha: string; paths: string[] };
  latest?: boolean;
};

/** One complete gzip member for `text` (what publish writes per entry of a gzip pack). */
export async function gzipBytes(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipText(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Write one published version following publishedStoreLayout.ts (files, packs, manifest, then latest). */
export async function seedAtlas(options: SeedOptions): Promise<void> {
  const bucket = edgeEnv.ATLAS_BUCKET;
  const { slug, versionId } = options;
  for (const [name, text] of Object.entries(options.files ?? {})) await bucket.put(publishedPublicFileKey(slug, versionId, name), text);
  for (const [name, text] of Object.entries(options.privateFiles ?? {})) await bucket.put(publishedPrivateFileKey(slug, versionId, name), text);
  const encoding = options.packEncoding === undefined ? 'identity' : options.packEncoding;
  for (const [pack, entries] of Object.entries(options.packs ?? {}) as Array<[PublishedPackName, Record<string, string>]>) {
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const index: Record<string, [number, number]> = {};
    let offset = 0;
    for (const [key, text] of Object.entries(entries)) {
      const bytes = encoding === 'gzip' ? await gzipBytes(text) : encoder.encode(text);
      index[key] = [offset, bytes.byteLength];
      chunks.push(bytes);
      offset += bytes.byteLength;
    }
    const packBytes = new Uint8Array(offset);
    let at = 0;
    for (const chunk of chunks) { packBytes.set(chunk, at); at += chunk.byteLength; }
    await bucket.put(publishedPackKey(slug, versionId, pack), packBytes);
    await bucket.put(publishedPackIndexKey(slug, versionId, pack), JSON.stringify({
      schema: PUBLISHED_PACK_INDEX_SCHEMA,
      ...(encoding === null ? {} : { encoding }),
      entries: index,
    }));
  }
  if (options.sourcePaths) {
    await bucket.put(publishedSourcePathsKey(slug, versionId), JSON.stringify({ schema: PUBLISHED_SOURCE_PATHS_SCHEMA, ...options.sourcePaths }));
  }
  await bucket.put(publishedManifestKey(slug, versionId), JSON.stringify({ slug, versionId }));
  if (options.latest !== false) {
    await bucket.put(publishedLatestKey(slug), JSON.stringify({ schema: PUBLISHED_LATEST_SCHEMA, slug, versionId, publishedAt: '2026-09-30T00:00:00Z' }));
  }
}

export async function seedIndex(repos: Array<{ slug: string; versionId: string; owner?: string; repo?: string }>): Promise<string> {
  const text = `${JSON.stringify({
    schema: PUBLISHED_INDEX_SCHEMA,
    schemaVersion: 1,
    repos: repos.map(repo => ({ ...repo, owner: repo.owner ?? repo.slug.split('__')[0], repo: repo.repo ?? repo.slug.split('__')[1], repositoryId: repo.slug, commitSha: 'abc123', generatedAt: '2026-09-30T00:00:00Z', entityCount: 3, publishedAt: '2026-09-30T00:00:00Z' })),
  }, null, 2)}\n`;
  await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), text);
  return text;
}

export type MemoryCacheOptions = { failMatch?: boolean; failPut?: boolean };

/**
 * An isolated in-memory Cache stand-in (the real `caches.default` is shared across tests). `keys` records
 * every `put` and `matches` every `match`; `failMatch`/`failPut` make those calls reject like a Cache API outage.
 */
export function memoryCache(options: MemoryCacheOptions = {}): Cache & { keys: string[]; matches: string[] } {
  const store = new Map<string, Response>();
  const keys: string[] = [];
  const matches: string[] = [];
  return {
    keys,
    matches,
    async match(key: RequestInfo | URL) {
      matches.push(String(key));
      if (options.failMatch) throw new Error('cache match unavailable');
      const hit = store.get(String(key));
      return hit ? hit.clone() : undefined;
    },
    async put(key: RequestInfo | URL, response: Response) {
      keys.push(String(key));
      if (options.failPut) throw new Error('cache put unavailable');
      store.set(String(key), response.clone());
    },
    async delete(key: RequestInfo | URL) { return store.delete(String(key)); },
  } as unknown as Cache & { keys: string[]; matches: string[] };
}

/** A token with a signature that can never verify: the first character carries 6 of the first byte's bits, so the decoded bytes always change (the last one carries only 4 real bits and atob ignores the rest). */
export function tamperSignature(token: string): string {
  const [v, payload, signature] = token.split('.');
  return `${v}.${payload}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
}
