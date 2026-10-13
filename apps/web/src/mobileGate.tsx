import { isFramedBrowsingContext } from './embedCanvas';
import { isEmbedQueryFlag } from './embedChrome';
import type { AppRoute } from './renderer/route';
import { SiteBrand, SiteFooter } from './siteFooter';
import { HOME_DESCRIPTION, repoPageDescription, repoPageHeading } from './siteMeta';

/**
 * Small-screen notice (CLA-318). The atlas canvas needs room for the map, its controls and the
 * inspector; on a phone it renders cramped. Before main.tsx mounts an atlas it asks
 * {@link shouldShowMobileNotice}; when true it shows {@link MobileNotice} instead, whose "Continue
 * anyway" mounts the atlas and is remembered for the tab's session. Never in embeds: oEmbed iframes
 * are often narrow and the host page chose that size.
 */

/** On a touch-primary device, narrower than this (CSS px) is a phone-sized viewport. */
export const MOBILE_NOTICE_MAX_WIDTH = 720;
/** A touch-primary device whose short side is below this (a phone held landscape) also gets the notice. */
export const MOBILE_NOTICE_COARSE_SHORT_SIDE = 480;
export const MOBILE_NOTICE_SESSION_KEY = 'okie.mobileNotice.continue';

export type MobileGateInput = {
  width: number;
  height: number;
  /** `(pointer: coarse)`: the primary pointer is a finger. */
  coarsePointer: boolean;
  /** `(hover: none)`: the primary input cannot hover (phones, most tablets). */
  noHover: boolean;
  framed: boolean;
  embedQuery: boolean;
  dismissed: boolean;
};

export type PhoneViewportInput = Pick<MobileGateInput, 'width' | 'height' | 'coarsePointer' | 'noHover'>;

/** The device test alone: a touch-primary, phone-sized viewport. Unlike the notice it stays
 * true in an embed and after "Continue anyway", so atlas behaviour can key on it. */
export function isPhoneSizedTouchViewport(input: PhoneViewportInput): boolean {
  // Touch-primary devices only: a narrow desktop window (mouse, hover) always keeps the atlas.
  if (!input.coarsePointer && !input.noHover) return false;
  return input.width < MOBILE_NOTICE_MAX_WIDTH || Math.min(input.width, input.height) < MOBILE_NOTICE_COARSE_SHORT_SIDE;
}

export function shouldShowMobileNotice(input: MobileGateInput): boolean {
  if (input.framed || input.embedQuery || input.dismissed) return false;
  return isPhoneSizedTouchViewport(input);
}

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

function sessionStore(win: { sessionStorage?: SessionStore }): SessionStore | undefined {
  try {
    return win.sessionStorage;
  } catch {
    // Reading the property itself throws when storage is blocked.
    return undefined;
  }
}

export function mobileNoticeDismissed(win: { sessionStorage?: SessionStore } = window): boolean {
  try {
    return sessionStore(win)?.getItem(MOBILE_NOTICE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

export function rememberMobileNoticeDismissed(win: { sessionStorage?: SessionStore } = window): void {
  try {
    sessionStore(win)?.setItem(MOBILE_NOTICE_SESSION_KEY, '1');
  } catch {
    // Storage denied: "Continue anyway" still works for this page load.
  }
}

type GateWindow = {
  innerWidth: number;
  innerHeight: number;
  self: unknown;
  top: unknown;
  location: { search: string };
  matchMedia?: (query: string) => { matches: boolean };
  sessionStorage?: SessionStore;
};

function mediaMatches(win: Pick<GateWindow, 'matchMedia'>, query: string): boolean {
  try {
    return Boolean(win.matchMedia?.(query).matches);
  } catch {
    return false;
  }
}

/** Read on every use: rotation and devtools emulation change these while the atlas is mounted. */
export function readPhoneViewportInput(win: Pick<GateWindow, 'innerWidth' | 'innerHeight' | 'matchMedia'> = window as unknown as GateWindow): PhoneViewportInput {
  return {
    width: win.innerWidth,
    height: win.innerHeight,
    coarsePointer: mediaMatches(win, '(pointer: coarse)'),
    noHover: mediaMatches(win, '(hover: none)'),
  };
}

export function readMobileGateInput(win: GateWindow = window as unknown as GateWindow): MobileGateInput {
  return {
    ...readPhoneViewportInput(win),
    framed: isFramedBrowsingContext(win),
    embedQuery: isEmbedQueryFlag(win.location.search),
    dismissed: mobileNoticeDismissed(win),
  };
}

/**
 * The notice's heading and summary. On `/r/…` the h1 is the atlas itself (`<repo> by <owner>`, the page
 * title without the site suffix) and the summary is the page's meta description, so a crawler rendering
 * at phone width still reads what the page is about; "best on a larger screen" is secondary.
 */
export function mobileNoticeCopy(route: AppRoute): { heading: string; description: string } {
  if (route.kind === 'repo') return { heading: repoPageHeading(route.owner, route.repo), description: repoPageDescription(route.owner, route.repo) };
  return { heading: 'Explore how open-source software is built', description: HOME_DESCRIPTION };
}

export function MobileNotice({ heading, description, onContinue }: { heading: string; description: string; onContinue: () => void }) {
  return <>
    <main data-testid="mobile-notice" style={{ maxWidth: '560px', margin: '0 auto', padding: '3rem 1.5rem 2rem', color: '#eef4f2', fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif', overflowWrap: 'anywhere' }}>
      <div style={{ marginBottom: '2rem' }}><SiteBrand/></div>
      <h1 style={{ fontSize: '1.6rem', lineHeight: 1.25, margin: '0 0 0.6rem' }}>{heading}</h1>
      <p data-testid="mobile-notice-description" style={{ color: '#b7c3c0', lineHeight: 1.6, margin: 0 }}>{description}</p>
      <h2 style={{ fontSize: '1.05rem', lineHeight: 1.35, margin: '1.75rem 0 0.4rem', color: '#d9ff70' }}>Best on a larger screen</h2>
      <p style={{ color: '#b7c3c0', lineHeight: 1.6, margin: 0 }}>
        An atlas is an interactive map with controls that need room, so a laptop or desktop works best.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginTop: '1.75rem' }}>
        <button
          data-testid="mobile-notice-continue"
          onClick={() => {
            rememberMobileNoticeDismissed();
            onContinue();
          }}
          style={{ padding: '0.6rem 1.1rem', borderRadius: '8px', border: '1px solid #d9ff70', background: '#d9ff70', color: '#0d1a17', fontWeight: 600, fontSize: '0.95rem', cursor: 'pointer' }}
          type="button"
        >
          Continue anyway
        </button>
        <a href="/" style={{ padding: '0.6rem 1.1rem', borderRadius: '8px', border: '1px solid #2a3a37', color: '#eef4f2', fontWeight: 600, textDecoration: 'none' }}>Browse published atlases</a>
      </div>
    </main>
    <SiteFooter/>
  </>;
}
