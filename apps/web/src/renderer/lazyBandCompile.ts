import type { ArchitectureEntity, ArchitectureSnapshot, C4Band, EntityKind } from '@okie/architecture';

const BANDS: readonly C4Band[] = ['context', 'container', 'component', 'code'];

/** Published child counts for a slim snapshot (CLA-73). Same object is mutated in place as neighborhoods merge. */
const publishedChildCounts = new WeakMap<ArchitectureSnapshot, Readonly<Record<string, number>>>();

/** Remember published child counts so Open inside stays enabled before the subgraph is fetched. */
export function rememberPublishedChildCounts(
  snapshot: ArchitectureSnapshot,
  counts: Readonly<Record<string, number>> | undefined,
): void {
  if (counts) publishedChildCounts.set(snapshot, counts);
}

function kindBand(kind: EntityKind): C4Band {
  if (kind === 'container' || kind === 'dataStore' || kind === 'queue') return 'container';
  if (kind === 'component') return 'component';
  if (kind === 'code') return 'code';
  return 'context';
}

function entityById(snapshot: ArchitectureSnapshot): Map<string, ArchitectureEntity> {
  return new Map(snapshot.entities.map(entity => [entity.id, entity]));
}

/** True when the snapshot (not the current scene) has a child under this entity. */
export function scanEntityHasChildren(
  snapshot: ArchitectureSnapshot,
  entityId: string,
  childCounts?: Readonly<Record<string, number>>,
): boolean {
  const counts = childCounts ?? publishedChildCounts.get(snapshot);
  if (counts && Object.prototype.hasOwnProperty.call(counts, entityId)) {
    return (counts[entityId] ?? 0) > 0;
  }
  return snapshot.entities.some(entity => entity.parentId === entityId);
}

/**
 * Nearest ancestor-or-self whose native C4 band matches `band`. Undefined when
 * the preferred entity sits above that band (e.g. the system has no container
 * ancestor).
 */
export function scanAncestorAtBand(
  snapshot: ArchitectureSnapshot,
  entityId: string,
  band: C4Band,
): string | undefined {
  const byId = entityById(snapshot);
  let current = byId.get(entityId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (kindBand(current.kind) === band) return current.id;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

/**
 * First descendant (not self) whose native C4 band matches `band`, walking
 * children in id-sorted BFS order. Prefers an entity that already has children
 * (resident or published) so L4 compile can target a file with symbols.
 */
export function scanDescendantAtBand(
  snapshot: ArchitectureSnapshot,
  ownerId: string,
  band: C4Band,
): string | undefined {
  const byId = entityById(snapshot);
  if (!byId.has(ownerId)) return undefined;
  const childrenByParent = new Map<string, string[]>();
  for (const entity of snapshot.entities) {
    if (entity.parentId === undefined) continue;
    const siblings = childrenByParent.get(entity.parentId);
    if (siblings) siblings.push(entity.id);
    else childrenByParent.set(entity.parentId, [entity.id]);
  }
  for (const siblings of childrenByParent.values()) siblings.sort((left, right) => left.localeCompare(right));

  const targetRank = BANDS.indexOf(band);
  const queue = [ownerId];
  const seen = new Set<string>();
  let fallback: string | undefined;
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const entity = byId.get(id);
    if (!entity) continue;
    const rank = BANDS.indexOf(kindBand(entity.kind));
    if (id !== ownerId && rank === targetRank) {
      if (scanEntityHasChildren(snapshot, id)) return id;
      fallback ??= id;
    }
    if (rank < targetRank || id === ownerId) {
      for (const child of childrenByParent.get(id) ?? []) queue.push(child);
    }
  }
  return fallback;
}

/**
 * Focus id for a per-neighborhood scoped compile of `band`.
 *
 * Compiled and resident set (CLA-74): focused entity + siblings + one band
 * down, then the camera tile window. L1/L2 compile at the view root. L3
 * compiles that container. L4 compiles that file-component. Approximate from
 * the zoom/selection/tour target, never the whole tree.
 *
 * When the Code rail is selected on an opened container (no file in focus),
 * L4 still compiles a file-component in that neighborhood — never the
 * container itself (`maxBand: component` would leave the code band empty).
 */
export function scanCompileFocusForBand(
  snapshot: ArchitectureSnapshot,
  preferredEntityId: string,
  band: C4Band,
  viewRootId: string,
): string {
  if (band === 'context' || band === 'container') return viewRootId;
  if (band === 'component') {
    return scanAncestorAtBand(snapshot, preferredEntityId, 'container') ?? viewRootId;
  }
  const file = scanAncestorAtBand(snapshot, preferredEntityId, 'component')
    ?? scanDescendantAtBand(snapshot, preferredEntityId, 'component');
  if (file) return file;
  const container = scanAncestorAtBand(snapshot, preferredEntityId, 'container');
  return (container ? scanDescendantAtBand(snapshot, container, 'component') : undefined)
    ?? container
    ?? viewRootId;
}

/**
 * Visible parents that have children — prefetch their next-band neighborhood
 * so Open inside / zoom is already warm. Prefetch stays on that child
 * neighborhood (CLA-66 ~25 code children), not the sibling dump. Does not skip
 * an opened neighborhood just because some of its entities sit outside the
 * viewport (renderer culling); CLA-74 pages off-screen L3/L4 at compile.
 */
export function scanPrefetchFocusIds(
  snapshot: ArchitectureSnapshot,
  visibleParentIds: readonly string[],
  childCounts?: Readonly<Record<string, number>>,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const id of visibleParentIds) {
    if (seen.has(id) || !scanEntityHasChildren(snapshot, id, childCounts)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * True when `entityId` is `ownerId` or a descendant of it. Used so an opened
 * L3 neighborhood (CLA-122) does not treat a CLA-106 peer container as in-focus.
 */
export function scanEntityIsInSubtree(
  snapshot: ArchitectureSnapshot,
  entityId: string,
  ownerId: string,
): boolean {
  if (entityId === ownerId) return true;
  const byId = entityById(snapshot);
  let current = byId.get(entityId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === ownerId) return true;
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return false;
}

/** Next C4 band below `band`, or undefined at code. */
export function scanNextBand(band: C4Band): C4Band | undefined {
  return BANDS[BANDS.indexOf(band) + 1];
}

/**
 * Cached neighborhoods must not keep a protocolPatch from the compile that
 * created them. That patch is revision-relative to whatever `previous` was at
 * compile time; replaying it after another neighborhood was shown misses the
 * renderer’s current revision. Full-snapshot load is the safe reuse path.
 */
const cacheSceneOrigins = new WeakMap<object, object>();
/** A patch-free cache copy can reference the worker's original retained scene.
 * Any changed field invalidates the alias; arbitrary edited/morph scenes are cloned. */
export function workerSceneOrigin<T extends object>(scene: T): T {
  const original = cacheSceneOrigins.get(scene) as T | undefined;
  if (!original) return scene;
  const fields = Object.keys(original).filter(key => key !== 'protocolPatch');
  const copyFields = Object.keys(scene).filter(key => key !== 'protocolPatch');
  return fields.length === copyFields.length && fields.every(key =>
    Object.prototype.hasOwnProperty.call(scene, key) && Reflect.get(scene, key) === Reflect.get(original, key)) ? original : scene;
}

export function cacheableNeighborhoodScene<T extends object>(scene: T): Omit<T, 'protocolPatch'> {
  if (!('protocolPatch' in scene) || scene.protocolPatch === undefined) return scene as Omit<T, 'protocolPatch'>;
  const { protocolPatch: _protocolPatch, ...rest } = scene as T & { protocolPatch?: unknown };
  cacheSceneOrigins.set(rest, scene);
  return rest as Omit<T, 'protocolPatch'>;
}
