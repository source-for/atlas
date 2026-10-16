// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import type { AtlasScene, Camera, RenderState, SceneSourceExcerpt } from '../renderer/types';

// CLA-581: what the inspector shows while it waits on the network (Source tab)
// or on a worker compile (open inside a component).

vi.mock('../renderer/createRenderer', () => ({
  createRenderer: async (host: HTMLElement) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    return { canvas, renderer: { kind: 'canvas2d', setScene() {}, setCamera(_camera: Camera) {}, setRenderState(_state: RenderState) {}, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'canvas2d', activeBackend: 'canvas2d', gpuAccelerated: false, lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  }, recoverRenderer: vi.fn(),
}));
// The demo atlas keeps every child resident; published atlases do not. Taking
// the resident fast path away sends a child open through the scan compile.
const resident = vi.hoisted(() => ({ enabled: true }));
vi.mock('./residentInspectorChild', async original => {
  const actual = await original<typeof import('./residentInspectorChild')>();
  return { navigateResidentInspectorChild: (input: Parameters<typeof actual.navigateResidentInspectorChild>[0]) => resident.enabled && actual.navigateResidentInspectorChild(input) };
});

// A cold App mount under a loaded machine can take seconds; the assertions, not the clock, are the test.
vi.setConfig({ testTimeout: 30_000 });

let root: Root;
let host: HTMLDivElement;
let fixture: ScanFixture;
async function settle() { for (let index = 0; index < 3; index += 1) await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
async function click(selector: string) { await act(async () => (host.querySelector(selector) as HTMLElement).click()); }
const entityTitle = () => host.querySelector('#inspector-entity-title')?.textContent;
const pendingTitle = () => host.querySelector('#inspector-pending-title')?.textContent;
const kicker = () => host.querySelector('.entity-kicker > span')?.textContent;
const liveMessage = () => host.querySelector('div.sr-only[aria-live="polite"][role="status"]')?.textContent;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function mount(url: string, withoutExcerpts = false) {
  const source = structuredClone(snapshot);
  if (withoutExcerpts) for (const entity of source.entities) delete (entity as { sourceExcerpts?: unknown }).sourceExcerpts;
  fixture = compileScanFixture({ snapshot: source, view: structuredClone(view), story: structuredClone(story) }, { targetAspect: 1440 / 900 });
  window.history.replaceState(null, '', url);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle();
}

beforeEach(() => {
  resident.enabled = true;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(element: Element) { this.callback([{ target: element, contentRect: { width: 1440, height: 900 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const map = this instanceof HTMLCanvasElement || this.getAttribute('data-testid') === 'atlas-canvas' || this.classList.contains('atlas-renderer-host');
    return new DOMRect(0, 0, map ? 1440 : 0, map ? 900 : 0);
  });
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setActiveScanFixture(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const codeDeepLink = '/?fixture=scan&backend=canvas2d&root=component%3Aweb-navigation&sel=code%3Aweb-navigation%3Anavigation-state&detail=code';
const excerpt: SceneSourceExcerpt = snapshot.entities.find(entity => entity.id === 'code:web-navigation:navigation-state')!.sourceExcerpts![0] as SceneSourceExcerpt;

describe('Source tab while the excerpt is in flight', () => {
  it('shows a loading skeleton, never "unavailable", until the excerpt lands in its place', async () => {
    await mount(codeDeepLink, true);
    const request = deferred<SceneSourceExcerpt[] | undefined>();
    // Like the real loader, a fetched excerpt is also kept on the snapshot entity.
    const load = vi.spyOn(fixture, 'ensureExcerpts').mockImplementation(id => request.promise.then(excerpts => {
      const entity = fixture.snapshot.entities.find(candidate => candidate.id === id)!;
      if (excerpts?.length) entity.sourceExcerpts = excerpts as typeof entity.sourceExcerpts;
      return excerpts as Awaited<ReturnType<ScanFixture['ensureExcerpts']>>;
    }));
    await click('#source-tab');
    expect(load).toHaveBeenCalledWith('code:web-navigation:navigation-state');
    const panel = host.querySelector('#source-panel')!;
    expect(panel.querySelector('[data-testid="source-loading"]')).not.toBeNull();
    expect(panel.querySelector('[data-testid="source-loading"]')!.classList.contains('source-viewer')).toBe(true);
    expect(panel.textContent).not.toContain('unavailable');
    expect(liveMessage()).toBe('Loading source excerpt…');
    await act(async () => request.resolve([excerpt]));
    await settle();
    expect(panel.querySelector('[data-testid="source-loading"]')).toBeNull();
    expect(panel.querySelector('.source-viewer')?.getAttribute('aria-label')).toBe('Read-only source for NavigationState');
    expect(panel.textContent).toContain('export type NavigationState = {');
  });

  it('says unavailable only once the request finished with no excerpt', async () => {
    await mount(codeDeepLink, true);
    const request = deferred<SceneSourceExcerpt[] | undefined>();
    vi.spyOn(fixture, 'ensureExcerpts').mockReturnValue(request.promise as ReturnType<ScanFixture['ensureExcerpts']>);
    await click('#source-tab');
    expect(host.querySelector('#source-panel')!.textContent).not.toContain('Source excerpt unavailable');
    await act(async () => request.resolve([]));
    await settle();
    expect(host.querySelector('[data-testid="source-loading"]')).toBeNull();
    expect(host.querySelector('#source-panel')!.textContent).toContain('Source excerpt unavailable');
  });

  it('shows the skeleton again for a new request after an empty result: reopening the tab, or returning to the entity', async () => {
    await mount(codeDeepLink, true);
    const requests: Array<ReturnType<typeof deferred<SceneSourceExcerpt[] | undefined>>> = [];
    vi.spyOn(fixture, 'ensureExcerpts').mockImplementation(id => {
      const request = deferred<SceneSourceExcerpt[] | undefined>();
      requests.push(request);
      // Like the real loader, a fetched excerpt is also kept on the snapshot entity.
      return request.promise.then(excerpts => {
        const entity = fixture.snapshot.entities.find(candidate => candidate.id === id)!;
        if (excerpts?.length) entity.sourceExcerpts = excerpts as typeof entity.sourceExcerpts;
        return excerpts;
      }) as ReturnType<ScanFixture['ensureExcerpts']>;
    });
    const panel = () => host.querySelector('#source-panel');
    const loading = () => Boolean(panel()?.querySelector('[data-testid="source-loading"]'));
    await click('#source-tab');
    await act(async () => requests[0]!.resolve([]));
    await settle();
    expect(panel()!.textContent).toContain('Source excerpt unavailable');
    // Reopen: Details, then Source again starts a second request.
    await click('#details-tab');
    await click('#source-tab');
    expect(requests).toHaveLength(2);
    expect(loading()).toBe(true);
    expect(panel()!.textContent).not.toContain('unavailable');
    await act(async () => requests[1]!.resolve([]));
    await settle();
    expect(panel()!.textContent).toContain('Source excerpt unavailable');
    // Return: leave for the parent, come Back, open Source on the same entity again.
    await click('#details-tab');
    await click('.inspector-link-list button[data-inspector-entity-id="component:web-navigation"]');
    await settle();
    expect(entityTitle()).toBe('Navigation and history');
    await click('[data-testid="inspector-back"]');
    await settle();
    expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-selected-entity-id')).toBe('code:web-navigation:navigation-state');
    await click('#source-tab');
    expect(requests).toHaveLength(3);
    expect(loading()).toBe(true);
    expect(panel()!.textContent).not.toContain('unavailable');
    await act(async () => requests[2]!.resolve([excerpt]));
    await settle();
    expect(panel()!.textContent).toContain('export type NavigationState = {');
  });
});

describe('open inside a non-resident child', () => {
  async function openContainer() {
    await mount('/?fixture=scan&backend=canvas2d&sel=container%3Aweb-app');
    await click('#details-tab');
    expect(entityTitle()).toBe('Atlas web app');
    resident.enabled = false;
    const compiles: Array<{ focus: string; release: () => void }> = [];
    vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency) => new Promise<AtlasScene>(done => {
      compiles.push({ focus, release: () => done(fixture.createScene(focus, previous, residency)) });
    }));
    return compiles;
  }
  const storiesName = snapshot.entities.find(entity => entity.id === 'component:web-stories')!.name;
  const childButton = (id: string) => `.inspector-link-list button[data-inspector-entity-id="${id}"]`;

  it("shows the target's header at once and a skeleton until the compiled map commits, then the normal content", async () => {
    const compiles = await openContainer();
    await settle(); // the Details tab's own deferred focus runs first
    const row = host.querySelector(childButton('component:web-navigation')) as HTMLButtonElement;
    row.focus();
    await click(childButton('component:web-navigation'));
    await settle();
    // The activated row was replaced: focus moves to the pending heading, and the wait is announced.
    expect(document.activeElement?.id).toBe('inspector-pending-title');
    expect(liveMessage()).toBe('Loading Navigation and history…');
    expect(compiles.map(compile => compile.focus)).toEqual(['component:web-navigation']);
    // Waiting: the target's own header, no stale container title, actions or child list.
    expect(pendingTitle()).toBe('Navigation and history');
    expect(kicker()).toBe('L3 · COMPONENT');
    expect(entityTitle()).toBeUndefined();
    expect(host.querySelector(childButton('component:web-shell'))).toBeNull();
    expect(host.querySelector('[data-testid="inspector-pending-child"]')!.getAttribute('aria-busy')).toBe('true');
    await act(async () => compiles[0]!.release());
    await settle();
    expect(pendingTitle()).toBeUndefined();
    expect(entityTitle()).toBe('Navigation and history');
    expect(kicker()).toBe('L3 · COMPONENT');
  });

  it('ends on the last of several same-tick child clicks, with no flash of an earlier one', async () => {
    const compiles = await openContainer();
    const seen = new Set<string>();
    const observer = new MutationObserver(() => {
      for (const title of [pendingTitle(), entityTitle()]) if (title) seen.add(title);
    });
    observer.observe(host, { childList: true, subtree: true, characterData: true });
    // Both clicks land before React re-renders, as rapid clicks on the list do.
    await act(async () => {
      (host.querySelector(childButton('component:web-navigation')) as HTMLElement).click();
      (host.querySelector(childButton('component:web-shell')) as HTMLElement).click();
    });
    await settle();
    // The first open is superseded before its compile starts.
    expect(compiles.map(compile => compile.focus)).toEqual(['component:web-shell']);
    expect(pendingTitle()).toBe('Application shell');
    await act(async () => compiles[0]!.release());
    await settle();
    observer.disconnect();
    expect(pendingTitle()).toBeUndefined();
    expect(entityTitle()).toBe('Application shell');
    expect([...seen]).not.toContain('Navigation and history');
  });

  // A is compiling when the reader leaves it (Back, the control that stays live
  // over the pending view) and opens B; A's compile is still outstanding while
  // B's runs. Released in either order, nothing of A is ever drawn again.
  //
  // History is set up so it does not depend on camera-flight timing: boot on the
  // shell (no inspector flight has run), so the parent click records exactly one
  // entry; the pending open records the container on top, and Back pops that.
  describe.each(['default motion', 'reduced motion'] as const)('with %s', motion => {
    it.each([['A then B', 0, 1], ['B then A', 1, 0]] as const)('ends on B when two child compiles overlap, released %s', async (_order, firstIndex, secondIndex) => {
      if (motion === 'reduced motion') {
        const matchMedia = window.matchMedia.bind(window);
        vi.spyOn(window, 'matchMedia').mockImplementation(query => {
          const list = matchMedia(query);
          if (query.includes('prefers-reduced-motion: reduce')) Object.defineProperty(list, 'matches', { value: true });
          return list;
        });
      }
      await mount('/?fixture=scan&backend=canvas2d&sel=component%3Aweb-shell');
      await click('#details-tab');
      expect(entityTitle()).toBe('Application shell');
      expect(host.querySelector('[data-testid="inspector-back"]')).toBeNull();
      resident.enabled = false;
      const compiles: Array<{ focus: string; release: () => void }> = [];
      vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency) => new Promise<AtlasScene>(done => {
        compiles.push({ focus, release: () => done(fixture.createScene(focus, previous, residency)) });
      }));
      // The parent link is a resident hierarchy navigation: history = [shell].
      await click(childButton('container:web-app'));
      await settle();
      expect(entityTitle()).toBe('Atlas web app');
      await click(childButton('component:web-navigation'));
      await settle();
      expect(compiles.map(compile => compile.focus)).toEqual(['component:web-navigation']);
      expect(pendingTitle()).toBe('Navigation and history');
      // Back returns to the container the pending view replaced.
      await click('[data-testid="inspector-back"]');
      await settle();
      expect(pendingTitle()).toBeUndefined();
      expect(entityTitle()).toBe('Atlas web app');
      const app = host.querySelector('[data-testid="atlas-app"]')!;
      const seen = new Set<string>();
      const record = () => { for (const value of [pendingTitle(), entityTitle(), app.getAttribute('data-selected-entity-id')]) if (value) seen.add(value); };
      const observer = new MutationObserver(record);
      observer.observe(host, { attributes: true, childList: true, subtree: true, characterData: true });
      await click(childButton('component:web-stories'));
      await settle();
      record();
      // Both compiles are outstanding: A was cancelled by Back but its compile never returned.
      expect(compiles.map(compile => compile.focus)).toEqual(['component:web-navigation', 'component:web-stories']);
      expect(pendingTitle()).toBe(storiesName);
      await act(async () => compiles[firstIndex]!.release());
      await settle();
      record();
      if (firstIndex === 0) expect(pendingTitle()).toBe(storiesName);
      await act(async () => compiles[secondIndex]!.release());
      await settle();
      record();
      observer.disconnect();
      expect(pendingTitle()).toBeUndefined();
      expect(entityTitle()).toBe(storiesName);
      expect(app.getAttribute('data-selected-entity-id')).toBe('component:web-stories');
      expect(seen).not.toContain('Navigation and history');
      expect(seen).not.toContain('component:web-navigation');
    });
  });

  it('drops the pending child when Back is used during the wait', async () => {
    const compiles = await openContainer();
    await click(childButton('component:web-shell'));
    await settle();
    await act(async () => compiles[0]!.release());
    await settle();
    expect(entityTitle()).toBe('Application shell');
    await click(childButton('container:web-app'));
    await settle();
    expect(entityTitle()).toBe('Atlas web app');
    await click(childButton('component:web-navigation'));
    await settle();
    expect(pendingTitle()).toBe('Navigation and history');
    await click('[data-testid="inspector-back"]');
    await settle();
    const restored = entityTitle();
    expect(pendingTitle()).toBeUndefined();
    expect(restored).toBeDefined();
    expect(restored).not.toBe('Navigation and history');
    await act(async () => compiles.at(-1)!.release());
    await settle();
    expect(pendingTitle()).toBeUndefined();
    expect(entityTitle()).toBe(restored);
  });

  // Boot on the shell, then reach the container through the shell's resident parent link,
  // as a reader does: history = [shell], and the container has no entry of its own yet.
  async function openContainerFromShell(shellUrl = '/?fixture=scan&backend=canvas2d&sel=component%3Aweb-shell') {
    await mount(shellUrl);
    await click('#details-tab');
    expect(entityTitle()).toBe('Application shell');
    await click(childButton('container:web-app'));
    await settle();
    expect(entityTitle()).toBe('Atlas web app');
    resident.enabled = false;
    const compiles: Array<{ focus: string; release: () => void }> = [];
    vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency) => new Promise<AtlasScene>(done => {
      compiles.push({ focus, release: () => done(fixture.createScene(focus, previous, residency)) });
    }));
    return compiles;
  }
  const selectedId = () => host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-selected-entity-id');

  it('returns the inspector Back during the wait to the container the pending view replaced, and the late compile never paints', async () => {
    const compiles = await openContainerFromShell();
    await click(childButton('component:web-navigation'));
    await settle();
    expect(pendingTitle()).toBe('Navigation and history');
    const seen = new Set<string>();
    const observer = new MutationObserver(() => { for (const value of [pendingTitle(), entityTitle(), selectedId()]) if (value) seen.add(value); });
    observer.observe(host, { attributes: true, childList: true, subtree: true, characterData: true });
    await click('[data-testid="inspector-back"]');
    await settle();
    expect(pendingTitle()).toBeUndefined();
    expect(entityTitle()).toBe('Atlas web app');
    expect(selectedId()).toBe('container:web-app');
    await act(async () => compiles[0]!.release());
    await settle();
    observer.disconnect();
    expect(entityTitle()).toBe('Atlas web app');
    expect(seen).not.toContain('Navigation and history');
    expect(seen).not.toContain('component:web-navigation');
    // The entry before it is still there.
    await click('[data-testid="inspector-back"]');
    await settle();
    expect(entityTitle()).toBe('Application shell');
  });

  it('keeps Back after a completed open inside as it was: one step to the container, then the shell', async () => {
    const compiles = await openContainerFromShell();
    await click(childButton('component:web-navigation'));
    await settle();
    await act(async () => compiles[0]!.release());
    await settle();
    expect(entityTitle()).toBe('Navigation and history');
    await click('[data-testid="inspector-back"]');
    await settle();
    expect(entityTitle()).toBe('Atlas web app');
    await click('[data-testid="inspector-back"]');
    await settle();
    expect(entityTitle()).toBe('Application shell');
    expect(host.querySelector('[data-testid="inspector-back"]')).toBeNull();
  });

  it('adds no Back entry when the open inside fails and the reader stays on the container', async () => {
    await mount('/?fixture=scan&backend=canvas2d&sel=container%3Aweb-app');
    await click('#details-tab');
    resident.enabled = false;
    vi.spyOn(fixture, 'createSceneAsync').mockImplementation(async () => { throw new Error('worker failed'); });
    await click(childButton('component:web-navigation'));
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    await settle();
    expect(pendingTitle()).toBeUndefined();
    expect(entityTitle()).toBe('Atlas web app');
    expect(host.querySelector('[data-testid="inspector-back"]')).toBeNull();
  });

  // Open inside never adds a browser entry (its flight replaces the URL), on main as here. So
  // history.back() goes to the entry before the container whether the compile is pending or done.
  it.each([['pending', false], ['completed', true]] as const)('takes history.back() to the entry before the container when the open inside is %s; the late compile never paints', async (_state, completeFirst) => {
    window.history.replaceState(null, '', '/?fixture=scan&backend=canvas2d&sel=component%3Aweb-shell');
    window.history.pushState(null, '', '/?fixture=scan&backend=canvas2d&sel=container%3Aweb-app');
    await mount('/?fixture=scan&backend=canvas2d&sel=container%3Aweb-app');
    await click('#details-tab');
    resident.enabled = false;
    const compiles: Array<() => void> = [];
    vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency) => new Promise<AtlasScene>(done => {
      compiles.push(() => done(fixture.createScene(focus, previous, residency)));
    }));
    await click(childButton('component:web-navigation'));
    await settle();
    expect(pendingTitle()).toBe('Navigation and history');
    if (completeFirst) {
      await act(async () => compiles[0]!());
      await settle();
      expect(entityTitle()).toBe('Navigation and history');
    }
    const seen = new Set<string>();
    const observer = new MutationObserver(() => { for (const value of [pendingTitle(), entityTitle(), selectedId()]) if (value) seen.add(value); });
    observer.observe(host, { attributes: true, childList: true, subtree: true, characterData: true });
    await act(async () => window.history.back());
    await settle();
    // The restore compiles its own scene; release it (the open inside's compile stays outstanding).
    const restoreCompiles = compiles.slice(1);
    for (const release of restoreCompiles) await act(async () => release());
    await settle();
    expect(restoreCompiles.length).toBeGreaterThan(0);
    expect(pendingTitle()).toBeUndefined();
    expect(selectedId()).toBe('component:web-shell');
    if (!completeFirst) {
      await act(async () => compiles[0]!());
      await settle();
      expect(seen).not.toContain('Navigation and history');
      expect(seen).not.toContain('component:web-navigation');
    }
    observer.disconnect();
    expect(selectedId()).toBe('component:web-shell');
    expect(pendingTitle()).toBeUndefined();
  });

  it('ignores clicks on the pending view and its skeleton: no selection change, no focus move, no console error', async () => {
    const compiles = await openContainerFromShell();
    const errors = vi.spyOn(console, 'error');
    await settle();
    const row = host.querySelector(childButton('component:web-navigation')) as HTMLButtonElement;
    row.focus();
    await click(childButton('component:web-navigation'));
    await settle();
    const heading = host.querySelector('#inspector-pending-title') as HTMLElement;
    expect(document.activeElement).toBe(heading);
    const article = host.querySelector('[data-testid="inspector-pending-child"]') as HTMLElement;
    for (const target of [article.querySelector('.inspector-skeleton-block')!, article.querySelector('.inspector-pending-row')!, article.querySelector('.inspector-skeleton-line')!, article]) {
      // A browser moves focus on mousedown (to <body> for non-focusable content); the view must keep it.
      const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      await act(async () => { target.dispatchEvent(down); });
      expect(down.defaultPrevented).toBe(true);
      await act(async () => (target as HTMLElement).click());
      await settle();
      expect(document.activeElement).toBe(heading);
      expect(selectedId()).toBe('container:web-app');
      expect(pendingTitle()).toBe('Navigation and history');
    }
    await act(async () => heading.click());
    await settle();
    expect(document.activeElement).toBe(heading);
    expect(compiles.map(compile => compile.focus)).toEqual(['component:web-navigation']);
    await act(async () => compiles[0]!.release());
    await settle();
    expect(entityTitle()).toBe('Navigation and history');
    expect(errors).not.toHaveBeenCalled();
  });

  // The child rows are buttons in tab order (no arrow-key roving). Enter activates the focused row.
  // The pending view replaces the list in the same commit as the activation, so a second Enter can
  // only land on the pending heading; moving to another row before the first Enter is what remains.
  it('ends on the row the keyboard activates last; an Enter after the pending view mounted does nothing', async () => {
    const compiles = await openContainerFromShell();
    await settle();
    (host.querySelector(childButton('component:web-navigation')) as HTMLButtonElement).focus();
    (host.querySelector(childButton('component:web-stories')) as HTMLButtonElement).focus();
    await act(async () => (document.activeElement as HTMLElement).click()); // Enter on the focused row
    await settle();
    expect(pendingTitle()).toBe(storiesName);
    expect(host.querySelector(childButton('component:web-navigation'))).toBeNull();
    expect(document.activeElement?.id).toBe('inspector-pending-title');
    await act(async () => (document.activeElement as HTMLElement).click()); // a second Enter
    await settle();
    expect(compiles.map(compile => compile.focus)).toEqual(['component:web-stories']);
    await act(async () => compiles[0]!.release());
    await settle();
    expect(entityTitle()).toBe(storiesName);
    expect(selectedId()).toBe('component:web-stories');
  });

  it('gives the pending header the same kicker the loaded inspector shows', async () => {
    await mount('/?fixture=scan&backend=canvas2d&sel=system%3Aokie');
    await click('#details-tab');
    resident.enabled = false;
    const compiles: Array<() => void> = [];
    vi.spyOn(fixture, 'createSceneAsync').mockImplementation((focus, previous, residency) => new Promise<AtlasScene>(done => {
      compiles.push(() => done(fixture.createScene(focus, previous, residency)));
    }));
    await click(childButton('container:web-app'));
    await settle();
    expect(pendingTitle()).toBe('Atlas web app');
    const pendingKicker = kicker();
    await act(async () => compiles[0]!());
    await settle();
    expect(entityTitle()).toBe('Atlas web app');
    expect(kicker()).toBe(pendingKicker);
  });

  // Code children keep their own open (owner-rooted L4 compile, maybe no selection change). In a
  // compiled scene they carry kind 'component' and only detail 'code', so the guard must use detail.
  it.each([
    ['the component is the L4 root', '/?fixture=scan&backend=canvas2d&root=component%3Aweb-navigation&sel=component%3Aweb-navigation&detail=code', true],
    ['the component is under a container root', '/?fixture=scan&backend=canvas2d&root=container%3Aweb-app&sel=component%3Aweb-navigation', true],
    ['the component is the L4 root, resident path off', '/?fixture=scan&backend=canvas2d&root=component%3Aweb-navigation&sel=component%3Aweb-navigation&detail=code', false],
  ] as const)('never shows a pending view for a code child when %s, and keeps focus on its row', async (_case, url, residentPath) => {
    await mount(url);
    await click('#details-tab');
    expect(entityTitle()).toBe('Navigation and history');
    resident.enabled = residentPath;
    vi.spyOn(fixture, 'createSceneAsync').mockImplementation(() => new Promise<AtlasScene>(() => {}));
    const pending: boolean[] = [];
    const observer = new MutationObserver(() => pending.push(Boolean(host.querySelector('[data-testid="inspector-pending-child"]'))));
    observer.observe(host, { childList: true, subtree: true });
    await settle(); // the Details tab's own deferred focus runs first
    const row = host.querySelector(childButton('code:web-navigation:canonical-url')) as HTMLButtonElement;
    expect(row).not.toBeNull();
    row.focus();
    expect(document.activeElement).toBe(row);
    await click(childButton('code:web-navigation:canonical-url'));
    await settle();
    observer.disconnect();
    expect(pending).not.toContain(true);
    expect(host.querySelector('[data-testid="inspector-pending-child"]')).toBeNull();
    expect(row.isConnected).toBe(true);
    expect(document.activeElement).toBe(row);
  });

  it('keeps the resident fast path free of any pending view', async () => {
    await mount('/?fixture=scan&backend=canvas2d&sel=container%3Aweb-app');
    await click('#details-tab');
    const pending: boolean[] = [];
    const observer = new MutationObserver(() => pending.push(Boolean(host.querySelector('[data-testid="inspector-pending-child"]'))));
    observer.observe(host, { childList: true, subtree: true });
    await click(childButton('component:web-navigation'));
    await settle();
    observer.disconnect();
    expect(entityTitle()).toBe('Navigation and history');
    expect(pending).not.toContain(true);
  });
});
