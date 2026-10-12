import { afterEach, expect, it, vi } from 'vitest';
import type { AtlasScene, RenderState } from './types';

const native = vi.hoisted(() => ({
  setScene: vi.fn(), applyPatch: vi.fn(), setVisibility: vi.fn(), setReducedMotion: vi.fn(), setProjectionOverride: vi.fn(),
  setTimeline: vi.fn(), pick: vi.fn(), visibleScene: vi.fn(), lodState: vi.fn(), setCamera: vi.fn(),
  pauseTimeline: vi.fn(), playTimeline: vi.fn(), seekTimeline: vi.fn(), setProjectionProgress: vi.fn(),
}));
vi.mock('../../../../crates/atlas-wasm/pkg/atlas_wasm.js', () => ({ default: vi.fn(async () => undefined), createAtlasRenderer: vi.fn(async () => native) }));
afterEach(() => { vi.clearAllMocks(); });

type SentTimeline = { durationMs: number; keyframes: Array<{ id: string; atMs: number; objectStates: unknown[]; pathStates: unknown[] }> };
const scene = {
  id: 'scene-1', entities: [], relations: [], regions: [],
  protocolSnapshot: { sceneId: 'scene', revision: 1, objects: [{ id: 'visual-node:from' }, { id: 'visual-node:to' }], paths: [{ id: 'visual-edge:to' }] },
  projection: {
    semanticToVisualEntityId: { from: 'visual-node:from', to: 'visual-node:to' },
    visualToSemanticEntityId: {},
    semanticToVisualRelationIds: { 'rel:to': ['visual-edge:to'] },
    visualToSemanticRelationIds: {},
  },
} as unknown as AtlasScene;
const flight = (durationMs: number, positionMs = 0): RenderState => ({
  selectedId: undefined, focusedIds: new Set<string>(), activeRelationIds: new Set<string>(), flowRelationIds: new Set<string>(), visibilityMode: 'dim', reduceMotion: false, animate: false,
  cinematicTransition: { id: 'flight', positionMs, durationMs, visualProgress: 0, departureProgress: 0, sourceFocusedIds: ['from'], targetFocusedIds: ['to'], sourceRelationIds: [], targetRelationIds: ['rel:to'] },
} as RenderState);
/** What crates/atlas-protocol/src/timeline.rs refuses about a timeline's length. */
function expectEngineAccepts(timeline: SentTimeline) {
  expect(Number.isInteger(timeline.durationMs)).toBe(true);
  expect(timeline.durationMs).toBeGreaterThan(0);
  timeline.keyframes.forEach((keyframe, index) => {
    expect(keyframe.atMs).toBeLessThanOrEqual(timeline.durationMs);
    if (index > 0) expect(keyframe.atMs).toBeGreaterThan(timeline.keyframes[index - 1]!.atMs);
  });
}

it.each([0, -200, Number.NaN, Number.POSITIVE_INFINITY, 0.4])('sends a transition of length %s as its target state, never as a timeline the engine refuses (CLA-544)', async durationMs => {
  const { WasmRendererAdapter } = await import('./WasmRendererAdapter');
  const adapter = await WasmRendererAdapter.create({} as HTMLCanvasElement, 'webgpu');
  adapter.setScene(scene);
  adapter.setRenderState(flight(durationMs, 700));
  expect(native.setTimeline).toHaveBeenCalledTimes(1);
  const timeline = native.setTimeline.mock.calls[0]![0] as SentTimeline;
  expectEngineAccepts(timeline);
  // Only the target focus is on the timeline, and the position sent is where it sits.
  expect(timeline.keyframes).toEqual([expect.objectContaining({
    id: 'flight-target', atMs: 0,
    objectStates: [expect.objectContaining({ objectIds: ['visual-node:to'] })],
    pathStates: [expect.objectContaining({ pathIds: ['visual-edge:to'] })],
  })]);
  expect(native.seekTimeline).toHaveBeenCalledExactlyOnceWith(0);
});

it('still sends a transition with a length from its source state to its target state', async () => {
  const { WasmRendererAdapter } = await import('./WasmRendererAdapter');
  const adapter = await WasmRendererAdapter.create({} as HTMLCanvasElement, 'webgpu');
  adapter.setScene(scene);
  adapter.setRenderState(flight(600, 250));
  const timeline = native.setTimeline.mock.calls[0]![0] as SentTimeline;
  expectEngineAccepts(timeline);
  expect(timeline.durationMs).toBe(600);
  expect(timeline.keyframes.map(keyframe => [keyframe.id, keyframe.atMs])).toEqual([
    ['flight-source', 0], ['flight-source-faded', 120], ['flight-focus-start', 400], ['flight-target', 600],
  ]);
  expect(native.seekTimeline).toHaveBeenCalledExactlyOnceWith(250);
});
