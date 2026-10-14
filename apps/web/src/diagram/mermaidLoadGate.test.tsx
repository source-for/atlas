// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SOURCE = 'flowchart LR\n  a[A] --> b[B]';
type Observed = { callback: IntersectionObserverCallback; targets: Element[] };
let observers: Observed[];
let root: Root | undefined;
let host: HTMLDivElement;

// The first-frame latch and the gate are page-lifetime module state: each case gets a fresh graph.
async function load() {
  vi.resetModules();
  const diagram = await import('./MermaidDiagram');
  const gate = await import('./mermaidLoadGate');
  const timings = await import('../performance/loadTimings');
  const loader = vi.fn(async () => ({ default: { initialize: vi.fn(), render: async () => ({ svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><rect width="10" height="10"/></g></svg>', diagramType: 'flowchart' }) } }));
  diagram.setMermaidModuleLoaderForTests(loader);
  return { ...diagram, ...gate, ...timings, loader };
}
async function render(MermaidDiagram: typeof import('./MermaidDiagram')['MermaidDiagram']) {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(<MermaidDiagram compact source={SOURCE} title="Overview"/>); });
  await act(async () => { await Promise.resolve(); });
}
const state = () => host.querySelector('[data-render-state]')!.getAttribute('data-render-state');
async function flush() { for (let index = 0; index < 5; index += 1) await act(async () => { await Promise.resolve(); }); }
async function rendered() {
  for (let attempt = 0; attempt < 100 && state() === 'loading'; attempt += 1) await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  return state();
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  observers = [];
  vi.stubGlobal('IntersectionObserver', class {
    private readonly entry: Observed;
    constructor(callback: IntersectionObserverCallback) { this.entry = { callback, targets: [] }; observers.push(this.entry); }
    observe(target: Element) { this.entry.targets.push(target); }
    disconnect() { this.entry.targets = []; }
    unobserve() {}
  });
});
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; host?.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function intersect(isIntersecting: boolean) {
  for (const observer of observers) {
    if (!observer.targets.length) continue;
    observer.callback(observer.targets.map(target => ({ target, isIntersecting } as IntersectionObserverEntry)), {} as IntersectionObserver);
  }
}

describe('Mermaid load gate (CLA-584)', () => {
  it('imports nothing while held, then loads at the first map frame', async () => {
    const api = await load();
    api.holdMermaidUntilFirstFrame();
    await render(api.MermaidDiagram);
    intersect(false);
    await flush();
    expect(api.loader).not.toHaveBeenCalled();
    expect(state()).toBe('loading');
    await act(async () => { api.recordAtlasFirstFrame(); });
    await flush();
    expect(api.loader).toHaveBeenCalledTimes(1);
    // The render ran (happy-dom cannot take the SVG through DOMPurify to "ready"; the gate only owns the import).
    expect(await rendered()).not.toBe('loading');
  });

  it('loads on the fallback timer when no map frame comes', async () => {
    vi.useFakeTimers();
    const api = await load();
    api.holdMermaidUntilFirstFrame();
    await render(api.MermaidDiagram);
    await act(async () => { vi.advanceTimersByTime(api.MERMAID_FIRST_FRAME_FALLBACK_MS - 1); });
    expect(api.loader).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(1); });
    vi.useRealTimers();
    await flush();
    expect(api.loader).toHaveBeenCalledTimes(1);
  });

  it('loads on demand when the reader can see the diagram before the frame', async () => {
    const api = await load();
    api.holdMermaidUntilFirstFrame();
    await render(api.MermaidDiagram);
    expect(observers.some(observer => observer.targets.length)).toBe(true);
    expect(api.loader).not.toHaveBeenCalled();
    await act(async () => { intersect(true); });
    await flush();
    expect(api.loader).toHaveBeenCalledTimes(1);
    // The render ran (happy-dom cannot take the SVG through DOMPurify to "ready"; the gate only owns the import).
    expect(await rendered()).not.toBe('loading');
    expect(api.mermaidReleased()).toBe(true);
  });

  it('loads at once when nothing holds it (diagrams outside the atlas shell)', async () => {
    const api = await load();
    await render(api.MermaidDiagram);
    await flush();
    expect(api.loader).toHaveBeenCalledTimes(1);
  });

  it('stays released: a later hold does not defer diagrams again', async () => {
    const api = await load();
    api.holdMermaidUntilFirstFrame();
    api.releaseMermaid();
    api.holdMermaidUntilFirstFrame();
    expect(api.mermaidReleased()).toBe(true);
  });
});
