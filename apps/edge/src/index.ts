import { homeHttpOutput, homeSearchFrom, homeViewFrom, isHomeRequest } from '../../web/src/homePage';
import { isKnownAppPath, notFoundHttpOutput } from '../../web/src/notFoundPage';
import { oembedAllowedOriginsFromEnv } from '../../web/src/oembed';
import { PUBLISHED_INDEX_SCHEMA } from '../../server/src/publishedStoreLayout';
import { securityHeadersFor } from '../../web/src/securityHeaders';
import { webMcpHostHeadersForFetchDest } from '../../web/src/webmcpHeaders';
import { analyticsConditionalRequest, injectsInto, webAnalyticsToken, withWebAnalytics } from './analytics';
import { handleApiRoute } from './api';
import { handleAgentReadRequest } from './agentReadHttp';
import { ACCOUNT_PATH, accountsEnabled, handleAccountPage, privacyCookies } from './auth';
import { privacyHttpOutput } from '../../web/src/privacyPage';
import { PRIVACY_PATH, TERMS_PATH } from '../../web/src/siteMeta';
import { termsHttpOutput } from '../../web/src/termsPage';
import { selectBackend, type Backend } from './backend';
import type { EdgeEnv } from './env';
import { defaultGuards, type Guard } from './guards';
import { NOINDEX_ROBOTS_TXT, notFoundJson, ROBOTS_TAG } from './http';
import { readPublishedIndex } from './publishedIndexCache';
import { handleScanRoute } from './scan';
import { handleShareRoute, isPublicAtlasRoutePath } from './share';
import { handleSitemapRequest, SITEMAP_PATH } from './sitemap';
import { DEV_STORE_PREFIX, handleStoreRead, storeKeyFromPath } from './store';

export { AtlasBudget } from './budget';
export { AtlasApiContainer } from './container';
// Required by @cloudflare/containers for outbound interception (the atlas-store.internal handler).
export { ContainerProxy } from '@cloudflare/containers';

/**
 * sourcefor.dev edge Worker (CLA-266). Static assets (apps/web/dist) are served by Workers Static
 * Assets behind this handler (`run_worker_first: true`, so every request reaches it first):
 *
 *   www.*                     301 to the canonical origin
 *   /robots.txt               disallow-all when ROBOTS_NOINDEX=1 (staging; also X-Robots-Tag on everything)
 *   /sitemap.xml              `/` and every published atlas from index.json (sitemap.ts)
 *   /assets/*                 Static Assets, but a missing hashed asset is 404 no-store, never the SPA shell
 *   /scan/*                   published atlases from R2 (scan.ts), source.json via GitHub raw (source.ts)
 *   /r/*, /og/*, /oembed      share pages (share.ts)
 *   /new, /new/               GET/HEAD: 301 to `/` keeping only the home's allowlisted query params
 *                             (homeSearchFrom; the directory moved to the home, CLA-269);
 *                             other methods as before (share.ts landing handler: 405, OPTIONS 204)
 *   /api/*                    GitHub sign-in (/api/auth/*, /api/account/*; auth.ts, CLA-316: off without its
 *                             secrets + USERS_DB, then auth/me is the public shape and the rest 404); Ask
 *                             status answered here; with ASK_ENABLED=1, Ask + block-plan → container behind
 *                             guards (api.ts), else 404
 *                             POST /api/operator/ask-usage: an account's daily Ask count, shown or reset
 *                             for a caller holding a one-time operator grant (operator.ts, CLA-539); 404 otherwise
 *   /__store/*                DEV_STORE_ROUTE=1 only (local mirror for a locally run apps/server)
 *   /, /index.html            GET/HEAD with no query, or only `q`/`sort`/`utm_*`/`ref`/`fbclid`/`gclid`
 *                             (isHomeRequest): the server-rendered home page, hero + directory of published
 *                             atlases from index.json, searched/sorted by `q`/`sort` (apps/web/src/homePage.ts,
 *                             CLA-269; /home.js, a Static Asset, filters in place). Any other query
 *                             (`?fixture=okie`, `?portable=1`, `?embed=1`, deep-nav state) or method: the SPA
 *                             shell as before, so the golden demo stays at `/?fixture=okie`
 *   /account                  signed-in account page (email, product-updates opt-in, delete; auth.ts +
 *                             apps/web/src/accountPage.ts); while accounts are off, like any unknown path
 *   /privacy                  GET/HEAD: the privacy page (apps/web/src/privacyPage.ts), always
 *   /terms                    GET/HEAD: the terms of use (apps/web/src/termsPage.ts), always
 *   /operator                 the SPA shell (Static Assets)
 *   anything else             a real static file (favicons, robots.txt, og-default.png) from Static
 *                             Assets; otherwise the branded 404 page with a real 404 (CLA-318)
 *
 * Every response leaves through {@link withEdgeHeaders}: nosniff + Referrer-Policy everywhere, a CSP on
 * HTML (frame-ancestors `*` on /r/... for oEmbed, 'self' elsewhere; securityHeaders.ts), and staging's
 * X-Robots-Tag. With `WEB_ANALYTICS_TOKEN` set, every HTML document also gets the Cloudflare Web
 * Analytics beacon before `</body>` (analytics.ts).
 */

export type EdgeDeps = {
  /** undefined = no container / dev backend (the browse-only deploy). */
  backend: Backend | undefined;
  guards: readonly Guard[];
  now: () => Date;
  /** Upstream fetch for source.json; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Cache API override (tests); defaults to `caches.default`. */
  cache?: Cache;
};

export function defaultDeps(env: EdgeEnv): EdgeDeps {
  return { backend: selectBackend(env), guards: defaultGuards(), now: () => new Date() };
}

/**
 * `www.<canonical host>` → 301 to the same path + query on `OKIE_PUBLIC_ORIGIN` (production binds both
 * sourcefor.dev and www.sourcefor.dev). Checked before anything else; the Worker runs first for every
 * path (`run_worker_first: true`), so this covers `/assets/*` too.
 */
export function canonicalHostRedirect(url: URL, env: Pick<EdgeEnv, 'OKIE_PUBLIC_ORIGIN'>): Response | undefined {
  const raw = env.OKIE_PUBLIC_ORIGIN?.trim();
  if (!raw) return undefined;
  let canonical: URL;
  try { canonical = new URL(raw); } catch { return undefined; }
  if (url.hostname.toLowerCase() !== `www.${canonical.hostname.toLowerCase()}`) return undefined;
  return new Response(null, {
    status: 301,
    headers: { location: `${canonical.origin}${url.pathname}${url.search}`, 'cache-control': 'public, max-age=3600' },
  });
}

function noindex(env: Pick<EdgeEnv, 'ROBOTS_NOINDEX'>): boolean {
  return env.ROBOTS_NOINDEX?.trim() === '1';
}

/**
 * `/assets/*` through Static Assets. With `not_found_handling: single-page-application` a missing
 * hashed asset (e.g. a chunk of the previous build, requested by a page loaded before a deploy) would
 * come back as index.html with 200 and the immutable `/assets/*` cache header, and a browser would
 * keep that wrong "script" for a year. Vite never emits HTML under /assets, so an HTML answer there
 * is the SPA fallback: turn it into an uncacheable 404. Cost: every /assets request is now a Worker
 * invocation (Workers Paid; a pass-through to env.ASSETS, negligible CPU).
 */
async function serveHashedAsset(request: Request, env: EdgeEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const type = response.headers.get('content-type') ?? '';
  // Any HTML status counts (a 304 revalidating index.html's ETag included).
  if (/^text\/html\b/i.test(type)) {
    return new Response(request.method === 'HEAD' ? null : 'not found\n', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
  return response;
}

export async function handleEdgeRequest(request: Request, env: EdgeEnv, ctx: ExecutionContext, deps: EdgeDeps = defaultDeps(env)): Promise<Response> {
  const response = await routeEdgeRequest(request, env, ctx, deps);
  return withEdgeHeaders(request, withWebAnalytics(request, response, env), env);
}

/**
 * Security headers on every response (CLA-318) and, on staging, the crawler opt-out. Always a copy:
 * responses fetched from Static Assets, R2 or upstream have immutable headers. A copy keeps the status,
 * statusText, headers (`_headers` rules included) and body stream as-is, so redirects, 204/304 (no
 * body) and HEAD answers pass through unchanged. A 101 WebSocket upgrade is returned untouched (a copy
 * would drop its socket).
 */
function withEdgeHeaders(request: Request, response: Response, env: Pick<EdgeEnv, 'ROBOTS_NOINDEX' | 'WEB_ANALYTICS_TOKEN'>): Response {
  if (response.status === 101 || response.webSocket) return response;
  const out = new Response(response.body, response);
  const url = new URL(request.url);
  // The CSP allows the Web Analytics beacon only on pages that carry it.
  const webAnalytics = webAnalyticsToken(env) !== undefined && injectsInto(url);
  for (const [name, value] of Object.entries(securityHeadersFor(url.pathname, out.headers.get('content-type'), { webAnalytics }))) {
    // A route that chose its own policy keeps it.
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  if (noindex(env)) out.headers.set('x-robots-tag', ROBOTS_TAG);
  return out;
}

async function routeEdgeRequest(request: Request, env: EdgeEnv, ctx: ExecutionContext, deps: EdgeDeps): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const waitUntil = (promise: Promise<unknown>) => ctx.waitUntil(promise);

  const redirect = canonicalHostRedirect(url, env);
  if (redirect) return redirect;

  if (pathname === '/robots.txt' && noindex(env)) {
    return new Response(request.method === 'HEAD' ? null : NOINDEX_ROBOTS_TXT, {
      headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }
  if (pathname === SITEMAP_PATH) return handleSitemapRequest(request, env);
  if (pathname === '/docs/agents' || pathname === '/docs/agents.html') return env.ASSETS.fetch(request);
  if (pathname === '/mcp' || pathname === '/api/atlas/query') return handleAgentReadRequest(request, env);
  if (pathname.startsWith('/assets/')) return serveHashedAsset(request, env);
  if (pathname.startsWith('/scan/')) {
    return handleScanRoute(request, {
      bucket: env.ATLAS_BUCKET,
      backend: deps.backend,
      env,
      waitUntil,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...('cache' in deps ? { cache: deps.cache } : {}),
    });
  }
  if (pathname.startsWith('/api/')) {
    return handleApiRoute(request, env, { backend: deps.backend, guards: deps.guards, now: deps.now, waitUntil, ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  }
  if (pathname.startsWith(DEV_STORE_PREFIX)) {
    if (env.DEV_STORE_ROUTE !== '1') return notFoundJson();
    const key = storeKeyFromPath(pathname, DEV_STORE_PREFIX);
    return key === undefined ? notFoundJson() : handleStoreRead(request, env.ATLAS_BUCKET, key);
  }
  const method = request.method.toUpperCase();
  const readOnly = method === 'GET' || method === 'HEAD';
  if (readOnly && (pathname === '/new' || pathname === '/new/')) {
    // Only the home's allowlisted params survive, so an old `/new?<other>` link still lands on the home, not the SPA.
    return new Response(null, { status: 301, headers: { location: `/${homeSearchFrom(url)}`, 'cache-control': 'public, max-age=3600' } });
  }
  if (readOnly && isHomeRequest(url)) return serveHome(request, url, env);
  if (readOnly && (pathname === PRIVACY_PATH || pathname === `${PRIVACY_PATH}/`)) return servePrivacy(request, url, env);
  if (readOnly && (pathname === TERMS_PATH || pathname === `${TERMS_PATH}/`)) return serveTerms(request, url, env);
  // Only while accounts are on; otherwise /account falls through like any unknown path (CLA-316).
  if ((pathname === ACCOUNT_PATH || pathname === `${ACCOUNT_PATH}/`) && accountsEnabled(env, url)) {
    return handleAccountPage(request, env, { now: deps.now(), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
  }
  if (isPublicAtlasRoutePath(pathname)) {
    const shared = await handleShareRoute(request, env, { waitUntil, ...('cache' in deps ? { cache: deps.cache } : {}) });
    if (shared) return shared;
  }
  if (isKnownAppPath(pathname)) return env.ASSETS.fetch(analyticsConditionalRequest(request, env));
  return serveStaticFileOr404(request, env);
}

/**
 * `/privacy` (CLA-316), whether or not accounts are on. Its cookie table is built from the cookies auth.ts
 * really sets (names + lifetimes), so the page cannot drift from the code.
 */
function servePrivacy(request: Request, url: URL, env: EdgeEnv): Response {
  const page = privacyHttpOutput(request.method, {
    cookies: privacyCookies(),
    requestOrigin: url.origin,
    allowedOrigins: oembedAllowedOriginsFromEnv({ OKIE_PUBLIC_ORIGIN: env.OKIE_PUBLIC_ORIGIN }),
  });
  return new Response(page.body === '' ? null : page.body, { status: page.status, headers: page.headers });
}

/** `/terms` (CLA-316), whether or not accounts are on; built like `/privacy`. */
function serveTerms(request: Request, url: URL, env: EdgeEnv): Response {
  const page = termsHttpOutput(request.method, {
    requestOrigin: url.origin,
    allowedOrigins: oembedAllowedOriginsFromEnv({ OKIE_PUBLIC_ORIGIN: env.OKIE_PUBLIC_ORIGIN }),
  });
  return new Response(page.body === '' ? null : page.body, { status: page.status, headers: page.headers });
}

/**
 * The parsed indexes whose skipped rows were already logged. readPublishedIndex hands back the same object while it
 * is cached, so each index read (at most one a minute per isolate) is reported once.
 */
const warnedHomeIndexes = new WeakSet<object>();

/**
 * The home page (CLA-269), rendered here from the published index (per-isolate cache), filtered and
 * sorted by `?q=` / `?sort=` (every card is rendered; non-matches are `hidden`, so /home.js can widen the
 * view). A missing, unreadable or foreign-schema index still answers 200 with the hero and an
 * empty-directory note. An index row the directory cannot show (its slug has no canonical path) is logged
 * with console.warn, so a published atlas never drops off the home silently: once per cached index per isolate
 * ({@link warnedHomeIndexes}), not on every request.
 */
async function serveHome(request: Request, url: URL, env: EdgeEnv): Promise<Response> {
  const index = await readPublishedIndex(env.ATLAS_BUCKET) as { schema?: unknown } | undefined;
  const view = homeViewFrom(url);
  const page = homeHttpOutput(request.method, {
    index: index?.schema === PUBLISHED_INDEX_SCHEMA ? index : undefined,
    q: view.q,
    sort: view.sort,
    requestOrigin: url.origin,
    allowedOrigins: oembedAllowedOriginsFromEnv({ OKIE_PUBLIC_ORIGIN: env.OKIE_PUBLIC_ORIGIN }),
    // Config-dependent only (never the user), so the page stays shared-cacheable.
    accounts: accountsEnabled(env, url),
  });
  if (page.skipped.length && index && typeof index === 'object' && !warnedHomeIndexes.has(index)) {
    warnedHomeIndexes.add(index);
    for (const row of page.skipped) {
      console.warn(`home: index row ${JSON.stringify(row.slug)} not listed (${row.reason})`);
    }
  }
  const headers = new Headers(page.headers);
  // WebMCP host headers, as share.ts gives its HTML (and `_headers` gave the static `/`): Permissions-Policy
  // always, Origin-Agent-Cluster unless the page is framed.
  for (const [name, value] of Object.entries(webMcpHostHeadersForFetchDest(request.headers.get('sec-fetch-dest') ?? undefined))) {
    headers.set(name, value);
  }
  return new Response(page.body === '' ? null : page.body, { status: page.status, headers });
}

/**
 * A path the SPA does not route (CLA-318). Real files in apps/web/dist (favicons, robots.txt,
 * og-default.png…) are served as-is; `_headers` is never served (Static Assets excludes it). Anything
 * else would come back as the SPA shell with 200 (`not_found_handling: single-page-application`):
 * dist has no HTML besides index.html, so an HTML answer here is that fallback, and it becomes the
 * branded 404 page with a real status (short shared cache; HEAD without a body).
 */
async function serveStaticFileOr404(request: Request, env: EdgeEnv): Promise<Response> {
  const response = await env.ASSETS.fetch(request);
  const type = response.headers.get('content-type') ?? '';
  // Any HTML status counts, like /assets/* (a 304 revalidating index.html's ETag included).
  if (!/^text\/html\b/i.test(type)) return response;
  const page = notFoundHttpOutput(request.method);
  return new Response(page.body === '' ? null : page.body, { status: page.status, headers: page.headers });
}

export default {
  fetch(request, env, ctx) {
    return handleEdgeRequest(request, env, ctx);
  },
} satisfies ExportedHandler<EdgeEnv>;
