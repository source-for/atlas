// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import { scanZoomEntityUnderPointer, semanticBounds } from '../renderer/goldenC4Scene';
import type { Camera, RenderState } from '../renderer/types';
import { MOBILE_NOTICE_SESSION_KEY } from '../mobileGate';
import { scanCodeRevealWindow } from './scanCodeRevealWindow';

const captured = vi.hoisted(() => ({ camera: { x: 0, y: 0, zoom: 1 } as Camera, state: undefined as RenderState | undefined, pick: undefined as { kind: 'entity'; id: string } | undefined }));
vi.mock('../renderer/createRenderer', () => ({
  createRenderer: async (host: HTMLElement) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    return { canvas, renderer: { kind: 'canvas2d', setScene() {}, setCamera(camera: Camera) { captured.camera = { ...camera }; }, setRenderState(state: RenderState) { captured.state = state; }, resize() {}, render() {}, pick() { return captured.pick; }, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'canvas2d', activeBackend: 'canvas2d', gpuAccelerated: false, lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  }, recoverRenderer: vi.fn(),
}));
let root: Root;
let host: HTMLDivElement;
let fixture: ScanFixture;
let canvas: HTMLCanvasElement;
let inputTime = 0;
let rafFrames = new Map<number, FrameRequestCallback>();
let rafId = 100000;
// A 390x844 phone. With no insets the harness measures no overlays and the safe width is the
// full 390; `realPhoneInsets` gives the level rail and the details toggle their real widths.
let insets = { left: 0, right: 0 };
const realPhoneInsets = { left: 56, right: 47 };
/** Frames a scene preparation takes; 0 is the harness default (ready on the next microtask). */
let preparationFrames = 0;
let preparing: { frames: number; resolve: () => void }[] = [];
/** Reads of the map's own rect: every safe-width measurement starts with one. */
let safeWidthReads = 0;
let mapWidth = 390;
let mapHeight = 844;
/** The window's width when it is wider than the map (a desktop grid with the panel beside it). */
let windowWidth: number | undefined;
/** The open details panel's rect: at 900px and under, a fixed sheet 94vw wide from the right edge (app.css). */
const detailsSheet = () => new DOMRect((windowWidth ?? mapWidth) * 0.06, 0, (windowWidth ?? mapWidth) * 0.94, mapHeight);
const pointer = { get x() { return mapWidth / 2; }, get y() { return mapHeight / 2; } };
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
  const ready = preparing.filter(entry => --entry.frames <= 0);
  preparing = preparing.filter(entry => entry.frames > 0);
  if (ready.length) { await act(async () => { for (const entry of ready) entry.resolve(); }); await settle(); }
}
/** Make every neighborhood request from here on take `frames` frames, as a worker compile does. */
function slowPreparation(frames: number) {
  preparationFrames = frames;
  const ensure = fixture.ensureNeighborhood.bind(fixture);
  return vi.spyOn(fixture, 'ensureNeighborhood').mockImplementation(async (...args: Parameters<ScanFixture['ensureNeighborhood']>) => {
    if (preparationFrames > 0) await new Promise<void>(resolve => { preparing.push({ frames: preparationFrames, resolve }); });
    return ensure(...args);
  });
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
    .map(entity => scanCodeRevealWindow(semanticBounds(scene, entity.id, 'component'), mapWidth - insets.left - insets.right)!)
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
  mapWidth = 390; mapHeight = 844; windowWidth = undefined; captured.pick = undefined;
  inputTime = 0; touchPrimary = true; clock.now = 5000; insets = { left: 0, right: 0 }; preparationFrames = 0; preparing = [];
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
    if (this.getAttribute('data-testid') === 'atlas-canvas') safeWidthReads++;
    if (insets.left && this.classList.contains('level-rail')) return new DOMRect(0, 200, insets.left, 300);
    if (this.classList.contains('details-panel') && this.classList.contains('open')) return windowWidth && windowWidth > 900 ? new DOMRect(mapWidth, 0, windowWidth - mapWidth, mapHeight) : detailsSheet();
    if (insets.right && this.classList.contains('details-toggle')) return new DOMRect(mapWidth - insets.right, 100, insets.right, 40);
    return new DOMRect(0, 0, map ? mapWidth : 0, map ? mapHeight : 0);
  });
  vi.spyOn(window, 'innerWidth', 'get').mockImplementation(() => windowWidth ?? mapWidth);
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => mapHeight + 68);
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

it.each([
  // device, the level band's commit zoom for containers -> files
  ['a phone opens it at the scaled band commit (3.58 x 0.4964)', true, 1.777],
  ['a desktop window opens it at main\'s 3.58', false, 3.58],
])('a container the lens cannot measure is opened by the level band: %s', async (_label, touch, commitZoom) => {
  touchPrimary = touch;
  // A large repo's root scene carries no file-level bounds for its containers, so the lens
  // never arms and only the zoom level band can ask for the container.
  const create = fixture.createScene.bind(fixture);
  vi.spyOn(fixture, 'createScene').mockImplementation((...args: Parameters<ScanFixture['createScene']>) => {
    const scene = create(...args);
    if ((scene.rootEntityId ?? 'system:okie') !== 'system:okie' || !scene.projection) return scene;
    const bounds = Object.fromEntries(Object.entries(scene.projection.boundsByEntityIdAndDetail).map(([id, byDetail]) => {
      if (!id.startsWith('container:')) return [id, byDetail];
      const { component: _component, ...rest } = byDetail;
      return [id, rest];
    }));
    return { ...scene, projection: { ...scene.projection, boundsByEntityIdAndDetail: bounds } };
  });
  await mountRootOver(containerCentre());
  const inward = await pinchThrough(commitZoom * 1.06);
  const opened = inward.find(sample => sample.bridge?.targetDetail === 'component')!;
  expect(opened).toMatchObject({ root: focusId });
  expect(opened.bridge!.startZoom).toBeGreaterThanOrEqual(commitZoom - 0.001);
  expect(opened.bridge!.startZoom).toBeLessThan(commitZoom * 1.02);
  expect(inward.filter(sample => sample.zoom < commitZoom - 0.001).every(sample => sample.bridge === null && sample.root === 'system:okie')).toBe(true);
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
  // The cold interval tops out where an expansion ends (the code arm, 2.12); arriving below
  // that it is anchored to the arrival zoom, with its start floored at 1.24.
  expect(contraction[0]!.bridge!.fullZoom).toBeCloseTo(1.8, 3);
  expect(contraction[0]!.bridge!.startZoom).toBeCloseTo(1.24, 9);
  expect(new Set(contraction.map(sample => sample.bridge!.progress).filter(progress => progress > 0 && progress < 1)).size).toBeGreaterThanOrEqual(3);
  // The contraction is over while containers are still the level shown.
  expect(outward.find(sample => sample.bridge?.progress === 0)).toMatchObject({ detail: 'container' });
  expect(outward.at(-1)).toMatchObject({ detail: 'context', root: 'system:okie', bridge: null });
});

it('lets a closed file\'s code bridge go at once on a phone, so the container can contract inside its own band', async () => {
  const code = earliestCodeWindow();
  await mountRootOver(containerCentre());
  await pinchThrough(code.fullZoom * 1.05);
  expect(detail()).toBe('code');
  // Out past the code window, still well inside the scaled component band (leave 3.12 x 0.4964 = 1.549).
  // Holding the bridge to that leave zoom, as desktop does at 3.12, left the contraction 7% of zoom.
  const out = await pinchThrough(1.75);
  const closed = out.findIndex(sample => sample.bridge?.targetDetail === 'code' && sample.bridge.progress === 0);
  expect(closed).toBeGreaterThan(-1);
  const after = out.slice(closed + 1);
  expect(after.length).toBeGreaterThan(2);
  expect(after.slice(1).every(sample => sample.bridge?.sourceDetail === 'container' && sample.bridge.targetDetail === 'component')).toBe(true);
  // It runs from where the forward expansion ends (the code arm) down to the floor.
  expect(out.at(-1)!.bridge!.startZoom).toBeCloseTo(1.24, 9);
  expect(out.at(-1)!.bridge!.fullZoom).toBeCloseTo(code.armZoom, 5);
  expect(out.at(-1)!.bridge!.progress).toBeGreaterThan(0.5);
  expect(out.at(-1)!.bridge!.progress).toBeLessThan(1);
  expect(out.at(-1)).toMatchObject({ detail: 'component', root: focusId });
});

describe('a real 390x844 phone: safe width 287 between the level rail and the details toggle', () => {
  beforeEach(() => { insets = realPhoneInsets; sessionStorage.setItem(MOBILE_NOTICE_SESSION_KEY, '1'); });

  it.each([[1.03], [1.06]])('a quick pinch-out (x%s per frame) from open code still shows the container contracting', async ratio => {
    const code = earliestCodeWindow();
    expect(code.armZoom).toBeCloseTo(1.559755, 5);
    await mountRootOver(containerCentre());
    const inward = await pinchThrough(code.fullZoom * 1.05, 1.01);
    expect(diagnostic().safeArea).toMatchObject({ left: 56, right: 47 });
    expect(detail()).toBe('code');
    const opened = inward.find(sample => sample.bridge?.targetDetail === 'component')!.bridge!;
    // A scene is not ready in the frame it is asked for: two frames, as a worker compile takes.
    slowPreparation(2);
    const outward = await pinchThrough(0.7, ratio);
    expectLevelsInOrder(outward, -1);
    const contraction = outward.filter(sample => sample.bridge?.sourceDetail === 'container' && sample.bridge.targetDetail === 'component');
    const partial = contraction.filter(sample => sample.root === focusId && sample.bridge!.progress > 0 && sample.bridge!.progress < 1);
    expect(new Set(partial.map(sample => sample.bridge!.progress)).size).toBeGreaterThanOrEqual(2);
    expect(partial[0]!.zoom).toBeGreaterThan(1.24);
    // The files close over the zooms they opened over (in: about 1.32 -> 1.58).
    expect(contraction[0]!.bridge!.startZoom).toBeCloseTo(1.24, 9);
    expect(contraction[0]!.bridge!.fullZoom).toBeCloseTo(code.armZoom, 5);
    expect(Math.abs(contraction[0]!.bridge!.fullZoom - opened.fullZoom)).toBeLessThan(0.03);
    expect(Math.abs(contraction[0]!.bridge!.startZoom - opened.startZoom)).toBeLessThan(0.1);
    // Then the closed container, then L1 below the container level's leave zoom.
    const closed = outward.find(sample => sample.bridge?.targetDetail === 'component' && sample.bridge.progress === 0)!;
    expect(closed).toMatchObject({ detail: 'container', root: 'system:okie' });
    expect(closed.zoom).toBeGreaterThan(1.08);
    expect(outward.find(sample => sample.detail === 'context')!.zoom).toBeLessThan(1.08);
    expect(outward.at(-1)).toMatchObject({ detail: 'context', root: 'system:okie', bridge: null });
  });

  it('after the closed code bridge yields, pinching in again reopens the code without a request loop (CLA-417)', async () => {
    const code = earliestCodeWindow();
    const requests = vi.spyOn(fixture, 'ensureNeighborhood');
    await mountRootOver(containerCentre());
    const inward = await pinchThrough(code.fullZoom * 1.05, 1.01);
    const fileId = inward.find(sample => sample.bridge?.targetDetail === 'code')!.root!;
    expect(requestRuns(requests)).toEqual([focusId, fileId]);
    // Out until the code is closed and its bridge has given way to the container's contraction.
    const outward = await pinchThrough(1.45, 1.01);
    expect(outward.at(-1)!.bridge).toMatchObject({ sourceDetail: 'container', targetDetail: 'component' });
    expect(outward.at(-1)!.bridge!.progress).toBeGreaterThan(0);
    expect(outward.at(-1)!.bridge!.progress).toBeLessThan(1);
    expect(requestRuns(requests)).toEqual([focusId, fileId, 'system:okie']);
    // Back in: the container re-expands on the same bridge, then the file's code opens following the pinch.
    const again = await pinchThrough(code.fullZoom * 1.05, 1.01);
    expectLevelsInOrder(again, 1);
    expect(again.at(-1)).toMatchObject({ detail: 'code', root: fileId, bridge: { targetDetail: 'code', progress: 1 } });
    const reveal = again.filter(sample => sample.bridge?.targetDetail === 'code');
    expect(reveal[0]!.bridge).toMatchObject({ startZoom: code.startZoom, fullZoom: code.fullZoom });
    expect(new Set(reveal.map(sample => sample.bridge!.progress).filter(progress => progress > 0 && progress < 1)).size).toBeGreaterThanOrEqual(3);
    expect(requestRuns(requests)).toEqual([focusId, fileId, 'system:okie', fileId]);
    // Rocking across the zoom where the bridge yields costs one preparation per reversal, no more.
    for (let turn = 0; turn < 3; turn++) {
      await pinchThrough(1.6, 1.01);
      await pinchThrough(code.fullZoom * 1.05, 1.01);
    }
    expect(detail()).toBe('code');
    expect(requestRuns(requests)).toHaveLength(4 + 3 * 2);
    // And nothing is asked for while the fingers are still.
    for (let idle = 0; idle < 20; idle++) await frame();
    const settled = requests.mock.calls.length;
    const state = shell().getAttribute('data-lens-diagnostics');
    for (let idle = 0; idle < 40; idle++) await frame();
    expect(requests.mock.calls).toHaveLength(settled);
    expect(shell().getAttribute('data-lens-diagnostics')).toBe(state);
    expect(detail()).toBe('code');
  });

  it('dev diagnostics report the zooms the phone expansion really uses', async () => {
    await mountRootOver(containerCentre());
    // Part-way through the expansion, whose bridge started near 1.32.
    await pinchThrough(1.4, 1.01);
    expect(diagnostic().bridge).toMatchObject({ sourceDetail: 'container', targetDetail: 'component' });
    const policy = diagnostic().targets.find((target: { id: string }) => target.id === focusId).policy;
    expect(policy).toMatchObject({ currentDetail: 'container', nextDetail: 'component' });
    expect(policy.enterZoom).toBeCloseTo(1.24, 9);
    expect(policy.leaveZoom).toBeCloseTo(1.24 - 0.23 * 0.42 * 287 / 330, 9);
  });
});

/** Let a pending camera settle run: its timers, then the frames it schedules. */
async function rest(turns = 30) {
  for (let turn = 0; turn < turns; turn++) { clock.now += 40; await act(async () => { await vi.advanceTimersByTimeAsync(40); }); await frame(); }
}
async function pan(deltaX: number) {
  await act(async () => canvas.dispatchEvent(wheel({ deltaMode: 0, deltaX, deltaY: 0, clientX: pointer.x, clientY: pointer.y })));
  await settle();
}
async function toggleDetails() {
  await act(async () => host.querySelector<HTMLButtonElement>('.details-toggle')!.click());
  await settle();
}
const panelOpen = () => host.querySelector('.details-panel')!.classList.contains('open');

describe('the details panel over the map on a phone (safe width 287)', () => {
  beforeEach(() => { insets = realPhoneInsets; sessionStorage.setItem(MOBILE_NOTICE_SESSION_KEY, '1'); });

  it.each([
    ['then a pan', true],
    ['straight after the last pinch sample', false],
  ])('opening it inside a container (%s) does not open a file\'s code', async (_label, settleFirst) => {
    const code = earliestCodeWindow();
    await mountRootOver(containerCentre());
    await pinchThrough(1.65, 1.01);
    if (settleFirst) await rest();
    const settled = { detail: 'component', root: focusId, bridge: { sourceDetail: 'container', targetDetail: 'component', progress: 1 } };
    expect(diagnostic()).toMatchObject({ currentDetail: 'component', sceneRoot: focusId, bridge: settled.bridge });
    // Below the files' code window (it starts at 1.77): the state a phone can now rest in.
    expect(captured.camera.zoom).toBeLessThan(code.armZoom * 1.07);
    await toggleDetails();
    expect(panelOpen()).toBe(true);
    if (settleFirst) await pan(4);
    await rest();
    // The sheet covers the map; it is not a narrower map, and the code window has not moved under it.
    expect(detail()).toBe('component');
    expect(rootId()).toBe(focusId);
    expect(diagnostic().bridge).toMatchObject(settled.bridge);
    await pan(-4);
    await rest();
    expect(detail()).toBe('component');
    expect(rootId()).toBe(focusId);
    await toggleDetails();
    expect(panelOpen()).toBe(false);
    await rest();
    const outward = await pinchThrough(0.7);
    expect(outward.every(sample => sample.detail !== 'code' && sample.bridge?.targetDetail !== 'code')).toBe(true);
    expectLevelsInOrder(outward, -1);
    expect(outward[0]!.detail).toBe('component');
    expect(outward.some(sample => sample.detail === 'container')).toBe(true);
    expect(outward.find(sample => sample.detail === 'context')!.zoom).toBeLessThan(1.08);
    expect(outward.at(-1)).toMatchObject({ detail: 'context', root: 'system:okie', bridge: null });
  });

  it('tapping a file card (which opens it) and then dragging the map does not open that file\'s code', async () => {
    const touch = async (type: string, x: number, y: number) => {
      const event = new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 });
      await act(async () => { canvas.dispatchEvent(event); });
      await settle();
    };
    await mountRootOver(containerCentre());
    await pinchThrough(1.65, 1.01);
    await rest();
    expect(panelOpen()).toBe(false);
    // The tap lands on a file: the renderer picks it and the inspector opens on it.
    captured.pick = { kind: 'entity', id: fixture.createScene(focusId).entities.find(entity => entity.parentId === focusId)!.id };
    await touch('pointerdown', pointer.x, pointer.y);
    await touch('pointerup', pointer.x, pointer.y);
    captured.pick = undefined;
    await rest(5);
    expect(panelOpen()).toBe(true);
    // A 6px drag on the strip of map left beside the sheet.
    const before = captured.camera.x;
    await touch('pointerdown', 10, 400);
    await touch('pointermove', 13, 400);
    await touch('pointermove', 16, 400);
    await touch('pointerup', 16, 400);
    await rest();
    expect(captured.camera.x).not.toBe(before);
    expect(detail()).toBe('component');
    expect(rootId()).toBe(focusId);
    expect(diagnostic().bridge).toMatchObject({ sourceDetail: 'container', targetDetail: 'component', progress: 1 });
  });

  it('with it open, zooming in over a file still opens its code in the normal window', async () => {
    // A touch pinch is ignored while the panel is open (as on main); this is the wheel path.
    const code = earliestCodeWindow();
    expect(code.startZoom).toBeCloseTo(1.772449, 5);
    expect(code.fullZoom).toBeCloseTo(2.126939, 5);
    await mountRootOver(containerCentre());
    await pinchThrough(1.65, 1.01);
    await rest();
    await toggleDetails();
    await rest();
    const inward = await pinchThrough(code.fullZoom * 1.05, 1.01);
    expect(inward.filter(sample => sample.zoom < code.startZoom).every(sample => sample.detail === 'component' && sample.bridge?.targetDetail === 'component')).toBe(true);
    const reveal = inward.filter(sample => sample.bridge?.targetDetail === 'code');
    expect(reveal[0]!.bridge).toMatchObject({ startZoom: code.startZoom, fullZoom: code.fullZoom });
    expect(new Set(reveal.map(sample => sample.bridge!.progress).filter(progress => progress > 0 && progress < 1)).size).toBeGreaterThanOrEqual(3);
    expect(inward.at(-1)).toMatchObject({ detail: 'code' });
    // The phone's bands hold too: back out, the files stay until the phone's own interval.
    const outward = await pinchThrough(1.62, 1.01);
    expect(outward.at(-1)).toMatchObject({ detail: 'component', root: focusId });
  });
});

it('a desktop at 1024x768 with the inspector open measures what main measures (safe width 549)', async () => {
  touchPrimary = false;
  // The inspector is a 360px grid column there, beside a 664px map; rail and toggle leave 549.
  mapWidth = 664; mapHeight = 700; windowWidth = 1024; insets = { left: 56, right: 59 };
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: mapWidth / mapHeight });
  await mountRootOver(containerCentre());
  expect(panelOpen()).toBe(true);
  const inward = await pinchThrough(4.6, 1.01);
  const expansion = inward.find(sample => sample.bridge?.targetDetail === 'component')!;
  expect(expansion.bridge!.startZoom).toBeGreaterThanOrEqual(3.35);
  expect(expansion.bridge!.fullZoom).toBeCloseTo(expansion.bridge!.startZoom * 1.2, 6);
  // Main's code window at safe width 549: arm 2.983643, so start 3.390504 and full 4.068605.
  const reveal = inward.find(sample => sample.bridge?.targetDetail === 'code')!;
  expect(reveal.bridge!.startZoom).toBeCloseTo(3.390504, 5);
  expect(reveal.bridge!.fullZoom).toBeCloseTo(4.068605, 5);
});

it('a narrow desktop window (860 wide, mouse) is still measured under the panel, exactly as on main', async () => {
  // Not a phone, so nothing here may change. On main the open panel's sheet narrows the
  // measured map to its floor and the code window collapses with it (0.494 -> 0.593): a
  // settled container view then opens a file's code. That is main's behaviour, pinned so
  // the phone-only rule cannot leak onto it; it is not a behaviour to keep for its own sake.
  touchPrimary = false;
  mapWidth = 860; mapHeight = 700; insets = { left: 56, right: 47 };
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: mapWidth / mapHeight });
  await mountRootOver(containerCentre());
  expect(panelOpen()).toBe(false);
  await pinchThrough(4.2, 1.01);
  await rest();
  expect(diagnostic()).toMatchObject({ currentDetail: 'component', sceneRoot: focusId, bridge: { targetDetail: 'component', progress: 1 } });
  await toggleDetails();
  await pan(4);
  await rest();
  expect(diagnostic().bridge).toMatchObject({ targetDetail: 'code' });
  expect(diagnostic().bridge.startZoom).toBeCloseTo(0.494062, 5);
  expect(diagnostic().bridge.fullZoom).toBeCloseTo(0.592875, 5);
});

it('a device that is not a phone does not measure the map for the expansion factor', async () => {
  touchPrimary = false;
  await mountRootOver(containerCentre());
  // The container level on desktop: no handoff is due anywhere in this stretch.
  await pinchThrough(1.6);
  expect(detail()).toBe('container');
  const before = safeWidthReads;
  const samples = await pinchThrough(2.6);
  expect(samples.every(sample => sample.detail === 'container' && sample.bridge === null)).toBe(true);
  // What is left is main's own one measurement per sample for the code window (the map's
  // rect is read for its width and again inside the safe-area measurement, per frame too).
  expect((safeWidthReads - before) / samples.length).toBe(6);
});

it('a device that is not a phone does not measure the map when a cold container view starts contracting', async () => {
  touchPrimary = false;
  const bounds = semanticBounds(fixture.createScene(focusId), focusId, 'component')!;
  await mount(`/?fixture=scan&backend=canvas2d&root=${encodeURIComponent(focusId)}&sel=${encodeURIComponent(focusId)}&detail=context&lens=system%3Aokie&lens=${encodeURIComponent(focusId)}&cx=${bounds.x + bounds.width / 2}&cy=${bounds.y + bounds.height / 2}&z=3.8`);
  await frame();
  expect(captured.camera.zoom).toBeCloseTo(3.8, 3);
  expect(detail()).toBe('component');
  const reads: number[] = [];
  const samples: Sample[] = [];
  while (captured.camera.zoom > 3.2) {
    const before = safeWidthReads;
    samples.push(...await pinchThrough(captured.camera.zoom / 1.02));
    reads.push(safeWidthReads - before);
  }
  // The contraction was prepared and published on the first outward sample ...
  expect(samples.every(sample => sample.bridge?.sourceDetail === 'container' && sample.bridge.targetDetail === 'component')).toBe(true);
  expect(samples.at(-1)!.bridge!.progress).toBeLessThan(1);
  // ... whose only reads of the map are the scene request's own; publishing the bridge adds none.
  expect(reads[0]).toBe(3);
  expect(reads.slice(1).every(count => count === 0)).toBe(true);
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

it('a phone too narrow to scale (safe width 272) is still measured under the open panel, exactly as on main', async () => {
  // Under the 272.07 limit a phone falls back to main on every path, the panel included:
  // main measures the map beside the sheet, and the code window collapses with it.
  insets = { left: 56, right: 62 };
  sessionStorage.setItem(MOBILE_NOTICE_SESSION_KEY, '1');
  await mountRootOver(containerCentre());
  await pinchThrough(2.0);
  await rest();
  await toggleDetails();
  expect(panelOpen()).toBe(true);
  await rest();
  const inward = await pinchThrough(4.4);
  // Main's thresholds: nothing opens before 3.35 ...
  const expansion = inward.find(sample => sample.bridge?.targetDetail === 'component')!;
  expect(expansion.bridge!.startZoom).toBeGreaterThanOrEqual(3.35);
  // ... and the code window is the one main derives from the panel-reduced width, not from 272.
  const reveal = inward.find(sample => sample.bridge?.targetDetail === 'code')!;
  expect(reveal.bridge!.startZoom).toBeCloseTo(0.494062, 5);
  expect(reveal.bridge!.fullZoom).toBeCloseTo(0.592875, 5);
});
