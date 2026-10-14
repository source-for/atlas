import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import { BootShell } from './BootShell';
import { advanceBootShellStep, BOOT_SHELL_STEPS, bootShellHeaderSlots, bootShellLayout, bootShellRepositoryId, bootShellStepLabel, createBootShellOwner, recallRouteRepository, rememberRouteRepository } from './bootShellState';
import { initialInspectorOpen } from './embedChrome';
import { defaultInspectorWidth, initialInspectorWidth, inspectorWidthStorageKey } from './inspector/inspectorPanel';
import { navigationStateFromUrl, type NavigationDefaults } from './navigation/navigationState';
import { parseAppRoute } from './renderer/route';

const top = {};
const page = (innerWidth: number) => ({ innerWidth, self: top, top });

describe('CLA-268 boot shell steps', () => {
  it('names each step in plain words, in boot order', () => {
    expect(BOOT_SHELL_STEPS.map(bootShellStepLabel)).toEqual(['Loading atlas data…', 'Preparing the view…', 'Opening the map…']);
  });

  it('only moves forward: a late report of an earlier step never replaces a later one', () => {
    expect(advanceBootShellStep('data', 'view')).toBe('view');
    expect(advanceBootShellStep('view', 'opening')).toBe('opening');
    expect(advanceBootShellStep('data', 'opening')).toBe('opening');
    expect(advanceBootShellStep('opening', 'view')).toBe('opening');
    expect(advanceBootShellStep('view', 'data')).toBe('view');
    expect(advanceBootShellStep('view', 'view')).toBe('view');
  });
});

describe('CLA-268 boot shell layout matches App\'s first render', () => {
  it.each([1440, 1280, 1061, 1060, 901, 900, 640])('a top-level page %ipx wide', width => {
    expect(bootShellLayout(page(width), '')).toEqual({
      embed: false,
      detailsOpen: initialInspectorOpen(page(width), ''),
      detailsWidth: defaultInspectorWidth(width),
    });
  });

  it('desktop: inspector open at the default width', () => {
    expect(bootShellLayout(page(1440), '')).toEqual({ embed: false, detailsOpen: true, detailsWidth: 403 });
  });

  it('embeds (?embed=1 or framed) get embed chrome with the inspector closed', () => {
    expect(bootShellLayout(page(1440), '?embed=1')).toMatchObject({ embed: true, detailsOpen: false });
    expect(bootShellLayout({ innerWidth: 800, self: {}, top: {} }, '')).toMatchObject({ embed: true, detailsOpen: false });
  });
});

function memoryStorage(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, map };
}

describe('CLA-268 boot shell keeps the repository\'s saved inspector width', () => {
  const repo = 'repo:source-for-atlas';
  it('App and the skeleton share one initializer', () => {
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
    expect(app).toContain('const [detailsWidth, setDetailsWidth] = useState(() => initialInspectorWidth(window.innerWidth, () => localStorage, initialNavigation.repositoryId));');
    expect(app).not.toMatch(/localStorage\.getItem\(inspectorWidthStorageKey/);
  });

  // Saved width, clamped to the viewport's range (360 up to 520 or 46% of the viewport); junk falls back to the default.
  it.each([
    [1440, '520', 520], [1440, '300', 360], [1440, '9999', 520], [1440, '455.4', 455], [1060, '520', 488], [800, '480', 368], [1440, 'wide', 403], [1440, '', 403],
  ])('at %ipx with %s saved, the skeleton opens the inspector at %ipx', (viewport, saved, expected) => {
    const storage = memoryStorage({ [inspectorWidthStorageKey(repo)]: saved });
    expect(bootShellLayout(page(viewport), '', { storage, repositoryId: repo }).detailsWidth).toBe(expected);
  });

  it('another repository\'s width is not this one\'s', () => {
    const storage = memoryStorage({ [inspectorWidthStorageKey(repo)]: '520' });
    expect(bootShellLayout(page(1440), '', { storage, repositoryId: 'repo:other' }).detailsWidth).toBe(403);
  });

  it('uses the default while the repository is unknown or storage is unavailable', () => {
    const storage = memoryStorage({ [inspectorWidthStorageKey(repo)]: '520' });
    expect(initialInspectorWidth(1440, () => storage, undefined)).toBe(403);
    expect(initialInspectorWidth(1440, () => undefined, repo)).toBe(403);
    expect(initialInspectorWidth(1440, () => ({ getItem: () => { throw new Error('denied'); } }), repo)).toBe(403);
    // Reading the storage property itself can throw in privacy modes: that is inside the guard too.
    expect(initialInspectorWidth(1440, () => { throw new Error('SecurityError'); }, repo)).toBe(403);
  });
});

describe('CLA-268 boot shell repository identity is App\'s', () => {
  const defaults = (repositoryId: string): NavigationDefaults => ({
    repositoryId, snapshotId: 'snapshot:x', viewId: 'view:x', rootEntityId: 'system:x', selectedId: 'system:x', camera: { x: 0, y: 0, zoom: 1 },
  });
  const base = 'https://atlas.test/r/source-for/atlas';
  it.each([
    '',
    '?nav=1&repo=repo%3Ashared&snap=snapshot%3Ax&view=view%3Ax&root=system%3Ax',
    '?repo=repo%3Ashared',
    '?repo=repo%3Afirst&repo=repo%3Alast',
    '?nav=2&repo=repo%3Ashared',
    '?nav=1&repo=%20%20',
    '?repo=%20repo%3Apadded%20',
    '?repo=bad%01id',
    `?repo=${'r'.repeat(513)}`,
    `?repo=repo%3Along&pad=${'x'.repeat(4100)}`,
    '?embed=1',
  ])('%s', search => {
    const href = base + search;
    expect(bootShellRepositoryId(href, 'repo:source-for-atlas')).toBe(navigationStateFromUrl(href, defaults('repo:source-for-atlas')).state.repositoryId);
  });

  it('a shared view names its repository before the data has arrived', () => {
    expect(bootShellRepositoryId(`${base}?nav=1&repo=repo%3Ashared`, undefined)).toBe('repo:shared');
    expect(bootShellRepositoryId(base, undefined)).toBeUndefined();
  });
});

describe('CLA-268 boot shell remembers which repository a route showed', () => {
  it('recalls what was remembered for that route only', () => {
    const storage = memoryStorage();
    expect(recallRouteRepository(storage, 'repo:source-for__atlas')).toBeUndefined();
    rememberRouteRepository(storage, 'repo:source-for__atlas', 'repo:source-for-atlas');
    expect(recallRouteRepository(storage, 'repo:source-for__atlas')).toBe('repo:source-for-atlas');
    expect(recallRouteRepository(storage, 'repo:other')).toBeUndefined();
  });

  it('never throws when storage is unavailable', () => {
    const denied = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(() => rememberRouteRepository(denied, 'k', 'v')).not.toThrow();
    expect(recallRouteRepository(denied, 'k')).toBeUndefined();
    expect(recallRouteRepository(undefined, 'k')).toBeUndefined();
  });
});

describe('CLA-268 boot shell root ownership', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(res => { resolve = res; });
    return { promise, resolve };
  }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  it('a font load that settles after App was scheduled never paints the skeleton again', async () => {
    const fonts = deferred();
    const render = vi.fn();
    const owner = createBootShellOwner({ render, fontsLoaded: () => false, loadFonts: () => fonts.promise, aborted: () => false });
    owner.show('data');
    owner.show('opening', 'repo:x');
    expect(render).toHaveBeenCalledTimes(2);
    // main.tsx's renderRoot: release, then schedule App. The skeleton is still in the DOM at this point.
    owner.release();
    fonts.resolve();
    await flush();
    expect(render).toHaveBeenCalledTimes(2);
    expect(owner.owns).toBe(false);
  });

  it('while it owns the root, the late font load repaints the current step with the wordmark shown', async () => {
    const fonts = deferred();
    const render = vi.fn();
    const owner = createBootShellOwner({ render, fontsLoaded: () => false, loadFonts: () => fonts.promise, aborted: () => false });
    owner.show('data');
    owner.show('view', 'repo:x');
    expect(render).toHaveBeenLastCalledWith({ step: 'view', fontsReady: false, atlasRepositoryId: 'repo:x' });
    fonts.resolve();
    await flush();
    expect(render).toHaveBeenCalledTimes(3);
    expect(render).toHaveBeenLastCalledWith({ step: 'view', fontsReady: true, atlasRepositoryId: 'repo:x' });
  });

  it('keeps the repository once known, and never paints after startup was aborted', async () => {
    const fonts = deferred();
    let aborted = false;
    const render = vi.fn();
    const owner = createBootShellOwner({ render, fontsLoaded: () => true, loadFonts: () => fonts.promise, aborted: () => aborted });
    owner.show('data', 'repo:recalled');
    owner.show('view');
    expect(render).toHaveBeenLastCalledWith({ step: 'view', fontsReady: true, atlasRepositoryId: 'repo:recalled' });
    aborted = true;
    owner.show('opening');
    expect(render).toHaveBeenCalledTimes(2);
  });
});

describe('CLA-268 main.tsx hands the root over only through renderRoot', () => {
  it('renders nothing but the skeleton straight into the root', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    const direct = [...main.matchAll(/\broot\.render\(/g)].map(match => main.slice(match.index, match.index + 22));
    expect(direct).toEqual(['root.render(<BootShell', 'root.render(node);\n}\n\n']);
    expect(main).toMatch(/function renderRoot\(node: ReactNode\): void \{\n {2}bootShell\.release\(\);\n {2}root\.render\(node\);/);
  });
});

describe('CLA-268 boot shell header slots', () => {
  it('holds the embed button\'s place on a published /r/ page outside embeds, in App\'s order', () => {
    expect(bootShellHeaderSlots(parseAppRoute('/r/source-for/atlas'), false)).toEqual(['import', 'screenshot', 'share', 'embed', 'repo']);
    expect(bootShellHeaderSlots(parseAppRoute('/r/THISS/okie'), false)).toEqual(['import', 'screenshot', 'share', 'embed', 'repo']);
  });
  it('has no embed slot inside an embed or off /r/', () => {
    expect(bootShellHeaderSlots(parseAppRoute('/r/source-for/atlas'), true)).toEqual(['import', 'screenshot', 'share', 'repo']);
    expect(bootShellHeaderSlots(parseAppRoute('/'), false)).toEqual(['import', 'screenshot', 'share', 'repo']);
  });
});

describe('CLA-268 boot shell view', () => {
  const markup = renderToStaticMarkup(createElement(BootShell, { layout: { embed: false, detailsOpen: true, detailsWidth: 403 }, step: 'view', headerSlots: ['import', 'screenshot', 'share', 'embed', 'repo'] as const, fontsReady: true }));

  it('has one live region naming the step, which nothing holds back', () => {
    expect(markup).toMatch(/^<div class="app-shell boot-shell" data-boot-step="view" data-embed="false"/);
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).toContain('<p class="boot-status" role="status">Preparing the view…</p>');
    // A busy ancestor may hold a live region's updates until it goes un-busy; the skeleton never does (App replaces it).
    expect(markup).not.toContain('aria-busy');
    // No accessible name on a role-less element.
    expect(markup).not.toContain('aria-label');
  });

  it('exposes no landmark or text other than the step line', () => {
    expect(markup).toMatch(/<header aria-hidden="true" class="topbar">/);
    const document = new Window().document;
    document.body.innerHTML = markup;
    for (const hidden of document.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
    expect(document.querySelectorAll('header, nav, main, aside, section[aria-label], [role]').length).toBe(1);
    const exposed = document.body.textContent;
    expect(exposed).toBe('Preparing the view…');
  });

  it('holds no controls: nothing can take focus or be clicked', () => {
    expect(markup).not.toMatch(/<(button|input|a|select|textarea|details|summary)[\s>]/);
    expect(markup).not.toMatch(/tabindex|href=|contenteditable/);
  });

  it('uses App\'s shell regions so each sits in App\'s box', () => {
    for (const region of ['class="topbar"', 'class="search-zone"', 'class="search-trigger"', 'class="top-actions"', 'class="diagram-view-bar"', 'class="workspace has-details"', 'class="map-stage"', 'class="level-rail"', 'class="details-panel open"', '--details-width:403px']) {
      expect(markup).toContain(region);
    }
    // Each header slot carries its App control's classes (App's narrow-width rules hide or keep them alike).
    expect(markup).toContain('<div class="top-actions"><span class="icon-button"></span><span class="diagram-add-menu screenshot-menu"><span class="boot-menu-summary"></span></span><span class="icon-button share-view-button"></span><span class="embed-atlas-control"><span class="icon-button embed-atlas-button"></span></span><span class="icon-button"></span></div>');
    // App's ids and test ids stay App's: the skeleton is never mistaken for the mounted atlas.
    expect(markup).not.toMatch(/id="architecture-inspector"|data-testid="atlas-(app|canvas)"/);
  });

  it('hides the wordmark until its webfont is in, so a face swap cannot move it', () => {
    const pending = renderToStaticMarkup(createElement(BootShell, { layout: { embed: false, detailsOpen: true, detailsWidth: 403 }, step: 'data', headerSlots: ['import', 'screenshot', 'share', 'repo'] as const, fontsReady: false }));
    expect(pending).toContain('data-fonts="pending"');
    expect(markup).toContain('data-fonts="ready"');
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toContain('.boot-shell[data-fonts="pending"] .brand-line { visibility: hidden; }');
  });

  it('stops pulsing under prefers-reduced-motion', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.boot-line,\s*\.boot-status::before \{ animation: none; \}/);
  });
});
