import { afterEach, expect, it, vi } from 'vitest';
import type { AtlasScene, RenderState } from './types';

const native = vi.hoisted(() => ({
  setScene: vi.fn(), applyPatch: vi.fn(), setVisibility: vi.fn(), setReducedMotion: vi.fn(), setProjectionOverride: vi.fn(),
  setTimeline: vi.fn(), clearTimeline: vi.fn(), setTimelinePlaying: vi.fn(), setTimelinePosition: vi.fn(), pick: vi.fn(),
  visibleScene: vi.fn(), lodState: vi.fn(), pauseTimeline: vi.fn(), playTimeline: vi.fn(),
}));
vi.mock('../../../../crates/atlas-wasm/pkg/atlas_wasm.js', () => ({ default: vi.fn(async () => undefined), createAtlasRenderer: vi.fn(async () => native) }));
afterEach(() => { vi.clearAllMocks(); });

function scene(objectIds: string[], pathIds: string[], revision = 1, protocolPatch?: unknown): AtlasScene {
  return {
    id: `scene-${revision}`, ...(protocolPatch ? { protocolPatch } : {}), entities: [], relations: [], regions: [],
    protocolSnapshot: { sceneId: 'scene', revision, objects: objectIds.map(id => ({ id })), paths: pathIds.map(id => ({ id })) },
    projection: {
      semanticToVisualEntityId: { 'file:a': 'visual-node:file:a', 'code:gone': 'visual-node:code:gone' },
      visualToSemanticEntityId: { 'visual-node:file:a': 'file:a' },
      semanticToVisualRelationIds: { 'rel:kept': ['visual-edge:kept'], 'rel:gone': ['visual-edge:gone'] },
      visualToSemanticRelationIds: {},
    },
  } as unknown as AtlasScene;
}
const state = (overrides: Partial<RenderState>): RenderState => ({
  selectedId: undefined, focusedIds: new Set<string>(), activeRelationIds: new Set<string>(), flowRelationIds: new Set<string>(), visibilityMode: 'dim', reduceMotion: true, animate: false,
  ...overrides,
} as RenderState);

it('drops focus and selection ids the native scene does not hold instead of failing the filter (CLA-401)', async () => {
  const { WasmRendererAdapter } = await import('./WasmRendererAdapter');
  const adapter = await WasmRendererAdapter.create({} as HTMLCanvasElement, 'webgpu');
  adapter.setScene(scene(['visual-node:file:a'], ['visual-edge:kept']));
  // A code symbol stays selected after its object left the scene.
  adapter.setRenderState(state({ selectedId: 'code:gone', focusedIds: new Set(['file:a']), activeRelationIds: new Set(['rel:kept', 'rel:gone']) }));
  expect(native.setVisibility).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    object_ids: ['visual-node:file:a'],
  }));
  expect(JSON.stringify(native.setVisibility.mock.calls)).not.toContain('gone');
  expect(JSON.stringify([native.setTimeline.mock.calls, native.setVisibility.mock.calls])).not.toContain('visual-edge:gone');
});

it('answers queries before the first scene without calling the engine', async () => {
  const { WasmRendererAdapter } = await import('./WasmRendererAdapter');
  const adapter = await WasmRendererAdapter.create({} as HTMLCanvasElement, 'webgl2');
  const refuse = () => { throw new Error('setScene must be called first'); };
  native.pick.mockImplementation(refuse); native.visibleScene.mockImplementation(refuse); native.lodState.mockImplementation(refuse);
  expect(adapter.pick(10, 10)).toBeUndefined();
  expect(adapter.visibleScene()).toEqual({ objectIds: [], relationIds: [] });
  expect(adapter.lodState()).toBeUndefined();
  expect(native.pick).not.toHaveBeenCalled();
  expect(native.visibleScene).not.toHaveBeenCalled();
  expect(native.lodState).not.toHaveBeenCalled();
});

it('applies a patch only when it starts from the scene the engine holds', async () => {
  const { WasmRendererAdapter } = await import('./WasmRendererAdapter');
  const adapter = await WasmRendererAdapter.create({} as HTMLCanvasElement, 'webgpu');
  adapter.setScene(scene(['a', 'b'], ['p'], 3));
  expect(native.setScene).toHaveBeenCalledTimes(1);
  // Compiled against a revision-1 scene the engine no longer holds.
  adapter.setScene(scene(['a', 'c'], ['p'], 2, { baseRevision: 1, revision: 2, upsertObjects: [{ id: 'c' }], removeObjectIds: ['b'] }));
  expect(native.applyPatch).not.toHaveBeenCalled();
  expect(native.setScene).toHaveBeenCalledTimes(2);
  // Same base revision, but a sibling base: the patch would leave 'c' behind and never add 'b'.
  adapter.setScene(scene(['a', 'b', 'd'], ['p'], 3, { baseRevision: 2, revision: 3, upsertObjects: [{ id: 'd' }], removeObjectIds: [] }));
  expect(native.applyPatch).not.toHaveBeenCalled();
  expect(native.setScene).toHaveBeenCalledTimes(3);
  // A patch from the held scene applies.
  const patch = { baseRevision: 3, revision: 4, upsertObjects: [{ id: 'e' }], removeObjectIds: ['d'], upsertPaths: [{ id: 'q' }], removePathIds: ['p'] };
  adapter.setScene(scene(['a', 'b', 'e'], ['q'], 4, patch));
  expect(native.applyPatch).toHaveBeenCalledExactlyOnceWith(patch);
  expect(native.setScene).toHaveBeenCalledTimes(3);
});
