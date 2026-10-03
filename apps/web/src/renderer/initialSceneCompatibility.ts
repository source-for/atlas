import type { AtlasScene } from './types';

/** Background detail may enrich a first view only when its existing drawable bands keep the same geometry. */
export function initialSceneBandsMatch(first: AtlasScene, enriched: AtlasScene): boolean {
  if (first.rootEntityId !== enriched.rootEntityId || first.frozenRevision !== enriched.frozenRevision) return false;
  if (!first.projection || !enriched.projection) return false;
  for (const band of ['context', 'container'] as const) {
    const before = first.projection.entityIdsByDetail[band];
    const after = enriched.projection.entityIdsByDetail[band];
    if (before.length !== after.length || before.some((id, index) => id !== after[index])) return false;
    for (const id of before) {
      const a = first.projection.boundsByEntityIdAndDetail[id]?.[band];
      const b = enriched.projection.boundsByEntityIdAndDetail[id]?.[band];
      if (!a || !b || a.x !== b.x || a.y !== b.y || a.width !== b.width || a.height !== b.height) return false;
    }
  }
  return true;
}
