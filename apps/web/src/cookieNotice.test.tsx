import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import source from './cookieNotice.tsx?raw';
import {
  COOKIE_NOTICE_STORAGE_KEY,
  COOKIE_NOTICE_TEXT,
  AUTH_ME_PATH,
  CookieNotice,
  cookieNoticeAllowedByAuthMe,
  cookieNoticeDismissed,
  fetchCookieNoticeAllowed,
  mountCookieNotice,
  dismissCookieNotice,
  initialCookieNoticeVisible,
  noticeStorage,
  rememberCookieNoticeDismissed,
  shouldShowCookieNotice,
  type NoticeStorage,
} from './cookieNotice';

/**
 * CLA-316 SPA cookie notice. The decisions are pure functions (tested here in node); the component is a thin
 * shell over them, checked as static markup.
 */

function memoryStorage(): NoticeStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

const throwingStorage: NoticeStorage = {
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
};

describe('CLA-316 SPA cookie notice: where it shows', () => {
  const at = (pathname: string, search = '', extra: { framed?: boolean; portable?: boolean } = {}) =>
    shouldShowCookieNotice({ pathname, search, framed: extra.framed ?? false, portable: extra.portable ?? false });

  it('shows on hosted atlases, the landing and paths the SPA does not route', () => {
    expect(at('/r/pmndrs/zustand')).toBe(true);
    expect(at('/r/pmndrs/zustand/main', '?nav=1&z=0.75')).toBe(true);
    expect(at('/new')).toBe(true);
    expect(at('/no-such-page')).toBe(true);
  });

  it('never in embeds (?embed=1 or framed), the portable viewer, the operator workspace or the demos', () => {
    expect(at('/r/pmndrs/zustand', '?embed=1')).toBe(false);
    expect(at('/r/pmndrs/zustand', '', { framed: true })).toBe(false);
    expect(at('/r/pmndrs/zustand', '', { portable: true })).toBe(false);
    expect(at('/', '?portable=1', { portable: true })).toBe(false);
    expect(at('/operator')).toBe(false);
    expect(at('/operator/')).toBe(false);
    expect(at('/')).toBe(false);
    expect(at('/', '?fixture=okie')).toBe(false);
    expect(at('/r/THISS/okie', '?fixture=scan')).toBe(false);
  });
});

describe('CLA-316 SPA cookie notice: only when sign-in is configured', () => {
  it('allows it only for an /api/auth/me answer with oauthConfigured: true', () => {
    expect(cookieNoticeAllowedByAuthMe({ authenticated: false, mode: 'accounts', oauthConfigured: true })).toBe(true);
    expect(cookieNoticeAllowedByAuthMe({ authenticated: true, login: 'octocat', oauthConfigured: true })).toBe(true);
    for (const body of [null, undefined, '', '<!doctype html>', 1, [], {}, { oauthConfigured: false }, { oauthConfigured: 'true' }, { oauthConfigured: 1 }, { authenticated: false, mode: 'public', oauthConfigured: false, ask: false }]) {
      expect(cookieNoticeAllowedByAuthMe(body)).toBe(false);
    }
  });

  it('asks /api/auth/me same-origin, and fails closed on a network error, a non-2xx, bad JSON or no fetch', async () => {
    const calls: Array<[string, RequestInit]> = [];
    const answering = (body: unknown, ok = true) => async (input: string, init: RequestInit) => {
      calls.push([input, init]);
      return { ok, json: async () => body };
    };
    expect(await fetchCookieNoticeAllowed(answering({ oauthConfigured: true }))).toBe(true);
    expect(calls).toEqual([[AUTH_ME_PATH, { credentials: 'same-origin', headers: { accept: 'application/json' } }]]);
    expect(AUTH_ME_PATH).toBe('/api/auth/me');
    expect(await fetchCookieNoticeAllowed(answering({ authenticated: false, mode: 'public', oauthConfigured: false, ask: false }))).toBe(false);
    expect(await fetchCookieNoticeAllowed(answering({ oauthConfigured: true }, false))).toBe(false);
    expect(await fetchCookieNoticeAllowed(async () => ({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } }))).toBe(false);
    expect(await fetchCookieNoticeAllowed(async () => { throw new TypeError('Failed to fetch'); })).toBe(false);
    expect(await fetchCookieNoticeAllowed(() => { throw new TypeError('sync'); })).toBe(false);
    expect(await fetchCookieNoticeAllowed(undefined)).toBe(false);
  });

  it('mountCookieNotice asks only after the page checks pass, and mounts nothing unless the answer allows it', async () => {
    const fakeWindow = (pathname: string, body: unknown, storage: NoticeStorage = memoryStorage()) => {
      const calls: string[] = [];
      const win: Record<string, unknown> = {
        location: { pathname, search: '' },
        localStorage: storage,
        fetch: async (input: string) => { calls.push(input); return { ok: true, json: async () => body }; },
        // No document: reaching the mount step would throw, so false here proves nothing was mounted.
      };
      win.self = win;
      win.top = win;
      return { win: win as unknown as Window, calls };
    };
    const operator = fakeWindow('/operator', { oauthConfigured: true });
    expect(await mountCookieNotice({ portable: false }, operator.win)).toBe(false);
    expect(operator.calls).toEqual([]);
    const portable = fakeWindow('/r/pmndrs/zustand', { oauthConfigured: true });
    expect(await mountCookieNotice({ portable: true }, portable.win)).toBe(false);
    expect(portable.calls).toEqual([]);
    const dismissed = memoryStorage();
    dismissCookieNotice(dismissed);
    const seen = fakeWindow('/r/pmndrs/zustand', { oauthConfigured: true }, dismissed);
    expect(await mountCookieNotice({ portable: false }, seen.win)).toBe(false);
    expect(seen.calls).toEqual([]);
    const accountsOff = fakeWindow('/r/pmndrs/zustand', { authenticated: false, mode: 'public', oauthConfigured: false, ask: false });
    expect(await mountCookieNotice({ portable: false }, accountsOff.win)).toBe(false);
    expect(accountsOff.calls).toEqual(['/api/auth/me']);
  });
});

describe('CLA-316 SPA cookie notice: remembering the dismissal', () => {
  it('starts visible, and OK stores sf.cookieNotice.dismissed=1 so the next page starts hidden', () => {
    const storage = memoryStorage();
    expect(COOKIE_NOTICE_STORAGE_KEY).toBe('sf.cookieNotice.dismissed');
    expect(initialCookieNoticeVisible(storage)).toBe(true);
    expect(dismissCookieNotice(storage)).toBe(false);
    expect(storage.values.get(COOKIE_NOTICE_STORAGE_KEY)).toBe('1');
    expect(cookieNoticeDismissed(storage)).toBe(true);
    expect(initialCookieNoticeVisible(storage)).toBe(false);
    // Only "1" counts.
    storage.values.set(COOKIE_NOTICE_STORAGE_KEY, 'yes');
    expect(initialCookieNoticeVisible(storage)).toBe(true);
  });

  it('storage that throws (or is missing): shown, and OK still hides it for the page without throwing', () => {
    expect(initialCookieNoticeVisible(throwingStorage)).toBe(true);
    expect(() => rememberCookieNoticeDismissed(throwingStorage)).not.toThrow();
    expect(dismissCookieNotice(throwingStorage)).toBe(false);
    expect(initialCookieNoticeVisible(undefined)).toBe(true);
    expect(dismissCookieNotice(undefined)).toBe(false);
    // Reading window.localStorage itself can throw (blocked site data, opaque sandbox): OK hides it for this page only.
    const blocked = noticeStorage(Object.defineProperty({}, 'localStorage', { get() { throw new Error('SecurityError'); } }));
    expect(initialCookieNoticeVisible(blocked)).toBe(true);
    expect(dismissCookieNotice(blocked)).toBe(false);
    expect(initialCookieNoticeVisible(blocked)).toBe(false);
    const storage = memoryStorage() as unknown as Storage;
    rememberCookieNoticeDismissed(noticeStorage({ localStorage: storage }));
    expect(storage.getItem(COOKIE_NOTICE_STORAGE_KEY)).toBe('1');
  });
});

describe('CLA-316 SPA cookie notice: markup', () => {
  it('renders a labelled region with the text, a Privacy link and an OK button; nothing once dismissed', () => {
    const html = renderToStaticMarkup(<CookieNotice storage={memoryStorage()}/>);
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Cookie notice"');
    expect(html).toContain(`<p>${COOKIE_NOTICE_TEXT}</p>`);
    expect(html).toContain('<a href="/privacy">Privacy</a>');
    expect(html).toContain('<button type="button">OK</button>');
    const dismissed = memoryStorage();
    dismissCookieNotice(dismissed);
    expect(renderToStaticMarkup(<CookieNotice storage={dismissed}/>)).toBe('');
    expect(renderToStaticMarkup(<CookieNotice storage={throwingStorage}/>)).toContain('aria-label="Cookie notice"');
  });

  it('imports nothing server-only (homePage/openGraph pull node:zlib into the browser bundle)', () => {
    expect(source).not.toMatch(/from '\.\/(homePage|openGraph|atlasCard|privacyPage|termsPage|accountPage)'/);
  });
});
