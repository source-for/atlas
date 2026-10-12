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
/** Rejected calls closer together than this are one episode, and are reported once. */
export const REJECTED_CALL_EPISODE_MS = 5_000;

/**
 * A rejected call is the engine refusing one input (an unknown id, a stale patch, a call
 * before the first scene); the device is intact. Anything not tagged as such is a loss.
 */
export function rendererFailureKind(error: unknown): 'rejected' | 'lost' {
  return error instanceof Error && error.name === REJECTED_CALL_ERROR_NAME ? 'rejected' : 'lost';
}

export function listenForWebGlContextLoss(canvas: EventTarget, onLoss: (message: string) => void) {
  const handleLoss = (event: Event) => {
    event.preventDefault();
    onLoss('WebGL context lost.');
  };
  canvas.addEventListener('webglcontextlost', handleLoss);
  return () => canvas.removeEventListener('webglcontextlost', handleLoss);
}
