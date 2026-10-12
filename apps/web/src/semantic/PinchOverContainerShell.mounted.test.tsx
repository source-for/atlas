// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import type { ArchitectureSnapshot } from '@okie/architecture';
import { compileScanFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import { scanZoomCompileHandoff, scanZoomEntityUnderPointer, semanticBounds } from '../renderer/goldenC4Scene';
import type { AtlasScene, Camera, RenderState } from '../renderer/types';
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
let inputTime = 0;
const mapWidth = 1440;
const mapHeight = 900;
const viewport = { width: mapWidth, height: mapHeight };
const pointer = { x: mapWidth / 2, y: mapHeight / 2 };
let rafFrames = new Map<number, FrameRequestCallback>();
let rafId = 100000;
let clock = 0;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function shell() { return host.querySelector('[data-testid="atlas-app"]')!; }
function diagnostic() { return JSON.parse(shell().getAttribute('data-lens-diagnostics')!); }
// happy-dom's WheelEvent omits MouseEvent fields; supply real browser fields.
function wheel(init: WheelEventInit) {
  const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true });
  for (const key of ['clientX', 'clientY', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) Object.defineProperty(event, key, { value: init[key] ?? (key.endsWith('Key') ? false : 0) });
  Object.defineProperty(event, 'timeStamp', { value: inputTime += 16 });
  return event;
}
async function pinchTo(zoom: number) {
  const deltaY = -Math.log(zoom / captured.camera.zoom) / .01;
  await act(async () => canvas.dispatchEvent(wheel({ ctrlKey: true, deltaMode: 0, deltaY, clientX: pointer.x, clientY: pointer.y })));
}
// The first mount also imports the App module, and a loop re-requests on every sample; both are slow on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });
beforeEach(() => {
  inputTime = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); localStorage.setItem('okie.devMode', '1'); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } })));
  rafFrames = new Map(); rafId = 100000;
  const enqueue = (callback: FrameRequestCallback) => { rafFrames.set(++rafId, callback); return rafId; };
  const cancel = (handle: number) => { rafFrames.delete(handle); };
  vi.stubGlobal('requestAnimationFrame', enqueue); vi.spyOn(window, 'requestAnimationFrame').mockImplementation(enqueue);
  vi.stubGlobal('cancelAnimationFrame', cancel); vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(cancel);
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(element: Element) { this.callback([{ target: element, contentRect: { width: mapWidth, height: mapHeight } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const map = this instanceof HTMLCanvasElement || this.getAttribute('data-testid') === 'atlas-canvas' || this.classList.contains('atlas-renderer-host');
    return new DOMRect(0, 0, map ? mapWidth : 0, map ? mapHeight : 0);
  });
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: mapWidth / mapHeight });
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setActiveScanFixture(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/**
 * Mount inside the web app container with the pointer on `overId` (a card that is not the
 * file the code handoff picks), then pinch past that file's whole reveal window while its
 * compile is still pending, so the L3→L4 bridge is published late, at progress 0.
 */
async function publishLateCodeBridgeUnder(overId: string) {
  const source = fixture.createScene('container:web-app');
  const over = semanticBounds(source, overId, 'component')!;
  let point: { x: number; y: number } | undefined;
  for (let row = 1; row < 40 && !point; row++) for (let column = 1; column < 40 && !point; column++) {
    const candidate = { x: over.x + over.width * column / 40, y: over.y + over.height * row / 40 };
    if (scanZoomEntityUnderPointer(source, { ...candidate, zoom: 4 }, viewport, pointer, 'component') === overId) point = candidate;
  }
  expect(point).toBeDefined();
  // The shell resolves to this file; selecting it makes a card outside the container fall back to it too.
  const fileId = scanZoomCompileHandoff(source, fixture.snapshot as ArchitectureSnapshot, 'container:web-app', 'system:okie', 'code')!.compileFocus;
  expect(fileId).not.toBe(overId);
  const reveal = scanCodeRevealWindow(semanticBounds(source, fileId, 'component')!)!;
  window.history.replaceState(null, '', `/?fixture=scan&backend=canvas2d&root=container%3Aweb-app&sel=${encodeURIComponent(fileId)}&detail=context&lens=system%3Aokie&lens=container%3Aweb-app&cx=${point!.x}&cy=${point!.y}&z=${reveal.startZoom * .98}`);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
  let resolve!: () => void;
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementationOnce((focus, previous, residency) => new Promise<AtlasScene>(done => { resolve = () => done(fixture.createScene(focus, previous, residency)); }));
  await pinchTo(reveal.startZoom * 1.01); await settle();
  expect(compile.mock.calls.map(call => call[0])).toEqual([fileId]);
  await pinchTo(reveal.fullZoom * 1.2);
  clock = 8000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  await act(async () => resolve()); await settle();
  expect(diagnostic().bridge).toMatchObject({ focusId: fileId, sourceDetail: 'component', targetDetail: 'code', progress: 0 });
  return fileId;
}

it.each([
  ['the container shell', 'container:web-app'],
  ['a peer container', 'container:architecture-model'],
])('reveals code when the pinch pointer is over %s (CLA-417)', async (_label, overId) => {
  const fileId = await publishLateCodeBridgeUnder(overId);
  const requests = vi.spyOn(fixture, 'ensureNeighborhood');
  for (let step = 0; step < 14; step++) {
    // Chrome delivers wheel input at the start of a frame, after that frame's timestamp is
    // fixed, so the reveal tick that follows a publication sees no elapsed time.
    clock += 16;
    const frameTime = clock;
    clock += 1;
    await pinchTo(captured.camera.zoom * 1.002); await settle();
    const pending = [...rafFrames.values()]; rafFrames.clear();
    await act(async () => { for (const callback of pending) callback(frameTime); }); await settle();
  }
  // Before the fix every inward sample released the bridge at progress 0 and requested the same file again.
  expect(requests).not.toHaveBeenCalled();
  expect(diagnostic().bridge).toMatchObject({ focusId: fileId, progress: 1 });
  expect(shell().getAttribute('data-detail')).toBe('code');
  expect(shell().getAttribute('data-root-entity-id')).toBe(fileId);
});
