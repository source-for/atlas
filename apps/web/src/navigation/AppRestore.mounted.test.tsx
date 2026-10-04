// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, compileScanNeighborhoodFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import type { NavigationHistoryController } from './historyController';
import { sliceArchitectureNeighborhood, type ArchitectureSnapshot, type ArchitectureView } from '@okie/architecture';
import { canonicalNavigationUrl } from './navigationState';

const captured = vi.hoisted(() => ({ controller: undefined as NavigationHistoryController | undefined }));
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
    return { canvas, renderer: { kind: 'canvas2d', setScene() {}, setCamera() {}, setRenderState() {}, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'canvas2d', activeBackend: 'canvas2d', gpuAccelerated: false, lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  }, recoverRenderer: vi.fn(),
}));
let root: Root;
let host: HTMLDivElement;
let fixture: ScanFixture;
let App: typeof import('../App')['App'];
async function settle() { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); }
async function restore(step: number, positionMs = 0) {
  const controller = captured.controller!;
  const state = { ...controller.current(), story: { id: fixture.story.id, step, positionMs } };
  const url = canonicalNavigationUrl(state);
  await act(async () => { window.history.pushState(null, '', url); window.dispatchEvent(new PopStateEvent('popstate')); });
  return state;
}
function player() { return host.querySelector('[data-playback-state]')!; }
beforeEach(async () => {
  localStorage.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } }))); 
  // Frames are explicit: no elapsed story playback races during restore assertions.
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  window.history.replaceState(null, '', '/?fixture=scan&backend=canvas2d');
  fixture = compileScanFixture({ snapshot, view, story });
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture(); App = module.App;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root.render(<App/>); }); await settle();
  await restore(0); await settle();
  expect(player().getAttribute('data-playback-state')).toBe('paused');
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setActiveScanFixture(undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('mounted App story history restoration', () => {
  it('prepares a restored story step and publishes it paused', async () => {
    await act(async () => { player().querySelector<HTMLButtonElement>('.story-play')!.click(); });
    expect(player().getAttribute('data-playback-state')).not.toBe('paused');
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    vi.spyOn(fixture, 'ensureNeighborhood').mockReturnValue(pending);
    await restore(1);
    expect(player().getAttribute('data-playback-state')).toBe('preparing');
    await act(async () => { resolve(); }); await settle();
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    expect(player().textContent).toContain('STEP 2 OF');
    expect(captured.controller!.current().story?.step).toBe(1);
    expect(new URL(window.location.href).searchParams.get('step')).toBe('1');
  });
  it('pauses the preserved flight when closing details cancels a pending story step', async () => {
    await act(async () => { player().querySelector<HTMLButtonElement>('.story-play')!.click(); });
    expect(player().getAttribute('data-story-phase')).toBe('flight');
    let resolve!: () => void;
    vi.spyOn(fixture, 'ensureNeighborhood').mockReturnValue(new Promise<void>(done => { resolve = done; }));
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Next story step, paused"]')!.click(); });
    expect(player().getAttribute('data-playback-state')).toBe('preparing');
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Close details panel"]')!.click(); });
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    expect(player().getAttribute('data-story-phase')).toBe('paused');
    const href = window.location.href;
    await act(async () => { resolve(); }); await settle();
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    expect(player().getAttribute('data-story-phase')).toBe('paused');
    expect(player().textContent).toContain('STEP 1 OF');
    expect(window.location.href).toBe(href);
  });
  it('cancels a pending story step when a relationship connection gesture starts', async () => {
    await restore(0, 100000); await settle();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', code: 'KeyD', shiftKey: true, altKey: true, bubbles: true })); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="interaction-mode-edit"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="authoring-tool-connect"]')!.click(); });
    const port = host.querySelector<SVGCircleElement>('.authoring-connection-port')!;
    expect(port).not.toBeNull();
    let resolve!: () => void;
    vi.spyOn(fixture, 'ensureNeighborhood').mockReturnValue(new Promise<void>(done => { resolve = done; }));
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Next story step, paused"]')!.click(); });
    expect(player().getAttribute('data-playback-state')).toBe('preparing');
    const canvas = host.querySelector<HTMLElement>('[data-testid="atlas-canvas"]')!;
    canvas.setPointerCapture = vi.fn();
    await act(async () => { canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: Number(port.getAttribute('cx')), clientY: Number(port.getAttribute('cy')), bubbles: true })); });
    expect(player().textContent).toContain('Created a relationship');
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    const href = window.location.href;
    await act(async () => { resolve(); }); await settle();
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    expect(player().textContent).toContain('STEP 1 OF');
    expect(window.location.href).toBe(href);
  });
  it('lets a pending history restore publish after a relationship connection gesture starts', async () => {
    await restore(0, 100000); await settle();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'D', code: 'KeyD', shiftKey: true, altKey: true, bubbles: true })); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="interaction-mode-edit"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="authoring-tool-connect"]')!.click(); });
    const port = host.querySelector<SVGCircleElement>('.authoring-connection-port')!;
    expect(port).not.toBeNull();
    let resolve!: () => void;
    vi.spyOn(fixture, 'ensureNeighborhood').mockReturnValue(new Promise<void>(done => { resolve = done; }));
    await restore(1);
    const href = window.location.href;
    expect(player().getAttribute('data-playback-state')).toBe('preparing');
    const canvas = host.querySelector<HTMLElement>('[data-testid="atlas-canvas"]')!;
    canvas.setPointerCapture = vi.fn();
    await act(async () => { canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, pointerType: 'mouse', clientX: Number(port.getAttribute('cx')), clientY: Number(port.getAttribute('cy')), bubbles: true })); });
    expect(player().textContent).toContain('Created a relationship');
    expect(player().getAttribute('data-playback-state')).toBe('preparing');
    expect(window.location.href).toBe(href);
    await act(async () => { resolve(); }); await settle();
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    expect(player().textContent).toContain('STEP 2 OF');
    expect(window.location.href).toBe(href);
    expect(captured.controller!.current().story?.step).toBe(1);
  });
  it('does not publish an abandoned restore after a newer history entry settles', async () => {
    let resolve!: () => void;
    vi.spyOn(fixture, 'ensureNeighborhood').mockResolvedValue(undefined)
      .mockReturnValueOnce(new Promise<void>(done => { resolve = done; }));
    await restore(1);
    expect(player().getAttribute('data-playback-state')).toBe('preparing');
    await restore(2); await settle();
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    expect(player().textContent).toContain('STEP 3 OF');
    expect(captured.controller!.current().story?.step).toBe(2);
    const href = window.location.href;
    await act(async () => { resolve(); }); await settle();
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    expect(player().textContent).toContain('STEP 3 OF');
    expect(window.location.href).toBe(href);
    expect(captured.controller!.current().story?.step).toBe(2);
  });
  it('keeps the reached history entry coherent when preparation fails', async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(fixture, 'ensureNeighborhood').mockReturnValue(new Promise<void>((_, fail) => { reject = fail; }));
    await restore(1);
    expect(player().getAttribute('data-playback-state')).toBe('preparing');
    const href = window.location.href;
    await act(async () => { reject(new Error('fixture preparation failed')); }); await settle();
    expect(player().getAttribute('data-playback-state')).toBe('paused');
    expect(player().textContent).toContain('STEP 1 OF');
    expect(host.textContent).toContain('This history entry could not be prepared.');
    expect(window.location.href).toBe(href);
    expect(captured.controller!.current().story?.step).toBe(1);
  });
});

 it('restores a golden container deep link without sel to its populated inspector', async () => {
   await act(async () => root.unmount());
   setActiveScanFixture(undefined);
   const module = await import('../App'); module.refreshAppScanFixture();
   window.history.replaceState(null, '', '/?fixture=okie&backend=canvas2d&root=container%3Aweb-app&detail=context&lens=system%3Aokie');
   root = createRoot(host);
   await act(async () => { root.render(<App/>); }); await settle();
   expect(captured.controller!.current()).toMatchObject({ rootEntityId: 'container:web-app', selectedId: 'container:web-app' });
   expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-selected-entity-id')).toBe('container:web-app');
   expect(host.querySelector('#architecture-inspector h2')!.textContent).toContain('Atlas web app');
   await act(async () => { host.querySelector<HTMLButtonElement>('#overview-tab')!.click(); });
   expect(host.querySelector('[data-testid="inspector-overview"]')!.textContent!.length).toBeGreaterThan(40);
 });

 it('restores a published neighborhood container root without sel to its own overview', async () => {
   await act(async () => root.unmount());
   const graph = JSON.parse(JSON.stringify(snapshot).replaceAll('container:web-app', 'container:apps-web').replaceAll('Atlas web app', '@okie/web')) as ArchitectureSnapshot;
   const graphView = structuredClone(view) as ArchitectureView;
   const packet = structuredClone(sliceArchitectureNeighborhood(graph, graphView, { focusEntityId: graphView.rootEntityId }));
   const container = graph.entities.find(entity => entity.id === 'container:apps-web')!;
   const description = container.responsibility!;
   expect(description).toBeTruthy();
   const loadNeighborhood = vi.fn(async (focus: string) => {
     const deepPacket = structuredClone(sliceArchitectureNeighborhood(graph, graphView, { focusEntityId: focus }));
     // Partial deep packets omit prose already captured in the boot neighborhood.
     delete deepPacket.snapshot.entities.find(entity => entity.id === container.id)!.responsibility;
     return deepPacket;
   });
   const renamedStory = JSON.parse(JSON.stringify(story).replaceAll('container:web-app', 'container:apps-web'));
   fixture = compileScanNeighborhoodFixture(packet, renamedStory, { loadNeighborhood, loadStory: async () => renamedStory, loadExcerpts: async () => undefined });
   setActiveScanFixture(fixture);
   const module = await import('../App'); module.refreshAppScanFixture();
   window.history.replaceState(null, '', '/?fixture=scan&backend=canvas2d&root=container%3Aapps-web&detail=context&lens=system%3Aokie&z=7.95');
   root = createRoot(host);
   await act(async () => { root.render(<App/>); }); await settle();
   await act(async () => { host.querySelector<HTMLButtonElement>('#overview-tab')!.click(); });
   expect(captured.controller!.current()).toMatchObject({ rootEntityId: 'container:apps-web', selectedId: 'container:apps-web' });
   expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-selected-entity-id')).toBe('container:apps-web');
   expect(loadNeighborhood).toHaveBeenCalledWith('container:apps-web', expect.anything());
   const overview = host.querySelector('[data-testid="inspector-overview"]')!;
   expect(overview.querySelector('[data-contextual-overview]')!.getAttribute('data-contextual-overview')).toBe('container:apps-web');
   expect(overview.querySelector('.overview-title')!.textContent).toBe('@okie/web');
   expect(overview.querySelector('.overview-identity-meta .overview-chip')!.textContent).toBe('Container');
   expect(overview.textContent).toContain(description);
 });

 it.each([false, true])('validates %s stress deep-link IDs against the loaded fixture', async unknown => {
   await act(async () => root.unmount()); setActiveScanFixture(undefined);
   const module = await import('../App'); module.refreshAppScanFixture();
   const { loadStressFixture } = await import('../renderer/stressFixture');
   const loaded = await loadStressFixture();
   const rootId = loaded.entities[2]!.id;
   const selectedId = loaded.entities[3]!.id;
   const requestedRoot = unknown ? 'unknown-root' : rootId;
   const requestedSelected = unknown ? 'unknown-selected' : selectedId;
   window.history.replaceState(null, '', `/?fixture=stress&backend=canvas2d&root=${requestedRoot}&sel=${requestedSelected}&lens=${unknown ? 'unknown-lens' : rootId}`);
   root = createRoot(host);
   await act(async () => { root.render(<App/>); }); await settle();
   const current = captured.controller!.current();
   expect(current.rootEntityId).toBe(unknown ? loaded.entities[0]!.id : rootId);
   expect(current.selectedId).toBe(unknown ? loaded.entities[0]!.id : selectedId);
   expect(current.lensPath).toBeUndefined();
   expect(window.location.search).not.toContain('unknown');
 }, 15000);

 it('does not replay the incoming stress link after newer navigation during loading', async () => {
   await act(async () => root.unmount()); setActiveScanFixture(undefined);
   const module = await import('../App'); module.refreshAppScanFixture();
   const stress = await import('../renderer/stressFixture');
   const loaded = await stress.loadStressFixture();
   let release!: (scene: typeof loaded) => void;
   vi.spyOn(stress, 'loadStressFixture').mockReturnValue(new Promise(done => { release = done; }));
   window.history.replaceState(null, '', `/?fixture=stress&backend=canvas2d&root=${loaded.entities[2]!.id}&sel=${loaded.entities[3]!.id}`);
   root = createRoot(host);
   await act(async () => { root.render(<App/>); }); await settle();
   await act(async () => { captured.controller!.push({ ...captured.controller!.current(), rootEntityId: 'stress-loading', selectedId: 'stress-loading' }); });
   await act(async () => { release(loaded); }); await settle();
   expect(captured.controller!.current().selectedId).toBe(loaded.entities[0]!.id);
   expect(captured.controller!.current().selectedId).not.toBe(loaded.entities[3]!.id);
 }, 15000);

 it('uses loaded stress defaults for unknown and missing later history entries', async () => {
   await act(async () => root.unmount()); setActiveScanFixture(undefined);
   const module = await import('../App'); module.refreshAppScanFixture();
   const stress = await import('../renderer/stressFixture'); const loaded = await stress.loadStressFixture();
   window.history.replaceState(null, '', '/?fixture=stress&backend=canvas2d');
   root = createRoot(host); await act(async () => { root.render(<App/>); }); await settle();
   for (const query of ['', '&root=unknown-root&sel=unknown-selected&lens=unknown-lens']) {
     await act(async () => { window.history.pushState(null, '', `/?fixture=stress&backend=canvas2d${query}`); window.dispatchEvent(new PopStateEvent('popstate')); }); await settle();
     expect(captured.controller!.current()).toMatchObject({ rootEntityId: loaded.entities[0]!.id, selectedId: loaded.entities[0]!.id });
     expect(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-selected-entity-id')).toBe(loaded.entities[0]!.id);
     expect(window.location.search).not.toContain('stress-loading');
     expect(window.location.search).not.toContain('unknown');
   }
 }, 15000);
