import type { Camera } from './renderer/types';

export type ZoomMotionTraceMetadata = {
  /** `performance.timeOrigin` supplied by the caller when recording starts. */
  timeOrigin: number;
  /** High-resolution timestamp in the same clock domain as event/frame timestamps. */
  startedAtMs: number;
  /** Caller-provided non-sensitive scene/snapshot identifiers for replay context. */
  snapshotId?: string;
  sceneId?: string;
  renderer?: string;
  backend?: string;
};

export type ZoomMotionInput = {
  timeMs: number;
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  pointerX: number;
  pointerY: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  viewport: { width: number; height: number };
  devicePixelRatio: number;
  /** How the canvas interpreted this input (CLA-326); absent in older traces. */
  intent?: 'pan' | 'pinch' | 'wheel' | 'modifier-wheel' | 'gesture';
  /** Multiplicative zoom factor applied for zoom intents; absent for pan. */
  zoomFactor?: number;
};

export type ZoomMotionFrame = {
  timeMs: number;
  camera: Camera;
  projectionProgress?: number;
  projectionId?: string;
  semanticRevision?: number;
  sceneId?: string;
  sceneRootId?: string;
  residentCountsByDetail?: { context: number; container: number; component: number; code: number };
  renderer?: string;
  viewport?: { width: number; height: number };
  /** Optional minimap camera snapshot, only when its owner supplies one. */
  minimapCamera?: Camera;
};

/**
 * A renderer loss or its recovery (CLA-401): without it a trace shows the
 * backend change between two frames but not why it happened.
 */
export type ZoomMotionRendererEvent = {
  timeMs: number;
  phase: 'lost' | 'recovered' | 'recovery-failed';
  /** The backend that failed (`lost`) or the one now active (`recovered`). */
  backend: string;
  /** The thrown error's message, or the new renderer's own fallback message. */
  reason: string;
  /** The thrown error's stack, when it had one. */
  stack?: string;
};

export type ZoomMotionTraceSample =
  | ({ kind: 'input' } & Omit<ZoomMotionInput, 'timeMs'> & { timeMs: number; sequence: number })
  | ({ kind: 'frame' } & Omit<ZoomMotionFrame, 'timeMs'> & { timeMs: number; sequence: number })
  | ({ kind: 'renderer' } & ZoomMotionRendererEvent & { sequence: number });

type UnsequencedZoomMotionTraceSample =
  | ({ kind: 'input' } & Omit<ZoomMotionInput, 'timeMs'> & { timeMs: number })
  | ({ kind: 'frame' } & Omit<ZoomMotionFrame, 'timeMs'> & { timeMs: number })
  | ({ kind: 'renderer' } & ZoomMotionRendererEvent);

export type ZoomMotionTrace = {
  version: 1;
  header: ZoomMotionTraceMetadata;
  samples: ZoomMotionTraceSample[];
  truncated: boolean;
  droppedSamples: number;
};

export type ZoomMotionTraceCollector = {
  start(metadata: ZoomMotionTraceMetadata): void;
  stop(): ZoomMotionTrace | undefined;
  recordInput(input: ZoomMotionInput): void;
  recordFrame(frame: ZoomMotionFrame): void;
  recordRendererEvent(event: ZoomMotionRendererEvent): void;
  isRecording(): boolean;
  readonly active: boolean;
};

export type ZoomMotionTraceOptions = { maxSamples?: number };

const DEFAULT_MAX_SAMPLES = 10_000;
const MAX_REASON_LENGTH = 2_000;
const MAX_STACK_LENGTH = 4_000;

function boundedSampleLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SAMPLES;
  return Math.max(1, Math.min(10_000, Math.floor(value!)));
}

function copyCamera(camera: Camera): Camera {
  return { x: camera.x, y: camera.y, zoom: camera.zoom };
}

function copyMetadata(metadata: ZoomMotionTraceMetadata): ZoomMotionTraceMetadata {
  return {
    timeOrigin: metadata.timeOrigin,
    startedAtMs: metadata.startedAtMs,
    ...(metadata.snapshotId === undefined ? {} : { snapshotId: metadata.snapshotId }),
    ...(metadata.sceneId === undefined ? {} : { sceneId: metadata.sceneId }),
    ...(metadata.renderer === undefined ? {} : { renderer: metadata.renderer }),
    ...(metadata.backend === undefined ? {} : { backend: metadata.backend }),
  };
}

/**
 * Explicit, in-memory diagnostic collector for correlating actual wheel input
 * with rendered frames. It never reads browser state or starts itself: callers
 * choose when to start/stop and pass only the metadata they want in the JSON.
 */
export function createZoomMotionTrace(options: ZoomMotionTraceOptions = {}): ZoomMotionTraceCollector {
  const maxSamples = boundedSampleLimit(options.maxSamples);
  let header: ZoomMotionTraceMetadata | undefined;
  let samples: ZoomMotionTraceSample[] = [];
  let truncated = false;
  let droppedSamples = 0;
  let nextSequence = 0;

  const append = (sample: UnsequencedZoomMotionTraceSample) => {
    if (!header) return;
    if (samples.length >= maxSamples) {
      truncated = true;
      droppedSamples += 1;
      return;
    }
    samples.push({ ...sample, sequence: nextSequence++ } as ZoomMotionTraceSample);
  };

  return {
    get active() {
      return header !== undefined;
    },
    isRecording() {
      return header !== undefined;
    },
    start(metadata) {
      header = copyMetadata(metadata);
      samples = [];
      truncated = false;
      droppedSamples = 0;
      nextSequence = 0;
    },
    stop() {
      if (!header) return undefined;
      const trace: ZoomMotionTrace = {
        version: 1,
        header: copyMetadata(header),
        samples: samples.map(sample => sample.kind === 'renderer'
          ? { ...sample }
          : sample.kind === 'input'
          ? { ...sample, viewport: { ...sample.viewport } }
          : {
              ...sample,
              camera: copyCamera(sample.camera),
              ...(sample.viewport ? { viewport: { ...sample.viewport } } : {}),
              ...(sample.minimapCamera ? { minimapCamera: copyCamera(sample.minimapCamera) } : {}),
              ...(sample.residentCountsByDetail ? { residentCountsByDetail: { ...sample.residentCountsByDetail } } : {}),
            }),
        truncated,
        droppedSamples,
      };
      header = undefined;
      samples = [];
      return trace;
    },
    recordInput(input) {
      append({
        kind: 'input',
        timeMs: input.timeMs,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        deltaMode: input.deltaMode,
        pointerX: input.pointerX,
        pointerY: input.pointerY,
        ctrlKey: input.ctrlKey,
        metaKey: input.metaKey,
        shiftKey: input.shiftKey,
        altKey: input.altKey,
        viewport: { width: input.viewport.width, height: input.viewport.height },
        devicePixelRatio: input.devicePixelRatio,
        ...(input.intent === undefined ? {} : { intent: input.intent }),
        ...(input.zoomFactor === undefined ? {} : { zoomFactor: input.zoomFactor }),
      });
    },
    recordRendererEvent(event) {
      append({
        kind: 'renderer',
        timeMs: event.timeMs,
        phase: event.phase,
        backend: event.backend,
        reason: event.reason.slice(0, MAX_REASON_LENGTH),
        ...(event.stack === undefined ? {} : { stack: event.stack.slice(0, MAX_STACK_LENGTH) }),
      });
    },
    recordFrame(frame) {
      append({
        kind: 'frame',
        timeMs: frame.timeMs,
        camera: copyCamera(frame.camera),
        ...(frame.projectionProgress === undefined ? {} : { projectionProgress: frame.projectionProgress }),
        ...(frame.projectionId === undefined ? {} : { projectionId: frame.projectionId }),
        ...(frame.semanticRevision === undefined ? {} : { semanticRevision: frame.semanticRevision }),
        ...(frame.sceneId === undefined ? {} : { sceneId: frame.sceneId }),
        ...(frame.sceneRootId === undefined ? {} : { sceneRootId: frame.sceneRootId }),
        ...(frame.renderer === undefined ? {} : { renderer: frame.renderer }),
        ...(frame.residentCountsByDetail === undefined ? {} : { residentCountsByDetail: { ...frame.residentCountsByDetail } }),
        ...(frame.viewport === undefined ? {} : { viewport: { width: frame.viewport.width, height: frame.viewport.height } }),
        ...(frame.minimapCamera === undefined ? {} : { minimapCamera: copyCamera(frame.minimapCamera) }),
      });
    },
  };
}
