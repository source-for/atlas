// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import { semanticBounds } from '../renderer/goldenC4Scene';
import type { Camera, RenderState } from '../renderer/types';
import { scanCodeRevealWindow } from './scanCodeRevealWindow';

const captured = vi.hoisted(() => ({ camera: { x: 0, y: 0, zoom: 1 } as Camera, state: undefined as RenderState | undefined }));
vi.mock('../renderer/createRenderer', () => ({
  createRenderer: async (host: HTMLElement) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    return { canvas, renderer: { kind: 'canvas2d', setScene() {}, setCamera(camera: Camera) { captured.camera = { ...camera }; }, setRenderState(state: RenderState) { captured.state = state; }, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'canvas2d', activeBackend: 'canvas2d', gpuAccelerated: false, lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  }, recoverRenderer: vi.fn(),
}));
let root: Root;
let host: HTMLDivElement;
let fixture: ScanFixture;
let canvas: HTMLCanvasElement;
let inputMode: 'mouse' | 'pinch' = 'pinch';
let inputTime = 0;
let mapWidth = 1440;
let mapHeight = 900;
let rafFrames = new Map<number, FrameRequestCallback>();
let resizeTargets: Array<{ callback: ResizeObserverCallback; element: Element }> = [];
let rafId = 100000;
let reveal: NonNullable<ReturnType<typeof scanCodeRevealWindow>>;
let bounds: NonNullable<ReturnType<typeof semanticBounds>>;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function diagnostic() { return JSON.parse(host.querySelector('[data-testid="atlas-app"]')!.getAttribute('data-lens-diagnostics')!); }
// happy-dom's WheelEvent omits MouseEvent fields; supply real browser fields.
function wheel(init: WheelEventInit) {
  const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true });
  for (const key of ['clientX', 'clientY', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) Object.defineProperty(event, key, { value: init[key] ?? (key.endsWith('Key') ? false : 0) });
  Object.defineProperty(event, 'timeStamp', { value: inputTime += 16 });
  return event;
}
async function zoomTo(zoom: number, pointer = { x: 720, y: 450 }) {
  const deltaY = -Math.log(zoom / captured.camera.zoom) / (inputMode === 'pinch' ? .01 : .0012 * 33);
  await act(async () => canvas.dispatchEvent(wheel({ ctrlKey: inputMode === 'pinch', deltaMode: inputMode === 'pinch' ? 0 : 1, deltaY, clientX: pointer.x, clientY: pointer.y })));
}
// The first mount also imports the App module, which alone can pass 5s on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });
async function mount(url: string) {
  window.history.replaceState(null, '', url);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
}
function shell() { return host.querySelector('[data-testid="atlas-app"]')!; }
function containerUrl(x: number, y: number, zoom: number) {
  return `/?fixture=scan&backend=canvas2d&root=container%3Aweb-app&sel=component%3Aweb-navigation&detail=context&lens=system%3Aokie&lens=container%3Aweb-app&cx=${x}&cy=${y}&z=${zoom}`;
}
beforeEach(() => {
  inputTime = 0; mapWidth = 1440; mapHeight = 900;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); localStorage.setItem('okie.devMode', '1'); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } })));
  rafFrames = new Map(); rafId = 100000;
  const enqueue = (callback: FrameRequestCallback) => { rafFrames.set(++rafId, callback); return rafId; };
  const cancel = (handle: number) => { rafFrames.delete(handle); };
  vi.stubGlobal('requestAnimationFrame', enqueue); vi.spyOn(window, 'requestAnimationFrame').mockImplementation(enqueue);
  vi.stubGlobal('cancelAnimationFrame', cancel); vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(cancel);
  resizeTargets = [];
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(element: Element) { resizeTargets.push({ callback: this.callback, element }); this.callback([{ target: element, contentRect: { width: mapWidth, height: mapHeight } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const map = this instanceof HTMLCanvasElement || this.getAttribute('data-testid') === 'atlas-canvas' || this.classList.contains('atlas-renderer-host');
    return new DOMRect(0, 0, map ? mapWidth : 0, map ? mapHeight : 0);
  });
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: 1440 / 900 });
  bounds = semanticBounds(fixture.createScene('container:web-app'), 'component:web-navigation', 'component')!;
  reveal = scanCodeRevealWindow(bounds)!;
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setActiveScanFixture(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function idle() {
  let clock = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  for (let round = 0; round < 3; round++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(240); }); await settle();
    clock += 400;
    const frames = [...rafFrames.values()]; rafFrames.clear();
    await act(async () => { for (const callback of frames) callback(clock); }); await settle();
  }
}

it('descends into the file under the map centre when a loaded URL is already past its code window', async () => {
  const zoom = reveal.fullZoom * 1.05;
  await mount(containerUrl(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, zoom));
  await idle();
  expect(shell().getAttribute('data-detail')).toBe('code');
  expect(shell().getAttribute('data-root-entity-id')).toBe('component:web-navigation');
  expect(new URL(window.location.href).searchParams.getAll('lens')).toEqual(['system:okie', 'container:web-app', 'component:web-navigation']);
  // The restored camera is where the reader was; the descent does not move it.
  expect(captured.camera.zoom).toBeCloseTo(zoom, 3);
});

it('leaves a loaded URL below the reveal start at L3 without preparing code', async () => {
  const compile = vi.spyOn(fixture, 'createSceneAsync');
  await mount(containerUrl(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, reveal.startZoom * .98));
  await idle();
  expect(shell().getAttribute('data-detail')).toBe('component');
  expect(shell().getAttribute('data-root-entity-id')).toBe('container:web-app');
  expect(compile.mock.calls.filter(call => call[0] === 'component:web-navigation')).toEqual([]);
});

it('does not descend into a fallback file when no file is under the map centre', async () => {
  const compile = vi.spyOn(fixture, 'createSceneAsync');
  const scene = fixture.createScene('container:web-app');
  const owner = semanticBounds(scene, 'container:web-app', 'component')!;
  // Well outside the opened container: nothing the reader is looking at has code.
  await mount(containerUrl(owner.x - owner.width * 4, owner.y - owner.height * 4, reveal.fullZoom * 1.05));
  await idle();
  expect(shell().getAttribute('data-detail')).toBe('component');
  expect(shell().getAttribute('data-root-entity-id')).toBe('container:web-app');
  expect(compile.mock.calls.filter(call => String(call[0]).startsWith('component:'))).toEqual([]);
});

it('does not descend when the map centre is over a peer container shell', async () => {
  const compile = vi.spyOn(fixture, 'createSceneAsync');
  const scene = fixture.createScene('container:web-app');
  // Peer containers stay painted at L3. One under the centre is not a file of the opened
  // container, and the handoff would swap it for that container's fallback file.
  const peer = semanticBounds(scene, 'container:architecture-model', 'component')!;
  expect(peer).toBeDefined();
  await mount(containerUrl(peer.x + peer.width / 2, peer.y + peer.height / 2, reveal.fullZoom * 1.05));
  await idle();
  expect(shell().getAttribute('data-detail')).toBe('component');
  expect(shell().getAttribute('data-root-entity-id')).toBe('container:web-app');
  expect(compile.mock.calls.filter(call => String(call[0]).startsWith('component:'))).toEqual([]);
});

async function frames(clock: { now: number }) {
  clock.now += 16;
  const pending = [...rafFrames.values()]; rafFrames.clear();
  await act(async () => { for (const callback of pending) callback(clock.now); }); await settle();
}

/** Pinch from the system map until the container's L2→L3 expansion owns the camera. */
async function enterContainerExpansion() {
  inputMode = 'pinch';
  const owner = semanticBounds(fixture.createScene('system:okie'), 'container:web-app', 'container')!;
  const compile = vi.spyOn(fixture, 'createSceneAsync');
  await mount(`/?fixture=scan&backend=canvas2d&root=system%3Aokie&detail=context&lens=system%3Aokie&cx=${owner.x + owner.width / 2}&cy=${owner.y + owner.height / 2}&z=0.6`);
  const clock = { now: 5000 };
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
  for (let step = 0; step < 24 && diagnostic()?.bridge?.focusId !== 'container:web-app'; step++) {
    await zoomTo(captured.camera.zoom * 1.12); await settle(); await frames(clock);
  }
  const bridge = diagnostic().bridge;
  expect(bridge).toMatchObject({ focusId: 'container:web-app', targetDetail: 'component' });
  // The case under test: this container's expansion ends past its file's whole code window.
  expect(bridge.fullZoom).toBeGreaterThan(reveal.fullZoom);
  expect(captured.camera.zoom).toBeLessThan(reveal.armZoom);
  const fileCompiles = () => compile.mock.calls.filter(call => call[0] === 'component:web-navigation').length;
  return { clock, bridge, fileCompiles };
}

it('prepares the file code scene while its container is still expanding, without publishing it', async () => {
  const { clock, fileCompiles } = await enterContainerExpansion();
  await zoomTo(reveal.armZoom * .98); await settle(); await frames(clock);
  expect(fileCompiles()).toBe(0);
  await zoomTo(reveal.armZoom * 1.03); await settle(); await frames(clock);
  expect(fileCompiles()).toBe(1);
  expect(diagnostic().bridge).toMatchObject({ focusId: 'container:web-app', targetDetail: 'component' });
  expect(diagnostic().bridge.progress).toBeLessThan(1);
  expect(shell().getAttribute('data-root-entity-id')).toBe('container:web-app');
  expect(shell().getAttribute('data-detail')).not.toBe('code');
  expect(new URL(window.location.href).searchParams.getAll('lens')).not.toContain('component:web-navigation');
  // Further samples over the same file do not ask again.
  await zoomTo(reveal.armZoom * 1.08); await settle(); await frames(clock);
  expect(fileCompiles()).toBe(1);
});

it('hands the prepared scene to the code handoff once the expansion completes', async () => {
  const { clock, bridge, fileCompiles } = await enterContainerExpansion();
  await zoomTo(reveal.armZoom * 1.03); await settle(); await frames(clock);
  expect(fileCompiles()).toBe(1);
  for (let step = 0; step < 12 && shell().getAttribute('data-root-entity-id') !== 'component:web-navigation'; step++) {
    await zoomTo(captured.camera.zoom * 1.12); await settle(); await frames(clock);
  }
  expect(captured.camera.zoom).toBeGreaterThan(bridge.fullZoom);
  expect(shell().getAttribute('data-root-entity-id')).toBe('component:web-navigation');
  expect(diagnostic().bridge).toMatchObject({ focusId: 'component:web-navigation', targetDetail: 'code' });
  // One compile served both the preparation and the handoff.
  expect(fileCompiles()).toBe(1);
});

it('does not publish a prepared scene when the reader pinches back out of the container', async () => {
  const { clock, fileCompiles } = await enterContainerExpansion();
  await zoomTo(reveal.armZoom * 1.03); await settle(); await frames(clock);
  expect(fileCompiles()).toBe(1);
  for (let step = 0; step < 14; step++) { await zoomTo(captured.camera.zoom * .85); await settle(); await frames(clock); }
  await idle();
  expect(shell().getAttribute('data-root-entity-id')).not.toBe('component:web-navigation');
  expect(shell().getAttribute('data-detail')).not.toBe('code');
  expect(new URL(window.location.href).searchParams.getAll('lens')).not.toContain('component:web-navigation');
});
