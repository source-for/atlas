import type { ArchitectureSnapshot } from '@okie/architecture';
import { entityForScene } from '../renderer/goldenC4Scene';
import type { SceneEntity } from '../renderer/types';

/** Inspection follows logical selection, independently of compiled residency.
 * Canonical presentation is never inserted into renderer geometry/projections.
 */
export function resolveInspectorEntity(snapshot: ArchitectureSnapshot, residents: readonly SceneEntity[], selectedId: string): SceneEntity {
  const resident = residents.find(entity => entity.id === selectedId);
  if (resident) return resident;
  const canonical = snapshot.entities.find(entity => entity.id === selectedId);
  return canonical ? entityForScene(canonical, {}) : residents[0]!;
}

/** Only actual scene residency authorizes using a record for camera geometry. */
export function inspectorEntityForFraming(residents: readonly SceneEntity[], inspected: SceneEntity): SceneEntity | undefined {
  return residents.find(entity => entity.id === inspected.id);
}
