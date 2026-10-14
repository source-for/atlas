// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, type ScanFixture } from '../renderer/scanFixture';
import { setActiveScanFixture } from '../renderer/fixtureBundle';
import type { NavigationHistoryController } from './historyController';

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

  it('still enriches a bare link straight away', async () => {
    const enrich = vi.spyOn(fixture, 'enrichInitialScene');
    await mount('');
    expect(enrich).toHaveBeenCalledTimes(1);
  });
});
