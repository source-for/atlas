import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { browserStorage } from './browserStorage';
import { isFramedBrowsingContext } from './embedCanvas';
import { isEmbedChrome, isEmbedQueryFlag } from './embedChrome';
import { isKnownAppPath } from './notFoundPage';
import { parseAppRoute } from './renderer/route';
// siteMeta, not homePage: homePage pulls the server-only OG card renderer (node:zlib) into the bundle.
import { COOKIE_NOTICE_STORAGE_KEY, COOKIE_NOTICE_TEXT, PRIVACY_PATH } from './siteMeta';

/**
 * The cookie notice in the SPA (CLA-316): the same words and dismissal key as the edge-rendered home
 * (homePage.ts + home.js). Mounted by main.tsx in its own root outside App, as a bar fixed to the bottom.
 * While it shows, `html[data-cookie-notice]` and `--cookie-notice-height` (its measured height) shrink the
 * atlas root, or pad a document page, so it never covers the canvas's bottom controls or the attribution
 * strip (app.css). Informational only (every cookie is strictly necessary), so no consent state. Shown only
 * when the edge's /api/auth/me answers `oauthConfigured: true`: without sign-in there are no cookies to
 * mention (and the local Vite server, or any failed request, shows nothing).
 */

export { COOKIE_NOTICE_STORAGE_KEY, COOKIE_NOTICE_TEXT };
export const COOKIE_NOTICE_ATTRIBUTE = 'data-cookie-notice';
export const COOKIE_NOTICE_HEIGHT_VAR = '--cookie-notice-height';

export type NoticeStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The page's localStorage; when it is blocked, a dismissal lasts for this page only (CLA-610). */
export function noticeStorage(win: { localStorage?: Storage } = window): NoticeStorage {
  return browserStorage('localStorage', win);
}

export function cookieNoticeDismissed(storage: NoticeStorage | undefined): boolean {
  try {
    return storage?.getItem(COOKIE_NOTICE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberCookieNoticeDismissed(storage: NoticeStorage | undefined): void {
  try {
    storage?.setItem(COOKIE_NOTICE_STORAGE_KEY, '1');
  } catch {
    // Storage refused: dismissed for this page only.
  }
}

export type CookieNoticeLocation = {
  pathname: string;
  search: string;
  /** Inside an iframe (an oEmbed embed). */
  framed: boolean;
  /** The self-hosted portable viewer (bootPlan `portable`). */
  portable: boolean;
};

/**
 * Where the SPA shows it: hosted pages people land on (`/r/...` atlases, the `/new` landing, and any path
 * the SPA does not route, i.e. the in-app 404). Never in embeds (framed or `?embed=1`), the portable viewer,
 * the operator workspace (`/operator`), or the golden/demo shell (`/` and any `?fixture=`).
 */
export function shouldShowCookieNotice(location: CookieNoticeLocation): boolean {
  if (location.portable) return false;
  if (isEmbedChrome({ framed: location.framed, embedQuery: isEmbedQueryFlag(location.search) })) return false;
  if (new URLSearchParams(location.search).has('fixture')) return false;
  const { pathname } = location;
  if (pathname === '/' || pathname === '/index.html' || pathname === '/operator' || pathname === '/operator/') return false;
  if (pathname === '/new' || pathname === '/new/') return true;
  // `/r/<owner>/<repo>` atlases, and paths the SPA does not route (its in-app 404).
  return isKnownAppPath(pathname) ? routeKind(pathname) === 'repo' : true;
}

function routeKind(pathname: string): string | undefined {
  try {
    return parseAppRoute(pathname).kind;
  } catch {
    return undefined;
  }
}

/** Same-origin: the edge Worker answers it (the public shape, `oauthConfigured: false`, when accounts are off). */
export const AUTH_ME_PATH = '/api/auth/me';

/** Whether an /api/auth/me answer allows the notice: only `oauthConfigured: true` (fail closed). */
export function cookieNoticeAllowedByAuthMe(body: unknown): boolean {
  return typeof body === 'object' && body !== null && (body as { oauthConfigured?: unknown }).oauthConfigured === true;
}

type AuthMeFetch = (input: string, init: RequestInit) => Promise<Pick<Response, 'ok' | 'json'>>;

/** Asks /api/auth/me (same-origin); any failure (network, non-2xx, not JSON) means no notice. */
export async function fetchCookieNoticeAllowed(fetchImpl: AuthMeFetch | undefined): Promise<boolean> {
  if (typeof fetchImpl !== 'function') return false;
  try {
    const response = await fetchImpl(AUTH_ME_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } });
    return response.ok ? cookieNoticeAllowedByAuthMe(await response.json()) : false;
  } catch {
    return false;
  }
}

/** Whether the notice starts visible: shown unless the dismissal is stored (storage that throws = shown). */
export function initialCookieNoticeVisible(storage: NoticeStorage | undefined): boolean {
  return !cookieNoticeDismissed(storage);
}

/** OK: remember the dismissal (best effort) and hide. Returns the new visibility (always false). */
export function dismissCookieNotice(storage: NoticeStorage | undefined): false {
  rememberCookieNoticeDismissed(storage);
  return false;
}

/** A thin shell over {@link initialCookieNoticeVisible} / {@link dismissCookieNotice}. `doc` defaults to the page (read in the effect only). */
export function CookieNotice({ storage, doc }: { storage: NoticeStorage | undefined; doc?: Document }) {
  const [visible, setVisible] = useState(() => initialCookieNoticeVisible(storage));
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const page = doc ?? document;
    const root = page.documentElement;
    if (!visible) return undefined;
    root.setAttribute(COOKIE_NOTICE_ATTRIBUTE, '');
    const measure = () => {
      const height = ref.current?.offsetHeight ?? 0;
      if (height > 0) root.style.setProperty(COOKIE_NOTICE_HEIGHT_VAR, `${height}px`);
    };
    measure();
    const view = page.defaultView as (Window & { ResizeObserver?: typeof ResizeObserver }) | null;
    const observer = view?.ResizeObserver && ref.current ? new view.ResizeObserver(measure) : undefined;
    if (observer && ref.current) observer.observe(ref.current);
    return () => {
      observer?.disconnect();
      root.removeAttribute(COOKIE_NOTICE_ATTRIBUTE);
      root.style.removeProperty(COOKIE_NOTICE_HEIGHT_VAR);
    };
  }, [visible, doc]);
  if (!visible) return null;
  return <div aria-label="Cookie notice" className="cookie-notice" data-testid="cookie-notice" ref={ref} role="region">
    <p>{COOKIE_NOTICE_TEXT}</p>
    <a href={PRIVACY_PATH}>Privacy</a>
    <button onClick={() => setVisible(dismissCookieNotice(storage))} type="button">OK</button>
  </div>;
}

/**
 * Mount the notice in its own root (outside App) when this page should show it, it was not dismissed, and
 * /api/auth/me says sign-in is configured (asked only after the local checks pass). Resolves to whether it mounted.
 */
export async function mountCookieNotice(options: { portable: boolean }, win: Window = window): Promise<boolean> {
  const location = {
    pathname: win.location.pathname,
    search: win.location.search,
    framed: isFramedBrowsingContext(win as unknown as { self: unknown; top: unknown }),
    portable: options.portable,
  };
  if (!shouldShowCookieNotice(location)) return false;
  const storage = noticeStorage(win);
  if (!initialCookieNoticeVisible(storage)) return false;
  if (!await fetchCookieNoticeAllowed(typeof win.fetch === 'function' ? win.fetch.bind(win) : undefined)) return false;
  const doc = win.document;
  const host = doc.createElement('div');
  host.id = 'cookie-notice-root';
  doc.body.append(host);
  createRoot(host).render(<CookieNotice doc={doc} storage={storage}/>);
  return true;
}
