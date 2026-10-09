import { parseAppRoute, scanSlug } from './renderer/route';

/**
 * Site identity and per-page <title>/description (CLA-318). The brand is "Source For", the product
 * "Atlas" (sourcefor.dev). One source for the browser (document.title after boot), the share/landing
 * HTML the edge Worker and Vite plugin render for crawlers, and the static index.html defaults
 * (asserted in siteMeta.test.ts).
 *
 * Canonical links always name production: staging.sourcefor.dev serves the same pages but must
 * canonicalize to sourcefor.dev. og:url / og:image follow the (allowlisted) request origin instead,
 * like the existing /r share tags, so a staging share still previews from staging.
 */
export const BRAND_NAME = 'Source For';
export const PRODUCT_NAME = 'Atlas';
export const SITE_NAME = `${BRAND_NAME} ${PRODUCT_NAME}`;
export const CANONICAL_ORIGIN = 'https://sourcefor.dev';
/** Static 1200×630 card for `/` and `/new` (apps/web/public; source docs/brand/og/og-default.svg). */
export const DEFAULT_OG_IMAGE_PATH = '/og-default.png';
export const DEFAULT_OG_IMAGE_WIDTH = 1200;
export const DEFAULT_OG_IMAGE_HEIGHT = 630;
export const DEFAULT_OG_IMAGE_ALT = `${SITE_NAME}: explore how open-source software is built`;

/** Footer / about (CLA-318): the product's own repository and contact address. */
export const GITHUB_REPO_URL = 'https://github.com/source-for/atlas';
export const CONTACT_EMAIL = 'hello@sourcefor.dev';
/** The contact on the legal pages (/privacy, /terms): the operator's own address, as on clabrate.com (CLA-316). */
export const LEGAL_CONTACT_EMAIL = 'support@clabrate.com';
/** The brand mark + wordmark link to the home page everywhere (CLA-269); this is its accessible name. */
export const SITE_HOME_HREF = '/';
export const SITE_HOME_LABEL = `${SITE_NAME} \u2014 home`;
/** Fine-print footer credit (CLA-269), in the site owner's words. */
export const CREDIT_LEAD = 'Brought to you by the guy who made ';
export const CREDIT_LINK_TEXT = 'clabrate.com';
export const CREDIT_URL = 'https://clabrate.com';
export const CREDIT_REL = 'noopener';
export const ATLAS_LICENCE_NOTE =
  'Atlases are derived from public repositories; each repository\u2019s code remains under its own licence.';

export const HOME_TITLE = `${SITE_NAME}: explore how open-source software is built`;
export const HOME_DESCRIPTION =
  'Architecture atlases of open-source software, from system context down to the exact lines of source. Every claim is backed by evidence from the code.';
export const LANDING_TITLE = `Published atlases · ${SITE_NAME}`;
export const LANDING_DESCRIPTION =
  'Browse the published architecture atlases of open-source repositories on Source For Atlas. No sign-in needed.';

export type PageMeta = {
  title: string;
  description: string;
  /** Path on {@link CANONICAL_ORIGIN}; always without a query. */
  canonicalPath: string;
};

/** `<repo> by <owner> · Source For Atlas` — the share page title for `/r/<owner>/<repo>`. */
export function repoPageTitle(owner: string, repo: string): string {
  return `${repoPageHeading(owner, repo)} · ${SITE_NAME}`;
}

/** `<repo> by <owner>`: the atlas's name as a page heading (the title without the site suffix). */
export function repoPageHeading(owner: string, repo: string): string {
  return `${repo} by ${owner}`;
}

export function repoPageDescription(owner: string, repo: string): string {
  return `Explore how ${owner}/${repo} is built: an architecture atlas from system context down to source, on ${SITE_NAME}.`;
}

/**
 * The one canonical share path for an atlas: `/r/<scanSlug(owner)>/<scanSlug(repo)>`, the same target
 * the edge's case/punctuation 301 lands on (apps/edge/src/share.ts canonicalShareRedirect). Case
 * variants and pinned refs all canonicalize to it.
 */
export function repoCanonicalPath(owner: string, repo: string): string {
  return `/r/${scanSlug(owner)}/${scanSlug(repo)}`;
}

/**
 * `/new`, the SPA's published-atlas list. Since CLA-269 the hosted home page `/` is the directory and
 * the edge 301s `/new` there, so `/new` canonicalizes to `/`.
 */
export function landingPageMeta(): PageMeta {
  return { title: LANDING_TITLE, description: LANDING_DESCRIPTION, canonicalPath: '/' };
}

/** The hosted home page `/` (CLA-269): hero plus the directory of published atlases. */
export function homePageMeta(): PageMeta {
  return { title: HOME_TITLE, description: HOME_DESCRIPTION, canonicalPath: '/' };
}

/** Title, description and canonical path for a pathname (a malformed escape reads as the home page). */
export function pageMetaForPath(pathname: string): PageMeta {
  if (pathname === '/operator' || pathname === '/operator/') return { title: `Operator review · ${SITE_NAME}`, description: HOME_DESCRIPTION, canonicalPath: '/' };
  let route: ReturnType<typeof parseAppRoute>;
  try {
    route = parseAppRoute(pathname);
  } catch {
    route = { kind: 'default' };
  }
  if (route.kind === 'landing') return landingPageMeta();
  if (route.kind === 'repo') {
    return {
      title: repoPageTitle(route.owner, route.repo),
      description: repoPageDescription(route.owner, route.repo),
      canonicalPath: repoCanonicalPath(route.owner, route.repo),
    };
  }
  return homePageMeta();
}

export function canonicalHref(canonicalPath: string): string {
  return new URL(canonicalPath, CANONICAL_ORIGIN).href;
}

/** The slice of `Document` applyPageMeta touches, structurally typed so the edge Worker (no DOM lib) can import this module. */
type MetaElement = { setAttribute(name: string, value: string): void };
export type MetaDocument = {
  title: string;
  head: { appendChild(element: never): unknown };
  createElement(tag: 'meta' | 'link'): MetaElement;
  querySelector(selector: string): MetaElement | null;
};

function upsert(doc: MetaDocument, selector: string, create: () => MetaElement, attribute: string, value: string): void {
  let element = doc.querySelector(selector);
  if (!element) {
    element = create();
    doc.head.appendChild(element as never);
  }
  element.setAttribute(attribute, value);
}

/**
 * Browser side: sets document.title, the meta description and the canonical link for the route
 * main.tsx is booting. Route changes are full page loads (`/new` → `/r/…` uses location.assign), so
 * boot is the only place this needs to run. Open Graph tags are left alone: crawlers never run the SPA.
 */
export function applyPageMeta(doc: MetaDocument, pathname: string): PageMeta {
  const meta = pageMetaForPath(pathname);
  doc.title = meta.title;
  upsert(doc, 'meta[name="description"]', () => {
    const element = doc.createElement('meta');
    element.setAttribute('name', 'description');
    return element;
  }, 'content', meta.description);
  upsert(doc, 'link[rel="canonical"]', () => {
    const element = doc.createElement('link');
    element.setAttribute('rel', 'canonical');
    return element;
  }, 'href', canonicalHref(meta.canonicalPath));
  return meta;
}

/**
 * The privacy policy version in force (CLA-316). Stored on each account row at sign-up
 * (`users.privacy_version`, apps/edge) and shown on the privacy page; bump it when the policy changes.
 */
export const PRIVACY_POLICY_VERSION = '2026-10-10';

/** The privacy page (CLA-316; privacyPage.ts, rendered by the edge Worker). Every site footer links it. */
export const PRIVACY_PATH = '/privacy';

/** The terms of use version in force (CLA-316): the "Last updated" date on /terms; bump it when the terms change. */
export const TERMS_VERSION = '2026-09-30';

/** The terms of use page (CLA-316; termsPage.ts, rendered by the edge Worker). Every site footer links it, next to Privacy. */
export const TERMS_PATH = '/terms';

/** The cookie notice's words (CLA-316): the edge home (homePage.ts + home.js) and the SPA (cookieNotice.tsx). */
export const COOKIE_NOTICE_TEXT = 'We use only the cookies needed to keep you signed in, and cookieless analytics.';
/** localStorage key (value "1") that remembers a dismissed notice, shared by home.js and the SPA. */
export const COOKIE_NOTICE_STORAGE_KEY = 'sf.cookieNotice.dismissed';
