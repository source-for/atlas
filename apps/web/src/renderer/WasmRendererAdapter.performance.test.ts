import { afterEach, expect, it, vi } from 'vitest';
import type { AtlasScene } from './types';

const native = vi.hoisted(() => ({ setScene: vi.fn(), applyPatch: vi.fn() }));
const wasm = vi.hoisted(() => ({ init: vi.fn(async () => undefined), create: vi.fn(async () => native) }));
vi.mock('../../../../crates/atlas-wasm/pkg/atlas_wasm.js', () => ({ default: wasm.init, createAtlasRenderer: wasm.create }));
vi.mock('./protocolScene', () => ({ toProtocolScene: vi.fn((scene: AtlasScene) => ({ sceneId: scene.id })) }));
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

it('measures actual adapter startup once, separates failed GPU recovery and native patches', async () => {
  vi.resetModules();
  const { subscribeLoadTiming } = await import('../performance/loadTimings');
  const { WasmRendererAdapter } = await import('./WasmRendererAdapter');
  const samples: string[] = [];
  const stop = subscribeLoadTiming(metric => samples.push(metric));
  const failure = new Error('private backend failure');
  wasm.create.mockRejectedValueOnce(failure);
  try {
    await expect(WasmRendererAdapter.create({} as HTMLCanvasElement, 'webgpu')).rejects.toBe(failure);
    const adapter = await WasmRendererAdapter.create({} as HTMLCanvasElement, 'webgl2', 'webgpu');
    const scene = { id: 'first' } as AtlasScene;
    adapter.setScene(scene);
    adapter.setScene(scene);
    const patched = { id: 'next', protocolPatch: { privatePayload: 'not exported' } } as unknown as AtlasScene;
    adapter.setScene(patched);
    expect(native.setScene).toHaveBeenCalledExactlyOnceWith({ sceneId: 'first' });
    expect(native.applyPatch).toHaveBeenCalledExactlyOnceWith(patched.protocolPatch);
    expect(wasm.init).toHaveBeenCalledOnce();
    expect(samples).toEqual(['renderer-wasm-init', 'renderer-gpu-init-failed', 'renderer-gpu-init', 'renderer-protocol', 'renderer-native-scene', 'renderer-protocol', 'renderer-native-patch']);
    expect(JSON.stringify(samples)).not.toContain('private');
  } finally { stop(); }
});

it('emits no timing and reads no clock when diagnostics have no subscriber', async () => {
  vi.resetModules();
  const { subscribeLoadTiming } = await import('../performance/loadTimings');
  const { WasmRendererAdapter } = await import('./WasmRendererAdapter');
  const listener = vi.fn();
  const stop = subscribeLoadTiming(listener);
  stop();
  const clock = vi.spyOn(performance, 'now');
  const adapter = await WasmRendererAdapter.create({} as HTMLCanvasElement, 'webgpu');
  adapter.setScene({ id: 'first' } as AtlasScene);
  adapter.setScene({ id: 'next', protocolPatch: {} } as AtlasScene);
  expect(listener).not.toHaveBeenCalled();
  expect(clock).not.toHaveBeenCalled();
  expect(native.setScene).toHaveBeenCalledOnce();
  expect(native.applyPatch).toHaveBeenCalledOnce();
});
