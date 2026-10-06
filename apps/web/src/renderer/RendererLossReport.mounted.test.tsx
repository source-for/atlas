// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Camera } from './types';

const control = vi.hoisted(() => ({ failSetCamera: undefined as Error | undefined, recovered: 0 }));
vi.mock('./createRenderer', () => {
  const session = (host: HTMLElement, kind: string, message: string, setCamera: (camera: Camera) => void) => {
    const canvas = document.createElement('canvas'); host.replaceChildren(canvas);
    return { canvas, renderer: { kind, setScene() {}, setCamera, setRenderState() {}, resize() {}, render() {}, pick() {}, visibleScene: () => ({ objectIds: [], relationIds: [] }), lodState() {}, diagnostics: () => ({ requestedBackend: 'auto', activeBackend: kind, gpuAccelerated: kind === 'webgpu', lastFrameMs: 0, message, entityCount: 0, relationCount: 0 }), dispose() {} } };
  };
  return {
    createRenderer: async (host: HTMLElement) => session(host, 'webgpu', '', () => { if (control.failSetCamera) throw control.failSetCamera; }),
    recoverRenderer: async (host: HTMLElement) => { control.recovered += 1; return session(host, 'canvas2d-preview', 'GPU surface lost (unreachable); WebGL2 recovery failed (module poisoned).', () => {}); },
  };
});
let root: Root;
let host: HTMLDivElement;
async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }
// happy-dom's WheelEvent omits MouseEvent fields; supply real browser fields.
function wheel(init: WheelEventInit) {
  const event = new WheelEvent('wheel', { ...init, bubbles: true, cancelable: true });
  for (const key of ['clientX', 'clientY', 'ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) Object.defineProperty(event, key, { value: init[key] ?? (key.endsWith('Key') ? false : 0) });
  return event;
}
beforeEach(async () => {
  control.failSetCamera = undefined; control.recovered = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  localStorage.clear(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mode: 'public', ask: false, connected: false }), { headers: { 'content-type': 'application/json' } })));
  let rafId = 0;
  vi.stubGlobal('requestAnimationFrame', () => ++rafId); vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => ++rafId);
  vi.stubGlobal('cancelAnimationFrame', () => {}); vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  vi.stubGlobal('ResizeObserver', class { constructor(private callback: ResizeObserverCallback) {} observe(element: Element) { this.callback([{ target: element, contentRect: { width: 1440, height: 900 } } as ResizeObserverEntry], this as unknown as ResizeObserver); } disconnect() {} unobserve() {} });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const map = this instanceof HTMLCanvasElement || this.getAttribute('data-testid') === 'atlas-canvas' || this.classList.contains('atlas-renderer-host');
    return new DOMRect(0, 0, map ? 1440 : 0, map ? 900 : 0);
  });
  window.history.replaceState(null, '', '/');
  const module = await import('../App');
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<module.App/>)); await settle(); await settle();
});
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('reports why the renderer was lost and what replaced it (CLA-401)', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const failure = new Error('unreachable');
  control.failSetCamera = failure;
  const canvas = host.querySelector('[data-testid="atlas-canvas"] canvas')!;
  await act(async () => canvas.dispatchEvent(wheel({ ctrlKey: true, deltaMode: 0, deltaY: -20, clientX: 720, clientY: 450 })));
  await settle(); await settle();
  expect(control.recovered).toBe(1);
  expect(error).toHaveBeenCalledWith('[atlas] webgpu renderer lost: unreachable', failure);
  expect(warn).toHaveBeenCalledWith('[atlas] renderer recovered on canvas2d-preview: GPU surface lost (unreachable); WebGL2 recovery failed (module poisoned).');
});
