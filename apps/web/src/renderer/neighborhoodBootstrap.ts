import { sliceArchitectureNeighborhood, validateNeighborhoodPacket, type ArchitectureNeighborhoodPacket, type ValidationIssue } from '@okie/architecture';
import { compileScanScene, type ScanModeOptions } from './scanScene';
import type { AtlasScene } from './types';

export type NeighborhoodBootstrapResult =
  | { status: 'invalid'; issues: ValidationIssue[]; validateDurationMs: number }
  | { status: 'ready'; scene: AtlasScene; validateDurationMs: number; sliceDurationMs: number; compileDurationMs: number };

/** Pure worker-side root bootstrap. Validation precedes every slice and compile.
 * The temporary shallow packet never replaces the worker's retained full graph.
 * Structural validator/compiler exceptions use the caller's original fallback.
 */
export function initializeNeighborhoodBootstrap(packet: ArchitectureNeighborhoodPacket, options: ScanModeOptions): NeighborhoodBootstrapResult {
  let start = performance.now();
  const issues = validateNeighborhoodPacket(packet);
  const validateDurationMs = performance.now() - start;
  if (issues.length) return { status: 'invalid', issues, validateDurationMs };
  start = performance.now();
  const first = packet.snapshot.entities.length > 128
    ? sliceArchitectureNeighborhood(packet.snapshot, packet.view, { focusEntityId: packet.view.rootEntityId, maxBand: 'container' })
    : undefined;
  const sliceDurationMs = performance.now() - start;
  start = performance.now();
  const scene = compileScanScene({
    snapshot: first?.snapshot ?? packet.snapshot,
    view: first?.view ?? packet.view,
    focusEntityId: packet.view.rootEntityId,
    boot: 'neighborhood',
    modeOptions: options,
    childCounts: packet.childCounts,
    unpublishedChildren: first?.unpublishedChildren ?? packet.unpublishedChildren ?? [],
  });
  return { status: 'ready', scene, validateDurationMs, sliceDurationMs, compileDurationMs: performance.now() - start };
}
