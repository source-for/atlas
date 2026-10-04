import type { ArchitectureSnapshot } from '@okie/architecture';
import { entityForScene } from '../renderer/goldenC4Scene';
import type { SceneEntity } from '../renderer/types';

/** Inspection follows logical selection, independently of compiled residency.
 * Canonical presentation is never inserted into renderer geometry/projections.
 */
export function resolveInspectorEntity(snapshot: ArchitectureSnapshot, residents: readonly SceneEntity[], selectedId: string, published = false): SceneEntity {
  const resident = residents.find(entity => entity.id === selectedId);
  const canonical = snapshot.entities.find(entity => entity.id === selectedId);
  if (resident) return published && canonical
    ? { ...entityForScene(canonical, {}), x: resident.x, y: resident.y, width: resident.width, height: resident.height }
    : resident;
  return canonical ? entityForScene(canonical, {}) : residents[0]!;
}

/** Only actual scene residency authorizes using a record for camera geometry. */
export function inspectorEntityForFraming(residents: readonly SceneEntity[], inspected: SceneEntity): SceneEntity | undefined {
  return residents.find(entity => entity.id === inspected.id);
}

/** Retain an existing scene presentation across a relationship scope change,
 * without promoting a canonical-only inspector record into drawable geometry.
 */
export function retainResidentInspectorEntity<T extends { entities: SceneEntity[] }>(next: T, residents: readonly SceneEntity[], inspected: SceneEntity): T {
  if (next.entities.some(entity => entity.id === inspected.id)) return next;
  const resident = inspectorEntityForFraming(residents, inspected);
  return resident ? { ...next, entities: [...next.entities, resident] } : next;
}
