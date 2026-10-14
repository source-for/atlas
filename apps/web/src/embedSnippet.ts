import type { PublishedAtlasAttribution } from './atlasAttribution';
import { isEmbedChrome, isEmbedQueryFlag } from './embedChrome';
import { isDogfoodAtlas } from './hostedAtlas';
import {
  buildOembedIframeHtml,
  OEMBED_EMBED_PARAM,
  parsePublicAtlasOembedUrl,
  type EmbedIframeSize,
  type PublicAtlasDisplayNames,
} from './oembed';
import { parseAppRoute } from './renderer/route';

/**
 * CLA-329: the header's "Embed this atlas" dialog. Pure: the snippet is a function of the page URL, the
 * chosen size and whether to start at the current view. It reuses the oEmbed iframe markup (oembed.ts), so a
 * pasted snippet and an oEmbed-discovered embed are the same iframe.
 */

export type EmbedSizePresetId = 'medium' | 'large' | 'responsive';

export type EmbedSizePreset = {
  id: EmbedSizePresetId;
  label: string;
  /** Pixels, or '100%' for the responsive preset (16:9 by aspect-ratio). */
  width: number | '100%';
  height: number | 'auto';
};

export const EMBED_SIZE_PRESETS: readonly EmbedSizePreset[] = [
  { id: 'medium', label: '800 × 500', width: 800, height: 500 },
  { id: 'large', label: '1200 × 675', width: 1200, height: 675 },
  { id: 'responsive', label: 'Responsive', width: '100%', height: 'auto' },
];

export const DEFAULT_EMBED_PRESET: EmbedSizePresetId = 'medium';

/**
 * Honest about reach: an oEmbed-discovering host (Ghost, WordPress for trusted authors) embeds the live atlas, but
 * proxies such as Iframely (Notion, many CMSs) show a link card for domains they have not reviewed.
 */
export const EMBED_OEMBED_NOTE = 'Or paste the link: tools that read oEmbed (like Ghost) embed the live atlas; others may show a preview card.';

function presetSize(preset: EmbedSizePreset): EmbedIframeSize {
  return typeof preset.width === 'number' && typeof preset.height === 'number'
    ? { width: preset.width, height: preset.height }
    : 'responsive';
}

/** The view's query minus any `embed` flag (the builder adds `embed=1` itself), '' when nothing is left. */
function viewSearch(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(OEMBED_EMBED_PARAM);
  const rest = params.toString();
  return rest ? `?${rest}` : '';
}

export type EmbedSnippetInput = {
  /** The current page URL (after the view has been flushed to it). */
  pageHref: string;
  /** Keep the current view's query (camera, selection, story); otherwise the atlas root. */
  startAtView: boolean;
  preset: EmbedSizePresetId | EmbedSizePreset;
  /** Names for the iframe title (GitHub's casing from the publication); the URL's otherwise. */
  displayNames?: PublicAtlasDisplayNames;
};

/**
 * The iframe snippet for the public atlas at `pageHref`, or undefined when it is not an embeddable `/r/owner/repo`
 * page. The target is parsed from origin + path only, so a long view query (navigation allows up to 4096 chars)
 * never blocks the embed; the view query is attached afterwards. No leading chrome comment: people copy a clean
 * `<iframe>` (the oEmbed payload keeps its comment).
 */
export function buildEmbedSnippet(input: EmbedSnippetInput): string | undefined {
  let page: URL;
  try {
    page = new URL(input.pageHref);
  } catch {
    return undefined;
  }
  const target = parsePublicAtlasOembedUrl(`${page.origin}${page.pathname}`, page.origin, [page.origin]);
  if (!target || page.username || page.password) return undefined;
  const preset = typeof input.preset === 'string'
    ? EMBED_SIZE_PRESETS.find(candidate => candidate.id === input.preset)
    : input.preset;
  if (!preset) return undefined;
  const search = input.startAtView ? viewSearch(page.search) : '';
  return buildOembedIframeHtml({ ...target, search }, presetSize(preset), input.displayNames ?? target, { chromeNote: false });
}

/**
 * The plain atlas link to paste into link-embedding tools (oEmbed discovery): the page URL without `embed`, at the
 * current view or the atlas root. Undefined when the page is not an embeddable `/r/owner/repo` page.
 */
export function buildEmbedLink(input: { pageHref: string; startAtView: boolean }): string | undefined {
  let page: URL;
  try {
    page = new URL(input.pageHref);
  } catch {
    return undefined;
  }
  const target = parsePublicAtlasOembedUrl(`${page.origin}${page.pathname}`, page.origin, [page.origin]);
  if (!target || page.username || page.password) return undefined;
  return `${page.origin}${page.pathname}${input.startAtView ? viewSearch(page.search) : ''}`;
}

export type EmbedButtonInput = {
  /** The page is a `/r/owner/repo` route. */
  routeIsRepo: boolean;
  /** The atlas came from a publication (its row in /scan/index.json). */
  published: boolean;
  /** The dogfood atlas (always public). */
  dogfood: boolean;
  /** Already inside an embed (framed or `?embed=1`). */
  embedded: boolean;
  /** The portable (offline) viewer. */
  portable: boolean;
};

/** Only public atlases offer an embed: the oEmbed endpoint 404s for anything else. */
export function embedButtonVisible(input: EmbedButtonInput): boolean {
  return input.routeIsRepo && (input.published || input.dogfood) && !input.embedded && !input.portable;
}

/**
 * CLA-268: while the publication index is still answering, hold the button's place in the header if a publication
 * would show it, so the header buttons do not move when it arrives. Once settled the button shows or the slot goes.
 */
export function embedButtonSlotReserved(input: EmbedButtonInput, settled: boolean): boolean {
  return !settled && !embedButtonVisible(input) && embedButtonVisible({ ...input, published: true });
}

/** The visibility input for the live page (pure; the hook feeds it window.location and the publication store). */
export function embedAvailabilityInput(input: {
  pathname: string;
  search: string;
  framed: boolean;
  portable: boolean;
  attribution: PublishedAtlasAttribution | undefined;
}): EmbedButtonInput {
  const route = parseAppRoute(input.pathname);
  return {
    routeIsRepo: route.kind === 'repo',
    published: input.attribution !== undefined,
    dogfood: route.kind === 'repo' && isDogfoodAtlas(route.owner, route.repo),
    embedded: isEmbedChrome({ framed: input.framed, embedQuery: isEmbedQueryFlag(input.search) }),
    portable: input.portable,
  };
}
