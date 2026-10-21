// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, compileScanNeighborhoodFixture, type ScanFixture } from '../renderer/scanFixture';
import { sliceArchitectureNeighborhood, type ArchitectureSnapshot, type ArchitectureView } from '@okie/architecture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import type { NavigationHistoryController } from './historyController';

const captured = vi.hoisted(() => ({ controller: undefined as NavigationHistoryController | undefined, scenes: [] as { entities: unknown[] }[] }));
vi.mock('./historyController', async importOriginal => {
  const original = await importOriginal<typeof import('./historyController')>();
  return { ...original, createNavigationHistoryController: (...args: Parameters<typeof original.createNavigationHistoryController>) => {
    captured.controller = original.createNavigationHistoryController(...args);
    return captured.controller;
  } };
});
vi.mock('../renderer/createRenderer', () => ({
  createRenderer: async (host: HTMLElement) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    return { canvas, renderer: { kind: 'canvas2d', setScene(scene: { entities: unknown[] }) { if (captured.scenes.at(-1) !== scene) captured.scenes.push(scene); }, setCamera() {}, setRenderState() {}, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'canvas2d', activeBackend: 'canvas2d', gpuAccelerated: false, lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  }, recoverRenderer: vi.fn(),
}));

let root: Root | undefined;
let host: HTMLDivElement;
let fixture: ScanFixture;
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function mount(search: string) {
  window.history.replaceState(null, '', `/?fixture=scan&backend=canvas2d${search}`);
  const module = await import('../App'); module.refreshAppScanFixture();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<module.App/>); }); await settle(); await settle();
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } })));
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  fixture = compileScanFixture({ snapshot, view, story });
  setActiveScanFixture(fixture);
});
// A neighborhood boot whose bootstrap scene lacks the model container's children: a selection or story
// focus there keeps the bootstrap root but still needs an async restore compile.
function bootWithoutModelChildren() {
  const full = sliceArchitectureNeighborhood(snapshot as ArchitectureSnapshot, view as ArchitectureView, { focusEntityId: 'system:okie' });
  const packet = structuredClone(full);
  const omitted = new Set(snapshot.entities.filter(entity => entity.parentId === 'container:architecture-model'
    || snapshot.entities.some(parent => parent.id === entity.parentId && parent.parentId === 'container:architecture-model')).map(entity => entity.id));
  packet.snapshot.entities = packet.snapshot.entities.filter(entity => !omitted.has(entity.id));
  packet.snapshot.relations = packet.snapshot.relations.filter(relation => !omitted.has(relation.from) && !omitted.has(relation.to));
  const entities = new Set(packet.snapshot.entities.map(entity => entity.id));
  const relations = new Set(packet.snapshot.relations.map(relation => relation.id));
  packet.view.entityIds = packet.view.entityIds.filter(id => entities.has(id));
  packet.view.relationIds = packet.view.relationIds.filter(id => relations.has(id));
  packet.view.layout.nodes = Object.fromEntries(Object.entries(packet.view.layout.nodes).filter(([id]) => entities.has(id)));
  if (packet.view.layout.edges) packet.view.layout.edges = Object.fromEntries(Object.entries(packet.view.layout.edges).filter(([id]) => relations.has(id)));
  fixture = compileScanNeighborhoodFixture(packet, story, {
    loadNeighborhood: async focus => structuredClone(focus === 'system:okie' ? packet : full),
    loadStory: async () => story, loadExcerpts: async () => undefined,
  });
  setActiveScanFixture(fixture);
  expect(fixture.snapshot.entities.some(entity => entity.id === 'component:model-scoping')).toBe(false);
}
// A neighborhood boot above the 128-entity slice threshold: the bootstrap scene is the L1/L2 slice and
// enrichment compiles the full packet (synchronously here: happy-dom has no Worker).
async function largeNeighborhoodBoot() {
  const full = structuredClone(snapshot) as unknown as ArchitectureSnapshot;
  // Children under a code entity leave L1/L2 geometry unchanged, so initialSceneBandsMatch accepts the
  // enriched scene, as it does for the published atlas.
  const owner = full.entities.find(entity => entity.id === 'code:web-shell:app')!;
  full.entities.push(...Array.from({ length: 150 }, (_, index) => ({ id: `code:boot-${index}`, name: `declaration${index}`, kind: 'code' as const, parentId: owner.id, sourceRefs: [] })));
  const sliced = sliceArchitectureNeighborhood(full, view as ArchitectureView, { focusEntityId: 'system:okie' });
  const packet = { ...sliced, snapshot: full, view: view as ArchitectureView, childCounts: { ...sliced.childCounts, [owner.id]: 150 } };
  fixture = compileScanNeighborhoodFixture(packet, story, { loadNeighborhood: async () => structuredClone(packet), loadStory: async () => story, loadExcerpts: async () => undefined });
  await fixture.prepareInitialScene(undefined, { worker: false });
  setActiveScanFixture(fixture);
}
async function holdRestoreCompile() {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const original = fixture.createSceneAsync;
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementation(async (...args) => { await held; return original(...args); });
  return { compile, release };
}
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; host?.remove(); setActiveScanFixture(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

// CLA-584: a scan deep link no longer compiles its root synchronously on mount just to validate
// its lens path. The expected paths were recorded from main before the change (a0dba65), which
// made one such compile per case: the initialize restore still installs the same settled entries
// (ids plus the base detail fix each entry's details), so the restored session and URL are unchanged.
describe('scan deep-link boot (CLA-584)', () => {
  it.each([
    ['container:web-app', ['system:okie', 'container:web-app', 'component:web-shell'], 7.95, ['system:okie', 'container:web-app', 'component:web-shell']],
    // Below the first lens's entry runway: the camera-incoherent path is truncated to nothing.
    ['container:web-app', ['system:okie', 'container:web-app'], 1, []],
    ['container:web-app', ['system:okie', 'container:web-app', 'component:web-shell'], 40, ['system:okie', 'container:web-app', 'component:web-shell']],
    ['container:web-app', ['system:okie', 'container:tooling'], 7.95, ['system:okie', 'container:tooling']],
    ['component:web-shell', ['system:okie', 'container:web-app', 'component:web-shell'], 7.95, ['system:okie', 'container:web-app', 'component:web-shell']],
  ] as const)('restores root %s with lens %j at z=%s to settled %j without a mount-time compile of that root', async (rootId, lens, zoom, settled) => {
    const createScene = vi.spyOn(fixture, 'createScene');
    await mount(`&root=${encodeURIComponent(rootId)}&detail=context${lens.map(id => `&lens=${encodeURIComponent(id)}`).join('')}&z=${zoom}`);
    expect(captured.controller!.current()).toMatchObject({ rootEntityId: rootId, detail: 'context' });
    expect(captured.controller!.current().lensPath ?? []).toEqual(settled);
    expect(new URLSearchParams(window.location.search).getAll('lens')).toEqual(settled);
    expect(createScene.mock.calls.filter(([focus]) => focus === rootId)).toEqual([]);
  });

  it('does not enrich the bootstrap root a deep link is about to replace', async () => {
    const enrich = vi.spyOn(fixture, 'enrichInitialScene');
    await mount('&root=container%3Aweb-app&detail=context&lens=system%3Aokie&z=7.95');
    expect(captured.controller!.current().rootEntityId).toBe('container:web-app');
    expect(enrich).not.toHaveBeenCalled();
  });

  it('enriches the bootstrap root once a deep-link restore leaves the bootstrap scene in place', async () => {
    const enrich = vi.spyOn(fixture, 'enrichInitialScene');
    vi.spyOn(fixture, 'createSceneAsync').mockRejectedValue(new Error('compile failed'));
    await mount('&root=container%3Aweb-app&detail=context&lens=system%3Aokie&z=7.95');
    for (let attempt = 0; attempt < 20 && !enrich.mock.calls.length; attempt += 1) await settle();
    expect(enrich).toHaveBeenCalledTimes(1);
  });

  // CLA-590: every initialize restore begins foreground work that aborts a queued enrichment, and the
  // abort of active speculative work terminates the worker holding the graph. Enrichment waits for it.
  it.each([
    ['a bare link', ''],
    ['a selection link the bootstrap scene already holds', '&sel=container%3Aweb-app'],
  ])('installs the bootstrap enrichment for %s, showing "Loading more detail…" only while it runs', async (_name, search) => {
    await largeNeighborhoodBoot();
    const original = fixture.enrichInitialScene;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let delivered: unknown;
    const enrich = vi.spyOn(fixture, 'enrichInitialScene').mockImplementation(async signal => { await held; delivered = await original(signal); return delivered as never; });
    // Queue frames so the canvas loop runs only when the test draws one.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => frames.push(callback)));
    const draw = async () => { await act(async () => { for (const callback of frames.splice(0)) callback(performance.now()); }); };
    captured.scenes = [];
    await mount(search);
    await draw();
    for (let attempt = 0; attempt < 20 && !enrich.mock.calls.length; attempt += 1) await settle();
    expect(enrich).toHaveBeenCalledTimes(1);
    const bootstrap = captured.scenes.at(-1)!;
    expect(host.textContent).toContain('Loading more detail…');
    await act(async () => { release(); }); await settle(); await settle();
    await draw();
    expect(enrich.mock.calls[0]![0]!.aborted).toBe(false);
    expect(delivered).toBeDefined();
    expect(captured.scenes.at(-1)).toBe(delivered);
    expect(captured.scenes.at(-1)!.entities.length).toBeGreaterThan(bootstrap.entities.length);
    expect(host.textContent).not.toContain('Loading more detail…');
  });

  it.each([
    ['a story step outside the bootstrap scene', '&story=story%3Aokie-context-to-code&step=2&t=0'],
    ['a selection outside the bootstrap scene', '&sel=component%3Amodel-scoping'],
  ])('does not enrich while the restore of %s is still compiling', async (_name, search) => {
    bootWithoutModelChildren();
    const enrich = vi.spyOn(fixture, 'enrichInitialScene');
    const { compile, release } = await holdRestoreCompile();
    await mount(search);
    for (let attempt = 0; attempt < 20 && !compile.mock.calls.length; attempt += 1) await settle();
    expect(compile).toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    release(); await settle(); await settle();
  });

  it('does not start a wasted enrichment when the user navigates before the restore settles', async () => {
    bootWithoutModelChildren();
    const enrich = vi.spyOn(fixture, 'enrichInitialScene');
    const { compile, release } = await holdRestoreCompile();
    await mount('&sel=component%3Amodel-scoping');
    for (let attempt = 0; attempt < 20 && !compile.mock.calls.length; attempt += 1) await settle();
    const level = host.querySelectorAll<HTMLButtonElement>('.level-rail button')[1]!;
    await act(async () => { level.click(); });
    release();
    for (let attempt = 0; attempt < 10; attempt += 1) await settle();
    expect(enrich).not.toHaveBeenCalled();
  });

  // Sol's CLA-590 review case: the enriched scene must be published to sceneRef with its state, or a
  // navigation begun before React commits captures the bootstrap scene and is then cancelled as obsolete.
  it('keeps a navigation begun between enrichment resolution and its commit', async () => {
    const bootstrap = fixture.createScene(fixture.navigation.rootEntityId);
    const enriched = structuredClone(bootstrap);
    enriched.title += ' enriched';
    let deliver!: (scene: typeof enriched) => void;
    vi.spyOn(fixture, 'enrichInitialScene').mockReturnValue(new Promise(resolve => { deliver = resolve; }));
    vi.spyOn(fixture, 'ensureNeighborhood').mockResolvedValue(undefined);
    let finish!: (scene: typeof enriched) => void;
    const compile = vi.spyOn(fixture, 'createSceneAsync').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    await mount('');
    await act(async () => {
      deliver(enriched);
      await Promise.resolve();
      host.querySelectorAll<HTMLButtonElement>('.level-rail button')[1]!.click();
    });
    for (let i = 0; i < 5; i++) await settle();
    expect(host.textContent).not.toContain('This view changed while navigation was being prepared.');
    expect(compile).toHaveBeenCalled();
    const signal = compile.mock.calls.at(-1)![3]!;
    expect(signal.aborted).toBe(false);
    await act(async () => { finish(enriched); });
    for (let i = 0; i < 5; i++) await settle();
    expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-detail')).toBe('container');
  });
});
