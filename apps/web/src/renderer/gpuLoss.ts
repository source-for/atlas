import {
  autoGpuAttemptOrder,
  EMBED_FRAME_IDLE_KICK_MS,
  isFramedBrowsingContext,
  isUsableAtlasViewport,
  isWebGpuInterfaceAvailable,
  WEBGPU_ADAPTER_TIMEOUT_MS,
  withDeadline,
} from '../embedCanvas';
// Also App.tsx's import point for the embed-chrome helpers (brandHomeLinkProps, initialInspectorOpen, isEmbedChrome, ...).
import { brandHomeLinkProps, initialInspectorOpen, isEmbedChrome, isEmbedQueryFlag } from '../embedChrome';

export {
  autoGpuAttemptOrder,
  brandHomeLinkProps,
  EMBED_FRAME_IDLE_KICK_MS,
  initialInspectorOpen,
  isEmbedChrome,
  isEmbedQueryFlag,
  isFramedBrowsingContext,
  isUsableAtlasViewport,
  isWebGpuInterfaceAvailable,
  WEBGPU_ADAPTER_TIMEOUT_MS,
  withDeadline,
};

export type RecoveryBackend = 'webgl2' | 'canvas2d';

export function nextBackendAfterLoss(requestedBackend: string, failedBackend: string): RecoveryBackend {
  return requestedBackend === 'auto' && failedBackend.toLowerCase() === 'webgpu' ? 'webgl2' : 'canvas2d';
}

/** The name crates/atlas-wasm/src/browser.rs gives an error for a call the engine refused. */
export const REJECTED_CALL_ERROR_NAME = 'AtlasRejectedCall';
/** A renderer that rejects this many calls in a row, with no frame drawn between, is replaced. */
export const MAX_CONSECUTIVE_REJECTED_CALLS = 5;
/** The same rejected-call message is reported at most once in this long. */
export const REJECTED_CALL_EPISODE_MS = 5_000;
/** Report times are kept for this many messages; the one reported longest ago is forgotten first. */
export const REJECTED_CALL_REMEMBERED_MESSAGES = 8;

/**
 * A rejected call is the engine refusing one input (an unknown id, a stale patch, a call
 * before the first scene); the device is intact. Anything not tagged as such is a loss.
 */
export function rendererFailureKind(error: unknown): 'rejected' | 'lost' {
  return error instanceof Error && error.name === REJECTED_CALL_ERROR_NAME ? 'rejected' : 'lost';
}

/**
 * Decides where a rejected call is reported. A message not reported before is due at
 * once; each message is due again REJECTED_CALL_EPISODE_MS after its own last report, so
 * messages that alternate are not reported every time. The zoom trace is judged apart
 * from the console and afresh for every recording (`recordingId`, undefined while not
 * recording), because a trace keeps nothing from before it started.
 */
export function createRejectedCallReports() {
  const sink = () => {
    // In order of last report, oldest first.
    const reportedAt = new Map<string, number>();
    return (message: string, nowMs: number) => {
      const last = reportedAt.get(message);
      if (last !== undefined && nowMs - last < REJECTED_CALL_EPISODE_MS) return false;
      reportedAt.delete(message);
      reportedAt.set(message, nowMs);
      if (reportedAt.size > REJECTED_CALL_REMEMBERED_MESSAGES) reportedAt.delete(reportedAt.keys().next().value!);
      return true;
    };
  };
  const consoleDue = sink();
  let traceDue = sink();
  let recording: number | undefined;
  return (message: string, nowMs: number, recordingId: number | undefined) => {
    if (recordingId !== recording) {
      recording = recordingId;
      traceDue = sink();
    }
    return { console: consoleDue(message, nowMs), trace: recordingId !== undefined && traceDue(message, nowMs) };
  };
}

export function listenForWebGlContextLoss(canvas: EventTarget, onLoss: (message: string) => void) {
  const handleLoss = (event: Event) => {
    event.preventDefault();
    onLoss('WebGL context lost.');
  };
  canvas.addEventListener('webglcontextlost', handleLoss);
  return () => canvas.removeEventListener('webglcontextlost', handleLoss);
}
