import { describe, expect, it } from 'vitest';
import { atlasCardLayout } from '../../web/src/atlasCard';
import { contentSecurityPolicy } from '../../web/src/securityHeaders';
import { publishedIndexKey } from '../../server/src/publishedStoreLayout';
import { PUBLISHED_INDEX_CACHE_TTL_MS, readPublishedIndex, resetPublishedIndexCache } from '../src/publishedIndexCache';
import { escapeXml, renderSitemap, sitemapUrls } from '../src/sitemap';
import { edgeEnv, edgeFetch, seedAtlas, seedIndex } from './helpers';

const FRAMABLE = contentSecurityPolicy({ framable: true });
const SELF_ONLY = contentSecurityPolicy({ framable: false });

/** CLA-318: security headers on every response, a CSP on HTML only. */
describe('security headers at the edge', () => {
  it('the CSP allows what the app loads and nothing broader', () => {
    // Web Analytics sources only with a token (analytics.test.ts); this suite runs without one.
    expect(SELF_ONLY).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(SELF_ONLY).toContain("connect-src 'self' https://raw.githubusercontent.com;");
    expect(SELF_ONLY).not.toContain('cloudflareinsights');
    expect(SELF_ONLY).toContain("object-src 'none'");
    expect(SELF_ONLY).toContain("base-uri 'self'");
    expect(SELF_ONLY).toContain("form-action 'self'");
    expect(SELF_ONLY).toContain("frame-ancestors 'self'");
    expect(FRAMABLE).not.toContain('frame-ancestors'); // any parent, file:/data:/blob:/sandboxed included
    expect(FRAMABLE).toBe(SELF_ONLY.replace("; frame-ancestors 'self'", ''));
    expect(SELF_ONLY).not.toContain("'unsafe-eval'");
    expect(SELF_ONLY).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  it('HTML documents get the CSP; atlas pages may be framed by any site, other pages only by this origin', async () => {
    await seedAtlas({ slug: 'acme__shared', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const cases: Array<[string, number, string]> = [
      ['/', 200, SELF_ONLY], // the home page (CLA-269)
      ['/index.html', 200, SELF_ONLY],
      ['/?fixture=okie', 200, SELF_ONLY], // the SPA shell
      ['/operator', 200, SELF_ONLY],
      ['/zzz', 404, SELF_ONLY], // branded 404
      ['/r/acme/shared', 200, FRAMABLE],
      ['/r/acme/shared?embed=1', 200, FRAMABLE],
      ['/r/acme/shared/main/src', 200, FRAMABLE],
      ['/r/THISS/okie', 200, FRAMABLE],
      ['/r/nobody/unpublished', 404, FRAMABLE], // the atlas 404 renders inside an embed too
    ];
    for (const [path, status, csp] of cases) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(status);
      expect(response.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(response.headers.get('content-security-policy'), path).toBe(csp);
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('x-frame-options'), path).toBeNull();
    }
    // Framed atlas views keep the WebMCP headers (and drop origin-keying) alongside the CSP.
    const framed = await edgeFetch('/r/acme/shared?embed=1', { init: { headers: { 'sec-fetch-dest': 'iframe' } } });
    expect(framed.headers.get('permissions-policy')).toBe('tools=(self)');
    expect(framed.headers.get('origin-agent-cluster')).toBeNull();
    expect(framed.headers.get('content-security-policy')).toBe(FRAMABLE);
    // HEAD keeps its headers and no body.
    const head = await edgeFetch('/r/acme/shared', { init: { method: 'HEAD' } });
    expect(head.headers.get('content-security-policy')).toBe(FRAMABLE);
    expect(await head.text()).toBe('');
  });

  it('non-HTML responses get nosniff + Referrer-Policy but no CSP; statuses, bodies and cache headers are unchanged', async () => {
    await seedAtlas({ slug: 'acme__shared', versionId: 'v1', files: { 'snapshot.json': '{"ok":true}' } });
    const cases: Array<[string, number]> = [
      ['/assets/index-abc123.js', 200],
      ['/assets/missing.js', 404],
      ['/favicon.svg', 200],
      ['/robots.txt', 200],
      ['/sitemap.xml', 200],
      ['/scan/acme__shared/snapshot.json', 200],
      ['/scan/nobody__here/snapshot.json', 404],
      ['/api/auth/me', 200],
      ['/og/acme/shared', 200],
      ['/oembed?url=http%3A%2F%2F127.0.0.1%3A4196%2Fr%2Facme%2Fshared', 200],
    ];
    for (const [path, status] of cases) {
      const response = await edgeFetch(path);
      expect(response.status, path).toBe(status);
      expect(response.headers.get('x-content-type-options'), path).toBe('nosniff');
      expect(response.headers.get('referrer-policy'), path).toBe('strict-origin-when-cross-origin');
      expect(response.headers.get('content-security-policy'), path).toBeNull();
    }
    const asset = await edgeFetch('/assets/index-abc123.js');
    expect(asset.headers.get('cache-control')).toBe('public, max-age=31536000, immutable'); // _headers still applies
    expect((await edgeFetch('/scan/acme__shared/snapshot.json')).headers.get('cache-control')).toBe('public, max-age=60');
    expect(await (await edgeFetch('/scan/acme__shared/snapshot.json')).text()).toBe('{"ok":true}');
  });

  it('redirects and conditional 304s pass through with the headers and no body', async () => {
    const www = await edgeFetch('https://www.sourcefor.dev/new?x=1', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } });
    expect(www.status).toBe(301);
    expect(www.headers.get('location')).toBe('https://sourcefor.dev/new?x=1');
    expect(www.headers.get('x-content-type-options')).toBe('nosniff');
    await seedAtlas({ slug: 'acme__shared', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    const first = await edgeFetch('/scan/acme__shared/snapshot.json');
    const etag = first.headers.get('etag')!;
    const notModified = await edgeFetch('/scan/acme__shared/snapshot.json', { init: { headers: { 'if-none-match': etag } } });
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await notModified.text()).toBe('');
  });

  it('staging keeps X-Robots-Tag alongside the security headers', async () => {
    const response = await edgeFetch('/', { env: { ROBOTS_NOINDEX: '1' } });
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(response.headers.get('content-security-policy')).toBe(SELF_ONLY);
  });
});

describe('sitemap.xml at the edge', () => {
  it('lists / (lastmod = newest publish) and each published atlas on the canonical origin, never /new', async () => {
    await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), JSON.stringify({
      schema: 'okie.published-index/v1',
      schemaVersion: 1,
      repos: [
        { slug: 'pmndrs__zustand', owner: 'pmndrs', repo: 'zustand', publishedAt: '2026-09-01T10:00:00Z' },
        { slug: 'burnt-sushi__ripgrep', owner: 'burntsushi', repo: 'ripgrep', ownerLogin: 'BurntSushi', repoName: 'ripgrep', publishedAt: '2026-09-20T08:30:00.000Z' },
        { slug: 'no-date__repo', owner: 'no-date', repo: 'repo' },
        { slug: 'bad__slug__extra', owner: 'bad', repo: 'slug', publishedAt: '2026-09-02T00:00:00Z' },
        { slug: 'Upper__Case', owner: 'Upper', repo: 'Case' },
        null,
      ],
    }));
    const response = await edgeFetch('/sitemap.xml', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    expect(await response.text()).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://sourcefor.dev/</loc>
    <lastmod>2026-09-20T08:30:00.000Z</lastmod>
  </url>
  <url>
    <loc>https://sourcefor.dev/privacy</loc>
    <lastmod>2026-10-10</lastmod>
  </url>
  <url>
    <loc>https://sourcefor.dev/terms</loc>
    <lastmod>2026-09-30</lastmod>
  </url>
  <url>
    <loc>https://sourcefor.dev/r/burnt-sushi/ripgrep</loc>
    <lastmod>2026-09-20T08:30:00.000Z</lastmod>
  </url>
  <url>
    <loc>https://sourcefor.dev/r/no-date/repo</loc>
  </url>
  <url>
    <loc>https://sourcefor.dev/r/pmndrs/zustand</loc>
    <lastmod>2026-09-01T10:00:00.000Z</lastmod>
  </url>
</urlset>
`);
    const head = await edgeFetch('/sitemap.xml', { init: { method: 'HEAD' } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('application/xml; charset=utf-8');
    expect(await head.text()).toBe('');
    expect((await edgeFetch('/sitemap.xml', { init: { method: 'POST' } })).status).toBe(405);
  });

  it('uses OKIE_PUBLIC_ORIGIN (staging) and falls back to production; a missing or broken index still lists /', async () => {
    await edgeEnv.ATLAS_BUCKET.delete(publishedIndexKey());
    const staging = await (await edgeFetch('/sitemap.xml', { env: { OKIE_PUBLIC_ORIGIN: 'https://staging.sourcefor.dev/' } })).text();
    expect(staging).toContain('<loc>https://staging.sourcefor.dev/</loc>');
    expect(staging).not.toContain('/new');
    const fallback = await (await edgeFetch('/sitemap.xml', { env: { OKIE_PUBLIC_ORIGIN: '' } })).text();
    // `/`, `/privacy` and `/terms` (CLA-316).
    expect(fallback.match(/<url>/g)).toHaveLength(3);
    expect(fallback).toContain('<loc>https://sourcefor.dev/</loc>\n  </url>'); // no lastmod without a publish
    await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), 'not json');
    const broken = await edgeFetch('/sitemap.xml', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } });
    expect(broken.status).toBe(200);
    expect((await broken.text()).match(/<url>/g)).toHaveLength(3);
    await seedIndex([]);
    expect((await (await edgeFetch('/sitemap.xml')).text()).match(/<url>/g)).toHaveLength(3);
  });

  it('escapes XML', () => {
    expect(escapeXml(`a&b<c>"d"'e'`)).toBe('a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
    const xml = renderSitemap([{ loc: 'https://x.test/?a=1&b=<2>', lastmod: '2026-09-30T00:00:00.000Z' }]);
    expect(xml).toContain('<loc>https://x.test/?a=1&amp;b=&lt;2&gt;</loc>');
    // Only slugs that map straight back to themselves are listed, so a row can't inject path text.
    expect(sitemapUrls({ schema: 'okie.published-index/v1', repos: [{ slug: 'a&b__c' }, { slug: '../x__y' }] }, 'https://sourcefor.dev').map(url => url.loc)).toEqual(['https://sourcefor.dev/', 'https://sourcefor.dev/privacy', 'https://sourcefor.dev/terms']);
  });
});

/** CLA-318: titles, oEmbed and cards use GitHub's casing from the published row; canonical URLs stay slug-form. */
describe('GitHub casing on share surfaces', () => {
  it('uses ownerLogin/repoName from index.json when present, the stored names otherwise', async () => {
    await seedAtlas({ slug: 'burnt-sushi__ripgrep', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    await seedAtlas({ slug: 'acme__shared', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), JSON.stringify({
      schema: 'okie.published-index/v1',
      schemaVersion: 1,
      repos: [
        { slug: 'burnt-sushi__ripgrep', owner: 'burntsushi', repo: 'ripgrep', ownerLogin: 'BurntSushi', repoName: 'ripgrep' },
        { slug: 'acme__shared', owner: 'acme', repo: 'shared' },
      ],
    }));
    const html = await (await edgeFetch('/r/burnt-sushi/ripgrep')).text();
    expect(html).toContain('<title>ripgrep by BurntSushi · Source For Atlas</title>');
    expect(html).toContain('<meta property="og:title" content="ripgrep by BurntSushi · Source For Atlas" />');
    expect(html).toContain('Explore how BurntSushi/ripgrep is built');
    expect(html).toContain('<link rel="canonical" href="https://sourcefor.dev/r/burnt-sushi/ripgrep" />');
    expect(html).toContain('content="http://127.0.0.1:4196/og/burnt-sushi/ripgrep"');
    const oembed = await (await edgeFetch(`/oembed?url=${encodeURIComponent('http://127.0.0.1:4196/r/burnt-sushi/ripgrep')}`)).json<{ title: string; html: string }>();
    expect(oembed.title).toBe('BurntSushi/ripgrep architecture atlas');
    expect(oembed.html).toContain('src="http://127.0.0.1:4196/r/burnt-sushi/ripgrep?embed=1"');
    expect(atlasCardLayout({ owner: 'burnt-sushi', repo: 'ripgrep', label: { owner: 'BurntSushi', repo: 'ripgrep' } }).title).toBe('BurntSushi/ripgrep');
    expect((await edgeFetch('/og/burnt-sushi/ripgrep')).status).toBe(200);
    // Fallback: no names recorded → the stored names.
    expect(await (await edgeFetch('/r/acme/shared')).text()).toContain('<title>shared by acme · Source For Atlas</title>');
    // No row at all (dogfood) → the URL's names, as before.
    expect(await (await edgeFetch('/r/THISS/okie')).text()).toContain('<title>okie by THISS · Source For Atlas</title>');
  });
});

describe('per-isolate index.json cache', () => {
  it('reads R2 at most once per TTL; a missing index is cached, a failed read is not', async () => {
    resetPublishedIndexCache();
    let gets = 0;
    let body: string | undefined = '{"schema":"okie.published-index/v1","repos":[]}';
    let fail = false;
    const bucket = {
      async get(key: string) {
        gets += 1;
        expect(key).toBe(publishedIndexKey());
        if (fail) throw new Error('r2 down');
        return body === undefined ? null : { json: async () => JSON.parse(body!) };
      },
    } as unknown as R2Bucket;
    expect(await readPublishedIndex(bucket, 1_000)).toEqual({ schema: 'okie.published-index/v1', repos: [] });
    body = '{"schema":"okie.published-index/v1","repos":[{"slug":"a__b"}]}';
    expect(await readPublishedIndex(bucket, 1_000 + PUBLISHED_INDEX_CACHE_TTL_MS - 1)).toEqual({ schema: 'okie.published-index/v1', repos: [] });
    expect(gets).toBe(1);
    expect(await readPublishedIndex(bucket, 1_000 + PUBLISHED_INDEX_CACHE_TTL_MS)).toMatchObject({ repos: [{ slug: 'a__b' }] });
    expect(gets).toBe(2);
    body = undefined;
    expect(await readPublishedIndex(bucket, 200_000)).toBeUndefined();
    expect(await readPublishedIndex(bucket, 200_001)).toBeUndefined();
    expect(gets).toBe(3);
    resetPublishedIndexCache();
    fail = true;
    expect(await readPublishedIndex(bucket, 300_000)).toBeUndefined();
    fail = false;
    body = '{"repos":[]}';
    expect(await readPublishedIndex(bucket, 300_001)).toEqual({ repos: [] });
    expect(gets).toBe(5);
  });

  it('share pages and the sitemap reuse the cached index across requests', async () => {
    await seedAtlas({ slug: 'burnt-sushi__ripgrep', versionId: 'v1', files: { 'snapshot.json': '{}' } });
    await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), JSON.stringify({ schema: 'okie.published-index/v1', schemaVersion: 1, repos: [{ slug: 'burnt-sushi__ripgrep', owner: 'burntsushi', repo: 'ripgrep', ownerLogin: 'BurntSushi', repoName: 'ripgrep' }] }));
    expect(await (await edgeFetch('/r/burnt-sushi/ripgrep')).text()).toContain('ripgrep by BurntSushi');
    // Rewritten index: the same isolate keeps serving the cached one until the TTL passes.
    await edgeEnv.ATLAS_BUCKET.put(publishedIndexKey(), JSON.stringify({ schema: 'okie.published-index/v1', schemaVersion: 1, repos: [] }));
    expect(await (await edgeFetch('/r/burnt-sushi/ripgrep', { keepIndexCache: true })).text()).toContain('ripgrep by BurntSushi');
    expect(await (await edgeFetch('/sitemap.xml', { keepIndexCache: true })).text()).toContain('/r/burnt-sushi/ripgrep');
    expect(await (await edgeFetch('/sitemap.xml')).text()).not.toContain('/r/burnt-sushi/ripgrep');
  });
});
