import type { AtlasScene, SceneEntity, SemanticDetail } from '../renderer/types';

/** Lookups over one `scene.entities` array, built once and shared by every lens query on it. */
export type SceneEntityIndex = {
  byId: ReadonlyMap<string, SceneEntity>;
  /** Some id names more than one entity; queries that walk ancestry then keep the old scan's exact semantics. */
  duplicateIds: boolean;
  /** Children in `scene.entities` order; roots are keyed by `undefined`. */
  childrenByParent: ReadonlyMap<string | undefined, readonly SceneEntity[]>;
  position: ReadonlyMap<SceneEntity, number>;
};

// Keyed by the entities array, not the scene: a scene spread with new entities
// (an excerpt attached, a compile) gets a fresh index; one spread with the same
// entities (camera, title) reuses it.
const indexes = new WeakMap<readonly SceneEntity[], SceneEntityIndex>();

export function sceneEntityIndex(scene: AtlasScene): SceneEntityIndex {
  const cached = indexes.get(scene.entities);
  if (cached) return cached;
  const byId = new Map<string, SceneEntity>();
  const childrenByParent = new Map<string | undefined, SceneEntity[]>();
  const position = new Map<SceneEntity, number>();
  scene.entities.forEach((entity, index) => {
    byId.set(entity.id, entity);
    position.set(entity, index);
    const siblings = childrenByParent.get(entity.parentId);
    if (siblings) siblings.push(entity);
    else childrenByParent.set(entity.parentId, [entity]);
  });
  const index = { byId, duplicateIds: byId.size !== scene.entities.length, childrenByParent, position };
  indexes.set(scene.entities, index);
  return index;
}

/** Entities projected at `detail` whose ancestor chain includes `targetId` (itself included), in scene order. */
export function descendantsInDetail(scene: AtlasScene, targetId: string, detail: SemanticDetail): SceneEntity[] {
  const visible = new Set(scene.projection?.entityIdsByDetail[detail] ?? []);
  const { byId, duplicateIds, childrenByParent, position } = sceneEntityIndex(scene);
  // An absent target ends every ancestor walk: entities that still name it as a parent are not its descendants.
  const target = byId.get(targetId);
  if (!target) return [];
  if (duplicateIds) return scanDescendantsInDetail(scene, byId, visible, targetId);
  const found: SceneEntity[] = [];
  if (visible.has(target.id)) found.push(target);
  const reached = new Set([targetId]);
  const queue = [targetId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    for (const child of childrenByParent.get(queue[cursor]) ?? []) {
      if (reached.has(child.id)) continue;
      reached.add(child.id);
      queue.push(child.id);
      if (visible.has(child.id)) found.push(child);
    }
  }
  return found.sort((left, right) => position.get(left)! - position.get(right)!);
}

/** The pre-index scan: each entity walks its own ancestor chain through `byId`. */
function scanDescendantsInDetail(scene: AtlasScene, byId: ReadonlyMap<string, SceneEntity>, visible: ReadonlySet<string>, targetId: string): SceneEntity[] {
  return scene.entities.filter(entity => {
    if (!visible.has(entity.id)) return false;
    let current: SceneEntity | undefined = entity;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === targetId) return true;
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  });
}
