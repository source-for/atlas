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
import type { AtlasScene, Camera, RenderState } from '../renderer/types';
import { scanCodeRevealWindow } from './scanCodeRevealWindow';

const captured = vi.hoisted(() => ({ camera: { x: 0, y: 0, zoom: 1 } as Camera, state: undefined as RenderState | undefined, scene: undefined as AtlasScene | undefined, renderers: 0 }));
vi.mock('../renderer/createRenderer', () => ({
  createRenderer: async (host: HTMLElement) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    captured.renderers += 1;
    return { canvas, renderer: { kind: 'canvas2d', setScene(scene: AtlasScene) { captured.scene = scene; }, setCamera(camera: Camera) { captured.camera = { ...camera }; }, setRenderState(state: RenderState) { captured.state = state; }, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'canvas2d', activeBackend: 'canvas2d', gpuAccelerated: false, lastFrameMs: 0, message: '', entityCount: 0, relationCount: 0 }), dispose() {} } };
  }, recoverRenderer: vi.fn(),
}));
const FILE_A = 'component:web-navigation';
// In web-navigation's code scene only web-shell also has a code face; web-renderer-host does not.
const FILE_B = 'component:web-shell';
const FILE_WITHOUT_CODE_FACE = 'component:web-renderer-host';
let root: Root;
let host: HTMLDivElement;
let fixture: ScanFixture;
let rafFrames = new Map<number, FrameRequestCallback>();
let rafId = 100000;
let reveal: NonNullable<ReturnType<typeof scanCodeRevealWindow>>;
let bounds: NonNullable<ReturnType<typeof semanticBounds>>;
const mapWidth = 1440;
const mapHeight = 900;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
// The first mount also imports the App module, which alone can pass 5s on a loaded machine.
vi.setConfig({ testTimeout: 20_000 });
async function mount(url: string) {
  window.history.replaceState(null, '', url);
  setActiveScanFixture(fixture);
  const module = await import('../App'); module.refreshAppScanFixture();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
}
function shell() { return host.querySelector('[data-testid="atlas-app"]')!; }
function containerUrl(x: number, y: number, zoom: number) {
  return `/?fixture=scan&backend=canvas2d&root=container%3Aweb-app&sel=component%3Aweb-navigation&detail=context&lens=system%3Aokie&lens=container%3Aweb-app&cx=${x}&cy=${y}&z=${zoom}`;
}
beforeEach(() => {
  captured.scene = undefined; captured.renderers = 0;
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
  vi.spyOn(HTMLElement.prototype, 'setPointerCapture').mockImplementation(() => {});
  fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: 1440 / 900 });
  bounds = semanticBounds(fixture.createScene('container:web-app'), FILE_A, 'component')!;
  reveal = scanCodeRevealWindow(bounds)!;
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); setActiveScanFixture(undefined); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function idle() {
  let clock = performance.now();
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  for (let round = 0; round < 4; round++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(240); }); await settle();
    clock += 400;
    const frames = [...rafFrames.values()]; rafFrames.clear();
    await act(async () => { for (const callback of frames) callback(clock); }); await settle();
  }
}

/** What each of the four places says the reader is on. */
function claims() {
  const url = new URL(window.location.href).searchParams;
  const current = host.querySelector('.semantic-breadcrumb [aria-current="page"]')?.textContent ?? null;
  const name = (id: string | null | undefined) => captured.scene?.entities.find(entity => entity.id === id)?.name ?? null;
  return {
    urlRoot: url.get('root'),
    urlLens: url.getAll('lens'),
    lensOwner: url.getAll('lens').at(-1) ?? null,
    navigationRoot: shell().getAttribute('data-root-entity-id'),
    breadcrumb: current,
    sceneRoot: captured.scene?.rootEntityId ?? null,
    sceneRootName: name(captured.scene?.rootEntityId),
    detail: shell().getAttribute('data-detail'),
  };
}

function centreOf(box: { x: number; y: number; width: number; height: number }) { return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
function screenPoint(world: { x: number; y: number }) {
  return { x: mapWidth / 2 + (world.x - captured.camera.x) * captured.camera.zoom, y: mapHeight / 2 + (world.y - captured.camera.y) * captured.camera.zoom };
}
/** Centre of a file's L3 card in the scene on screen now. */
function cardCentre(id: string) { return centreOf(semanticBounds(captured.scene!, id, 'component')!); }
function onFile(id: string) {
  const name = captured.scene!.entities.find(entity => entity.id === id)!.name;
  return { urlRoot: id, lensOwner: id, navigationRoot: id, sceneRoot: id, breadcrumb: name, sceneRootName: name, detail: 'code' };
}

/** Mouse-drag the map so the world point lands on the map centre, then release. */
async function dragToCentre(world: { x: number; y: number }, steps = 6) {
  const surface = host.querySelector<HTMLElement>('[data-testid="atlas-canvas"]')!;
  const from = screenPoint(world);
  const dx = mapWidth / 2 - from.x;
  const dy = mapHeight / 2 - from.y;
  const pointer = (type: string, x: number, y: number) => act(async () => {
    surface.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', button: 0, clientX: x, clientY: y, bubbles: true }));
  });
  await pointer('pointerdown', 720, 450);
  for (let step = 1; step <= steps; step++) await pointer('pointermove', 720 + dx * step / steps, 450 + dy * step / steps);
  await pointer('pointerup', 720 + dx, 450 + dy);
  await settle();
}

/** Two-finger trackpad scroll that brings the world point to the map centre. */
async function scrollToCentre(world: { x: number; y: number }, steps = 5) {
  const canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
  const from = screenPoint(world);
  let time = 0;
  for (let step = 0; step < steps; step++) {
    const init = { deltaMode: 0, deltaX: (from.x - mapWidth / 2) / steps, deltaY: (from.y - mapHeight / 2) / steps, clientX: 720, clientY: 450 };
    const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true });
    // happy-dom's WheelEvent omits MouseEvent fields; supply real browser fields.
    for (const key of ['clientX', 'clientY'] as const) Object.defineProperty(event, key, { value: init[key] });
    for (const key of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) Object.defineProperty(event, key, { value: false });
    Object.defineProperty(event, 'timeStamp', { value: time += 16 });
    await act(async () => canvas.dispatchEvent(event));
  }
  await settle();
}

async function openFileA() {
  await mount(containerUrl(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, reveal.fullZoom * 1.05));
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  // The premise of every test here: which sibling files have a code face in this scene.
  expect(semanticBounds(captured.scene!, FILE_B, 'code')).toBeDefined();
  expect(semanticBounds(captured.scene!, FILE_WITHOUT_CODE_FACE, 'code')).toBeUndefined();
}

/** The camera the URL (and so the current history entry) records. */
function urlCamera() {
  const url = new URL(window.location.href).searchParams;
  return { x: Number(url.get('cx')), y: Number(url.get('cy')), zoom: Number(url.get('z')) };
}
function expectCamera(actual: Camera, expected: Camera) {
  expect(actual.x).toBeCloseTo(expected.x, 1);
  expect(actual.y).toBeCloseTo(expected.y, 1);
  expect(actual.zoom).toBeCloseTo(expected.zoom, 3);
}

/** Hold every scene compile until released, as a busy worker would. */
function holdCompiles() {
  const real = fixture.createSceneAsync.bind(fixture);
  const waiting: Array<() => void> = [];
  const compile = vi.spyOn(fixture, 'createSceneAsync').mockImplementation(async (...args: Parameters<typeof real>) => {
    await new Promise<void>(done => waiting.push(done));
    return real(...args);
  });
  return { compile, release: async () => { await act(async () => { for (const done of waiting.splice(0)) done(); }); await settle(); } };
}

it('re-roots on the other file after a drag-pan onto it at L4, without moving it or replacing the renderer', async () => {
  await openFileA();
  const entries = window.history.length;
  await dragToCentre(cardCentre(FILE_B));
  // The pan itself has finished; the lens settle is still 160 ms away.
  const landed = screenPoint(cardCentre(FILE_B));
  expect(landed.x).toBeCloseTo(720, 3); expect(landed.y).toBeCloseTo(450, 3);
  const frame = screenPoint(semanticBounds(captured.scene!, FILE_B, 'component')!);
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
  expect(claims().urlLens).toEqual(['system:okie', 'container:web-app', FILE_B]);
  const face = screenPoint(semanticBounds(captured.scene!, FILE_B, 'code')!);
  expect(Math.abs(face.x - frame.x)).toBeLessThan(1);
  expect(Math.abs(face.y - frame.y)).toBeLessThan(1);
  expect(captured.camera.zoom).toBeCloseTo(reveal.fullZoom * 1.05, 3);
  expect(captured.renderers).toBe(1);
  expect(window.history.length).toBe(entries + 1);
});

it('re-roots after a trackpad scroll-pan onto the other file', async () => {
  await openFileA();
  await scrollToCentre(cardCentre(FILE_B));
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
});

it('stays on the first file until the other file is ready, then moves everything at once', async () => {
  await openFileA();
  const held = holdCompiles();
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  expect(held.compile.mock.calls.some(call => call[0] === FILE_B)).toBe(true);
  expect(claims()).toMatchObject(onFile(FILE_A));
  expect(claims().urlLens).toEqual(['system:okie', 'container:web-app', FILE_A]);
  await held.release(); await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
});

it('drops a pending file change when the reader pans on to empty space', async () => {
  await openFileA();
  const entries = window.history.length;
  const held = holdCompiles();
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  expect(held.compile.mock.calls.some(call => call[0] === FILE_B)).toBe(true);
  const container = semanticBounds(captured.scene!, 'container:web-app', 'component')!;
  await dragToCentre({ x: container.x - container.width * 4, y: container.y - container.height * 4 });
  const reached = { ...captured.camera };
  await idle();
  await held.release(); await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  expect(window.history.length).toBe(entries);
  expectCamera(urlCamera(), reached);
});

it('never leaves the four disagreeing when the reader zooms while the other file is being prepared', async () => {
  await openFileA();
  for (const factor of [1.04, 0.5]) {
    const held = holdCompiles();
    await dragToCentre(cardCentre(FILE_B));
    await idle();
    const canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
    const event = new WheelEvent('wheel', { deltaMode: 0, deltaY: -Math.log(factor) / .01, bubbles: true, cancelable: true });
    for (const [key, value] of Object.entries({ clientX: 720, clientY: 450, ctrlKey: true, metaKey: false, shiftKey: false, altKey: false, timeStamp: 16 })) Object.defineProperty(event, key, { value });
    await act(async () => canvas.dispatchEvent(event)); await settle();
    await held.release(); await idle();
    const after = claims();
    expect([after.urlRoot, after.navigationRoot, after.sceneRoot]).toEqual([after.sceneRoot, after.sceneRoot, after.sceneRoot]);
    if (after.detail === 'code') expect(after.lensOwner).toBe(after.sceneRoot);
    else expect(after.urlLens).not.toContain(FILE_B);
    held.compile.mockRestore();
    if (after.sceneRoot !== FILE_A) break;
  }
});

it('stays on the first file when the other file cannot be prepared', async () => {
  await openFileA();
  const entries = window.history.length;
  const real = fixture.createSceneAsync.bind(fixture);
  vi.spyOn(fixture, 'createSceneAsync').mockImplementation(async (...args: Parameters<typeof real>) => {
    if (args[0] === FILE_B) throw new Error('compile failed');
    return real(...args);
  });
  await dragToCentre(cardCentre(FILE_B));
  const reached = { ...captured.camera };
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  expect(window.history.length).toBe(entries);
  expectCamera(urlCamera(), reached);
});

it('changes nothing on a pan to empty space', async () => {
  await openFileA();
  const entries = window.history.length;
  const container = semanticBounds(captured.scene!, 'container:web-app', 'component')!;
  await dragToCentre({ x: container.x - container.width * 4, y: container.y - container.height * 4 });
  const reached = { ...captured.camera };
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  expect(window.history.length).toBe(entries);
  expectCamera(urlCamera(), reached);
});

it('changes nothing on a pan onto a file that has no code face in this scene', async () => {
  await openFileA();
  const entries = window.history.length;
  const compile = vi.spyOn(fixture, 'createSceneAsync');
  await dragToCentre(cardCentre(FILE_WITHOUT_CODE_FACE));
  const reached = { ...captured.camera };
  await idle();
  expectCamera(urlCamera(), reached);
  expect(claims()).toMatchObject(onFile(FILE_A));
  expect(claims().urlLens).toEqual(['system:okie', 'container:web-app', FILE_A]);
  expect(compile.mock.calls.filter(call => call[0] === FILE_WITHOUT_CODE_FACE)).toEqual([]);
  expect(window.history.length).toBe(entries);
});

it('pans back to the first file, and Back steps through both file changes', async () => {
  await openFileA();
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
  await dragToCentre(cardCentre(FILE_A));
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  await act(async () => window.history.back()); await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
  await act(async () => window.history.back()); await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  // Forward is not covered here: happy-dom drops forward entries on replaceState, which
  // the app calls after every restore. A real browser keeps them.
});

it('restores the same file from the URL the pan left behind', async () => {
  await openFileA();
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  const url = window.location.pathname + window.location.search;
  const before = claims();
  const camera = { ...captured.camera };
  await act(async () => root.unmount()); host.remove();
  captured.scene = undefined;
  await mount(url);
  await idle();
  expect(claims()).toEqual(before);
  expect(captured.camera.x).toBeCloseTo(camera.x, 3);
  expect(captured.camera.y).toBeCloseTo(camera.y, 3);
  expect(captured.camera.zoom).toBeCloseTo(camera.zoom, 3);
});

it('keeps the file frame\'s top-left where it was when the other file\'s scene lays it out elsewhere', async () => {
  await openFileA();
  const real = fixture.createSceneAsync.bind(fixture);
  // The demo fixture puts a file's code frame within 1 px of its L3 card; move and resize it.
  vi.spyOn(fixture, 'createSceneAsync').mockImplementation(async (...args: Parameters<typeof real>) => {
    const scene = await real(...args);
    if (args[0] !== FILE_B) return scene;
    const moved = structuredClone(scene);
    const code = moved.projection!.boundsByEntityIdAndDetail[FILE_B]!.code!;
    moved.projection!.boundsByEntityIdAndDetail[FILE_B]!.code = { ...code, x: code.x + 40, y: code.y - 30, width: code.width * .8, height: code.height * 1.3 };
    return moved;
  });
  await dragToCentre(cardCentre(FILE_B));
  const frame = screenPoint(semanticBounds(captured.scene!, FILE_B, 'component')!);
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
  const component = semanticBounds(captured.scene!, FILE_B, 'component')!;
  const code = semanticBounds(captured.scene!, FILE_B, 'code')!;
  expect(Math.abs(centreOf(code).x - centreOf(component).x)).toBeGreaterThan(20);
  const face = screenPoint(code);
  expect(Math.abs(face.x - frame.x)).toBeLessThan(1);
  expect(Math.abs(face.y - frame.y)).toBeLessThan(1);
  expect(captured.renderers).toBe(1);
});

it('Back returns to the first file at the camera the pan began from, and a reload there shows the same', async () => {
  await openFileA();
  const before = { ...captured.camera };
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
  await act(async () => window.history.back()); await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  expectCamera(captured.camera, before);
  expectCamera(urlCamera(), before);
  const url = window.location.pathname + window.location.search;
  const restored = claims();
  await act(async () => root.unmount()); host.remove();
  captured.scene = undefined;
  await mount(url);
  await idle();
  expect(claims()).toEqual(restored);
  expectCamera(captured.camera, before);
  // Forward is not covered here (see the Back test above); QA covers it in a browser.
});

it('counts drags that end within the lens settle as one pan, from where the first began', async () => {
  await openFileA();
  const before = { ...captured.camera };
  const target = cardCentre(FILE_B);
  await dragToCentre({ x: (before.x + target.x) / 2, y: (before.y + target.y) / 2 });
  await dragToCentre(target);
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
  await act(async () => window.history.back()); await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  expectCamera(captured.camera, before);
});

it('after a settled pan to empty space, Back from the other file returns to that empty space', async () => {
  await openFileA();
  const container = semanticBounds(captured.scene!, 'container:web-app', 'component')!;
  await dragToCentre({ x: container.x - container.width * 4, y: container.y - container.height * 4 });
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  const settled = { ...captured.camera };
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
  await act(async () => window.history.back()); await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  expectCamera(captured.camera, settled);
});

it('drops a pending file change as soon as the reader starts another pan, before that pan settles', async () => {
  for (const pan of [dragToCentre, scrollToCentre]) {
    await openFileA();
    const entries = window.history.length;
    const held = holdCompiles();
    await dragToCentre(cardCentre(FILE_B));
    await idle();
    expect(held.compile.mock.calls.some(call => call[0] === FILE_B)).toBe(true);
    const container = semanticBounds(captured.scene!, 'container:web-app', 'component')!;
    await pan({ x: container.x - container.width * 4, y: container.y - container.height * 4 });
    // The compile lands inside the new pan's 160 ms settle window.
    await held.release();
    expect(claims()).toMatchObject(onFile(FILE_A));
    expect(window.history.length).toBe(entries);
    await idle();
    expect(claims()).toMatchObject(onFile(FILE_A));
    expect(window.history.length).toBe(entries);
    held.compile.mockRestore();
    await act(async () => root.unmount()); host.remove();
  }
});

it('a click that cancels a pending lens settle ends that pan: Back returns to where it stopped', async () => {
  await openFileA();
  const before = { ...captured.camera };
  const target = cardCentre(FILE_B);
  await dragToCentre({ x: (before.x + target.x) / 2, y: (before.y + target.y) / 2 });
  const stopped = { ...captured.camera };
  // A click inside the 160 ms lens settle: pointer down and up with no move.
  const surface = host.querySelector<HTMLElement>('[data-testid="atlas-canvas"]')!;
  for (const type of ['pointerdown', 'pointerup']) {
    await act(async () => { surface.dispatchEvent(new PointerEvent(type, { pointerId: 8, pointerType: 'mouse', button: 0, clientX: 720, clientY: 450, bubbles: true })); });
  }
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  expect(claims()).toMatchObject(onFile(FILE_B));
  await act(async () => window.history.back()); await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  expectCamera(captured.camera, stopped);
});

it('drops a pending file change when the reader presses Fit while it is prepared', async () => {
  await openFileA();
  const entries = window.history.length;
  const held = holdCompiles();
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  expect(held.compile.mock.calls.some(call => call[0] === FILE_B)).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Fit architecture to view"]')!.click()); await settle();
  const fitted = { ...captured.camera };
  await held.release(); await idle();
  expect(claims()).toMatchObject(onFile(FILE_A));
  expect(window.history.length).toBe(entries);
  expectCamera(captured.camera, fitted);
  expectCamera(urlCamera(), fitted);
});

it('drops a pending file change when the reader presses a zoom button while it is prepared', async () => {
  await openFileA();
  const held = holdCompiles();
  await dragToCentre(cardCentre(FILE_B));
  await idle();
  expect(held.compile.mock.calls.some(call => call[0] === FILE_B)).toBe(true);
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Zoom out"]')!.click()); await settle();
  await held.release(); await idle();
  const after = claims();
  expect([after.urlRoot, after.navigationRoot, after.sceneRoot, after.lensOwner]).not.toContain(FILE_B);
  expect(after.urlLens).not.toContain(FILE_B);
  expect([after.urlRoot, after.navigationRoot]).toEqual([after.sceneRoot, after.sceneRoot]);
});
