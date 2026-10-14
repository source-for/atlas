import { isFramedBrowsingContext } from './embedCanvas';
import { isEmbedChrome, isEmbedQueryFlag } from './embedChrome';
import { publishedNamesFor, publishedRowForSlug } from './publishedNames';
import { CREDIT_LEAD, CREDIT_LINK_TEXT, CREDIT_REL, CREDIT_URL, PRIVACY_PATH, repoPageTitle, TERMS_PATH } from './siteMeta';

/**
 * CLA-266 attribution for published atlases. Every `/r/<owner>/<repo>` page whose atlas came from a
 * publication shows the upstream repository, the pinned commit and its licence, linked back to GitHub.
 * The data is the slug's row in `/scan/index.json` (the published index carries owner, repo, commitSha
 * and license {spdxId, name, url}); a row without a licence is not a publication, so nothing renders.
 * Names and GitHub links use GitHub's casing (`ownerLogin`/`repoName`, CLA-318) when the row has it,
 * else the stored owner/repo.
 *
 * Rendered as a small fixed strip outside the React root (main.tsx), so the atlas shell is untouched;
 * `html[data-atlas-attribution]` shrinks `#root` by the strip height so nothing overlaps the canvas
 * controls (app.css). Embed contexts (framed or `?embed=1`) keep map-first chrome: they get a compact one-line
 * variant instead (CLA-328: `owner/repo · licence · source ↗`), shrinking `#root` by its smaller height.
 *
 * CLA-329: the resolved attribution is also published to a tiny store (`onPublishedAtlasAttribution`), so App,
 * mounted before the index fetch lands, learns that the atlas is a publication (and GitHub's casing of its names).
 */

export type PublishedAtlasAttribution = {
  owner: string;
  repo: string;
  /** True when owner/repo are GitHub's own casing from the row (ownerLogin/repoName). */
  canonicalNames: boolean;
  commitSha: string;
  shortSha: string;
  /** Repository tree at the pinned commit. */
  treeUrl: string;
  commitUrl: string;
  licenceLabel: string;
  licenceUrl?: string;
};

const COMMIT = /^[a-f0-9]{7,40}$/;

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function licenceLabel(spdxId: string, name: string): string {
  // An SPDX expression ("MIT AND CC-BY-4.0", "Unlicense OR MIT") reads as a list, not an adjective.
  if (spdxId && /\s/.test(spdxId)) return `licence: ${spdxId}`;
  if (spdxId && spdxId !== 'NOASSERTION') return `${spdxId} licence`;
  // An operator override of NOASSERTION records it as the name too (publishAtlas.ts): not a licence name.
  return name && name !== 'NOASSERTION' ? name : 'Licence not asserted';
}

/** The attribution for `slug` from a published index, or undefined when it is not a publication. */
export function atlasAttributionFor(index: unknown, slug: string): PublishedAtlasAttribution | undefined {
  const row = publishedRowForSlug(index, slug);
  if (!row) return undefined;
  const names = publishedNamesFor(row);
  const { commitSha, license } = row;
  if (!names || typeof commitSha !== 'string' || !COMMIT.test(commitSha)) return undefined;
  const { owner, repo } = names;
  if (!license || typeof license !== 'object') return undefined;
  const spdxId = typeof (license as { spdxId?: unknown }).spdxId === 'string' ? (license as { spdxId: string }).spdxId.trim() : '';
  const name = typeof (license as { name?: unknown }).name === 'string' ? (license as { name: string }).name.trim() : '';
  if (!spdxId && !name) return undefined;
  const base = `https://github.com/${owner}/${repo}`;
  const licenceUrl = httpsUrl((license as { url?: unknown }).url);
  return {
    owner,
    repo,
    canonicalNames: names.canonical,
    commitSha,
    shortSha: commitSha.slice(0, 7),
    treeUrl: `${base}/tree/${commitSha}`,
    commitUrl: `${base}/commit/${commitSha}`,
    licenceLabel: licenceLabel(spdxId, name),
    ...(licenceUrl ? { licenceUrl } : {}),
  };
}

/** The strip's words, in order, as plain text (also its accessible description). */
export function attributionText(attribution: PublishedAtlasAttribution): string {
  return `Source For Atlas · ${attribution.repo} by ${attribution.owner} · commit ${attribution.shortSha} · ${attribution.licenceLabel} · source on GitHub · About · Privacy · Terms · ${CREDIT_LEAD}${CREDIT_LINK_TEXT}`;
}

type Link = { text: string; href: string; code?: boolean; internal?: boolean; rel?: string };
type Part = string | Link | { credit: Part[] };

/** CLA-318: the strip's one site link: the home page's footer (GitHub, contact, licence note; CLA-269). Keeps the canvas uncluttered. */
export const ATTRIBUTION_ABOUT_HREF = '/#about';

function parts(attribution: PublishedAtlasAttribution): Part[] {
  return [
    'Source For Atlas · ',
    { text: attribution.repo, href: attribution.treeUrl },
    ` by ${attribution.owner} · commit `,
    { text: attribution.shortSha, href: attribution.commitUrl, code: true },
    ' · ',
    attribution.licenceUrl ? { text: attribution.licenceLabel, href: attribution.licenceUrl } : attribution.licenceLabel,
    ' · ',
    { text: 'source on GitHub', href: attribution.treeUrl },
    ' · ',
    { text: 'About', href: ATTRIBUTION_ABOUT_HREF, internal: true },
    ' · ',
    { text: 'Privacy', href: PRIVACY_PATH, internal: true },
    ' · ',
    { text: 'Terms', href: TERMS_PATH, internal: true },
    ' · ',
    // CLA-269: the site footer's fine-print credit (same words, href and rel), trailing the strip's one line.
    { credit: [CREDIT_LEAD, { text: CREDIT_LINK_TEXT, href: CREDIT_URL, rel: CREDIT_REL }] },
  ];
}

export const ATTRIBUTION_CREDIT_CLASS = 'atlas-attribution-credit';

function appendParts(doc: Document, parent: HTMLElement, list: readonly Part[]): void {
  for (const part of list) {
    if (typeof part === 'string') {
      parent.append(doc.createTextNode(part));
      continue;
    }
    if ('credit' in part) {
      const credit = doc.createElement('span');
      credit.className = ATTRIBUTION_CREDIT_CLASS;
      appendParts(doc, credit, part.credit);
      parent.append(credit);
      continue;
    }
    const link = doc.createElement('a');
    link.href = part.href;
    if (!part.internal) {
      link.target = '_blank';
      link.rel = part.rel ?? 'noopener noreferrer';
    }
    if (part.code) {
      const code = doc.createElement('code');
      code.textContent = part.text;
      link.append(code);
    } else {
      link.textContent = part.text;
    }
    parent.append(link);
  }
}

export const ATTRIBUTION_ATTRIBUTE = 'data-atlas-attribution';

/** Build (or replace) the strip in `doc`. Links open GitHub in a new tab without an opener. */
export function renderAtlasAttribution(doc: Document, attribution: PublishedAtlasAttribution): HTMLElement {
  doc.querySelector('footer.atlas-attribution')?.remove();
  const footer = doc.createElement('footer');
  footer.className = 'atlas-attribution';
  footer.setAttribute('aria-label', 'Atlas attribution');
  footer.dataset.testid = 'atlas-attribution';
  const line = doc.createElement('p');
  appendParts(doc, line, parts(attribution));
  footer.append(line);
  doc.body.append(footer);
  doc.documentElement.setAttribute(ATTRIBUTION_ATTRIBUTE, '');
  return footer;
}

/** CLA-328: the embed variant's words, in order, as plain text. */
export function embedAttributionText(attribution: PublishedAtlasAttribution): string {
  return `${attribution.owner}/${attribution.repo} · ${attribution.licenceLabel} · source ↗`;
}

function embedParts(attribution: PublishedAtlasAttribution): Part[] {
  return [
    { text: `${attribution.owner}/${attribution.repo}`, href: attribution.treeUrl },
    ' · ',
    attribution.licenceUrl ? { text: attribution.licenceLabel, href: attribution.licenceUrl } : attribution.licenceLabel,
    ' · ',
    { text: 'source ↗', href: attribution.treeUrl },
  ];
}

export const EMBED_ATTRIBUTION_CLASS = 'atlas-attribution-embed';

/**
 * CLA-328: the compact strip for embeds (repo, licence, source; external links only). Same element and test id as
 * the full strip; `html[data-atlas-attribution="embed"]` gives it (and the #root shrink) the smaller height.
 */
export function renderEmbedAtlasAttribution(doc: Document, attribution: PublishedAtlasAttribution): HTMLElement {
  doc.querySelector('footer.atlas-attribution')?.remove();
  const footer = doc.createElement('footer');
  footer.className = `atlas-attribution ${EMBED_ATTRIBUTION_CLASS}`;
  footer.setAttribute('aria-label', 'Atlas attribution');
  footer.dataset.testid = 'atlas-attribution';
  footer.dataset.variant = 'embed';
  const line = doc.createElement('p');
  appendParts(doc, line, embedParts(attribution));
  footer.append(line);
  doc.body.append(footer);
  doc.documentElement.setAttribute(ATTRIBUTION_ATTRIBUTE, 'embed');
  return footer;
}

let publishedAttribution: PublishedAtlasAttribution | undefined;
let publishedAttributionSettled = false;
const publishedListeners = new Set<() => void>();

/** CLA-329: the page's publication attribution once the index has answered (undefined before, or when none). */
export function getPublishedAtlasAttribution(): PublishedAtlasAttribution | undefined {
  return publishedAttribution;
}

/** CLA-268: true once this page's index lookup has finished, whatever it found (false while it is in flight). */
export function getPublishedAtlasAttributionSettled(): boolean {
  return publishedAttributionSettled;
}

/** Subscribe to the attribution resolving (useSyncExternalStore-shaped); returns the unsubscribe. */
export function onPublishedAtlasAttribution(listener: () => void): () => void {
  publishedListeners.add(listener);
  return () => { publishedListeners.delete(listener); };
}

function publishAttribution(attribution: PublishedAtlasAttribution | undefined): void {
  if (attribution === publishedAttribution && publishedAttributionSettled) return;
  publishedAttribution = attribution;
  publishedAttributionSettled = true;
  for (const listener of [...publishedListeners]) listener();
}

/**
 * CLA-268: hold the strip's height from boot on a `/r/` page, before `/scan/index.json` has answered, so the shell
 * (skeleton, then App) is laid out at its final height and nothing moves when the strip arrives. The strip's own
 * render sets the same attribute; `releaseAtlasAttributionReservation` gives the space back when no strip comes.
 */
export function reserveAtlasAttribution(doc: Document, embedded: boolean): void {
  if (!doc.documentElement.hasAttribute(ATTRIBUTION_ATTRIBUTE)) doc.documentElement.setAttribute(ATTRIBUTION_ATTRIBUTE, embedded ? 'embed' : '');
}

/** Drop a reservation that no strip filled (not a publication, the index failed, or the atlas did not load). */
export function releaseAtlasAttributionReservation(doc: Document): void {
  if (!doc.querySelector('footer.atlas-attribution')) doc.documentElement.removeAttribute(ATTRIBUTION_ATTRIBUTE);
}

/** Fetch the published index and show the strip for `slug` (compact in embeds; nothing for non-publications). */
export async function installPublishedAtlasAttribution(
  slug: string,
  options: { fetch?: typeof fetch; doc?: Document; search?: string; framed?: boolean } = {},
): Promise<PublishedAtlasAttribution | undefined> {
  const search = options.search ?? window.location.search;
  const framed = options.framed ?? isFramedBrowsingContext();
  const embedded = isEmbedChrome({ framed, embedQuery: isEmbedQueryFlag(search) });
  const fetchImpl = options.fetch ?? fetch;
  const doc = options.doc ?? document;
  try {
    const response = await fetchImpl('/scan/index.json', { headers: { accept: 'application/json' } });
    if (!response.ok) {
      releaseAtlasAttributionReservation(doc);
      publishAttribution(undefined);
      return undefined;
    }
    const attribution = atlasAttributionFor(await response.json(), slug);
    if (attribution) {
      if (embedded) renderEmbedAtlasAttribution(doc, attribution);
      else renderAtlasAttribution(doc, attribution);
      // The boot title came from the URL; the row's names (GitHub's casing, else the stored owner/repo) are known
      // only now. They are the names the server put in the share HTML's <title>, so the tab keeps that title.
      doc.title = repoPageTitle(attribution.owner, attribution.repo);
    }
    else releaseAtlasAttributionReservation(doc);
    publishAttribution(attribution);
    return attribution;
  } catch {
    releaseAtlasAttributionReservation(doc);
    publishAttribution(undefined);
    return undefined;
  }
}
