import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { atlasAttributionFor, attributionText, embedAttributionText, getPublishedAtlasAttribution, installPublishedAtlasAttribution, onPublishedAtlasAttribution, reserveAtlasAttribution } from './atlasAttribution';

const SHA = '4f1c2a9e0b7d6c5a4f3e2d1c0b9a8f7e6d5c4b3a';
const INDEX = {
  schema: 'okie.published-index/v1',
  schemaVersion: 1,
  repos: [
    {
      slug: 'pmndrs__zustand',
      owner: 'pmndrs',
      repo: 'zustand',
      repositoryId: 'repo:pmndrs-zustand',
      versionId: 'publication-1',
      commitSha: SHA,
      generatedAt: '2026-09-30T00:00:00Z',
      entityCount: 120,
      publishedAt: '2026-09-30T00:00:00Z',
      license: { spdxId: 'MIT', name: 'MIT License', url: `https://github.com/pmndrs/zustand/blob/${SHA}/LICENSE` },
    },
    { slug: 'acme__local', owner: 'acme', repo: 'local', commitSha: SHA, generatedAt: '2026-09-30T00:00:00Z' },
  ],
};

/** Just enough DOM for renderAtlasAttribution (the web test env has no DOM). */
function fakeDocument() {
  type Node = { tag: string; attrs: Record<string, string>; children: Array<Node | string>; textContent?: string; dataset: Record<string, string>; [key: string]: unknown };
  const make = (tag: string): Node => {
    const node: Node = {
      tag,
      attrs: {},
      children: [],
      dataset: {},
      setAttribute(name: string, value: string) { node.attrs[name] = value; },
      hasAttribute(name: string) { return name in node.attrs; },
      removeAttribute(name: string) { delete node.attrs[name]; },
      append(...items: Array<Node | string>) { node.children.push(...items); },
    };
    return node;
  };
  const body = make('body');
  const root = make('html');
  const doc = {
    body,
    documentElement: root,
    createElement: make,
    createTextNode: (text: string) => text,
    querySelector: () => null,
  };
  const text = (node: Node | string): string => typeof node === 'string' ? node : node.textContent ?? node.children.map(text).join('');
  const links = (node: Node | string): Array<{ text: string; href: string; rel: string }> => typeof node === 'string' ? [] : [
    ...(node.tag === 'a' ? [{ text: text(node), href: String(node.href), rel: String(node.rel) }] : []),
    ...node.children.flatMap(links),
  ];
  return { doc: doc as unknown as Document, body, root, text, links };
}

describe('published atlas attribution (CLA-266)', () => {
  it('maps the slug row of /scan/index.json to repo, commit and licence links', () => {
    const attribution = atlasAttributionFor(INDEX, 'pmndrs__zustand');
    expect(attribution).toEqual({
      owner: 'pmndrs',
      repo: 'zustand',
      canonicalNames: false,
      commitSha: SHA,
      shortSha: '4f1c2a9',
      treeUrl: `https://github.com/pmndrs/zustand/tree/${SHA}`,
      commitUrl: `https://github.com/pmndrs/zustand/commit/${SHA}`,
      licenceLabel: 'MIT licence',
      licenceUrl: `https://github.com/pmndrs/zustand/blob/${SHA}/LICENSE`,
    });
    expect(attributionText(attribution!)).toBe('Source For Atlas · zustand by pmndrs · commit 4f1c2a9 · MIT licence · source on GitHub · About · Privacy · Terms · Brought to you by the guy who made clabrate.com');
  });

  it('renders nothing for rows that are not publications or are malformed', () => {
    expect(atlasAttributionFor(INDEX, 'acme__local')).toBeUndefined(); // no licence: not from a publication
    expect(atlasAttributionFor(INDEX, 'nobody__here')).toBeUndefined();
    expect(atlasAttributionFor(undefined, 'pmndrs__zustand')).toBeUndefined();
    expect(atlasAttributionFor({ repos: 'x' }, 'pmndrs__zustand')).toBeUndefined();
    const row = INDEX.repos[0]!;
    const variant = (patch: Record<string, unknown>) => atlasAttributionFor({ repos: [{ ...row, ...patch }] }, 'pmndrs__zustand');
    expect(variant({ owner: 'pm/ndrs' })).toBeUndefined();
    expect(variant({ commitSha: 'main' })).toBeUndefined();
    expect(variant({ license: { spdxId: '', name: '' } })).toBeUndefined();
    // Licence URL must be https; the rest still renders.
    expect(variant({ license: { spdxId: 'MIT', name: 'MIT License', url: 'javascript:alert(1)' } })).not.toHaveProperty('licenceUrl');
    expect(variant({ license: { spdxId: 'NOASSERTION', name: 'Other' } })?.licenceLabel).toBe('Other');
    // `--license-override NOASSERTION` records { spdxId: 'NOASSERTION', name: 'NOASSERTION' }: still labelled, never the raw token.
    expect(variant({ license: { spdxId: 'NOASSERTION', name: 'NOASSERTION' } })?.licenceLabel).toBe('Licence not asserted');
    expect(variant({ license: { spdxId: 'Apache-2.0', name: 'Apache License 2.0' } })?.licenceLabel).toBe('Apache-2.0 licence');
    // SPDX expressions (operator overrides) read as a list.
    expect(variant({ license: { spdxId: 'MIT AND CC-BY-4.0', name: 'MIT AND CC-BY-4.0' } })?.licenceLabel).toBe('licence: MIT AND CC-BY-4.0');
    expect(variant({ license: { spdxId: 'Unlicense OR MIT', name: 'Unlicense OR MIT' } })?.licenceLabel).toBe('licence: Unlicense OR MIT');
  });

  it('installs a labelled footer with GitHub links, and skips embeds', async () => {
    const fetchIndex = vi.fn(async () => new Response(JSON.stringify(INDEX), { status: 200 })) as unknown as typeof fetch;
    const page = fakeDocument();
    const installed = await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: page.doc, search: '', framed: false });
    expect(installed?.repo).toBe('zustand');
    const footer = page.body.children[0] as { tag: string; attrs: Record<string, string> };
    expect(footer.tag).toBe('footer');
    expect(footer.attrs['aria-label']).toBe('Atlas attribution');
    expect(page.text(footer as never)).toBe(attributionText(installed!));
    expect(page.links(footer as never).map(link => [link.text, link.href, link.rel])).toEqual([
      ['zustand', `https://github.com/pmndrs/zustand/tree/${SHA}`, 'noopener noreferrer'],
      ['4f1c2a9', `https://github.com/pmndrs/zustand/commit/${SHA}`, 'noopener noreferrer'],
      ['MIT licence', `https://github.com/pmndrs/zustand/blob/${SHA}/LICENSE`, 'noopener noreferrer'],
      ['source on GitHub', `https://github.com/pmndrs/zustand/tree/${SHA}`, 'noopener noreferrer'],
      // CLA-318: the one site link, to the home page's footer (GitHub, contact, licence note; CLA-269), same tab.
      ['About', '/#about', 'undefined'], // no rel: same tab
      // CLA-316: the privacy and terms pages, same tab.
      ['Privacy', '/privacy', 'undefined'],
      ['Terms', '/terms', 'undefined'],
      // CLA-269: the site footer's credit, same words, href and rel.
      ['clabrate.com', 'https://clabrate.com', 'noopener'],
    ]);
    expect(page.text(footer as never)).toMatch(/ · About · Privacy · Terms · Brought to you by the guy who made clabrate\.com$/);
    const line = (footer as unknown as { children: Array<{ children: Array<{ tag?: string; className?: string }> }> }).children[0]!;
    const credit = line.children.at(-1)!;
    expect(credit).toMatchObject({ tag: 'span', className: 'atlas-attribution-credit' });
    expect(page.text(credit as never)).toBe('Brought to you by the guy who made clabrate.com');
    expect(page.links(credit as never)).toEqual([{ text: 'clabrate.com', href: 'https://clabrate.com', rel: 'noopener' }]);
    expect(page.root.attrs['data-atlas-attribution']).toBe('');

    // CLA-328: embeds get the compact variant instead (tested below), never the full strip.
    for (const context of [{ search: '?embed=1', framed: false }, { search: '', framed: true }]) {
      const embed = fakeDocument();
      expect(await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: embed.doc, ...context })).toBeDefined();
      expect(embed.body.children).toHaveLength(1);
      expect(embed.text(embed.body.children[0] as never)).toBe(embedAttributionText(installed!));
      expect((embed.body.children[0] as unknown as { className: string }).className).toBe('atlas-attribution atlas-attribution-embed');
    }
    const embed = fakeDocument();
    const failing = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: failing, doc: embed.doc, search: '', framed: false })).toBeUndefined();
  });

  it('CLA-318: shows GitHub casing (ownerLogin/repoName) when the row has it, else the stored names', async () => {
    const row = { ...INDEX.repos[0]!, slug: 'burnt-sushi__ripgrep', owner: 'burntsushi', repo: 'ripgrep' };
    const canonical = atlasAttributionFor({ repos: [{ ...row, ownerLogin: 'BurntSushi', repoName: 'ripgrep' }] }, 'burnt-sushi__ripgrep');
    expect(canonical).toMatchObject({
      owner: 'BurntSushi',
      repo: 'ripgrep',
      canonicalNames: true,
      treeUrl: `https://github.com/BurntSushi/ripgrep/tree/${SHA}`,
      commitUrl: `https://github.com/BurntSushi/ripgrep/commit/${SHA}`,
    });
    expect(attributionText(canonical!)).toContain('ripgrep by BurntSushi');
    // Missing fields: the stored (lower-case) names, as before.
    const fallback = atlasAttributionFor({ repos: [row] }, 'burnt-sushi__ripgrep');
    expect(fallback).toMatchObject({ owner: 'burntsushi', repo: 'ripgrep', canonicalNames: false, treeUrl: `https://github.com/burntsushi/ripgrep/tree/${SHA}` });
    // Only one of the two, a different name, or an unsafe value never renames the atlas.
    for (const patch of [{ ownerLogin: 'BurntSushi' }, { ownerLogin: 'Someone', repoName: 'ripgrep' }, { ownerLogin: 'Burnt/Sushi', repoName: 'ripgrep' }, { ownerLogin: 'BurntSushi', repoName: 42 }]) {
      expect(atlasAttributionFor({ repos: [{ ...row, ...patch }] }, 'burnt-sushi__ripgrep')?.owner, JSON.stringify(patch)).toBe('burntsushi');
    }
    // Installing sets the tab title to GitHub's casing (the boot title came from the URL).
    const page = fakeDocument();
    const fetchIndex = vi.fn(async () => new Response(JSON.stringify({ repos: [{ ...row, ownerLogin: 'BurntSushi', repoName: 'ripgrep' }] }), { status: 200 })) as unknown as typeof fetch;
    await installPublishedAtlasAttribution('burnt-sushi__ripgrep', { fetch: fetchIndex, doc: page.doc, search: '', framed: false });
    expect((page.doc as unknown as { title?: string }).title).toBe('ripgrep by BurntSushi · Source For Atlas');
    // Without GitHub names: the stored names, the same as the server's share title (not the URL's slug casing).
    const stored = fakeDocument();
    const storedIndex = vi.fn(async () => new Response(JSON.stringify({ repos: [row] }), { status: 200 })) as unknown as typeof fetch;
    await installPublishedAtlasAttribution('burnt-sushi__ripgrep', { fetch: storedIndex, doc: stored.doc, search: '', framed: false });
    expect((stored.doc as unknown as { title?: string }).title).toBe('ripgrep by burntsushi · Source For Atlas');
    // No row: the boot title (from the URL) is left alone.
    const none = fakeDocument();
    (none.doc as unknown as { title: string }).title = 'boot title';
    await installPublishedAtlasAttribution('nobody__here', { fetch: storedIndex, doc: none.doc, search: '', framed: false });
    expect((none.doc as unknown as { title: string }).title).toBe('boot title');
  });

  it('CLA-269 credit: muted fine print on the strip, AA contrast on its real background, never widens the page', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    const tokens = readFileSync(new URL('../../../packages/theme/src/tokens.css', import.meta.url), 'utf8');
    const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/\./g, '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
    const token = (name: string) => tokens.match(new RegExp(`--${name}: (#[0-9a-f]{6});`))?.[1];
    const strip = rule('.atlas-attribution');
    const credit = rule('.atlas-attribution-credit');
    expect(credit).toContain('color: var(--atlas-muted);');
    expect(rule('.atlas-attribution .atlas-attribution-credit a')).toContain('color: inherit;');
    // The strip's own background and the credit's colour, read from the tokens the page uses.
    const bg = strip.match(/background: var\(--([a-z-]+)\);/)?.[1];
    const fg = credit.match(/color: var\(--([a-z-]+)\);/)?.[1];
    expect(bg).toBe('atlas-bg-raised');
    const luminance = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (luminance(token(fg!)!) + 0.05) / (luminance(token(bg!)!) + 0.05);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
    // Narrow widths: the one line scrolls inside the strip (nowrap + overflow-x), the strip is pinned to both edges.
    expect(rule('.atlas-attribution p')).toMatch(/min-width: 0;.*overflow-x: auto; white-space: nowrap;/);
    expect(strip).toMatch(/right: 0; bottom: 0; left: 0;/);
    expect(credit).not.toMatch(/white-space|width/);
  });

  it('reserves its height in the layout instead of overlapping the canvas controls', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toContain('html[data-atlas-attribution] #root { height: calc(100% - var(--atlas-attribution-height)); }');
    expect(css).toMatch(/\.atlas-attribution \{[^}]*position: fixed;[^}]*height: var\(--atlas-attribution-height\);/);
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(main).toContain('installPublishedAtlasAttribution(route.slug)');
  });

  it('CLA-328: embeds show a compact repo · licence · source line with external links only', async () => {
    const install = async (row: Record<string, unknown>, context = { search: '?embed=1', framed: false }) => {
      const page = fakeDocument();
      const fetchIndex = vi.fn(async () => new Response(JSON.stringify({ repos: [{ ...INDEX.repos[0]!, ...row }] }), { status: 200 })) as unknown as typeof fetch;
      const attribution = await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: page.doc, ...context });
      const footer = page.body.children[0] as unknown as { tag: string; className: string; attrs: Record<string, string>; dataset: Record<string, string> };
      return { page, attribution: attribution!, footer };
    };
    const { page, attribution, footer } = await install({});
    expect(footer.tag).toBe('footer');
    expect(footer.className).toBe('atlas-attribution atlas-attribution-embed');
    expect(footer.dataset).toEqual({ testid: 'atlas-attribution', variant: 'embed' });
    expect(footer.attrs['aria-label']).toBe('Atlas attribution');
    expect(page.text(footer as never)).toBe('pmndrs/zustand · MIT licence · source ↗');
    expect(embedAttributionText(attribution)).toBe('pmndrs/zustand · MIT licence · source ↗');
    const links = (footer as unknown as { children: Array<{ children: Array<{ tag?: string; target?: string; rel?: string; href?: string; textContent?: string }> }> }).children[0]!.children.filter(child => child.tag === 'a');
    expect(links.map(link => [link.textContent, link.href, link.target, link.rel])).toEqual([
      ['pmndrs/zustand', `https://github.com/pmndrs/zustand/tree/${SHA}`, '_blank', 'noopener noreferrer'],
      ['MIT licence', `https://github.com/pmndrs/zustand/blob/${SHA}/LICENSE`, '_blank', 'noopener noreferrer'],
      ['source ↗', `https://github.com/pmndrs/zustand/tree/${SHA}`, '_blank', 'noopener noreferrer'],
    ]);
    // The smaller strip still shrinks #root (html[data-atlas-attribution="embed"]).
    expect(page.root.attrs['data-atlas-attribution']).toBe('embed');

    // Framed (no query flag) is an embed too.
    expect((await install({}, { search: '', framed: true })).footer.dataset.variant).toBe('embed');
    // Operator override of NOASSERTION, and an SPDX expression; no licence URL renders plain text.
    const unasserted = await install({ license: { spdxId: 'NOASSERTION', name: 'NOASSERTION' } });
    expect(unasserted.page.text(unasserted.footer as never)).toBe('pmndrs/zustand · Licence not asserted · source ↗');
    expect(unasserted.page.links(unasserted.footer as never).map(link => link.text)).toEqual(['pmndrs/zustand', 'source ↗']);
    const expression = await install({ license: { spdxId: 'MIT AND CC-BY-4.0', name: 'MIT AND CC-BY-4.0', url: 'https://example.com/L' } });
    expect(expression.page.text(expression.footer as never)).toBe('pmndrs/zustand · licence: MIT AND CC-BY-4.0 · source ↗');
    // GitHub's casing when the row has it.
    const canonical = await install({ ownerLogin: 'PMNDRS', repoName: 'zustand', owner: 'pmndrs' });
    expect(canonical.page.text(canonical.footer as never)).toBe('PMNDRS/zustand · MIT licence · source ↗');
    expect(canonical.page.links(canonical.footer as never)[0]!.href).toBe(`https://github.com/PMNDRS/zustand/tree/${SHA}`);

    // Outside embeds the full strip is unchanged.
    const full = await install({}, { search: '', framed: false });
    expect(full.footer.className).toBe('atlas-attribution');
    expect(full.footer.dataset).toEqual({ testid: 'atlas-attribution' });
    expect(full.page.text(full.footer as never)).toBe(attributionText(full.attribution));
    expect(full.page.root.attrs['data-atlas-attribution']).toBe('');
  });

  it('CLA-328: the embed strip reserves a smaller height and never covers the canvas', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toContain('html[data-atlas-attribution="embed"] { --atlas-attribution-height: 22px; }');
    expect(css).toContain('html[data-atlas-attribution] #root { height: calc(100% - var(--atlas-attribution-height)); }');
  });

  it('CLA-329: publishes the resolved attribution so App can react after mount', async () => {
    const seen: Array<string | undefined> = [];
    const unsubscribe = onPublishedAtlasAttribution(() => { seen.push(getPublishedAtlasAttribution()?.repo); });
    const fetchIndex = vi.fn(async () => new Response(JSON.stringify(INDEX), { status: 200 })) as unknown as typeof fetch;
    await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: fakeDocument().doc, search: '', framed: false });
    expect(getPublishedAtlasAttribution()).toMatchObject({ owner: 'pmndrs', repo: 'zustand' });
    await installPublishedAtlasAttribution('acme__local', { fetch: fetchIndex, doc: fakeDocument().doc, search: '', framed: false });
    expect(getPublishedAtlasAttribution()).toBeUndefined();
    unsubscribe();
    await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: fakeDocument().doc, search: '', framed: false });
    expect(seen).toEqual(['zustand', undefined]);
  });

  it('CLA-268: holds the strip height from boot and gives it back only when no strip comes', async () => {
    const fetchIndex = vi.fn(async () => new Response(JSON.stringify(INDEX), { status: 200 })) as unknown as typeof fetch;
    const published = fakeDocument();
    reserveAtlasAttribution(published.doc, false);
    expect(published.root.attrs['data-atlas-attribution']).toBe('');
    await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: fetchIndex, doc: published.doc, search: '', framed: false });
    expect(published.root.attrs['data-atlas-attribution']).toBe('');

    const embed = fakeDocument();
    reserveAtlasAttribution(embed.doc, true);
    expect(embed.root.attrs['data-atlas-attribution']).toBe('embed');

    const notPublished = fakeDocument();
    reserveAtlasAttribution(notPublished.doc, false);
    await installPublishedAtlasAttribution('acme__local', { fetch: fetchIndex, doc: notPublished.doc, search: '', framed: false });
    expect(notPublished.root.attrs).not.toHaveProperty('data-atlas-attribution');

    const failed = fakeDocument();
    reserveAtlasAttribution(failed.doc, false);
    await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch, doc: failed.doc, search: '', framed: false });
    expect(failed.root.attrs).not.toHaveProperty('data-atlas-attribution');

    const offline = fakeDocument();
    reserveAtlasAttribution(offline.doc, false);
    await installPublishedAtlasAttribution('pmndrs__zustand', { fetch: vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch, doc: offline.doc, search: '', framed: false });
    expect(offline.root.attrs).not.toHaveProperty('data-atlas-attribution');
  });

  it('CLA-268: reports the index lookup as settled whatever it found, so App can stop holding the embed slot', async () => {
    vi.resetModules();
    const fresh = await import('./atlasAttribution');
    const settled: boolean[] = [];
    const unsubscribe = fresh.onPublishedAtlasAttribution(() => { settled.push(fresh.getPublishedAtlasAttributionSettled()); });
    expect(fresh.getPublishedAtlasAttributionSettled()).toBe(false);
    await fresh.installPublishedAtlasAttribution('pmndrs__zustand', { fetch: vi.fn(async () => new Response('', { status: 404 })) as unknown as typeof fetch, doc: fakeDocument().doc, search: '', framed: false });
    expect(fresh.getPublishedAtlasAttributionSettled()).toBe(true);
    expect(fresh.getPublishedAtlasAttribution()).toBeUndefined();
    expect(settled).toEqual([true]);
    unsubscribe();
  });
});
