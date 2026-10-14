import { onAtlasFirstFrame } from '../performance/loadTimings';

/** Without a first map frame (a failed renderer, a stalled scene) diagrams load this long after the hold. */
export const MERMAID_FIRST_FRAME_FALLBACK_MS = 3_000;

type GateState = 'open' | 'held' | 'released';
let state: GateState = 'open';
let stopHold: (() => void) | undefined;
const waiters = new Set<() => void>();

/**
 * CLA-584: Mermaid (≈ 200 KB of chunks plus ≈ 65 ms of evaluation) must not compete with the
 * WASM download and the first map frame. The atlas shell holds inline diagrams from its first
 * render until that frame, or the fallback; a diagram the reader can see releases them at once.
 * Once per page: a released gate never closes again, and without a hold diagrams load as before.
 */
export function holdMermaidUntilFirstFrame(fallbackMs = MERMAID_FIRST_FRAME_FALLBACK_MS): void {
  if (state !== 'open') return;
  state = 'held';
  const timer = setTimeout(releaseMermaid, fallbackMs);
  const unsubscribe = onAtlasFirstFrame(releaseMermaid);
  stopHold = () => { clearTimeout(timer); unsubscribe(); };
}

export function releaseMermaid(): void {
  if (state === 'released') return;
  state = 'released';
  stopHold?.();
  stopHold = undefined;
  const pending = [...waiters];
  waiters.clear();
  for (const waiter of pending) waiter();
}

export function mermaidReleased(): boolean {
  return state !== 'held';
}

/** Calls `callback` once when the gate releases (never, if it already has: check `mermaidReleased` first). */
export function whenMermaidReleased(callback: () => void): () => void {
  waiters.add(callback);
  return () => { waiters.delete(callback); };
}

/** Test seam: back to the never-held page state. */
export function resetMermaidLoadGateForTests(): void {
  stopHold?.();
  stopHold = undefined;
  waiters.clear();
  state = 'open';
}
