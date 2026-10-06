import { describe, expect, it } from 'vitest';
import { createZoomMotionTrace } from './zoomMotionTrace';

const metadata = {
  timeOrigin: 1_700_000_000_000,
  startedAtMs: 500,
  snapshotId: 'snapshot:demo',
  sceneId: 'scene:system',
  renderer: 'webgl2',
};

describe('zoom motion trace', () => {
  it('preserves raw timestamps while sequence records interleaved delivery order', () => {
    const trace = createZoomMotionTrace();
    trace.start(metadata);
    trace.recordFrame({ timeMs: 510, camera: { x: 1, y: 2, zoom: 1 } });
    trace.recordInput({
      timeMs: 505, deltaX: 0, deltaY: -18, deltaMode: 0, pointerX: 320, pointerY: 180,
      ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
      viewport: { width: 800, height: 600 }, devicePixelRatio: 2,
    });
    trace.recordFrame({ timeMs: 520, camera: { x: 3, y: 4, zoom: 1.1 }, projectionProgress: .25 });

    const result = trace.stop()!;
    expect(result.header).toEqual(metadata);
    expect(result.samples.map(sample => sample.kind)).toEqual(['frame', 'input', 'frame']);
    expect(result.samples.map(sample => sample.timeMs)).toEqual([510, 505, 520]);
    expect(result.samples.map(sample => sample.sequence)).toEqual([0, 1, 2]);
  });

  it('bounds the trace and reports each dropped sample', () => {
    const trace = createZoomMotionTrace({ maxSamples: 2 });
    trace.start(metadata);
    for (let timeMs = 501; timeMs <= 504; timeMs += 1) {
      trace.recordFrame({ timeMs, camera: { x: timeMs, y: 0, zoom: 1 } });
    }

    expect(trace.stop()).toMatchObject({
      truncated: true,
      droppedSamples: 2,
      samples: [{ timeMs: 501 }, { timeMs: 502 }],
    });
  });

  it('is opt-in, resets on start, and snapshots mutable input values', () => {
    const trace = createZoomMotionTrace();
    trace.recordFrame({ timeMs: 1, camera: { x: 1, y: 1, zoom: 1 } });
    expect(trace.stop()).toBeUndefined();

    trace.start(metadata);
    const camera = { x: 9, y: 8, zoom: 1.5 };
    const viewport = { width: 900, height: 700 };
    trace.recordInput({
      timeMs: 510, deltaX: 0, deltaY: -1, deltaMode: 0, pointerX: 8, pointerY: 9,
      ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, viewport, devicePixelRatio: 1,
    });
    const residentCountsByDetail = { context: 1, container: 2, component: 3, code: 4 };
    trace.recordFrame({ timeMs: 511, camera, minimapCamera: camera, sceneRootId: 'container:web', residentCountsByDetail });
    camera.x = 99;
    viewport.width = 99;
    residentCountsByDetail.component = 99;
    const first = trace.stop()!;
    expect(first.samples[0]).toMatchObject({ viewport: { width: 900, height: 700 } });
    expect(first.samples[1]).toMatchObject({ camera: { x: 9 }, minimapCamera: { x: 9 }, sceneRootId: 'container:web', residentCountsByDetail: { context: 1, container: 2, component: 3, code: 4 } });

    trace.start({ ...metadata, startedAtMs: 600 });
    trace.recordFrame({ timeMs: 601, camera: { x: 0, y: 0, zoom: 1 } });
    const second = trace.stop()!;
    expect(second.samples).toHaveLength(1);
    expect(second.truncated).toBe(false);
    expect(trace.active).toBe(false);
  });

  it('records the classified input intent and zoom factor only when supplied', () => {
    const trace = createZoomMotionTrace();
    trace.start(metadata);
    const base = {
      deltaX: 0, deltaY: -2, deltaMode: 0, pointerX: 1, pointerY: 2,
      ctrlKey: true, metaKey: false, shiftKey: false, altKey: false,
      viewport: { width: 800, height: 600 }, devicePixelRatio: 2,
    };
    trace.recordInput({ ...base, timeMs: 501, intent: 'pinch', zoomFactor: 1.02 });
    trace.recordInput({ ...base, timeMs: 502, intent: 'pan' });
    trace.recordInput({ ...base, timeMs: 503 });
    const [pinch, pan, legacy] = trace.stop()!.samples;
    expect(pinch).toMatchObject({ intent: 'pinch', zoomFactor: 1.02 });
    expect(pan).toMatchObject({ intent: 'pan' });
    expect(pan).not.toHaveProperty('zoomFactor');
    expect(legacy).not.toHaveProperty('intent');
    expect(legacy).not.toHaveProperty('zoomFactor');
  });

  it('records why the renderer was lost and what replaced it, in delivery order (CLA-401)', () => {
    const trace = createZoomMotionTrace();
    trace.start(metadata);
    trace.recordFrame({ timeMs: 510, camera: { x: 0, y: 0, zoom: 1 }, renderer: 'webgpu' });
    trace.recordRendererEvent({ timeMs: 520, phase: 'lost', backend: 'webgpu', reason: 'unreachable', stack: 'RuntimeError: unreachable\n    at wasm' });
    trace.recordRendererEvent({ timeMs: 530, phase: 'recovered', backend: 'canvas2d-preview', reason: 'x'.repeat(5_000) });
    trace.recordFrame({ timeMs: 540, camera: { x: 0, y: 0, zoom: 1 }, renderer: 'canvas2d-preview' });

    const result = trace.stop()!;
    expect(result.samples.map(sample => sample.kind)).toEqual(['frame', 'renderer', 'renderer', 'frame']);
    expect(result.samples[1]).toEqual({
      kind: 'renderer', timeMs: 520, phase: 'lost', backend: 'webgpu', reason: 'unreachable',
      stack: 'RuntimeError: unreachable\n    at wasm', sequence: 1,
    });
    const recovered = result.samples[2]!;
    expect(recovered.kind === 'renderer' && recovered.reason.length).toBe(2_000);
    expect(recovered).not.toHaveProperty('stack');
  });

  it('ignores renderer events while not recording', () => {
    const trace = createZoomMotionTrace();
    trace.recordRendererEvent({ timeMs: 1, phase: 'lost', backend: 'webgpu', reason: 'ignored' });
    trace.start(metadata);
    expect(trace.stop()!.samples).toEqual([]);
  });
});
