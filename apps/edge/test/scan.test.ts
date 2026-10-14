import { beforeEach, describe, expect, it } from 'vitest';
import { publishedPackKey } from '../../server/src/publishedStoreLayout';
import { ifNoneMatchHits, PACK_SLICE_SERVING_FORMAT, resetPackIndexCache, sanitizeFocusId, VERSION_HEADER } from '../src/scan';
import { acceptsGzip } from '../src/scan';
import { edgeEnv, edgeFetch, gunzipText, memoryCache, recordingBackend, seedAtlas, seedIndex } from './helpers';

const NEIGHBORHOOD_DEFAULT = `${JSON.stringify({ focus: null, entities: ['a'] })}\n`;
const NEIGHBORHOOD_A = `${JSON.stringify({ focus: 'container:a', entities: ['a', 'b'] })}\n`;
const EXCERPT_A = `${JSON.stringify({ entityId: 'code:a', excerpt: 'fn a() {}' })}\n`;

beforeEach(() => resetPackIndexCache());

describe('/scan from R2', () => {
  it('serves index.json with a short cache', async () => {
    const text = await seedIndex([{ slug: 'acme__index', versionId: 'v1' }]);
    const response = await edgeFetch('/scan/index.json');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await response.text()).toBe(text);
  });

  it('serves latest-resolved files briefly and version-pinned files immutably', async () => {
    await seedAtlas({ slug: 'acme__files', versionId: 'v1', files: { 'snapshot.json': '{"v":1}' }, latest: false });
    await seedAtlas({ slug: 'acme__files', versionId: 'v2', files: { 'snapshot.json': '{"v":2}' } });

    const latest = await edgeFetch('/scan/acme__files/snapshot.json');
    expect(latest.status).toBe(200);
    expect(await latest.text()).toBe('{"v":2}');
    expect(latest.headers.get('cache-control')).toBe('public, max-age=60');
    expect(latest.headers.get(VERSION_HEADER)).toBe('v2');
    expect(latest.headers.get('etag')).toBeTruthy();

    const pinned = await edgeFetch('/scan/acme__files/snapshot.json?version=v1');
    expect(pinned.status).toBe(200);
    expect(await pinned.text()).toBe('{"v":1}');
    expect(pinned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    // Served again (possibly from the Cache API) with identical bytes.
    const again = await edgeFetch('/scan/acme__files/snapshot.json?version=v1');
    expect(await again.text()).toBe('{"v":1}');

    const conditional = await edgeFetch('/scan/acme__files/snapshot.json', { init: { headers: { 'if-none-match': latest.headers.get('etag')! } } });
    expect(conditional.status).toBe(304);

    const head = await edgeFetch('/scan/acme__files/snapshot.json', { init: { method: 'HEAD' } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('7');
  });

  it('404s like the server for unknown slugs, files, versions and methods', async () => {
    await seedAtlas({ slug: 'acme__miss', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    for (const path of [
      '/scan/nobody__here/snapshot.json',
      '/scan/acme__miss/secrets.json',
      '/scan/acme__miss/manifest.json',
      '/scan/acme__miss/view.json',
      '/scan/acme__miss/snapshot.json?version=v9',
      '/scan/acme__miss/snapshot.json?version=../v1',
      '/scan/ACME__miss/snapshot.json',
      '/scan/acme__miss/versions/v1/public/snapshot.json',
      '/scan/snapshot.json',
    ]) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: 'not found' });
    }
    expect((await edgeFetch('/scan/acme__miss/snapshot.json', { init: { method: 'POST', body: '{}' } })).status).toBe(404);
  });

  it('answers an absent optional sidecar with 204 (no console 404), a present one with its bytes', async () => {
    await seedAtlas({ slug: 'acme__sidecar', versionId: 'v1', files: { 'snapshot.json': '{}', 'stories.json': '{"s":1}' } });
    for (const file of ['enrichment-report.json', 'enrichment-status.json']) {
      for (const query of ['', '?version=v1']) {
        const response = await edgeFetch(`/scan/acme__sidecar/${file}${query}`);
        expect(response.status, file + query).toBe(204);
        expect(await response.text()).toBe('');
        expect(response.headers.get(VERSION_HEADER)).toBe('v1');
        expect(response.headers.get('content-type')).toBeNull();
      }
    }
    expect(await (await edgeFetch('/scan/acme__sidecar/stories.json')).text()).toBe('{"s":1}');
    // A pinned 204 is as immutable as the version: cached like a 200; a latest-resolved one is not.
    const cache = memoryCache();
    await edgeFetch('/scan/acme__sidecar/enrichment-report.json?version=v1', { cache });
    await edgeFetch('/scan/acme__sidecar/enrichment-status.json', { cache });
    expect(cache.keys).toEqual(['http://127.0.0.1:4196/scan/acme__sidecar/enrichment-report.json?version=v1']);
    expect((await edgeFetch('/scan/acme__sidecar/enrichment-report.json?version=v1', { cache })).status).toBe(204);
    // Required files, and sidecars of an unknown slug or version, still 404.
    expect((await edgeFetch('/scan/acme__sidecar/view.json')).status).toBe(404);
    expect((await edgeFetch('/scan/nobody__here/enrichment-report.json')).status).toBe(404);
    expect((await edgeFetch('/scan/acme__sidecar/enrichment-report.json?version=v9')).status).toBe(404);
  });

  it('never serves a private/ object, even under a public file name', async () => {
    await seedAtlas({
      slug: 'acme__private',
      versionId: 'v1',
      files: { 'operator-explanations.json': '{"public":true}' },
      privateFiles: { 'operator-explanations.json': '{"claims":"operator-only"}' },
    });
    const response = await edgeFetch('/scan/acme__private/operator-explanations.json');
    expect(await response.text()).toBe('{"public":true}');
    for (const path of [
      '/scan/acme__private/private/operator-explanations.json',
      '/scan/acme__private/..%2Fprivate%2Foperator-explanations.json',
      '/scan/acme__private/operator-explanations.json/../../private/operator-explanations.json',
    ]) {
      const miss = await edgeFetch(path);
      expect(miss.status, path).toBe(404);
      expect(await miss.text(), path).not.toContain('operator-only');
    }
  });
});

describe('/scan packs', () => {
  it('range-reads neighborhood slices verbatim (default and focused)', async () => {
    await seedAtlas({ slug: 'acme__packs', versionId: 'v1', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT, 'container:a': NEIGHBORHOOD_A } } });
    const { backend, seen } = recordingBackend();
    const focused = await edgeFetch('/scan/acme__packs/neighborhood.json?focus=container:a', { backend });
    expect(focused.status).toBe(200);
    expect(focused.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await focused.text()).toBe(NEIGHBORHOOD_A);
    const unfocused = await edgeFetch('/scan/acme__packs/neighborhood.json', { backend });
    expect(await unfocused.text()).toBe(NEIGHBORHOOD_DEFAULT);
    // An invalid focus is "no focus", exactly like the server.
    const invalid = await edgeFetch('/scan/acme__packs/neighborhood.json?focus=..%2Fx', { backend });
    expect(await invalid.text()).toBe(NEIGHBORHOOD_DEFAULT);
    const pinned = await edgeFetch('/scan/acme__packs/neighborhood.json?focus=container:a&version=v1', { backend });
    expect(pinned.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(seen).toHaveLength(0);
  });

  it('404s a pack miss without a container (browse-only) and excerpts=1 always', async () => {
    await seedAtlas({ slug: 'acme__nocontainer', versionId: 'v7', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT } } });
    for (const path of [
      '/scan/acme__nocontainer/neighborhood.json?focus=code:zzz',
      '/scan/acme__nocontainer/neighborhood.json?excerpts=1',
    ]) {
      const response = await edgeFetch(path, { backend: undefined });
      expect(response.status, path).toBe(404);
      expect(await response.json(), path).toEqual({ error: 'not found' });
    }
    const { backend, seen } = recordingBackend();
    expect((await edgeFetch('/scan/acme__nocontainer/neighborhood.json?excerpts=1', { backend })).status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('with a container, sends a pack miss for a published atlas, pinned, rate-limited, headers stripped', async () => {
    await seedAtlas({ slug: 'acme__packmiss', versionId: 'v7', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT } } });
    const { backend, seen } = recordingBackend(() => new Response('{"from":"backend"}\n', {
      headers: { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-okie-ask-cost-usd': '1' },
    }));
    const keys: string[] = [];
    let allow = true;
    const limiter = { limit: async ({ key }: { key: string }) => { keys.push(key); return { success: allow }; } } as unknown as RateLimit;
    const env = { ASK_RATE_LIMITER: limiter };
    const init = { headers: { 'cf-connecting-ip': '2001:db8:5:6::9' } };
    const miss = await edgeFetch('/scan/acme__packmiss/neighborhood.json?focus=code:zzz', { backend, env, init });
    expect(await miss.text()).toBe('{"from":"backend"}\n');
    expect(miss.headers.get('set-cookie')).toBeNull();
    expect(miss.headers.get('x-okie-ask-cost-usd')).toBeNull();
    expect(seen.map(request => request.url)).toEqual(['http://backend.test/scan/acme__packmiss/neighborhood.json?focus=code%3Azzz&version=v7']);
    expect(keys).toEqual(['scan-miss:2001:db8:5:6::/64']);
    allow = false;
    const limited = await edgeFetch('/scan/acme__packmiss/neighborhood.json?focus=code:yyy', { backend, env, init });
    expect(limited.status).toBe(429);
    expect(seen).toHaveLength(1);
  });

  it('never forwards a pack miss for an unpublished slug (pinned version without latest.json)', async () => {
    await seedAtlas({ slug: 'acme__unlisted', versionId: 'v1', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT } }, latest: false });
    const { backend, seen } = recordingBackend();
    const response = await edgeFetch('/scan/acme__unlisted/neighborhood.json?focus=code:zzz&version=v1', { backend });
    expect(response.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it('proxies neighborhood to the container when the version has no pack at all', async () => {
    await seedAtlas({ slug: 'acme__nopack', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const { backend, seen } = recordingBackend();
    await edgeFetch('/scan/acme__nopack/neighborhood.json?version=v1', { backend });
    expect(seen.map(request => request.url)).toEqual(['http://backend.test/scan/acme__nopack/neighborhood.json?version=v1']);
  });

  it('does not negatively cache a missing pack index', async () => {
    await seedAtlas({ slug: 'acme__late', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    expect((await edgeFetch('/scan/acme__late/neighborhood.json?version=v1', { backend: undefined })).status).toBe(404);
    await seedAtlas({ slug: 'acme__late', versionId: 'v1', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT } } });
    const later = await edgeFetch('/scan/acme__late/neighborhood.json?version=v1', { backend: undefined });
    expect(later.status).toBe(200);
    expect(await later.text()).toBe(NEIGHBORHOOD_DEFAULT);
  });

  it('serves gzip packs as is to gzip clients (Content-Encoding: gzip) and inflated to others', async () => {
    await seedAtlas({
      slug: 'acme__gzip',
      versionId: 'v1',
      packEncoding: 'gzip',
      packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT, 'container:a': NEIGHBORHOOD_A }, excerpt: { 'code:a': EXCERPT_A } },
    });
    const gz = await edgeFetch('/scan/acme__gzip/neighborhood.json?focus=container:a', { backend: undefined, init: { headers: { 'accept-encoding': 'br, gzip' } } });
    expect(gz.status).toBe(200);
    expect(gz.headers.get('content-encoding')).toBe('gzip');
    expect(gz.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(gz.headers.get('vary')).toBe('Accept-Encoding');
    const bytes = await gz.arrayBuffer();
    expect(gz.headers.get('content-length')).toBe(String(bytes.byteLength));
    expect(new Uint8Array(bytes).slice(0, 2)).toEqual(new Uint8Array([0x1f, 0x8b]));
    expect(await gunzipText(bytes)).toBe(NEIGHBORHOOD_A);

    for (const acceptEncoding of [undefined, 'identity', 'gzip;q=0', 'br']) {
      const plain = await edgeFetch('/scan/acme__gzip/neighborhood.json', { backend: undefined, init: { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {} } });
      expect(plain.headers.get('content-encoding'), acceptEncoding).toBeNull();
      expect(plain.headers.get('vary')).toBe('Accept-Encoding');
      expect(await plain.text(), acceptEncoding).toBe(NEIGHBORHOOD_DEFAULT);
    }
    const excerpt = await edgeFetch('/scan/acme__gzip/excerpt.json?entity=code:a&version=v1', { backend: undefined });
    expect(await excerpt.text()).toBe(EXCERPT_A);
    const head = await edgeFetch('/scan/acme__gzip/neighborhood.json', { backend: undefined, init: { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-encoding')).toBe('gzip');
  });

  it('reads legacy pack indexes without an encoding field as identity', async () => {
    await seedAtlas({ slug: 'acme__legacy', versionId: 'v1', packEncoding: null, packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT } } });
    const response = await edgeFetch('/scan/acme__legacy/neighborhood.json', { init: { headers: { 'accept-encoding': 'gzip' } } });
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(await response.text()).toBe(NEIGHBORHOOD_DEFAULT);
  });

  it('parses Accept-Encoding', () => {
    const accepts = (value?: string) => acceptsGzip(new Request('http://x/', value === undefined ? {} : { headers: { 'accept-encoding': value } }));
    expect(accepts()).toBe(false);
    expect(accepts('gzip')).toBe(true);
    expect(accepts('gzip, deflate, br, zstd')).toBe(true);
    expect(accepts('GZIP;q=0.5')).toBe(true);
    expect(accepts('gzip;q=0')).toBe(false);
    expect(accepts('*')).toBe(true);
    expect(accepts('*;q=0')).toBe(false);
    expect(accepts('br, *;q=0.1')).toBe(true);
    expect(accepts('identity')).toBe(false);
  });

  it('serves excerpt hits and 404s misses without waking the container', async () => {
    await seedAtlas({ slug: 'acme__excerpt', versionId: 'v1', packs: { excerpt: { 'code:a': EXCERPT_A } } });
    const { backend, seen } = recordingBackend();
    const hit = await edgeFetch('/scan/acme__excerpt/excerpt.json?entity=code:a', { backend });
    expect(await hit.text()).toBe(EXCERPT_A);
    for (const path of ['/scan/acme__excerpt/excerpt.json?entity=code:b', '/scan/acme__excerpt/excerpt.json', '/scan/acme__excerpt/excerpt.json?entity=a%2Fb']) {
      expect((await edgeFetch(path, { backend })).status, path).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it('sanitizes focus ids exactly like apps/server scanNeighborhood.ts', () => {
    expect(sanitizeFocusId(null)).toBeUndefined();
    expect(sanitizeFocusId('  ')).toBeUndefined();
    expect(sanitizeFocusId(' container:a ')).toBe('container:a');
    expect(sanitizeFocusId('a/b')).toBeUndefined();
    expect(sanitizeFocusId('a\\b')).toBeUndefined();
    expect(sanitizeFocusId('a..b')).toBeUndefined();
    expect(sanitizeFocusId('a\u0000')).toBeUndefined();
    expect(sanitizeFocusId('x'.repeat(512))).toBe('x'.repeat(512));
    expect(sanitizeFocusId('x'.repeat(513))).toBeUndefined();
  });
});

describe('/scan pack slice revalidation (CLA-584)', () => {
  const NEIGHBORHOOD_V2 = `${JSON.stringify({ focus: null, entities: ['a', 'rescanned'] })}\n`;
  const gzipInit = (extra: Record<string, string> = {}) => ({ headers: { 'accept-encoding': 'gzip', ...extra } });

  it('gives a slice a weak ETag that is stable for the same version, entry and encoding', async () => {
    await seedAtlas({ slug: 'acme__etag', versionId: 'v1', packEncoding: 'gzip', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT, 'container:a': NEIGHBORHOOD_A } } });
    const first = await edgeFetch('/scan/acme__etag/neighborhood.json', { backend: undefined, init: gzipInit() });
    const etag = first.headers.get('etag');
    expect(etag).toMatch(new RegExp(`^W/"${PACK_SLICE_SERVING_FORMAT}-gz-[0-9a-f]{24}"$`));
    resetPackIndexCache();
    const again = await edgeFetch('/scan/acme__etag/neighborhood.json', { backend: undefined, init: gzipInit() });
    expect(again.headers.get('etag')).toBe(etag);
    const focused = await edgeFetch('/scan/acme__etag/neighborhood.json?focus=container:a', { backend: undefined, init: gzipInit() });
    expect(focused.headers.get('etag')).not.toBe(etag);
    const identity = await edgeFetch('/scan/acme__etag/neighborhood.json', { backend: undefined });
    expect(identity.headers.get('etag')).toMatch(/^W\/"s1-id-[0-9a-f]{24}"$/);
    expect(identity.headers.get('etag')).not.toBe(etag);
    const pinned = await edgeFetch('/scan/acme__etag/neighborhood.json?version=v1', { backend: undefined, init: gzipInit() });
    expect(pinned.headers.get('etag')).toBe(etag);
  });

  it('answers a matching If-None-Match with 304 (same cache headers, no body) before the range read', async () => {
    await seedAtlas({ slug: 'acme__304', versionId: 'v1', packEncoding: 'gzip', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT } } });
    for (const [label, init] of [['gzip', gzipInit()], ['identity', {}]] as const) {
      const path = '/scan/acme__304/neighborhood.json';
      const first = await edgeFetch(path, { backend: undefined, init });
      expect(first.status, label).toBe(200);
      const etag = first.headers.get('etag')!;
      const revalidated = await edgeFetch(path, { backend: undefined, init: { headers: { ...init.headers ?? {}, 'if-none-match': etag } } });
      expect(revalidated.status, label).toBe(304);
      expect(await revalidated.text(), label).toBe('');
      expect(revalidated.headers.get('etag'), label).toBe(etag);
      expect(revalidated.headers.get('cache-control'), label).toBe('public, max-age=60');
      expect(revalidated.headers.get('vary'), label).toBe('Accept-Encoding');
      expect(revalidated.headers.get(VERSION_HEADER), label).toBe('v1');
      expect(revalidated.headers.get('content-encoding'), label).toBeNull();
      // A stale or foreign validator is a full 200.
      const other = await edgeFetch(path, { backend: undefined, init: { headers: { ...init.headers ?? {}, 'if-none-match': 'W/"s0-gz-000000000000000000000000"' } } });
      expect(other.status, label).toBe(200);
    }
    // The encodings never validate each other: a gzip ETag sent by an identity client is a 200.
    const gzipTag = (await edgeFetch('/scan/acme__304/neighborhood.json', { backend: undefined, init: gzipInit() })).headers.get('etag')!;
    const crossed = await edgeFetch('/scan/acme__304/neighborhood.json', { backend: undefined, init: { headers: { 'if-none-match': gzipTag } } });
    expect(crossed.status).toBe(200);
    expect(await crossed.text()).toBe(NEIGHBORHOOD_DEFAULT);
    // The pack object itself is gone; the (cached) index still names the entry, so a 304 proves no range read ran.
    await edgeEnv.ATLAS_BUCKET.delete(publishedPackKey('acme__304', 'v1', 'neighborhood'));
    const noRead = await edgeFetch('/scan/acme__304/neighborhood.json', { backend: undefined, init: gzipInit({ 'if-none-match': gzipTag }) });
    expect(noRead.status).toBe(304);
  });

  it('a new latest.json version changes the ETag and sends the new body', async () => {
    await seedAtlas({ slug: 'acme__rescan', versionId: 'v1', packEncoding: 'gzip', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT } } });
    const path = '/scan/acme__rescan/neighborhood.json';
    const before = await edgeFetch(path, { backend: undefined, init: gzipInit() });
    const etag = before.headers.get('etag')!;
    // Same entry offsets and lengths in the new version would still change the tag: it names the version.
    await seedAtlas({ slug: 'acme__rescan', versionId: 'v2', packEncoding: 'gzip', packs: { neighborhood: { '': NEIGHBORHOOD_V2 } } });
    const after = await edgeFetch(path, { backend: undefined, init: gzipInit({ 'if-none-match': etag }) });
    expect(after.status).toBe(200);
    expect(after.headers.get(VERSION_HEADER)).toBe('v2');
    expect(after.headers.get('etag')).not.toBe(etag);
    expect(await gunzipText(await after.arrayBuffer())).toBe(NEIGHBORHOOD_V2);
    // The old version, pinned, still revalidates with its own tag and stays immutable.
    const pinnedOld = await edgeFetch(`${path}?version=v1`, { backend: undefined, init: gzipInit({ 'if-none-match': etag }) });
    expect(pinnedOld.status).toBe(304);
    expect(pinnedOld.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('HEAD carries the ETag and honours If-None-Match; excerpt slices revalidate too', async () => {
    await seedAtlas({ slug: 'acme__headtag', versionId: 'v1', packEncoding: 'gzip', packs: { neighborhood: { '': NEIGHBORHOOD_DEFAULT }, excerpt: { 'code:a': EXCERPT_A } } });
    const get = await edgeFetch('/scan/acme__headtag/neighborhood.json', { backend: undefined, init: gzipInit() });
    const head = await edgeFetch('/scan/acme__headtag/neighborhood.json', { backend: undefined, init: { method: 'HEAD', ...gzipInit() } });
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(get.headers.get('etag'));
    const headHit = await edgeFetch('/scan/acme__headtag/neighborhood.json', { backend: undefined, init: { method: 'HEAD', ...gzipInit({ 'if-none-match': get.headers.get('etag')! }) } });
    expect(headHit.status).toBe(304);
    const excerpt = await edgeFetch('/scan/acme__headtag/excerpt.json?entity=code:a&version=v1', { backend: undefined, init: gzipInit() });
    const excerptTag = excerpt.headers.get('etag')!;
    expect(excerptTag).toMatch(/^W\//);
    expect(excerptTag).not.toBe(get.headers.get('etag'));
    const excerptHit = await edgeFetch('/scan/acme__headtag/excerpt.json?entity=code:a&version=v1', { backend: undefined, init: gzipInit({ 'if-none-match': excerptTag }) });
    expect(excerptHit.status).toBe(304);
    expect(excerptHit.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('compares If-None-Match weakly, over lists and *', () => {
    const tag = 'W/"s1-gz-abc"';
    const request = (value?: string) => new Request('http://x/', value === undefined ? {} : { headers: { 'if-none-match': value } });
    expect(ifNoneMatchHits(request(), tag)).toBe(false);
    expect(ifNoneMatchHits(request(tag), tag)).toBe(true);
    expect(ifNoneMatchHits(request('"s1-gz-abc"'), tag)).toBe(true);
    expect(ifNoneMatchHits(request('"x", W/"s1-gz-abc"'), tag)).toBe(true);
    expect(ifNoneMatchHits(request('*'), tag)).toBe(true);
    expect(ifNoneMatchHits(request('W/"s1-id-abc"'), tag)).toBe(false);
  });
});
