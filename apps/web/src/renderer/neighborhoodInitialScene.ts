import { sliceArchitectureNeighborhood, type ArchitectureSnapshot, type ArchitectureView } from '@okie/architecture';

/** Full graphs use even identities; the preceding odd identity is their shallow bootstrap. */
export const fullSceneWorkerGeneration = (snapshotGeneration: number): number => snapshotGeneration * 2 + 2;

/** Shared first-view policy for worker bootstrap and synchronous fallback. */
export function initialNeighborhoodSlice(snapshot: ArchitectureSnapshot, view: ArchitectureView) {
  return snapshot.entities.length > 128
    ? sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: view.rootEntityId, maxBand: 'container' })
    : undefined;
}
