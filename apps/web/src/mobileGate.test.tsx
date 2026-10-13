import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  MOBILE_NOTICE_SESSION_KEY,
  MobileNotice,
  isPhoneSizedTouchViewport,
  mobileNoticeCopy,
  mobileNoticeDismissed,
  readMobileGateInput,
  readPhoneViewportInput,
  rememberMobileNoticeDismissed,
  shouldShowMobileNotice,
  type MobileGateInput,
} from './mobileGate';
import { parseAppRoute } from './renderer/route';
import { CONTACT_EMAIL, GITHUB_REPO_URL, HOME_DESCRIPTION, repoPageDescription } from './siteMeta';

const desktop: MobileGateInput = { width: 1440, height: 900, coarsePointer: false, noHover: false, framed: false, embedQuery: false, dismissed: false };
const touch = { coarsePointer: true, noHover: true };

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

describe('CLA-318 small-screen notice', () => {
  it('shows only on touch-primary devices: below 720px wide, or a phone held landscape', () => {
    expect(shouldShowMobileNotice(desktop)).toBe(false);
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 390, height: 844 })).toBe(true);
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 719 })).toBe(true);
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 720 })).toBe(false);
    // Either signal counts as touch-primary.
    expect(shouldShowMobileNotice({ ...desktop, coarsePointer: true, width: 390 })).toBe(true);
    expect(shouldShowMobileNotice({ ...desktop, noHover: true, width: 390 })).toBe(true);
    // iPhone landscape: wide but short.
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 844, height: 390 })).toBe(true);
    // Tablets are fine.
    expect(shouldShowMobileNotice({ ...desktop, ...touch, width: 1024, height: 768 })).toBe(false);
  });

  it('never shows in a desktop window, however narrow or short (mouse + hover)', () => {
    for (const [width, height] of [[390, 844], [719, 900], [844, 390], [320, 320]]) {
      expect(shouldShowMobileNotice({ ...desktop, width, height }), `${width}x${height}`).toBe(false);
    }
  });

  it('never shows in embeds or after "Continue anyway"', () => {
    const phone = { ...desktop, ...touch, width: 390, height: 844 };
    expect(shouldShowMobileNotice({ ...phone, framed: true })).toBe(false);
    expect(shouldShowMobileNotice({ ...phone, embedQuery: true })).toBe(false);
    expect(shouldShowMobileNotice({ ...phone, dismissed: true })).toBe(false);
  });

  it('remembers "Continue anyway" per session and survives blocked storage', () => {
    const win = { sessionStorage: memoryStorage() };
    expect(mobileNoticeDismissed(win)).toBe(false);
    rememberMobileNoticeDismissed(win);
    expect(win.sessionStorage.getItem(MOBILE_NOTICE_SESSION_KEY)).toBe('1');
    expect(mobileNoticeDismissed(win)).toBe(true);
    const blocked = { get sessionStorage(): Storage { throw new Error('SecurityError'); } };
    expect(mobileNoticeDismissed(blocked)).toBe(false);
    expect(() => rememberMobileNoticeDismissed(blocked)).not.toThrow();
    const throwing = { sessionStorage: { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } };
    expect(mobileNoticeDismissed(throwing)).toBe(false);
    expect(() => rememberMobileNoticeDismissed(throwing)).not.toThrow();
  });

  it('reads the viewport, pointer, frame and ?embed=1 from the window', () => {
    const win = { innerWidth: 390, innerHeight: 844, location: { search: '?embed=1' }, matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)' }), sessionStorage: memoryStorage() };
    const top = {};
    expect(readMobileGateInput({ ...win, self: top, top })).toEqual({ width: 390, height: 844, coarsePointer: true, noHover: true, framed: false, embedQuery: true, dismissed: false });
    expect(readMobileGateInput({ ...win, location: { search: '' }, self: {}, top: {}, matchMedia: undefined }).framed).toBe(true);
    expect(readMobileGateInput({ ...win, location: { search: '' }, self: top, top, matchMedia: undefined })).toMatchObject({ coarsePointer: false, noHover: false });
  });

  it('leads with the atlas identity and its description (what a phone-width crawler reads)', () => {
    const copy = mobileNoticeCopy(parseAppRoute('/r/BurntSushi/ripgrep'));
    expect(copy).toEqual({ heading: 'ripgrep by BurntSushi', description: repoPageDescription('BurntSushi', 'ripgrep') });
    expect(mobileNoticeCopy(parseAppRoute('/')).description).toBe(HOME_DESCRIPTION);
    const html = renderToStaticMarkup(<MobileNotice {...copy} onContinue={() => {}} />);
    expect(html.match(/<h1[^>]*>([^<]*)<\/h1>/)?.[1]).toBe('ripgrep by BurntSushi');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toContain(copy.description);
    expect(html).toContain('Best on a larger screen</h2>');
    expect(html).toContain('Continue anyway');
    expect(html).toContain('<a href="/" ');
    expect(html).not.toContain('href="/new"');
    expect(html).toContain(`href="${GITHUB_REPO_URL}"`);
    expect(html).toContain(CONTACT_EMAIL);
    // CLA-269: the brand links home; the footer carries the credit.
    expect(html).toMatch(/<a aria-label="Source For Atlas — home" data-testid="site-brand" href="\/"[^>]*><svg aria-hidden="true"/);
    expect(html).toContain('Brought to you by the guy who made <a href="https://clabrate.com" rel="noopener"');
  });
});

describe('phone-sized touch viewport (CLA-404)', () => {
  it('is the notice\'s device test without the embed and dismissal exemptions', () => {
    const phone = { ...desktop, ...touch, width: 390, height: 844 };
    expect(isPhoneSizedTouchViewport(phone)).toBe(true);
    // After "Continue anyway", and inside an embed, the device is still a phone.
    for (const exempt of [{ dismissed: true }, { framed: true }, { embedQuery: true }]) {
      expect(shouldShowMobileNotice({ ...phone, ...exempt })).toBe(false);
      expect(isPhoneSizedTouchViewport({ ...phone, ...exempt })).toBe(true);
    }
    expect(isPhoneSizedTouchViewport({ ...desktop, width: 390, height: 844 })).toBe(false);
    expect(isPhoneSizedTouchViewport({ ...desktop, ...touch, width: 844, height: 390 })).toBe(true);
    expect(isPhoneSizedTouchViewport({ ...desktop, ...touch, width: 720, height: 480 })).toBe(false);
    expect(isPhoneSizedTouchViewport({ ...desktop, ...touch, width: 719, height: 900 })).toBe(true);
    expect(isPhoneSizedTouchViewport({ ...desktop, ...touch, width: 900, height: 479 })).toBe(true);
    expect(isPhoneSizedTouchViewport({ ...desktop, ...touch, width: 1024, height: 768 })).toBe(false);
  });

  it('leaves the notice decision the same for every input', () => {
    // The rule as it was written before the device test was extracted.
    const before = (input: MobileGateInput) => {
      if (input.framed || input.embedQuery || input.dismissed) return false;
      if (!input.coarsePointer && !input.noHover) return false;
      return input.width < 720 || Math.min(input.width, input.height) < 480;
    };
    const flags = [false, true];
    let checked = 0;
    for (const width of [320, 390, 479, 480, 719, 720, 844, 1024, 1440]) for (const height of [320, 390, 479, 480, 768, 844, 900])
      for (const coarsePointer of flags) for (const noHover of flags) for (const framed of flags) for (const embedQuery of flags) for (const dismissed of flags) {
        const input = { width, height, coarsePointer, noHover, framed, embedQuery, dismissed };
        expect(shouldShowMobileNotice(input), JSON.stringify(input)).toBe(before(input));
        expect(isPhoneSizedTouchViewport(input), JSON.stringify(input)).toBe(before({ ...input, framed: false, embedQuery: false, dismissed: false }));
        checked++;
      }
    expect(checked).toBe(9 * 7 * 32);
  });

  it('reads the live window each time, so rotation and emulation are seen', () => {
    const win = { innerWidth: 390, innerHeight: 844, matchMedia: (query: string) => ({ matches: query === '(pointer: coarse)' }) };
    expect(readPhoneViewportInput(win)).toEqual({ width: 390, height: 844, coarsePointer: true, noHover: false });
    expect(isPhoneSizedTouchViewport(readPhoneViewportInput(win))).toBe(true);
    win.innerWidth = 844; win.innerHeight = 390;
    expect(isPhoneSizedTouchViewport(readPhoneViewportInput(win))).toBe(true);
    win.innerWidth = 1024; win.innerHeight = 768;
    expect(isPhoneSizedTouchViewport(readPhoneViewportInput(win))).toBe(false);
    win.innerWidth = 390; win.matchMedia = () => ({ matches: false });
    expect(isPhoneSizedTouchViewport(readPhoneViewportInput(win))).toBe(false);
    expect(isPhoneSizedTouchViewport(readPhoneViewportInput({ innerWidth: 390, innerHeight: 844 }))).toBe(false);
  });
});
