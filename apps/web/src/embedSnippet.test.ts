import { describe, expect, it } from 'vitest';
import type { PublishedAtlasAttribution } from './atlasAttribution';
import { buildEmbedLink, buildEmbedSnippet, EMBED_SIZE_PRESETS, embedAvailabilityInput, embedButtonSlotReserved, embedButtonVisible, type EmbedButtonInput } from './embedSnippet';
import { buildOembedIframeHtml, OEMBED_SNIPPET_CHROME_NOTE, parsePublicAtlasOembedUrl } from './oembed';

const PAGE = 'https://sourcefor.dev/r/pmndrs/zustand?nav=1&z=0.75&sel=container%3Aapi';
const comment = `<!-- ${OEMBED_SNIPPET_CHROME_NOTE} -->`;
const srcOf = (html: string) => html.match(/ src="([^"]*)"/)?.[1]?.replace(/&amp;/g, '&');

describe('CLA-329 embed snippet', () => {
  it('each preset: fixed 800×500 and 1200×675 iframes, and a full-width 16:9 responsive one', () => {
    const snippet = (preset: 'medium' | 'large' | 'responsive') => buildEmbedSnippet({ pageHref: PAGE, startAtView: true, preset });
    expect(EMBED_SIZE_PRESETS.map(preset => preset.label)).toEqual(['800 × 500', '1200 × 675', 'Responsive']);
    expect(snippet('medium')).toBe(`<iframe src="https://sourcefor.dev/r/pmndrs/zustand?nav=1&amp;z=0.75&amp;sel=container%3Aapi&amp;embed=1" width="800" height="500" loading="lazy" style="border:0;border-radius:12px" title="pmndrs/zustand architecture atlas" allow="fullscreen; gpu" allowfullscreen></iframe>`);
    expect(snippet('large')).toContain(' width="1200" height="675" loading="lazy" style="border:0;border-radius:12px" ');
    const responsive = snippet('responsive')!;
    expect(responsive).toContain(' width="100%" loading="lazy" style="border:0;border-radius:12px;width:100%;height:auto;aspect-ratio:16/9" ');
    expect(responsive).not.toContain('height="');
  });

  it('start at this view keeps the view query; off, the atlas root (plus embed=1 only)', () => {
    expect(srcOf(buildEmbedSnippet({ pageHref: PAGE, startAtView: true, preset: 'medium' })!)).toBe('https://sourcefor.dev/r/pmndrs/zustand?nav=1&z=0.75&sel=container%3Aapi&embed=1');
    expect(srcOf(buildEmbedSnippet({ pageHref: PAGE, startAtView: false, preset: 'medium' })!)).toBe('https://sourcefor.dev/r/pmndrs/zustand?embed=1');
  });

  it('embed=1 appears exactly once, whatever embed flag the page URL already carried', () => {
    for (const pageHref of [`${PAGE}&embed=1`, `${PAGE}&embed=0&embed=1`, 'https://sourcefor.dev/r/pmndrs/zustand?embed=1']) {
      for (const startAtView of [true, false]) {
        const src = srcOf(buildEmbedSnippet({ pageHref, startAtView, preset: 'large' })!)!;
        expect(new URL(src).searchParams.getAll('embed'), `${pageHref} ${startAtView}`).toEqual(['1']);
      }
    }
  });

  it('keeps a ref-pinned path', () => {
    const src = srcOf(buildEmbedSnippet({ pageHref: 'https://sourcefor.dev/r/pmndrs/zustand/v5.0.0?nav=1', startAtView: true, preset: 'medium' })!);
    expect(src).toBe('https://sourcefor.dev/r/pmndrs/zustand/v5.0.0?nav=1&embed=1');
  });

  it('escapes hostile characters in the query and the title', () => {
    const html = buildEmbedSnippet({
      pageHref: 'https://sourcefor.dev/r/pmndrs/zustand?q="><script>&x=1',
      startAtView: true,
      preset: 'medium',
      displayNames: { owner: 'a"b<c', repo: 'd&e' },
    })!;
    const iframe = html;
    expect(iframe).not.toMatch(/<script/);
    expect(iframe.match(/"/g)!.length % 2).toBe(0);
    expect(iframe).toContain('title="a&quot;b&lt;c/d&amp;e architecture atlas"');
    expect(iframe).not.toMatch(/src="[^"]*[<>][^"]*"/);
    // The src's only `&` are escaped separators.
    expect(iframe.match(/src="([^"]*)"/)![1]).not.toMatch(/&(?!amp;)/);
  });

  it('uses the publication names for the title when given', () => {
    const html = buildEmbedSnippet({ pageHref: 'https://sourcefor.dev/r/burntsushi/ripgrep', startAtView: false, preset: 'medium', displayNames: { owner: 'BurntSushi', repo: 'ripgrep' } })!;
    expect(html).toContain('title="BurntSushi/ripgrep architecture atlas"');
    expect(srcOf(html)).toBe('https://sourcefor.dev/r/burntsushi/ripgrep?embed=1');
  });

  it('starts with a clean <iframe>: no embed-chrome comment (the oEmbed payload keeps it)', () => {
    for (const preset of ['medium', 'large', 'responsive'] as const) {
      const html = buildEmbedSnippet({ pageHref: PAGE, startAtView: true, preset })!;
      expect(html.startsWith('<iframe ')).toBe(true);
      expect(html).not.toContain('<!--');
    }
  });

  it('builds for long view queries (navigation allows up to 4096 chars; the oEmbed URL cap is 2048)', () => {
    const pageHref = `https://sourcefor.dev/r/pmndrs/zustand?nav=1&sel=${'a'.repeat(2100)}`;
    expect(pageHref.length).toBeGreaterThan(2048);
    const src = srcOf(buildEmbedSnippet({ pageHref, startAtView: true, preset: 'medium' })!)!;
    expect(new URL(src).searchParams.get('sel')).toHaveLength(2100);
    expect(new URL(src).searchParams.getAll('embed')).toEqual(['1']);
  });

  it('is undefined for a ref outside the allowed charset', () => {
    expect(buildEmbedSnippet({ pageHref: 'https://sourcefor.dev/r/pmndrs/zustand/feat~x', startAtView: true, preset: 'medium' })).toBeUndefined();
    expect(buildEmbedSnippet({ pageHref: 'https://sourcefor.dev/r/pmndrs/zustand/a%20b', startAtView: false, preset: 'medium' })).toBeUndefined();
  });

  it('is undefined off a public atlas route', () => {
    for (const pageHref of ['https://sourcefor.dev/', 'https://sourcefor.dev/new', 'https://sourcefor.dev/r/pmndrs', 'https://sourcefor.dev/operator', 'not a url', 'https://user:pw@sourcefor.dev/r/pmndrs/zustand']) {
      expect(buildEmbedSnippet({ pageHref, startAtView: true, preset: 'medium' }), pageHref).toBeUndefined();
    }
  });

  it('works on loopback dev servers too', () => {
    expect(srcOf(buildEmbedSnippet({ pageHref: 'http://localhost:4173/r/THISS/okie', startAtView: true, preset: 'medium' })!)).toBe('http://localhost:4173/r/THISS/okie?embed=1');
  });

  it('leaves the oEmbed iframe markup byte-identical', () => {
    const target = parsePublicAtlasOembedUrl('https://sourcefor.dev/r/pmndrs/zustand?nav=1', 'https://sourcefor.dev', ['https://sourcefor.dev'])!;
    expect(buildOembedIframeHtml(target, { width: 800, height: 560 })).toBe(`${comment}<iframe src="https://sourcefor.dev/r/pmndrs/zustand?nav=1&amp;embed=1" width="800" height="560" loading="lazy" style="border:0;border-radius:12px" title="pmndrs/zustand architecture atlas" allow="fullscreen; gpu" allowfullscreen></iframe>`);
  });
});

describe('CLA-329 embed button visibility', () => {
  const base: EmbedButtonInput = { routeIsRepo: true, published: true, dogfood: false, embedded: false, portable: false };
  it.each<[string, Partial<EmbedButtonInput>, boolean]>([
    ['published /r/ atlas', {}, true],
    ['dogfood /r/ atlas (no publication row yet)', { published: false, dogfood: true }, true],
    ['published and dogfood', { dogfood: true }, true],
    ['unpublished /r/ atlas (private scan)', { published: false }, false],
    ['not a /r/ route (demo, landing)', { routeIsRepo: false }, false],
    ['not a /r/ route even if dogfood', { routeIsRepo: false, dogfood: true }, false],
    ['already inside an embed', { embedded: true }, false],
    ['portable viewer', { portable: true }, false],
  ])('%s', (_label, patch, expected) => {
    expect(embedButtonVisible({ ...base, ...patch })).toBe(expected);
  });
});

describe('CLA-329 embed availability input (the hook\'s derivation)', () => {
  const attribution = { owner: 'pmndrs', repo: 'zustand' } as PublishedAtlasAttribution;
  const at = (patch: Partial<Parameters<typeof embedAvailabilityInput>[0]> = {}) =>
    embedAvailabilityInput({ pathname: '/r/pmndrs/zustand', search: '', framed: false, portable: false, attribution, ...patch });
  it('a published /r/ atlas', () => {
    expect(at()).toEqual({ routeIsRepo: true, published: true, dogfood: false, embedded: false, portable: false });
    expect(embedButtonVisible(at())).toBe(true);
  });
  it('unpublished until the index answers', () => {
    expect(at({ attribution: undefined })).toMatchObject({ published: false });
    expect(embedButtonVisible(at({ attribution: undefined }))).toBe(false);
  });
  it('dogfood (any casing) needs no publication row', () => {
    const input = at({ pathname: '/r/thiss/okie', attribution: undefined });
    expect(input).toMatchObject({ routeIsRepo: true, dogfood: true, published: false });
    expect(embedButtonVisible(input)).toBe(true);
  });
  it('embedded by query flag or by frame', () => {
    expect(at({ search: '?nav=1&embed=1' }).embedded).toBe(true);
    expect(at({ search: '?embed=0' }).embedded).toBe(false);
    expect(at({ framed: true }).embedded).toBe(true);
    expect(embedButtonVisible(at({ framed: true }))).toBe(false);
  });
  it('portable and non-repo routes', () => {
    expect(embedButtonVisible(at({ portable: true }))).toBe(false);
    expect(at({ pathname: '/' })).toMatchObject({ routeIsRepo: false, dogfood: false });
    expect(embedButtonVisible(at({ pathname: '/new' }))).toBe(false);
  });
});

describe('CLA-329 embed dialog link', () => {
  const PAGE = 'https://sourcefor.dev/r/burnt-sushi/ripgrep?nav=1&z=0.75&embed=1';
  it('is the atlas URL at the current view without embed, or the atlas root', () => {
    expect(buildEmbedLink({ pageHref: PAGE, startAtView: true })).toBe('https://sourcefor.dev/r/burnt-sushi/ripgrep?nav=1&z=0.75');
    expect(buildEmbedLink({ pageHref: PAGE, startAtView: false })).toBe('https://sourcefor.dev/r/burnt-sushi/ripgrep');
    expect(buildEmbedLink({ pageHref: 'https://sourcefor.dev/r/burnt-sushi/ripgrep?embed=1', startAtView: true })).toBe('https://sourcefor.dev/r/burnt-sushi/ripgrep');
  });
  it('is undefined off an atlas route', () => {
    expect(buildEmbedLink({ pageHref: 'https://sourcefor.dev/new', startAtView: true })).toBeUndefined();
    expect(buildEmbedLink({ pageHref: 'not a url', startAtView: true })).toBeUndefined();
  });
});

describe('CLA-268 embed button slot while the publication index is answering', () => {
  const unpublished: EmbedButtonInput = { routeIsRepo: true, published: false, dogfood: false, embedded: false, portable: false };
  it.each<[string, Partial<EmbedButtonInput>, boolean, boolean]>([
    ['/r/ atlas, index pending', {}, false, true],
    ['/r/ atlas, index answered: not a publication', {}, true, false],
    ['/r/ atlas, index answered: a publication (the button itself shows)', { published: true }, true, false],
    ['dogfood shows the button already', { dogfood: true }, false, false],
    ['not a /r/ route', { routeIsRepo: false }, false, false],
    ['inside an embed', { embedded: true }, false, false],
    ['portable viewer', { portable: true }, false, false],
  ])('%s', (_label, patch, settled, expected) => {
    expect(embedButtonSlotReserved({ ...unpublished, ...patch }, settled)).toBe(expected);
  });
});
