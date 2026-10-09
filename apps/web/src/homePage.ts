import { SITE_FOOTER_CSS, siteBrandLinkHtml, siteFooterHtml } from './notFoundPage';
import { buildSitePageOpenGraphTags, renderOpenGraphHead, trustedPageOrigin } from './openGraph';
import { canonicalAtlasPathForSlug, isoDate, publishedNamesFor } from './publishedNames';
import { repoSlugFor } from './renderer/route';
import { CONTACT_EMAIL, COOKIE_NOTICE_STORAGE_KEY, COOKIE_NOTICE_TEXT, HOME_DESCRIPTION, homePageMeta, PRIVACY_PATH } from './siteMeta';

/**
 * The hosted home page (CLA-269): `/` on sourcefor.dev is a server-rendered hero plus a directory of
 * every published atlas, built from the published index.json. One HTML document with inline CSS and SVG
 * and no inline script (the CSP forbids it), so it renders without the SPA bundle. Runtime-agnostic (no
 * DOM, no Node): the edge Worker bundles it for workerd.
 *
 * Search and sort (`?q=`, `?sort=recent|az`) work without JavaScript: the GET form round-trips to the
 * server, which renders EVERY card in the chosen order and marks the non-matching ones `hidden`. The
 * deferred, self-hosted `/home.js` (apps/web/public/home.js) then filters and re-sorts those same cards as
 * you type, so it can widen a server-filtered view as well as narrow it. Both sides share one matching rule
 * ({@link normalizeHomeQuery} + {@link homeCardMatches}: a substring of the names in `data-search`, or a
 * word start in the description/language in `data-search-words`).
 *
 * Only the edge serves it ({@link isHomeRequest}); the Vite dev/preview servers keep `/` as the golden
 * demo. Everything interpolated from the index is HTML-escaped; names come through publishedNamesFor
 * (GitHub's casing), links through canonicalAtlasPathForSlug. A published atlas never silently drops out:
 * a row whose names do not slug back to its slug is shown under its stored names when those match the slug
 * loosely (case and punctuation ignored), else under its slug's names, and only a row whose slug has no
 * canonical path at all is skipped (reported in `skipped`, which the edge logs).
 */

/** The primary CTA: the product's own atlas, when the index lists it (else the first card; no cards, no CTA). */
export const HOME_EXPLORE_HREF = '/r/source-for/atlas';
export const HOME_CACHE_CONTROL = 'public, max-age=60';
/** Caps for the free-text row fields a later increment adds to the index. */
export const HOME_DESCRIPTION_MAX = 280;
export const HOME_LANGUAGE_MAX = 40;
const LICENCE_MAX = 64;

/** Query params that still serve the home (search and sort; the rest are tracking). */
const HOME_QUERY_PARAMS = new Set(['q', 'sort', 'ref', 'fbclid', 'gclid']);

/** Whether a query param name is on the home allowlist (shared by {@link isHomeRequest} and the `/new` 301). */
export function isHomeQueryParam(name: string): boolean {
  return HOME_QUERY_PARAMS.has(name) || /^utm_[A-Za-z0-9_-]*$/.test(name);
}

/**
 * Whether a request URL gets the home page: `/` or `/index.html` whose query holds only allowlisted
 * params (`q`, `sort`, any `utm_*`, `ref`, `fbclid`, `gclid`). Any other param (`fixture`, `portable`,
 * `embed`, `open`, navigation/story state…) keeps today's SPA shell, so the golden demo stays at
 * `/?fixture=okie` and every query-carrying deep link keeps working.
 */
export function isHomeRequest(url: URL): boolean {
  if (url.pathname !== '/' && url.pathname !== '/index.html') return false;
  for (const name of url.searchParams.keys()) {
    if (!isHomeQueryParam(name)) return false;
  }
  return true;
}

/**
 * `url`'s query with only the home-allowlisted params kept, in order (`?utm_source=x`), or `''` when none
 * are left: the `/new` 301 target's query, so an old `/new?<other>` link still lands on the home.
 */
export function homeSearchFrom(url: URL): string {
  const kept = new URLSearchParams();
  for (const [name, value] of url.searchParams) {
    if (isHomeQueryParam(name)) kept.append(name, value);
  }
  const search = kept.toString();
  return search ? `?${search}` : '';
}

/** The longest search the home applies (code points; longer input is cut, not refused). */
export const HOME_QUERY_MAX = 100;
export type HomeSort = 'recent' | 'az';
export const HOME_SORTS: readonly HomeSort[] = ['recent', 'az'];

/**
 * Bidi controls and invisible characters: they can reorder or hide the text around them (U+202E flips a name).
 * U+200C/U+200D (zero-width non-joiner/joiner) are kept: they hold emoji sequences (the woman mage, U+1F9D9 U+200D U+2640 U+FE0F) and some scripts together.
 * home.js strips the same set.
 */
const INVISIBLE = /[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/**
 * A search as typed → the text echoed back into the box: control characters become spaces, bidi and
 * invisible characters ({@link INVISIBLE}) are dropped, trimmed, at most
 * {@link HOME_QUERY_MAX} code points. home.js applies the same rule. Matching lower-cases it.
 */
export function normalizeHomeQuery(value: unknown): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return Array.from(text).slice(0, HOME_QUERY_MAX).join('').trim();
}

/** `sort` as requested, or `recent` (the default) for anything unknown. */
export function homeSortFrom(value: unknown): HomeSort {
  return value === 'az' ? 'az' : 'recent';
}

/** The home view a request asks for: `?q=` and `?sort=` (the first of each). */
export function homeViewFrom(url: URL): { q: string; sort: HomeSort } {
  return { q: normalizeHomeQuery(url.searchParams.get('q') ?? ''), sort: homeSortFrom(url.searchParams.get('sort')) };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Single-line, trimmed, length-capped text (an ellipsis marks a cut), with bidi and invisible characters
 * ({@link INVISIBLE}) removed; undefined when not a non-empty string.
 */
function cappedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(INVISIBLE, '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
  if (!text) return undefined;
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `4 Aug 2026` in UTC (deterministic: no locale, no time zone). */
export function formatHomeDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** `2,831 entities` / `1 entity` (deterministic grouping, no locale). */
export function formatEntityCount(count: number): string {
  const grouped = String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped} ${count === 1 ? 'entity' : 'entities'}`;
}

const COMMIT = /^[a-f0-9]{7,40}$/;

export type HomeAtlasCard = {
  href: string;
  /** `/og/<slug owner>/<slug repo>`: the 1200×630 share card. */
  thumbnail: string;
  owner: string;
  repo: string;
  licence?: string;
  shortSha?: string;
  /** The snapshot generatedAt: the pinned commit's committer date (packages/scan github.ts). */
  commitDate?: string;
  publishedAt?: string;
  entityCount?: number;
  description?: string;
  language?: string;
  /**
   * Lower-cased names the search matches anywhere (a substring), one field per entry: the shown `owner/repo`
   * and the row's stored `owner/repo` when it differs (only when those names are the card's own).
   */
  search: string[];
  /** Lower-cased description and language, which the search matches only at a word start (see {@link matchesAtWordStart}). */
  searchWords: string[];
};

/** A row the directory could not show: its slug has no canonical path (or it is a repeat of one already shown). */
export type HomeSkippedRow = { slug: string; reason: string };

function licenceFor(license: unknown): string | undefined {
  if (!license || typeof license !== 'object') return undefined;
  const spdxId = cappedText((license as { spdxId?: unknown }).spdxId, LICENCE_MAX);
  if (spdxId && spdxId !== 'NOASSERTION') return spdxId;
  return cappedText((license as { name?: unknown }).name, LICENCE_MAX);
}

/** Newest first by an ISO field; undated last; 0 on a tie. */
function newestFirst(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return a < b ? 1 : -1;
}

function byName(a: HomeAtlasCard, b: HomeAtlasCard): number {
  const an = `${a.owner}/${a.repo}`.toLowerCase();
  const bn = `${b.owner}/${b.repo}`.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.href < b.href ? -1 : a.href > b.href ? 1 : 0;
}

/** `recent`: by the date each card shows (the commit date) newest first, then most recently published; undated last; ties by name. */
function compareRecent(a: HomeAtlasCard, b: HomeAtlasCard): number {
  // ISO strings from isoDate compare in time order.
  return newestFirst(a.commitDate, b.commitDate) || newestFirst(a.publishedAt, b.publishedAt) || byName(a, b);
}

/** Cards in a sort's order (a new array). `az` is case-insensitive `owner/repo` as shown. */
export function sortHomeCards(cards: readonly HomeAtlasCard[], sort: HomeSort): HomeAtlasCard[] {
  return [...cards].sort(sort === 'az' ? byName : compareRecent);
}

/** A letter, combining mark or digit: a match right after one is inside a word. */
const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;

/**
 * Whether `needle` occurs in `field` at a word start: the start of the text, or right after a character that is not
 * a letter or digit (a space, `-`, `/`, an emoji…). camelCase inside a word is not a boundary: `script` does not
 * match `typescript`. home.js applies the same rule.
 */
export function matchesAtWordStart(field: string, needle: string): boolean {
  for (let at = field.indexOf(needle); at !== -1; at = field.indexOf(needle, at + 1)) {
    if (at === 0 || !WORD_CHAR.test(field.charAt(at - 1))) return true;
  }
  return false;
}

/**
 * Whether a card matches a search ({@link normalizeHomeQuery} form), case-insensitively: a substring of a name
 * (`search`), or a word start in the description or language (`searchWords`); everything matches an empty one.
 */
export function homeCardMatches(card: Pick<HomeAtlasCard, 'search' | 'searchWords'>, q: string): boolean {
  const needle = q.toLowerCase();
  return !needle || card.search.some(field => field.includes(needle)) || card.searchWords.some(field => matchesAtWordStart(field, needle));
}

/** Owner/repo compared the way people mistype them: case and punctuation ignored (as apps/edge share.ts canonicalShareRedirect does). */
function looseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The names a card shows: GitHub's casing or the stored names (publishedNamesFor) when they slug back to the
 * row's slug, so a card can never show one repo and link another. The casing counts because the slug is
 * derived from it: stored `burntsushi` has slug `burnt-sushi__ripgrep` (from `BurntSushi`), which the stored
 * names alone would never reproduce. Failing that, the same (valid GitHub) names when they match the slug once
 * case and punctuation are ignored (`burntsushi` ≈ `burnt-sushi`). Otherwise (mismatched or unusable names) the
 * slug's own names. The link is always the slug's canonical path.
 */
function shownNames(row: Record<string, unknown>, slug: string): { owner: string; repo: string; fromRow: boolean } {
  const names = publishedNamesFor(row);
  const [slugOwner, slugRepo] = slug.split('__') as [string, string];
  if (names && (repoSlugFor(String(row.owner), String(row.repo)) === slug || repoSlugFor(names.owner, names.repo) === slug
    || (looseName(names.owner) === looseName(slugOwner) && looseName(names.repo) === looseName(slugRepo)))) {
    return { owner: names.owner, repo: names.repo, fromRow: true };
  }
  return { owner: slugOwner, repo: slugRepo, fromRow: false };
}

function slugLabel(value: unknown): string {
  return typeof value === 'string' ? value : '(no slug)';
}

/**
 * Directory cards from a parsed index (`{ repos: [...] }`) in `recent` order, plus the rows that could not
 * be shown. A row is shown whenever its slug has a canonical path; only an unusable slug (or a repeat of a
 * slug already shown) is skipped.
 */
export function homeDirectory(index: unknown): { cards: HomeAtlasCard[]; skipped: HomeSkippedRow[] } {
  const repos = (index as { repos?: unknown } | null | undefined)?.repos;
  const skipped: HomeSkippedRow[] = [];
  if (!Array.isArray(repos)) return { cards: [], skipped };
  const cards: HomeAtlasCard[] = [];
  const seen = new Set<string>();
  for (const row of repos) {
    if (!row || typeof row !== 'object') {
      skipped.push({ slug: '(no slug)', reason: 'not an object' });
      continue;
    }
    const value = row as Record<string, unknown>;
    const href = canonicalAtlasPathForSlug(value.slug);
    if (!href) {
      skipped.push({ slug: slugLabel(value.slug), reason: 'the slug has no canonical /r/ path' });
      continue;
    }
    if (seen.has(href)) {
      skipped.push({ slug: slugLabel(value.slug), reason: 'a repeat of a row already shown' });
      continue;
    }
    seen.add(href);
    const names = shownNames(value, value.slug as string);
    const commitSha = typeof value.commitSha === 'string' && COMMIT.test(value.commitSha) ? value.commitSha : undefined;
    const entityCount = typeof value.entityCount === 'number' && Number.isSafeInteger(value.entityCount) && value.entityCount >= 0 ? value.entityCount : undefined;
    const licence = licenceFor(value.license);
    const commitDate = isoDate(value.generatedAt);
    const publishedAt = isoDate(value.publishedAt);
    const description = cappedText(value.description, HOME_DESCRIPTION_MAX);
    const language = cappedText(value.language, HOME_LANGUAGE_MAX);
    // The stored names are searchable only when they are the card's own (verified against the slug): a
    // mismatched row must not be found by names it does not show.
    const stored = names.fromRow ? `${value.owner as string}/${value.repo as string}` : undefined;
    const search = [...new Set([`${names.owner}/${names.repo}`, stored]
      .filter((field): field is string => Boolean(field))
      .map(field => field.toLowerCase()))];
    const searchWords = [...new Set([description, language]
      .filter((field): field is string => Boolean(field))
      .map(field => field.toLowerCase()))];
    cards.push({
      href,
      thumbnail: `/og/${href.slice('/r/'.length)}`,
      owner: names.owner,
      repo: names.repo,
      ...(licence ? { licence } : {}),
      ...(commitSha ? { shortSha: commitSha.slice(0, 7) } : {}),
      ...(commitDate ? { commitDate } : {}),
      ...(publishedAt ? { publishedAt } : {}),
      ...(entityCount !== undefined ? { entityCount } : {}),
      ...(description ? { description } : {}),
      ...(language ? { language } : {}),
      search,
      searchWords,
    });
  }
  return { cards: sortHomeCards(cards, 'recent'), skipped };
}

/** Directory cards from a parsed index in `recent` order (see {@link homeDirectory}). */
export function homeAtlasCards(index: unknown): HomeAtlasCard[] {
  return homeDirectory(index).cards;
}

/** Thumbnails above the fold on a wide screen (one row of three) load eagerly; the rest wait for the viewport. */
export const HOME_EAGER_THUMBNAILS = 3;

/** The hero CTA target: the product's own atlas when listed, else the first card; undefined without cards. */
export function homeExploreHref(cards: readonly HomeAtlasCard[]): string | undefined {
  return cards.some(card => card.href === HOME_EXPLORE_HREF) ? HOME_EXPLORE_HREF : cards[0]?.href;
}

type CardPlacement = {
  /** Position among the cards shown for this view (the first {@link HOME_EAGER_THUMBNAILS} load eagerly); undefined when hidden. */
  shown: number | undefined;
  /** Rank in each sort, for home.js to re-sort without re-deriving the order. */
  recent: number;
  az: number;
};

function cardHtml(card: HomeAtlasCard, placement: CardPlacement): string {
  const e = escapeHtml;
  const name = `${card.owner}/${card.repo}`;
  const facts: string[] = [];
  if (card.language) facts.push(`<span class="fact" data-field="language">${e(card.language)}</span>`);
  if (card.licence) facts.push(`<span class="fact" data-field="licence">${e(card.licence)}</span>`);
  if (card.entityCount !== undefined) facts.push(`<span class="fact" data-field="entities">${e(formatEntityCount(card.entityCount))}</span>`);
  const commit = card.shortSha
    ? `<span class="commit">commit <code>${e(card.shortSha)}</code>${card.commitDate ? ` · <time datetime="${e(card.commitDate)}">${e(formatHomeDate(card.commitDate))}</time>` : ''}</span>`
    : '';
  const body = [
    `<span class="name"><span class="owner">${e(card.owner)}/</span><strong>${e(card.repo)}</strong></span>`,
    card.description ? `<span class="description" title="${e(card.description)}">${e(card.description)}</span>` : '',
    facts.length ? `<span class="facts">${facts.join('')}</span>` : '',
    commit,
  ].filter(Boolean);
  const attributes = [
    `data-name="${e(name.toLowerCase())}"`,
    card.commitDate ? `data-committed="${e(card.commitDate)}"` : '',
    card.publishedAt ? `data-published="${e(card.publishedAt)}"` : '',
    card.entityCount !== undefined ? `data-entities="${card.entityCount}"` : '',
    card.language ? `data-language="${e(card.language.toLowerCase())}"` : '',
    // One field per line (none contains a line break; written as &#10; to keep the tag on one line): home.js
    // matches each field separately, as the server does (names anywhere, description/language at word starts).
    `data-search="${e(card.search.join('\n')).replace(/\n/g, '&#10;')}"`,
    card.searchWords.length ? `data-search-words="${e(card.searchWords.join('\n')).replace(/\n/g, '&#10;')}"` : '',
    `data-rank-recent="${placement.recent}"`,
    `data-rank-az="${placement.az}"`,
    placement.shown === undefined ? 'hidden' : '',
  ].filter(Boolean).join(' ');
  const eager = placement.shown !== undefined && placement.shown < HOME_EAGER_THUMBNAILS;
  return `<li class="atlas" ${attributes}>
          <a class="card" href="${e(card.href)}">
            <img src="${e(card.thumbnail)}" alt="" width="1200" height="630" loading="${eager ? 'eager' : 'lazy'}" decoding="async" />
            <span class="body">
              ${body.join('\n              ')}
            </span>
          </a>
        </li>`;
}

/** `7 atlases` unfiltered, `3 of 7 atlases` when a search is applied (home.js writes the same text). */
export function homeCountText(shown: number, total: number, filtered: boolean): string {
  const noun = total === 1 ? 'atlas' : 'atlases';
  return filtered ? `${shown} of ${total} ${noun}` : `${total} ${noun}`;
}

function searchFormHtml(q: string, sort: HomeSort): string {
  const e = escapeHtml;
  const option = (value: HomeSort, label: string) => `<option value="${value}"${value === sort ? ' selected' : ''}>${label}</option>`;
  return `<form class="search" action="/" method="get" role="search" aria-label="Search published atlases" data-home-search>
        <label class="sr-only" for="home-q">Search atlases</label>
        <input id="home-q" class="search-input" type="search" name="q" value="${e(q)}" maxlength="${HOME_QUERY_MAX}" placeholder="Search by name, description or language" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" />
        <span class="search-controls">
          <label class="sr-only" for="home-sort">Sort</label>
          <select id="home-sort" name="sort">
            ${option('recent', 'Most recent')}
            ${option('az', 'A–Z')}
          </select>
          <button type="submit">Search</button>
        </span>
      </form>`;
}

export type HomePageInput = {
  /** The parsed published index.json (`{ repos: [...] }`), or undefined when missing/unreadable. */
  index: unknown;
  /** The search (`?q=`), any form; normalized with {@link normalizeHomeQuery}. */
  q?: string;
  /** The sort (`?sort=`), any value; unknown values are `recent`. */
  sort?: string;
  /** The request's origin; og:url / og:image use it only when allowlisted, else production. */
  requestOrigin?: string;
  allowedOrigins?: readonly string[];
  /**
   * Sign-in is configured on this deployment (CLA-316): render the header's account slot and load /home.js
   * to fill it. Off (the default), the page is exactly as before accounts existed.
   */
  accounts?: boolean;
};

const FAVICONS = `<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon-32.png" type="image/png" sizes="32x32" />
    <link rel="icon" href="/favicon-16.png" type="image/png" sizes="16x16" />
    <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180" />`;

const STYLE = `
      *{box-sizing:border-box}
      html,body{margin:0;min-height:100%;background:#070a0b;color:#eef4f2}
      body{font:16px/1.6 "IBM Plex Sans",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
      a{color:inherit}
      .hero{max-width:1120px;margin:0 auto;padding:4rem 1rem 2.5rem}
      .hero h1{display:flex;align-items:center;gap:.7rem;margin:0 0 .75rem;font-size:2rem;line-height:1.2;font-weight:600;letter-spacing:-.02em;color:#f1f7f4}
      .hero h1 svg{flex:none;width:40px;height:40px}
      .hero h1 span span{color:#97a5a0;font-weight:500}
      .hero h1 .brand{display:inline-flex;align-items:center;gap:.7rem;min-width:0;color:inherit;text-decoration:none}
      .hero h1 strong{font-weight:inherit}
      .lede{max-width:42rem;margin:0;color:#b7c3c0;font-size:1.1rem}
      .actions{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem 1.25rem;margin-top:1.75rem}
      .cta{padding:.6rem 1.1rem;border:1px solid #d9ff70;border-radius:8px;background:#d9ff70;color:#0d1a17;font-weight:600;text-decoration:none}
      .cta:hover{border-color:#79dfd4;background:#79dfd4}
      .cta:focus-visible,.ask a:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}
      .ask{margin:0;color:#97a5a0;font-size:.9rem}
      .ask a{color:#79dfd4}
      .directory{max-width:1120px;margin:0 auto;padding:0 1rem 3rem}
      .directory h2{margin:0 0 1rem;font-size:1.15rem;font-weight:600}
      .directory h2 span{color:#97a5a0;font-weight:400}
      .empty{margin:0;color:#b7c3c0}
      .atlases{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:1rem;margin:0;padding:0;list-style:none}
      .atlas{min-width:0}
      .card{display:flex;flex-direction:column;height:100%;border:1px solid #1d2a28;border-radius:10px;background:#0d1413;text-decoration:none;overflow:hidden}
      .card:hover,.card:focus-visible{border-color:#79dfd4}
      .card:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}
      .card img{display:block;width:100%;height:auto;aspect-ratio:1200/630;background:#101918;border-bottom:1px solid #1d2a28}
      .body{display:flex;flex:1;flex-direction:column;gap:.45rem;padding:.85rem 1rem 1rem}
      .name{font-size:1.05rem;line-height:1.3;color:#f1f7f4}
      .name .owner{color:#97a5a0}
      .name strong{font-weight:600}
      .description{color:#b7c3c0;font-size:.9rem;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;line-clamp:3;overflow:hidden;overflow-wrap:anywhere}
      .facts{display:flex;flex-wrap:wrap;gap:.35rem}
      .fact{padding:.1rem .5rem;border:1px solid #2a3a37;border-radius:999px;color:#cfd9d6;font-size:.78rem}
      .commit{margin-top:auto;color:#97a5a0;font-size:.8rem}
      .commit code{color:#d9ff70;font:600 .8rem/1 "IBM Plex Mono",ui-monospace,monospace}
      .site-footer{max-width:1120px;margin:0 auto;padding:1.5rem 1rem 3rem;border-top:1px solid #1d2a28;color:#b7c3c0;font-size:.85rem;display:grid;gap:.4rem}
      .site-footer p{margin:0}
      .site-footer a{color:#79dfd4}
      ${SITE_FOOTER_CSS}
      .sr-only{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
      .search{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 .75rem}
      .search-input{flex:1 1 16rem;min-width:0}
      .search-controls{display:flex;flex:1 1 auto;gap:.5rem;min-width:0}
      .search-controls select{flex:1 1 auto;min-width:0}
      .search input,.search select,.search button{min-height:44px;margin:0;padding:.5rem .75rem;border:1px solid #2a3a37;border-radius:8px;background:#0d1413;color:#eef4f2;font:inherit;font-size:1rem}
      .search input::placeholder{color:#7f8d89}
      .search button{flex:none;border-color:#79dfd4;color:#79dfd4;font-weight:600;cursor:pointer}
      .search button:hover{background:#12201e}
      .search input:focus-visible,.search select:focus-visible,.search button:focus-visible,.no-match a:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}
      .count{margin:0 0 1rem;color:#97a5a0;font-size:.9rem}
      .no-match{margin:0 0 1rem;color:#b7c3c0}
      .no-match a{color:#79dfd4}
      .no-match[hidden],.atlas[hidden]{display:none}
      @media (min-width:720px){.hero{padding:5rem 1.5rem 3rem}.hero h1{font-size:2.6rem}.directory,.site-footer{padding-left:1.5rem;padding-right:1.5rem}.search-controls{flex:none}}
    `;

/**
 * The script that filters and re-sorts the cards in place and fills the sign-in slot
 * (apps/web/public/home.js; the page works without it).
 */
export const HOME_SCRIPT_PATH = '/home.js';

/**
 * The header's account links (CLA-316), rendered only when accounts are configured. Hidden and empty in
 * the HTML (the page is shared-cached, so it never carries a user): home.js asks /api/auth/me and fills it
 * with "Sign in with GitHub" or "@login · Account · Sign out". Without JavaScript it stays hidden.
 */
export const AUTH_SLOT_HTML = '<nav class="site-auth" aria-label="Account" data-auth-slot hidden></nav>';

/** The home page's "Request a scan" link (CLA-455): the form on the account page. */
export const SCAN_REQUEST_HREF = '/account#request-scan';

export { COOKIE_NOTICE_STORAGE_KEY, COOKIE_NOTICE_TEXT };

/**
 * The cookie notice (CLA-316), rendered only when accounts are configured (no sign-in, no cookies to tell
 * anyone about). `hidden` in the HTML, so without JavaScript nothing shows (it is informational only: every
 * cookie is strictly necessary). home.js reveals it only when /api/auth/me answers `oauthConfigured: true`,
 * and not once it was dismissed.
 */
export const COOKIE_NOTICE_HTML = `<div class="cookie-notice" role="region" aria-label="Cookie notice" data-cookie-notice hidden>
      <p>${COOKIE_NOTICE_TEXT}</p>
      <a href="${PRIVACY_PATH}">Privacy</a>
      <button type="button" data-cookie-notice-dismiss>OK</button>
    </div>`;

const COOKIE_NOTICE_STYLE = `
      .cookie-notice{position:fixed;left:0;right:0;bottom:0;z-index:10;display:flex;align-items:center;gap:.5rem .9rem;padding:.55rem 1rem;border-top:1px solid #2a3a37;background:#0d1413;color:#b7c3c0;font-size:.85rem;line-height:1.4}
      .cookie-notice[hidden]{display:none}
      .cookie-notice p{flex:1;min-width:0;margin:0}
      .cookie-notice a{color:#79dfd4}
      .cookie-notice button{flex:none;min-height:36px;padding:.3rem .9rem;border:1px solid #79dfd4;border-radius:8px;background:transparent;color:#79dfd4;font:inherit;font-weight:600;cursor:pointer}
      .cookie-notice a:focus-visible,.cookie-notice button:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}
      body.has-cookie-notice{padding-bottom:5.5rem}
    `;

/** The slot's CSS, only on pages that render it (positioned over the hero, so filling it never shifts the layout). */
const AUTH_STYLE = `
      body{position:relative}
      .site-header{position:absolute;top:0;left:0;right:0;max-width:1120px;margin:0 auto;padding:1rem 1rem 0;display:flex;justify-content:flex-end;pointer-events:none}
      .site-header>*{pointer-events:auto}
      .site-auth{display:flex;flex-wrap:wrap;align-items:center;gap:.35rem .75rem;font-size:.9rem;color:#97a5a0}
      .site-auth[hidden]{display:none}
      .site-auth a{color:#79dfd4}
      .site-auth a:focus-visible{outline:2px solid #79dfd4;outline-offset:2px}
      .site-auth .login{color:#eef4f2}
      @media (min-width:720px){.site-header{padding:1.25rem 1.5rem 0}}
    `;

function directoryHtml(cards: readonly HomeAtlasCard[], q: string, sort: HomeSort): string {
  if (!cards.length) {
    return `<h2 id="atlases-heading">Published atlases</h2>
      <p class="empty" data-empty="true">No atlases published yet.</p>`;
  }
  const az = new Map(sortHomeCards(cards, 'az').map((card, rank) => [card, rank]));
  const ordered = sort === 'az' ? sortHomeCards(cards, 'az') : [...cards];
  let shown = 0;
  const items = ordered.map(card => {
    const matches = homeCardMatches(card, q);
    const placement: CardPlacement = { shown: matches ? shown++ : undefined, recent: cards.indexOf(card), az: az.get(card)! };
    return cardHtml(card, placement);
  });
  const e = escapeHtml;
  return `<h2 id="atlases-heading">Published atlases <span>(${cards.length})</span></h2>
      ${searchFormHtml(q, sort)}
      <p class="count" aria-live="polite" data-home-count>${e(homeCountText(shown, cards.length, q !== ''))}</p>
      <p class="no-match" data-home-no-match${shown === 0 ? '' : ' hidden'}>No atlases match “<span data-home-query>${e(q)}</span>”. <a href="/">Clear the search</a></p>
      <ul class="atlases" aria-labelledby="atlases-heading" data-atlas-count="${cards.length}">
        ${items.join('\n        ')}
      </ul>`;
}

function renderHomePage(input: HomePageInput, cards: readonly HomeAtlasCard[]): string {
  const tags = buildSitePageOpenGraphTags(homePageMeta(), trustedPageOrigin(input.requestOrigin ?? '', input.allowedOrigins));
  const q = normalizeHomeQuery(input.q ?? '');
  const sort = homeSortFrom(input.sort);
  // The CTA ignores the search: it is the product atlas (or the first card by date) whatever is shown.
  const exploreHref = homeExploreHref(cards);
  const cta = exploreHref ? `<a class="cta" href="${escapeHtml(exploreHref)}">Explore an atlas</a>\n          ` : '';
  // The search needs it when there are cards; the sign-in slot (CLA-316) whenever accounts are on.
  const accounts = input.accounts === true;
  const script = cards.length || accounts ? `\n    <script src="${HOME_SCRIPT_PATH}" defer></script>` : '';
  // With accounts on, a request goes through the account page's form (CLA-455). A signed-out reader signs in
  // first and lands on /account (or the welcome page, then /account), not always at the form's anchor.
  const askHtml = accounts
    ? `Want your repo mapped? <a href="${SCAN_REQUEST_HREF}" data-scan-request-link>Request a scan</a>`
    : `Want your repo mapped? <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a>`;
  const header = accounts ? `<header class="site-header">
      ${AUTH_SLOT_HTML}
    </header>
    ` : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#070a0b" />
    <meta name="color-scheme" content="dark" />
    ${renderOpenGraphHead(tags)}
    ${FAVICONS}
    <style>${STYLE}${accounts ? AUTH_STYLE : ''}${accounts ? COOKIE_NOTICE_STYLE : ''}</style>${script}
  </head>
  <body>
    ${header}<main data-home="true">
      <section class="hero" aria-labelledby="home-heading">
        <h1 id="home-heading">${siteBrandLinkHtml('brand', true)}</h1>
        <p class="lede">${escapeHtml(HOME_DESCRIPTION)}</p>
        <div class="actions">
          ${cta}<p class="ask">${askHtml}</p>
        </div>
      </section>
      <section class="directory" aria-labelledby="atlases-heading">
      ${directoryHtml(cards, q, sort)}
      </section>
    </main>
    ${siteFooterHtml()}${accounts ? `\n    ${COOKIE_NOTICE_HTML}` : ''}
  </body>
</html>
`;
}

export function homePageHtml(input: HomePageInput): string {
  return renderHomePage(input, homeAtlasCards(input.index));
}

export type HomeHttpOutput = {
  status: 200;
  headers: Record<string, string>;
  body: string;
  /** Index rows the directory could not show (the edge logs them, so an atlas never drops out silently). */
  skipped: HomeSkippedRow[];
};

/** The home answer for GET/HEAD; HEAD gets the headers only. */
export function homeHttpOutput(method: string, input: HomePageInput): HomeHttpOutput {
  const { cards, skipped } = homeDirectory(input.index);
  return {
    status: 200,
    headers: { 'cache-control': HOME_CACHE_CONTROL, 'content-type': 'text/html; charset=utf-8' },
    body: method.toUpperCase() === 'HEAD' ? '' : renderHomePage(input, cards),
    skipped,
  };
}
