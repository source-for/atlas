// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import { scanZoomEntityUnderPointer, semanticBounds } from '../renderer/goldenC4Scene';
import type { Camera, RenderState } from '../renderer/types';
import { MOBILE_NOTICE_SESSION_KEY } from '../mobileGate';
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
let rafFrames = new Map<number, FrameRequestCallback>();
let rafId = 100000;
// A 390x844 phone. The harness measures no overlays, so the safe width is the full 390.
const mapWidth = 390;
const mapHeight = 844;
const pointer = { x: mapWidth / 2, y: mapHeight / 2 };
const focusId = 'container:web-app';
let touchPrimary = true;
const clock = { now: 5000 };
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
function shell() { return host.querySelector('[data-testid="atlas-app"]')!; }
function diagnostic() { return JSON.parse(shell().getAttribute('data-lens-diagnostics')!); }
function detail() { return shell().getAttribute('data-detail'); }
function rootId() { return shell().getAttribute('data-root-entity-id'); }
// happy-dom's WheelEvent omits MouseEvent fields; supply real browser fields.
function wheel(init: WheelEventInit) {
  const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true });
  for (const key of ['clientX', 'clientY', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) Object.defineProperty(event, key, { value: init[key] ?? (key.endsWith('Key') ? false : 0) });
  Object.defineProperty(event, 'timeStamp', { value: inputTime += 16 });
  return event;
}
async function frame() {
  clock.now += 16;
  const pending = [...rafFrames.values()]; rafFrames.clear();
  await act(async () => { for (const callback of pending) callback(clock.now); }); await settle();
}
/** One pinch sample to `zoom`, then the frame a browser paints before the next one. */
async function pinchTo(zoom: number) {
  const deltaY = -Math.log(zoom / captured.camera.zoom) / .01;
  await act(async () => canvas.dispatchEvent(wheel({ ctrlKey: true, deltaMode: 0, deltaY, clientX: pointer.x, clientY: pointer.y })));
  await settle();
  await frame();
}
async function mount(url: string) {
  window.history.replaceState(null, '', url);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
  canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
}
/** The root map at L1, with `point` (world) under the pinch. */
async function mountRootOver(point: { x: number; y: number }, selectedId = focusId) {
  await mount(`/?fixture=scan&backend=canvas2d&root=system%3Aokie&sel=${encodeURIComponent(selectedId)}&detail=context&lens=system%3Aokie&cx=${point.x}&cy=${point.y}&z=0.6`);
  await frame();
  expect(captured.camera.zoom).toBeCloseTo(.6, 3);
}
function containerCentre() {
  const bounds = semanticBounds(fixture.createScene('system:okie'), focusId, 'container')!;
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}
/** The earliest code window among the container's files, at this map's width. */
function earliestCodeWindow() {
  const scene = fixture.createScene(focusId);
  return scene.entities.filter(entity => entity.parentId === focusId)
    .map(entity => scanCodeRevealWindow(semanticBounds(scene, entity.id, 'component'), mapWidth)!)
    .reduce((first, window) => window.armZoom < first.armZoom ? window : first);
}
type Sample = { zoom: number; detail: string | null; root: string | null; bridge: { sourceDetail: string; targetDetail: string; startZoom: number; fullZoom: number; progress: number } | null };
/** Pinch in small steps to `toZoom`, recording what the app showed after each sample. */
async function pinchThrough(toZoom: number, ratio = 1.02): Promise<Sample[]> {
  const samples: Sample[] = [];
  const inward = toZoom > captured.camera.zoom;
  for (let step = 0; step < 400 && (inward ? captured.camera.zoom < toZoom : captured.camera.zoom > toZoom); step++) {
    await pinchTo(inward ? captured.camera.zoom * ratio : captured.camera.zoom / ratio);
    samples.push({ zoom: captured.camera.zoom, detail: detail(), root: rootId(), bridge: diagnostic().bridge });
  }
  return samples;
}
// The first mount also imports the App module, which alone can pass 5s on a loaded machine.
vi.setConfig({ testTimeout: 60_000 });
beforeEach(() => {
  inputTime = 0; touchPrimary = true; clock.now = 5000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); sessionStorage.clear(); localStorage.setItem('okie.devMode', '1'); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
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
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(mapWidth);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(mapHeight + 68);
  // Read live by the app: a test flips `touchPrimary` to change the device under it.
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: touchPrimary && (query === '(pointer: coarse)' || query === '(hover: none)'), media: query, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  }) as unknown as MediaQueryList);
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: mapWidth / mapHeight });
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setActiveScanFixture(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });


/** Requested focus ids with consecutive repeats collapsed. */
function requestRuns(requests: { mock: { calls: unknown[][] } }) {
  return requests.mock.calls.map(call => call[0] as string).filter((id, index, ids) => id !== ids[index - 1]);
}
const levels = ['context', 'container', 'component', 'code'];
function expectLevelsInOrder(samples: Sample[], direction: 1 | -1) {
  for (let index = 1; index < samples.length; index++) {
    const step = levels.indexOf(samples[index]!.detail!) - levels.indexOf(samples[index - 1]!.detail!);
    expect(step === 0 || step === direction, `${samples[index - 1]!.detail} -> ${samples[index]!.detail} at ${samples[index]!.zoom}`).toBe(true);
  }
}

it('on a phone the container expansion and then the code reveal follow the pinch, and reverse in order (CLA-404)', async () => {
  // "Continue anyway" on the small-screen notice was pressed: the device is still a phone.
  sessionStorage.setItem(MOBILE_NOTICE_SESSION_KEY, '1');
  const code = earliestCodeWindow();
  expect(code.armZoom).toBeCloseTo(2.119528, 5);
  const requests = vi.spyOn(fixture, 'ensureNeighborhood');
  await mountRootOver(containerCentre());
  const inward = await pinchThrough(code.fullZoom * 1.1);
  const expansion = inward.filter(sample => sample.bridge?.targetDetail === 'component');
  // It starts where the scaled lens arms (3.35 x 0.4964 = 1.663), not at desktop's 3.35 ...
  expect(expansion[0]!.bridge!.startZoom).toBeGreaterThanOrEqual(1.662);
  expect(expansion[0]!.bridge!.startZoom).toBeLessThan(1.663 * 1.02);
  // ... and is complete at the code window's arm zoom, before code starts.
  expect(expansion[0]!.bridge!.fullZoom).toBeCloseTo(code.armZoom, 5);
  expect(inward.find(sample => sample.root === focusId)!.zoom).toBeLessThan(code.armZoom);
  // It follows the pinch: several distinct partial steps, never past its own sampled zoom.
  const partial = new Set(expansion.map(sample => sample.bridge!.progress).filter(progress => progress > 0 && progress < 1));
  expect(partial.size).toBeGreaterThanOrEqual(4);
  const complete = inward.find(sample => sample.bridge?.targetDetail === 'component' && sample.bridge.progress === 1)!;
  expect(complete.zoom).toBeLessThan(code.startZoom);
  // The code reveal then also follows the pinch, inside CLA-381's window, not on a timer.
  const reveal = inward.filter(sample => sample.bridge?.targetDetail === 'code');
  expect(reveal[0]!.bridge).toMatchObject({ startZoom: code.startZoom, fullZoom: code.fullZoom });
  expect(reveal[0]!.zoom).toBeLessThan(code.fullZoom);
  expect(new Set(reveal.map(sample => sample.bridge!.progress).filter(progress => progress > 0 && progress < 1)).size).toBeGreaterThanOrEqual(3);
  expect(inward.at(-1)).toMatchObject({ detail: 'code' });
  expectLevelsInOrder(inward, 1);
  // One request per level entered: no release-and-request loop.
  // Each level is prepared once, in order. (The file is asked for again on every sample
  // between its arm and start zoom, as on desktop; those reuse the prepared scene.)
  expect(requestRuns(requests)).toEqual([focusId, reveal[0]!.root]);
  expect(requests.mock.calls.filter(call => call[0] === focusId)).toHaveLength(1);

  const outward = await pinchThrough(0.7);
  expectLevelsInOrder(outward, -1);
  expect(outward.at(-1)).toMatchObject({ detail: 'context', root: 'system:okie', bridge: null });
  // Code closes first, then the container contracts above the container level's own leave zoom.
  const contraction = outward.filter(sample => sample.bridge?.targetDetail === 'component');
  expect(contraction[0]!.zoom).toBeLessThan(outward.find(sample => sample.detail === 'component')!.zoom);
  expect(contraction[0]!.bridge!.startZoom).toBeGreaterThanOrEqual(1.24 - 1e-9);
  expect(new Set(contraction.map(sample => sample.bridge!.progress).filter(progress => progress > 0 && progress < 1)).size).toBeGreaterThanOrEqual(3);
  expect(outward.find(sample => sample.detail === 'context')!.zoom).toBeLessThan(1.08);
  expect(requestRuns(requests)).toEqual([focusId, reveal[0]!.root, 'system:okie']);
});

it('a narrow desktop window (mouse, hover) keeps main\'s thresholds at the same 390 width', async () => {
  touchPrimary = false;
  await mountRootOver(containerCentre());
  const inward = await pinchThrough(4.4);
  const below = inward.filter(sample => sample.zoom < 3.35);
  expect(below.length).toBeGreaterThan(40);
  expect(below.every(sample => sample.root === 'system:okie' && sample.bridge === null)).toBe(true);
  expect(below.at(-1)!.detail).toBe('container');
  const expansion = inward.find(sample => sample.bridge?.targetDetail === 'component')!;
  expect(expansion.bridge!.startZoom).toBeGreaterThanOrEqual(3.35);
  expect(expansion.bridge!.startZoom).toBeLessThan(3.35 * 1.02);
  // Main at this width: the code window (arm 2.12) is already behind, so the minimum span decides.
  expect(expansion.bridge!.fullZoom).toBeCloseTo(expansion.bridge!.startZoom * 1.2, 6);
});

it('a device change in the middle of an expansion finishes it late instead of looping', async () => {
  const code = earliestCodeWindow();
  const requests = vi.spyOn(fixture, 'ensureNeighborhood');
  await mountRootOver(containerCentre());
  await pinchThrough(1.9);
  const before = diagnostic().bridge;
  expect(before).toMatchObject({ sourceDetail: 'container', targetDetail: 'component' });
  expect(before.progress).toBeGreaterThan(0);
  expect(before.progress).toBeLessThan(1);
  expect(requests.mock.calls.map(call => call[0])).toEqual([focusId]);
  // Devtools emulation off, or a rotation to a tablet-sized viewport: no longer a phone.
  touchPrimary = false;
  const rest = await pinchThrough(code.fullZoom * 1.1);
  // The expansion keeps the interval it was built with and completes on the same pinch.
  for (const sample of rest.filter(sample => sample.bridge?.targetDetail === 'component')) {
    expect(sample.bridge).toMatchObject({ startZoom: before.startZoom, fullZoom: before.fullZoom });
    expect(sample.root).toBe(focusId);
  }
  expectLevelsInOrder(rest, 1);
  expect(rest.some(sample => sample.bridge?.targetDetail === 'component' && sample.bridge.progress === 1)).toBe(true);
  expect(rest.at(-1)!.root).not.toBe('system:okie');
  // At most the code handoff is requested afterwards; nothing is released and re-requested.
  // The container is not released and requested again; only the file's code follows.
  expect(requests.mock.calls.filter(call => call[0] === focusId)).toHaveLength(1);
  expect(requestRuns(requests)).toHaveLength(2);
  // And back the other way while pinching out: still ordered, still ends at the root map.
  touchPrimary = true;
  const outward = await pinchThrough(0.7);
  expectLevelsInOrder(outward, -1);
  expect(outward.at(-1)).toMatchObject({ detail: 'context', root: 'system:okie' });
  expect(requests.mock.calls.filter(call => call[0] === focusId)).toHaveLength(1);
  expect(requestRuns(requests)).toHaveLength(3);
});

it('expands the selected container early on a phone when the pinch is between cards (CLA-416)', async () => {
  const system = fixture.createScene('system:okie');
  const shellBounds = semanticBounds(system, 'system:okie', 'container')!;
  let gap: { x: number; y: number } | undefined;
  for (let row = 1; row < 40 && !gap; row++) for (let column = 1; column < 40 && !gap; column++) {
    const point = { x: shellBounds.x + shellBounds.width * column / 40, y: shellBounds.y + shellBounds.height * row / 40 };
    if (scanZoomEntityUnderPointer(system, { ...point, zoom: 2 }, { width: mapWidth, height: mapHeight }, pointer, 'container') === 'system:okie') gap = point;
  }
  expect(gap).toBeDefined();
  const code = earliestCodeWindow();
  const requests = vi.spyOn(fixture, 'ensureNeighborhood');
  await mountRootOver(gap!);
  const inward = await pinchThrough(code.startZoom * 0.97);
  // It opens no later than the scaled band commit (3.58 x 0.4964 = 1.777), not at desktop's 3.58.
  const expansion = inward.find(sample => sample.bridge?.targetDetail === 'component')!;
  expect(expansion.root).toBe(focusId);
  expect(expansion.bridge!.startZoom).toBeGreaterThanOrEqual(1.662);
  expect(expansion.bridge!.startZoom).toBeLessThan(1.777 * 1.02);
  expect(expansion.bridge!.fullZoom).toBeLessThan(code.startZoom);
  expectLevelsInOrder(inward, 1);
  expect(inward.at(-1)).toMatchObject({ detail: 'component', root: focusId });
  expect(requests.mock.calls.filter(call => call[0] === focusId)).toHaveLength(1);
});

it('contracts a restored phone view of a container above the container level on the way out', async () => {
  const scene = fixture.createScene(focusId);
  const bounds = semanticBounds(scene, focusId, 'component')!;
  // Saved inside the container at a zoom only a phone reaches there (desktop's leave zoom is 3.12).
  await mount(`/?fixture=scan&backend=canvas2d&root=${encodeURIComponent(focusId)}&sel=${encodeURIComponent(focusId)}&detail=context&lens=system%3Aokie&lens=${encodeURIComponent(focusId)}&cx=${bounds.x + bounds.width / 2}&cy=${bounds.y + bounds.height / 2}&z=1.8`);
  await frame();
  expect(captured.camera.zoom).toBeCloseTo(1.8, 3);
  expect(detail()).toBe('component');
  const outward = await pinchThrough(0.7);
  expectLevelsInOrder(outward, -1);
  const contraction = outward.filter(sample => sample.bridge?.targetDetail === 'component');
  // The cold interval is the scaled band (enter 1.663), with its start floored at 1.24.
  expect(contraction[0]!.bridge!.fullZoom).toBeCloseTo(1.662818, 5);
  expect(contraction[0]!.bridge!.startZoom).toBeCloseTo(1.24, 9);
  expect(new Set(contraction.map(sample => sample.bridge!.progress).filter(progress => progress > 0 && progress < 1)).size).toBeGreaterThanOrEqual(3);
  // The contraction is over while containers are still the level shown.
  expect(outward.find(sample => sample.bridge?.progress === 0)).toMatchObject({ detail: 'container' });
  expect(outward.at(-1)).toMatchObject({ detail: 'context', root: 'system:okie', bridge: null });
});

it('holds a closed file\'s code bridge through the phone\'s own component band, then lets it go below it', async () => {
  const code = earliestCodeWindow();
  await mountRootOver(containerCentre());
  await pinchThrough(code.fullZoom * 1.05);
  expect(detail()).toBe('code');
  // Back out past the code window but still inside the scaled component band (leave 3.12 x 0.4964 = 1.549).
  // Desktop's band would call this zoom "left" (below 3.12) and drop the bridge on the first sample.
  const held = await pinchThrough(1.75);
  expect(held.at(-1)).toMatchObject({ detail: 'component', root: focusId, bridge: { sourceDetail: 'component', targetDetail: 'code', progress: 0 } });
  expect(held.filter(sample => sample.zoom < code.leaveStartZoom).every(sample => sample.bridge?.targetDetail === 'code' && sample.bridge.progress === 0)).toBe(true);
  // Below the scaled leave zoom the file's bridge is released and the container contracts.
  const left = await pinchThrough(1.45);
  expect(left.at(-1)!.bridge).toMatchObject({ sourceDetail: 'container', targetDetail: 'component' });
  expect(left.find(sample => sample.bridge?.targetDetail === 'component')!.zoom).toBeLessThan(1.549);
});

it.each([
  ['a phone keeps the saved view inside the container', true, 'component'],
  ['a desktop window drops it to the container level, as on main', false, 'container'],
])('Back to a view saved inside a container at phone zoom: %s', async (_label, touch, restoredDetail) => {
  touchPrimary = touch;
  const bounds = semanticBounds(fixture.createScene(focusId), focusId, 'component')!;
  await mountRootOver(containerCentre());
  // In this portrait layout the container's own scene authors its expansion at 1.84 (leave 1.61).
  // Zoom 1.4 is below that, and above the phone's scaled and floored 1.24 (leave 1.13).
  window.history.pushState(null, '', `/?fixture=scan&backend=canvas2d&root=${encodeURIComponent(focusId)}&sel=${encodeURIComponent(focusId)}&detail=context&lens=system%3Aokie&lens=${encodeURIComponent(focusId)}&cx=${bounds.x + bounds.width / 2}&cy=${bounds.y + bounds.height / 2}&z=1.4`);
  await act(async () => { window.dispatchEvent(new PopStateEvent('popstate')); });
  for (let turn = 0; turn < 6; turn++) { await settle(); await frame(); }
  expect(rootId()).toBe(focusId);
  expect(captured.camera.zoom).toBeCloseTo(1.4, 3);
  expect(detail()).toBe(restoredDetail);
});

it.each([
  ['a phone opens it inside the container', true, 'component'],
  ['a desktop window opens it at the container level, as on main', false, 'container'],
])('a link saved inside a container at phone zoom, loaded cold: %s', async (_label, touch, restoredDetail) => {
  touchPrimary = touch;
  const bounds = semanticBounds(fixture.createScene(focusId), focusId, 'component')!;
  // The first validation runs before the map is measured, from the window width.
  await mount(`/?fixture=scan&backend=canvas2d&root=${encodeURIComponent(focusId)}&sel=${encodeURIComponent(focusId)}&detail=context&lens=system%3Aokie&lens=${encodeURIComponent(focusId)}&cx=${bounds.x + bounds.width / 2}&cy=${bounds.y + bounds.height / 2}&z=1.4`);
  await frame();
  expect(rootId()).toBe(focusId);
  expect(captured.camera.zoom).toBeCloseTo(1.4, 3);
  expect(detail()).toBe(restoredDetail);
});
