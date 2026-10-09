import { describe, expect, it } from 'vitest';
import source from '../public/home.js?raw';
import { AUTH_SLOT_HTML, COOKIE_NOTICE_HTML, SCAN_REQUEST_HREF, COOKIE_NOTICE_STORAGE_KEY, COOKIE_NOTICE_TEXT, homeAtlasCards, homeCardMatches, homeCountText, homePageHtml, matchesAtWordStart, normalizeHomeQuery } from './homePage';

/**
 * CLA-269: apps/web/public/home.js, the home page's plain-script enhancement. The file is evaluated as the
 * browser would run it, with a `module` in scope so it hands back its functions instead of starting. The DOM
 * part runs against a minimal stand-in built from the server-rendered cards (this package has no jsdom).
 */
type HomeScript = {
  QUERY_MAX: number;
  URL_DELAY_MS: number;
  normalizeQuery(value: unknown): string;
  sortFrom(value: unknown): 'recent' | 'az';
  matchesAtWordStart(field: string, needle: string): boolean;
  matches(search: string, words: string, query: string): boolean;
  supported(doc: unknown): boolean;
  countText(shown: number, total: number, filtered: boolean): string;
  searchFor(search: string, query: string, sort: string): string;
  init(doc: unknown, win: unknown): { update(): unknown } | undefined;
  AUTH_ME_PATH: string;
  COOKIE_NOTICE_KEY: string;
  cookieNoticeAllowed(me: unknown): boolean;
  initCookieNotice(doc: unknown, win: unknown, me: unknown): unknown;
  authLinks(me: unknown): Array<{ text: string; href?: string }> | null;
  initAuth(doc: unknown, win: unknown): Promise<unknown> | undefined;
};

function loadScript(): HomeScript {
  const module = { exports: {} as HomeScript };
  new Function('module', 'window', source)(module, undefined);
  return module.exports;
}

const script = loadScript();

function row(slug: string, extra: Record<string, unknown> = {}) {
  const [owner, repo] = slug.split('__') as [string, string];
  return { slug, owner, repo, commitSha: '3fce3b5a1b2c3d4e5f60718293a4b5c6d7e8f901', generatedAt: '2026-09-01T00:00:00Z', publishedAt: '2026-09-01T00:00:00Z', entityCount: 10, license: { spdxId: 'MIT' }, ...extra };
}

const INDEX = {
  schema: 'okie.published-index/v1',
  schemaVersion: 1,
  repos: [
    row('pmndrs__zustand', { generatedAt: '2026-09-20T00:00:00Z', description: '🐻 Bear necessities for state management', language: 'TypeScript' }),
    row('burnt-sushi__ripgrep', { owner: 'burntsushi', ownerLogin: 'BurntSushi', repoName: 'ripgrep', generatedAt: '2026-08-04T00:00:00Z', language: 'Rust' }),
    row('source-for__atlas', { generatedAt: '2026-09-25T00:00:00Z', description: 'Maps <code>', language: 'TypeScript' }),
    row('ziglang__zig', { generatedAt: '2026-09-10T00:00:00Z', language: 'Zig' }),
  ],
};

/** Decodes the few entities escapeHtml writes (attribute values). */
const unescape = (value: string) => value.replace(/&#10;/g, '\n').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

class FakeElement {
  hidden = false;
  textContent = '';
  value = '';
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: { preventDefault(): void }) => void>>();
  children: FakeElement[] = [];
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  addEventListener(type: string, listener: (event: { preventDefault(): void }) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  dispatch(type: string): boolean {
    let prevented = false;
    for (const listener of this.listeners.get(type) ?? []) listener({ preventDefault: () => { prevented = true; } });
    return prevented;
  }
  appendChild(child: FakeElement) {
    this.children = [...this.children.filter(existing => existing !== child), child];
    return child;
  }
  querySelector(selector: string): FakeElement | null { return this.lookup.get(selector) ?? null; }
  querySelectorAll(selector: string): FakeElement[] { return selector === '.atlas' ? [...this.children] : []; }
  lookup = new Map<string, FakeElement>();
}

/** A stand-in page from the server-rendered HTML: the form controls, count, no-match line and cards (with their attributes and hidden state). */
function fakePage(html: string, url: string) {
  const list = new FakeElement();
  const cards = [...html.matchAll(/<li class="atlas" ([^>]*)>\s*<a class="card" href="([^"]+)"/g)].map(([, attributes, href]) => {
    const item = new FakeElement();
    for (const [, name, value] of attributes!.matchAll(/([a-z-]+)="([^"]*)"/g)) item.attributes.set(name!, unescape(value!));
    // The bare `hidden` attribute only: a " hidden " inside another attribute's value does not count.
    item.hidden = /(^| )hidden( |$)/.test(attributes!.replace(/"[^"]*"/g, '""'));
    item.attributes.set('href', href!);
    list.children.push(item);
    return item;
  });
  const input = new FakeElement();
  input.value = unescape(/name="q" value="([^"]*)"/.exec(html)![1]!);
  const select = new FakeElement();
  select.value = /<option value="(\w+)" selected>/.exec(html)![1]!;
  const form = new FakeElement();
  form.lookup.set('input[name="q"]', input);
  form.lookup.set('select[name="sort"]', select);
  const count = new FakeElement();
  count.textContent = /data-home-count>([^<]*)</.exec(html)![1]!;
  const empty = new FakeElement();
  empty.hidden = /data-home-no-match hidden/.test(html);
  const echo = new FakeElement();
  const doc = new FakeElement();
  doc.lookup.set('[data-home-search]', form);
  doc.lookup.set('.atlases', list);
  doc.lookup.set('[data-home-count]', count);
  doc.lookup.set('[data-home-no-match]', empty);
  doc.lookup.set('[data-home-query]', echo);
  const location = new URL(url);
  const history = { state: null, calls: [] as string[], replaceState(_state: unknown, _title: string, target: string) {
    this.calls.push(target);
    const next = new URL(target, location);
    location.search = next.search;
  } };
  // Manual timers: the URL write is debounced, and `flush()` runs whatever is pending.
  let timers: Array<{ id: number; run: () => void }> = [];
  let nextTimer = 1;
  const win = {
    location,
    history,
    setTimeout(run: () => void, _ms: number) { const id = nextTimer++; timers.push({ id, run }); return id; },
    clearTimeout(id: number) { timers = timers.filter(timer => timer.id !== id); },
  };
  const flush = () => { const due = timers; timers = []; for (const timer of due) timer.run(); };
  const pendingTimers = () => timers.length;
  const visible = () => list.children.filter(item => !item.hidden).map(item => item.getAttribute('href'));
  const order = () => list.children.map(item => item.getAttribute('href'));
  return { doc, win, list, cards, input, select, form, count, empty, echo, history, visible, order, flush, pendingTimers };
}

const ZWJ_MAGE = '\u{1F9D9}\u200D♀️';

describe('CLA-269 home.js: shared rules', () => {
  it('normalizes a search exactly like the server, keeping ZWJ emoji whole', () => {
    expect(script.QUERY_MAX).toBe(100);
    for (const value of ['  zu\tst \n', '\u202Ezu\u200Bst', '\u2066a\u2069\u200Eb\u200F\uFEFF', '', '   ', '🐻'.repeat(150), `  ${'x'.repeat(150)}  `, 'Zust', 'a\u0000b', ZWJ_MAGE, `a\u200Cb`, undefined, 42]) {
      expect(script.normalizeQuery(value), JSON.stringify(value)).toBe(normalizeHomeQuery(value));
    }
    expect(script.normalizeQuery(ZWJ_MAGE)).toBe(ZWJ_MAGE);
    expect(script.normalizeQuery('a\u200Cb')).toBe('a\u200Cb');
    expect(script.normalizeQuery('\u202Ezu\u200Bst')).toBe('zust');
  });

  it('matches names anywhere and description/language at word starts, like the server', () => {
    const cards = homeAtlasCards(INDEX);
    for (const q of ['zust', 'ZUST', 'burntsushi', 'BurntSushi/rip', 'typescript', 'rust', 'rip', 'script', 'type', 'ts', 'necess', 'bear', 'management', 'state man', 'code', '🐻', '<code>', 'zig zig', 'nothing', '']) {
      const query = normalizeHomeQuery(q);
      for (const card of cards) {
        expect(script.matches(card.search.join('\n'), card.searchWords.join('\n'), query), `${q} ${card.href}`).toBe(homeCardMatches(card, query));
      }
    }
    const hits = (q: string) => cards.filter(card => homeCardMatches(card, normalizeHomeQuery(q))).map(card => card.href);
    // "TypeScript" contains "rip", but not at a word start: only ripgrep (by name) matches.
    expect(hits('rip')).toEqual(['/r/burnt-sushi/ripgrep']);
    expect(hits('script')).toEqual([]);
    expect(hits('type')).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand']);
    // Word starts after a space, an emoji or `<`; not inside "necessities".
    expect(hits('necess')).toEqual(['/r/pmndrs/zustand']);
    expect(hits('bear')).toEqual(['/r/pmndrs/zustand']);
    expect(hits('code')).toEqual(['/r/source-for/atlas']);
    expect(hits('ssities')).toEqual([]);
    // Names still match anywhere: "sushi" is inside "burntsushi".
    expect(hits('sushi')).toEqual(['/r/burnt-sushi/ripgrep']);
    for (const [field, needle, expected] of [
      ['typescript', 'script', false], ['type script', 'script', true], ['type-script', 'script', true], ['typescript', 'type', true],
      ['café au lait', 'fé', false], ['🐻 bear', 'bear', true], ['a.b', 'b', true], ['x2y', 'y', false], ['scriptscript', 'script', true],
    ] as const) {
      expect(matchesAtWordStart(field, needle), `${field} ${needle}`).toBe(expected);
      expect(script.matchesAtWordStart(field, needle), `${field} ${needle}`).toBe(expected);
    }
    for (const [shown, total, filtered] of [[3, 7, true], [7, 7, false], [1, 1, false], [0, 1, true]] as const) {
      expect(script.countText(shown, total, filtered)).toBe(homeCountText(shown, total, filtered));
    }
    expect(script.sortFrom('az')).toBe('az');
    expect(script.sortFrom('popular')).toBe('recent');
  });

  it('builds the shareable query: defaults dropped, other params kept', () => {
    expect(script.searchFor('', '', 'recent')).toBe('');
    expect(script.searchFor('?q=old&sort=az', '', 'recent')).toBe('');
    expect(script.searchFor('', 'zu', 'recent')).toBe('?q=zu');
    expect(script.searchFor('', 'zu st', 'az')).toBe('?q=zu+st&sort=az');
    expect(script.searchFor('?utm_source=hn', '', 'az')).toBe('?utm_source=hn&sort=az');
  });

  it('holds no raw bidi or zero-width characters (they are written as \\u escapes)', () => {
    expect(source).not.toMatch(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/);
    expect(source).toContain(String.raw`/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g`);
  });
});

describe('CLA-269 home.js: in the page', () => {
  it('filters as you type, widening a server-filtered view, and keeps count, message and URL in sync', () => {
    const page = fakePage(homePageHtml({ index: INDEX, q: 'zust' }), 'https://sourcefor.dev/?q=zust');
    expect(page.visible()).toEqual(['/r/pmndrs/zustand']);
    script.init(page.doc, page.win);
    // Init keeps the server's view.
    expect(page.visible()).toEqual(['/r/pmndrs/zustand']);
    expect(page.count.textContent).toBe('1 of 4 atlases');

    page.input.value = 'typescript';
    page.input.dispatch('input');
    expect(page.visible()).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand']);
    expect(page.count.textContent).toBe('2 of 4 atlases');
    expect(page.empty.hidden).toBe(true);
    page.flush();
    expect(page.history.calls.at(-1)).toBe('/?q=typescript');

    page.input.value = 'rip';
    page.input.dispatch('input');
    expect(page.visible()).toEqual(['/r/burnt-sushi/ripgrep']);

    page.input.value = '';
    page.input.dispatch('input');
    expect(page.visible()).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand', '/r/ziglang/zig', '/r/burnt-sushi/ripgrep']);
    expect(page.count.textContent).toBe('4 atlases');
    page.flush();
    expect(page.history.calls.at(-1)).toBe('/');

    page.input.value = '  nope<b>  ';
    page.input.dispatch('input');
    expect(page.visible()).toEqual([]);
    expect(page.empty.hidden).toBe(false);
    expect(page.echo.textContent).toBe('nope<b>');
    expect(page.count.textContent).toBe('0 of 4 atlases');
    page.flush();
    expect(page.history.calls.at(-1)).toBe('/?q=nope%3Cb%3E');
  });

  it('debounces the URL: a burst of typing rewrites it once, with the last query', () => {
    const page = fakePage(homePageHtml({ index: INDEX }), 'https://sourcefor.dev/');
    script.init(page.doc, page.win);
    page.flush();
    expect(page.history.calls).toEqual([]);
    expect(script.URL_DELAY_MS).toBe(250);
    for (const value of ['z', 'zu', 'zus']) {
      page.input.value = value;
      page.input.dispatch('input');
    }
    // The view follows every keystroke; the URL waits.
    expect(page.visible()).toEqual(['/r/pmndrs/zustand']);
    expect(page.history.calls).toEqual([]);
    expect(page.pendingTimers()).toBe(1);
    page.flush();
    expect(page.history.calls).toEqual(['/?q=zus']);
    // A submit writes the URL at once (and cancels the pending write).
    page.input.value = 'zig';
    page.input.dispatch('input');
    expect(page.form.dispatch('submit')).toBe(true);
    expect(page.history.calls).toEqual(['/?q=zus', '/?q=zig']);
    expect(page.pendingTimers()).toBe(0);
  });

  it('re-sorts by moving the cards on a sort change, and the submit stays on the page', () => {
    const page = fakePage(homePageHtml({ index: INDEX }), 'https://sourcefor.dev/?utm_source=hn');
    script.init(page.doc, page.win);
    expect(page.order()).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand', '/r/ziglang/zig', '/r/burnt-sushi/ripgrep']);
    const before = [...page.cards];
    page.select.value = 'az';
    page.select.dispatch('change');
    expect(page.order()).toEqual(['/r/burnt-sushi/ripgrep', '/r/pmndrs/zustand', '/r/source-for/atlas', '/r/ziglang/zig']);
    // The same nodes, reordered (never re-rendered).
    expect(new Set(page.list.children)).toEqual(new Set(before));
    page.flush();
    expect(page.win.location.search).toBe('?utm_source=hn&sort=az');
    expect(page.order()).toEqual(homeAtlasCards(INDEX).map(card => card.href).sort());

    page.input.value = 'rust';
    expect(page.form.dispatch('submit')).toBe(true);
    expect(page.visible()).toEqual(['/r/burnt-sushi/ripgrep']);
    expect(page.win.location.search).toBe('?utm_source=hn&q=rust&sort=az');

    page.select.value = 'recent';
    page.select.dispatch('change');
    expect(page.order()).toEqual(['/r/source-for/atlas', '/r/pmndrs/zustand', '/r/ziglang/zig', '/r/burnt-sushi/ripgrep']);
    page.flush();
    expect(page.win.location.search).toBe('?utm_source=hn&q=rust');
  });

  it('drops an unknown sort from the URL and does nothing on a page without a directory', () => {
    const page = fakePage(homePageHtml({ index: INDEX, sort: 'popular' }), 'https://sourcefor.dev/?sort=popular');
    script.init(page.doc, page.win);
    page.flush();
    expect(page.history.calls).toEqual(['/']);
    expect(script.init(new FakeElement(), page.win)).toBeUndefined();
  });

  it('bails before touching the form when the browser lacks what it needs, so the GET form still submits', () => {
    const page = fakePage(homePageHtml({ index: INDEX, q: 'zust' }), 'https://sourcefor.dev/?q=zust');
    const doc = Object.assign(Object.create(FakeElement.prototype) as FakeElement, page.doc, { querySelectorAll: undefined });
    expect(script.supported(doc)).toBe(false);
    expect(script.init(doc, page.win)).toBeUndefined();
    // No listener was attached: a submit is not prevented, and the view is the server's.
    expect(page.form.dispatch('submit')).toBe(false);
    expect(page.visible()).toEqual(['/r/pmndrs/zustand']);
    expect(page.history.calls).toEqual([]);
    expect(script.supported(page.doc)).toBe(true);
    const forEach = Array.prototype.forEach;
    try {
      (Array.prototype as { forEach?: unknown }).forEach = undefined;
      expect(script.supported(page.doc)).toBe(false);
    } finally {
      Array.prototype.forEach = forEach;
    }
  });

  it('reads the hidden attribute only, not a " hidden " inside another attribute value', () => {
    const html = homePageHtml({ index: { ...INDEX, repos: [row('acme__app', { description: 'a hidden gem' })] } });
    expect(html).toContain('data-search-words="a hidden gem"');
    const page = fakePage(html, 'https://sourcefor.dev/');
    expect(page.visible()).toEqual(['/r/acme/app']);
  });
});

/** A tiny DOM for the sign-in slot: elements that record children, attributes and text. */
class SlotNode {
  hidden = true;
  textContent = '';
  readonly attributes = new Map<string, string>();
  children: SlotNode[] = [];
  constructor(readonly tag: string) {}
  get firstChild() { return this.children[0] ?? null; }
  removeChild(child: SlotNode) { this.children = this.children.filter(existing => existing !== child); return child; }
  appendChild(child: SlotNode) { this.children.push(child); return child; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  text() { return this.children.map(child => child.textContent).join(' '); }
}

function authPage(me: unknown, options: { ok?: boolean; fail?: boolean; slot?: boolean } = {}) {
  const slot = new SlotNode('nav');
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const doc = {
    querySelector: (selector: string) => (selector === '[data-auth-slot]' && options.slot !== false ? slot : null),
    createElement: (tag: string) => new SlotNode(tag),
  };
  const win = {
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (options.fail) throw new Error('offline');
      return { ok: options.ok !== false, json: async () => me };
    },
  };
  return { slot, doc, win, calls };
}

describe('CLA-316 home.js: the sign-in slot', () => {
  it('ships hidden and empty in the home HTML when accounts are on (with or without atlases), so the page works without JS', () => {
    expect(AUTH_SLOT_HTML).toBe('<nav class="site-auth" aria-label="Account" data-auth-slot hidden></nav>');
    for (const index of [INDEX, undefined]) {
      const html = homePageHtml({ index, accounts: true });
      expect(html).toContain(`<header class="site-header">\n      ${AUTH_SLOT_HTML}\n    </header>`);
      expect(html).toContain('.site-auth[hidden]{display:none}');
      expect(html).toContain('<script src="/home.js" defer></script>');
      // CLA-455: the hero's ask goes to the account page's request form, not email.
      expect(html).toContain(`Want your repo mapped? <a href="${SCAN_REQUEST_HREF}" data-scan-request-link>Request a scan</a>`);
      expect(html).not.toContain('Want your repo mapped? <a href="mailto:');
    }
    expect(SCAN_REQUEST_HREF).toBe('/account#request-scan');
  });

  it('leaves the home exactly as before when accounts are off: no slot, no slot CSS, no script on an empty directory', () => {
    for (const index of [INDEX, undefined]) {
      const html = homePageHtml({ index });
      expect(html).toBe(homePageHtml({ index, accounts: false }));
      expect(html).not.toContain('data-auth-slot');
      expect(html).not.toContain('site-header');
      expect(html).not.toContain('site-auth');
      expect(html).not.toContain('data-scan-request-link');
    }
    expect(homePageHtml({ index: undefined })).not.toMatch(/<script/i);
  });

  it('stays hidden when accounts are off, the request fails, or there is no slot', async () => {
    for (const [me, options] of [
      [{ authenticated: false, mode: 'public', oauthConfigured: false, ask: false }, {}],
      [{ oauthConfigured: true }, { ok: false }],
      [{ oauthConfigured: true }, { fail: true }],
      ['<!doctype html>', {}],
    ] as const) {
      const page = authPage(me, options);
      await script.initAuth(page.doc, page.win);
      expect(page.slot.hidden).toBe(true);
      expect(page.slot.children).toEqual([]);
    }
    const noSlot = authPage({ oauthConfigured: true }, { slot: false });
    expect(script.initAuth(noSlot.doc, noSlot.win)).toBeUndefined();
    expect(noSlot.calls).toEqual([]);
    // The directory test pages (no createElement, no fetch) are left alone too.
    expect(script.initAuth(new FakeElement(), {})).toBeUndefined();
  });

  it('shows "Sign in with GitHub" signed out, and "@login · Account · Sign out" signed in, from same-origin paths only', async () => {
    const signedOut = authPage({ authenticated: false, mode: 'accounts', oauthConfigured: true, loginPath: '/api/auth/github', logoutPath: '/api/auth/logout', accountPath: '/account', ask: false });
    await script.initAuth(signedOut.doc, signedOut.win);
    expect(signedOut.calls).toEqual([{ url: '/api/auth/me', init: { credentials: 'same-origin', headers: { accept: 'application/json' } } }]);
    expect(signedOut.slot.hidden).toBe(false);
    expect(signedOut.slot.children.map(node => [node.tag, node.textContent, node.attributes.get('href')])).toEqual([['a', 'Sign in with GitHub', '/api/auth/github?return=/']]);

    const signedIn = authPage({ authenticated: true, login: '<img src=x>', mode: 'accounts', oauthConfigured: true, loginPath: '/api/auth/github', logoutPath: '//evil.example', accountPath: 'https://evil.example/account' });
    await script.initAuth(signedIn.doc, signedIn.win);
    expect(signedIn.slot.children.filter(node => node.attributes.get('aria-hidden') !== 'true').map(node => [node.tag, node.textContent, node.attributes.get('href')])).toEqual([
      // textContent, never HTML.
      ['span', '@<img src=x>', undefined],
      ['a', 'Account', '/account'],
      ['a', 'Sign out', '/api/auth/logout?return=/'],
    ]);
  });
});

const CONFIGURED = { authenticated: false, mode: 'accounts', oauthConfigured: true };

describe('CLA-316 home.js: the cookie notice', () => {
  function noticePage(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void } | 'throws' | undefined) {
    const notice = new FakeElement();
    notice.hidden = true;
    const button = new FakeElement();
    notice.lookup.set('[data-cookie-notice-dismiss]', button);
    const classes = new Set<string>();
    const doc = new FakeElement();
    doc.lookup.set('[data-cookie-notice]', notice);
    (doc as unknown as { body: unknown }).body = { classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) } };
    const win = storage === 'throws'
      ? Object.defineProperty({}, 'localStorage', { get() { throw new Error('SecurityError'); } })
      : { localStorage: storage };
    return { doc, win, notice, button, classes };
  }
  const memory = () => {
    const values = new Map<string, string>();
    return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  };

  it('ships hidden in the home HTML (so nothing shows without JS), with a Privacy link and an OK button', () => {
    const html = homePageHtml({ index: INDEX, accounts: true });
    expect(html).toContain(COOKIE_NOTICE_HTML);
    expect(COOKIE_NOTICE_HTML).toContain('role="region" aria-label="Cookie notice" data-cookie-notice hidden>');
    expect(COOKIE_NOTICE_HTML).toContain(`<p>${COOKIE_NOTICE_TEXT}</p>`);
    expect(COOKIE_NOTICE_HTML).toContain('<a href="/privacy">Privacy</a>');
    expect(COOKIE_NOTICE_HTML).toContain('<button type="button" data-cookie-notice-dismiss>OK</button>');
    expect(script.COOKIE_NOTICE_KEY).toBe(COOKIE_NOTICE_STORAGE_KEY);
    expect(COOKIE_NOTICE_STORAGE_KEY).toBe('sf.cookieNotice.dismissed');
    // With accounts on, an empty directory still loads home.js, so it gets the notice too. Accounts off: no
    // notice at all (no sign-in, no cookies), even though the directory still loads home.js.
    expect(homePageHtml({ index: undefined, accounts: true })).toContain('data-cookie-notice hidden');
    expect(homePageHtml({ index: undefined })).not.toContain('data-cookie-notice');
    expect(homePageHtml({ index: INDEX })).not.toContain('cookie-notice');
  });

  it('reveals it, and OK hides it and remembers the dismissal', () => {
    const storage = memory();
    const page = noticePage(storage);
    expect(script.initCookieNotice(page.doc, page.win, CONFIGURED)).toBe(page.notice);
    expect(page.notice.hidden).toBe(false);
    expect(page.classes.has('has-cookie-notice')).toBe(true);
    page.button.dispatch('click');
    expect(page.notice.hidden).toBe(true);
    expect(page.classes.has('has-cookie-notice')).toBe(false);
    expect(storage.values.get('sf.cookieNotice.dismissed')).toBe('1');
    // Next page load: stays hidden.
    const next = noticePage(storage);
    expect(script.initCookieNotice(next.doc, next.win, CONFIGURED)).toBeUndefined();
    expect(next.notice.hidden).toBe(true);
  });

  it('shows it when storage throws, and OK still hides it for the page', () => {
    const page = noticePage('throws');
    script.initCookieNotice(page.doc, page.win, CONFIGURED);
    expect(page.notice.hidden).toBe(false);
    page.button.dispatch('click');
    expect(page.notice.hidden).toBe(true);
    const failingSet = noticePage({ getItem: () => null, setItem: () => { throw new Error('QuotaExceeded'); } });
    script.initCookieNotice(failingSet.doc, failingSet.win, CONFIGURED);
    failingSet.button.dispatch('click');
    expect(failingSet.notice.hidden).toBe(true);
  });

  it('does nothing on a page without the notice', () => {
    expect(script.initCookieNotice(new FakeElement(), {}, CONFIGURED)).toBeUndefined();
  });

  it('shows only when /api/auth/me answers oauthConfigured: true (fail closed)', () => {
    expect(script.cookieNoticeAllowed(CONFIGURED)).toBe(true);
    for (const me of [null, undefined, '<!doctype html>', {}, { oauthConfigured: false }, { oauthConfigured: 'true' }, { authenticated: false, mode: 'public', oauthConfigured: false, ask: false }]) {
      expect(script.cookieNoticeAllowed(me)).toBe(false);
      const page = noticePage(memory());
      expect(script.initCookieNotice(page.doc, page.win, me)).toBeUndefined();
      expect(page.notice.hidden).toBe(true);
      expect(page.classes.has('has-cookie-notice')).toBe(false);
    }
  });

  it('initAuth reveals it from the same single request, and never when accounts are off or the request fails', async () => {
    const withFetch = (me: unknown, options: { ok?: boolean; fail?: boolean } = {}) => {
      const page = noticePage(memory());
      const calls: string[] = [];
      Object.assign(page.doc, { createElement: () => new FakeElement() });
      Object.assign(page.win, {
        fetch: async (url: string) => {
          calls.push(url);
          if (options.fail) throw new Error('offline');
          return { ok: options.ok !== false, json: async () => me };
        },
      });
      return { ...page, calls };
    };
    const on = withFetch({ authenticated: false, mode: 'accounts', oauthConfigured: true });
    await script.initAuth(on.doc, on.win);
    expect(on.calls).toEqual(['/api/auth/me']);
    expect(on.notice.hidden).toBe(false);
    for (const [me, options] of [
      [{ authenticated: false, mode: 'public', oauthConfigured: false, ask: false }, {}],
      [{ oauthConfigured: true }, { ok: false }],
      [{ oauthConfigured: true }, { fail: true }],
      ['<!doctype html>', {}],
    ] as const) {
      const off = withFetch(me, options);
      await script.initAuth(off.doc, off.win);
      expect(off.calls).toEqual(['/api/auth/me']);
      expect(off.notice.hidden).toBe(true);
    }
  });
});
