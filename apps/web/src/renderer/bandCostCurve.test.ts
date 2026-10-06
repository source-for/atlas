import { describe, expect, it, vi } from 'vitest';
import {
  BAND_COST_PREFETCH_CODE_CHILDREN,
  C4_ZOOM_BANDS,
  SCOPED_CODE_COMPILE,
  SCOPED_COMPONENT_COMPILE,
  denseNeighborhoodSnapshot,
  medianMs,
} from '@okie/scene-compiler';
import { Canvas2DRenderer } from './Canvas2DRenderer';
import { createC4Scene } from './goldenC4Scene';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './scanFixture';
import type { AtlasScene, Camera, RenderState } from './types';

function fakeCanvas() {
  const values: Record<PropertyKey, unknown> = {};
  const calls = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const context = new Proxy(values, {
    get(target, property) {
      if (property in target) return target[property];
      const call = calls.get(property) ?? vi.fn();
      calls.set(property, call);
      return call;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    canvas: { width: 0, height: 0, style: {}, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement,
  };
}

const state: RenderState = {
  focusedIds: new Set(),
  activeRelationIds: new Set(),
  flowRelationIds: new Set(),
  reduceMotion: true,
  animate: false,
  visibilityMode: 'all',
};

function neighborhoodScene(band: 'component' | 'code', childCount: number): AtlasScene {
  const snapshot = denseNeighborhoodSnapshot(band, childCount);
  const options = band === 'component' ? SCOPED_COMPONENT_COMPILE : SCOPED_CODE_COMPILE;
  const focus = band === 'component'
    ? { rootEntityId: 'system:d', focusEntityId: 'container:c' }
    : { rootEntityId: 'system:d', focusEntityId: 'component:c' };
  return createC4Scene({
    baseSnapshot: snapshot,
    familyId: 'f',
    sceneId: `band-cost:${band}:${childCount}`,
    title: 'band-cost',
    subtitle: '',
    frozenRevision: 'c',
    ...focus,
    ...options,
  });
}

function cameraFor(scene: AtlasScene, zoom: number): Camera {
  const entities = scene.entities;
  const minX = Math.min(...entities.map(entity => entity.x));
  const minY = Math.min(...entities.map(entity => entity.y));
  const maxX = Math.max(...entities.map(entity => entity.x + entity.width));
  const maxY = Math.max(...entities.map(entity => entity.y + entity.height));
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
}

function measureCanvasFrames(scene: AtlasScene, zoom: number) {
  const { canvas } = fakeCanvas();
  const renderer = new Canvas2DRenderer(canvas, 'canvas2d');
  renderer.resize(1280, 720, 1);
  renderer.setScene(scene);
  renderer.setRenderState(state);
  const fitted = cameraFor(scene, zoom);
  renderer.setCamera(fitted);
  const firstFrameMs = medianMs(() => renderer.render(0), 5, 1);
  const panMs = medianMs(() => {
    renderer.setCamera({ ...fitted, x: fitted.x + 80, y: fitted.y + 40 });
    renderer.render(16);
  }, 5, 1);
  const zoomMs = medianMs(() => {
    renderer.setCamera({ ...fitted, zoom: zoom * 1.25 });
    renderer.render(32);
  }, 5, 1);
  const diagnostics = renderer.diagnostics();
  renderer.dispose();
  return { firstFrameMs, panMs, zoomMs, visibleEntities: diagnostics.visibleEntities };
}

describe('CLA-67 Canvas2D per-band frame cost', () => {
  it('does not change the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('keeps a healthy 50-child component band interactive on the CPU paint path', () => {
    const scene = neighborhoodScene('component', 50);
    const zoom = C4_ZOOM_BANDS.find(band => band.detail === 'component')!.focusZoom;
    const frames = measureCanvasFrames(scene, zoom);
    expect(frames.visibleEntities).toBeGreaterThan(0);
    expect(frames.firstFrameMs).toBeLessThan(50);
    expect(frames.panMs).toBeLessThan(50);
    expect(frames.zoomMs).toBeLessThan(50);
  });

  it('Open inside / one-down prefetch of 25 code children stays cheaper than compiling a 50-child parent band', () => {
    // Fastest of three interleaved compiles each: since CLA-385 both take tens of ms, so one
    // GC pause in a single sample could flip the comparison without the costs changing.
    let parentCompileMs = Number.POSITIVE_INFINITY;
    let prefetchCompileMs = Number.POSITIVE_INFINITY;
    let prefetchScene!: ReturnType<typeof neighborhoodScene>;
    for (let sample = 0; sample < 3; sample += 1) {
      const parentStarted = performance.now();
      neighborhoodScene('component', 50);
      parentCompileMs = Math.min(parentCompileMs, performance.now() - parentStarted);
      const prefetchStarted = performance.now();
      prefetchScene = neighborhoodScene('code', BAND_COST_PREFETCH_CODE_CHILDREN);
      prefetchCompileMs = Math.min(prefetchCompileMs, performance.now() - prefetchStarted);
    }
    const zoom = C4_ZOOM_BANDS.find(band => band.detail === 'code')!.focusZoom;
    const frames = measureCanvasFrames(prefetchScene, zoom);
    expect(prefetchCompileMs).toBeLessThan(parentCompileMs);
    expect(frames.firstFrameMs).toBeLessThan(50);
  });
});
