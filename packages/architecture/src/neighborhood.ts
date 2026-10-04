import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  ArchitectureView,
  EntityKind,
  SourceExcerpt,
} from "./model.js";
import { C4_BANDS, type C4Band } from "./c4.js";
import { computeContainmentLayout, type ContainmentEntity } from "./containment-layout.js";
import { validateSnapshot, validateView, type ValidationIssue } from "./validation.js";

export const NEIGHBORHOOD_PACKET_KIND = "neighborhood" as const;
export const EXCERPT_PACKET_KIND = "excerpt" as const;
export const NEIGHBORHOOD_PACKET_VERSION = 1 as const;

/** Native C4 band for an entity kind (same mapping CLA-66 compile uses). */
export function c4BandForKind(kind: EntityKind): C4Band {
  if (kind === "code") return "code";
  if (kind === "component") return "component";
  if (kind === "container" || kind === "dataStore" || kind === "queue") return "container";
  return "context";
}

export function nextC4Band(band: C4Band): C4Band | undefined {
  return C4_BANDS[C4_BANDS.indexOf(band) + 1];
}

const CONTAINER_KINDS: ReadonlySet<EntityKind> = new Set(["container", "dataStore", "queue"]);

/**
 * CLA-107: small-repo L2 pre-places L3 when the published tree has this many
 * containers or fewer (THISS/okie dogfood is ~10). Large-repo L2 stays CLA-66 lazy.
 */
export const SMALL_REPO_L3_PREPLACE_CONTAINERS = 12;

/**
 * File-component cap, same number as the scan hang-guard
 * (`SCAN_BAND_DEPTH_MIN_ENTITIES`). Do not raise it here — CLA-107 must not
 * become a 2000-cap rewrite. Counts components, not total snapshot size.
 */
export const SMALL_REPO_L3_PREPLACE_MAX_COMPONENTS = 2000;

export function snapshotContainerCount(snapshot: ArchitectureSnapshot): number {
  return snapshot.entities.filter(entity => CONTAINER_KINDS.has(entity.kind)).length;
}

/**
 * True when a scan may compile L3+L4 landmarks into the L2 (system) scene.
 * Default CLA-73/CLA-66 path stays one band down; this is the additive
 * small-repo gate (container handful). Total entity count is not the switch —
 * THISS/okie is ~3k entities mostly L4 code, but only ~10 containers / ~170
 * file-components. The hang-guard still refuses unbounded compiles elsewhere.
 * CLA-109 extends the same gate through code so L3↔L4 can morph like L1↔L2.
 */
export function snapshotPreplacesL3InL2(snapshot: ArchitectureSnapshot): boolean {
  const containers = snapshotContainerCount(snapshot);
  if (containers === 0 || containers > SMALL_REPO_L3_PREPLACE_CONTAINERS) return false;
  const components = snapshot.entities.filter(entity => entity.kind === "component").length;
  return components <= SMALL_REPO_L3_PREPLACE_MAX_COMPONENTS;
}

/**
 * Opt-in deeper L1 slice for CLA-107/109. Empty for container/file focus and
 * for large repos so CLA-73 default packets stay current-band + one down.
 */
export function neighborhoodSliceOptionsForFocus(
  snapshot: ArchitectureSnapshot,
  focusEntityId?: string,
): Pick<SliceNeighborhoodOptions, "maxBand"> {
  const requested = focusEntityId?.trim() ?? "";
  const focus = requested
    ? snapshot.entities.find(entity => entity.id === requested)
    : undefined;
  if (focus && c4BandForKind(focus.kind) !== "context") return {};
  if (!snapshotPreplacesL3InL2(snapshot)) return {};
  return { maxBand: "code" };
}

export type SliceNeighborhoodOptions = {
  /** Entity to center the packet on. Unknown ids fall back to the view root. */
  focusEntityId?: string;
  /** When false (default), drop portable source excerpts from every entity. */
  includeExcerpts?: boolean;
  /**
   * Deepest C4 band to include (opt-in). Default: native band + one layer down
   * (CLA-73). CLA-107/109 small-repo L2 pre-place passes `code` on a context
   * focus so file-component and symbol landmarks ship with L1–L4. Large-repo
   * context packets still stop at containers unless the focus is already
   * component/code.
   */
  maxBand?: C4Band;
};

/**
 * Slim semantic packet for one C4 neighborhood: ancestors of the focus, the
 * current band, and one band down. Not a full-graph snapshot and not a SceneSnapshot.
 */
export type ArchitectureNeighborhoodPacket = {
  schemaVersion: typeof NEIGHBORHOOD_PACKET_VERSION;
  kind: typeof NEIGHBORHOOD_PACKET_KIND;
  focusEntityId: string;
  /** True when the published snapshot has entities this packet omitted. */
  truncated: boolean;
  /** Children in the published snapshot, including ones not shipped in this packet. */
  childCounts: Record<string, number>;
  /**
   * Direct unpublished children of packet members (id/kind/parentId only).
   * Lets the client reserve nested footprints without fetching the subgraph.
   * Absent when every child is already in `snapshot`.
   */
  unpublishedChildren?: readonly ContainmentEntity[];
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
};

export type ArchitectureExcerptPacket = {
  schemaVersion: typeof NEIGHBORHOOD_PACKET_VERSION;
  kind: typeof EXCERPT_PACKET_KIND;
  entityId: string;
  sourceExcerpts: SourceExcerpt[];
};

function bandRank(band: C4Band): number {
  return C4_BANDS.indexOf(band);
}

function entityByIdMap(snapshot: ArchitectureSnapshot): Map<string, ArchitectureEntity> {
  return new Map(snapshot.entities.map(entity => [entity.id, entity]));
}

function childrenByParentMap(snapshot: ArchitectureSnapshot): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const entity of snapshot.entities) {
    if (entity.parentId === undefined) continue;
    const siblings = children.get(entity.parentId);
    if (siblings) siblings.push(entity.id);
    else children.set(entity.parentId, [entity.id]);
  }
  return children;
}

/** Owner of the CLA-66 fetch neighborhood for this focus (the box being opened). */
export function neighborhoodOwnerId(
  snapshot: ArchitectureSnapshot,
  viewRootId: string,
  focusEntityId: string,
): string {
  const byId = entityByIdMap(snapshot);
  const focus = byId.get(focusEntityId);
  if (!focus) return byId.has(viewRootId) ? viewRootId : focusEntityId;
  const native = c4BandForKind(focus.kind);
  if (native === "context") {
    return byId.has(viewRootId) ? viewRootId : focus.id;
  }
  if (native === "code") {
    let current: ArchitectureEntity | undefined = focus;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (c4BandForKind(current.kind) === "component") return current.id;
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return focus.id;
  }
  return focus.id;
}

function ancestorIds(byId: Map<string, ArchitectureEntity>, startId: string): string[] {
  const ids: string[] = [];
  let current = byId.get(startId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    ids.push(current.id);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return ids;
}

function stripExcerpts(entity: ArchitectureEntity): ArchitectureEntity {
  if (entity.sourceExcerpts === undefined) return entity;
  const { sourceExcerpts: _sourceExcerpts, ...rest } = entity;
  return rest;
}

function placeholderLayout() {
  return { x: 0, y: 0, width: 1, height: 1 };
}

function childCountMap(snapshot: ArchitectureSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of snapshot.entities) counts[entity.id] = 0;
  for (const entity of snapshot.entities) {
    if (entity.parentId === undefined) continue;
    counts[entity.parentId] = (counts[entity.parentId] ?? 0) + 1;
  }
  return counts;
}

/**
 * Slice a published snapshot+view down to the focus neighborhood (current C4
 * band + one layer down by default). `maxBand` is an additive opt-in (CLA-107/109)
 * and does not change CLA-66 compile options on its own.
 */
export function sliceArchitectureNeighborhood(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  options: SliceNeighborhoodOptions = {},
): ArchitectureNeighborhoodPacket {
  const byId = entityByIdMap(snapshot);
  const childrenByParent = childrenByParentMap(snapshot);
  const requested = options.focusEntityId?.trim() ?? "";
  const focus = byId.get(requested)
    ?? byId.get(view.rootEntityId)
    ?? snapshot.entities[0];
  if (!focus) {
    return {
      schemaVersion: NEIGHBORHOOD_PACKET_VERSION,
      kind: NEIGHBORHOOD_PACKET_KIND,
      focusEntityId: requested || view.rootEntityId,
      truncated: false,
      childCounts: {},
      snapshot,
      view,
    };
  }

  const native = c4BandForKind(focus.kind);
  const defaultMax = nextC4Band(native) ?? native;
  const requestedMax = options.maxBand;
  const maxBand = requestedMax && bandRank(requestedMax) >= bandRank(native)
    ? requestedMax
    : defaultMax;
  const maxRank = bandRank(maxBand);
  const ownerId = neighborhoodOwnerId(snapshot, view.rootEntityId, focus.id);
  const included = new Set<string>(ancestorIds(byId, focus.id));

  const stack = [ownerId];
  const seenDescendants = new Set<string>();
  while (stack.length) {
    const id = stack.pop()!;
    if (seenDescendants.has(id)) continue;
    seenDescendants.add(id);
    const entity = byId.get(id);
    if (!entity) continue;
    if (bandRank(c4BandForKind(entity.kind)) <= maxRank) included.add(id);
    if (bandRank(c4BandForKind(entity.kind)) >= maxRank) continue;
    for (const childId of childrenByParent.get(id) ?? []) stack.push(childId);
  }

  if (native === "context") {
    for (const entity of snapshot.entities) {
      if (bandRank(c4BandForKind(entity.kind)) <= maxRank && entity.parentId === undefined) {
        included.add(entity.id);
      }
    }
  }

  const fullChildCounts = childCountMap(snapshot);
  const childCounts: Record<string, number> = {};
  for (const id of included) {
    const count = fullChildCounts[id];
    if (count !== undefined) childCounts[id] = count;
  }
  const unpublishedChildren: ContainmentEntity[] = [];
  for (const id of [...included].sort()) {
    for (const childId of [...(childrenByParent.get(id) ?? [])].sort()) {
      if (included.has(childId)) continue;
      const child = byId.get(childId);
      if (!child) continue;
      unpublishedChildren.push({ id: child.id, kind: child.kind, parentId: id });
      const nested = fullChildCounts[child.id];
      if (nested !== undefined) childCounts[child.id] = nested;
    }
  }

  const includeExcerpts = options.includeExcerpts === true;
  const entities = snapshot.entities
    .filter(entity => included.has(entity.id))
    .map(entity => includeExcerpts ? entity : stripExcerpts(entity));
  const relations = snapshot.relations.filter(
    relation => included.has(relation.from) && included.has(relation.to),
  );

  const slimSnapshot: ArchitectureSnapshot = {
    ...snapshot,
    entities,
    relations,
  };

  const viewEntityIds = new Set(view.entityIds);
  const viewRelationIds = new Set(view.relationIds);
  const includedRelationIds = new Set(relations.map(relation => relation.id));
  const entityIds = [
    ...view.entityIds.filter(id => included.has(id)),
    ...[...included].filter(id => !viewEntityIds.has(id)).sort(),
  ];
  const relationIds = [
    ...view.relationIds.filter(id => includedRelationIds.has(id)),
    ...relations.map(relation => relation.id).filter(id => !viewRelationIds.has(id)).sort(),
  ];
  const containment = computeContainmentLayout([
    ...entities.map(entity => ({ id: entity.id, kind: entity.kind, ...(entity.parentId ? { parentId: entity.parentId } : {}) })),
    ...unpublishedChildren,
  ], { childCounts });
  const nodes = Object.fromEntries(entityIds.map(id => {
    const authored = view.layout.nodes[id];
    const reserved = containment[id];
    if (reserved) return [id, { x: reserved.x, y: reserved.y, width: reserved.width, height: reserved.height }];
    return [id, authored && authored.width > 1 && authored.height > 1 ? authored : placeholderLayout()];
  }));
  const publishedEdges = view.layout.edges ?? {};
  const edges = Object.fromEntries(
    relationIds.flatMap(id => publishedEdges[id] ? [[id, publishedEdges[id]]] : []),
  );
  const rootEntityId = included.has(view.rootEntityId) ? view.rootEntityId : ownerId;
  const slimView: ArchitectureView = {
    ...view,
    rootEntityId,
    entityIds,
    relationIds,
    layout: Object.keys(edges).length ? { nodes, edges } : { nodes },
  };

  return {
    schemaVersion: NEIGHBORHOOD_PACKET_VERSION,
    kind: NEIGHBORHOOD_PACKET_KIND,
    focusEntityId: focus.id,
    truncated: included.size < snapshot.entities.length,
    childCounts,
    ...(unpublishedChildren.length ? { unpublishedChildren } : {}),
    snapshot: slimSnapshot,
    view: slimView,
  };
}

export function excerptPacketForEntity(
  snapshot: ArchitectureSnapshot,
  entityId: string,
): ArchitectureExcerptPacket | undefined {
  const entity = snapshot.entities.find(candidate => candidate.id === entityId);
  if (!entity) return undefined;
  return {
    schemaVersion: NEIGHBORHOOD_PACKET_VERSION,
    kind: EXCERPT_PACKET_KIND,
    entityId,
    sourceExcerpts: entity.sourceExcerpts?.map(excerpt => ({
      ...excerpt,
      lines: [...excerpt.lines],
    })) ?? [],
  };
}

function preferEntity(existing: ArchitectureEntity, incoming: ArchitectureEntity): ArchitectureEntity {
  if (existing.sourceExcerpts?.length && !incoming.sourceExcerpts?.length) {
    return { ...incoming, sourceExcerpts: existing.sourceExcerpts };
  }
  return incoming;
}

/**
 * Union two neighborhood snapshots. Existing excerpts win when the incoming
 * packet stripped them. Order: base entities, then new ids in incoming order.
 */
export function mergeArchitectureNeighborhoods(
  base: ArchitectureSnapshot,
  incoming: ArchitectureSnapshot,
): ArchitectureSnapshot {
  const entities = new Map<string, ArchitectureEntity>();
  for (const entity of base.entities) entities.set(entity.id, entity);
  for (const entity of incoming.entities) {
    const existing = entities.get(entity.id);
    entities.set(entity.id, existing ? preferEntity(existing, entity) : entity);
  }
  const relations = new Map<string, ArchitectureRelation>();
  for (const relation of base.relations) relations.set(relation.id, relation);
  for (const relation of incoming.relations) {
    if (!relations.has(relation.id)) relations.set(relation.id, relation);
  }
  const entityIds = new Set(entities.keys());
  return {
    ...base,
    entities: [...entities.values()],
    relations: [...relations.values()].filter(
      relation => entityIds.has(relation.from) && entityIds.has(relation.to),
    ),
  };
}

/** Mutate `target` in place so boot-time snapshot references stay live. */
export function assignNeighborhoodSnapshot(target: ArchitectureSnapshot, incoming: ArchitectureSnapshot): void {
  const merged = mergeArchitectureNeighborhoods(target, incoming);
  target.entities = merged.entities;
  target.relations = merged.relations;
}

export function mergeChildCounts(
  base: Record<string, number>,
  incoming: Record<string, number>,
): Record<string, number> {
  return { ...base, ...incoming };
}

export function validateNeighborhoodPacket(packet: ArchitectureNeighborhoodPacket): ValidationIssue[] {
  const issues: ValidationIssue[] = [
    ...validateSnapshot(packet.snapshot).map(issue => ({
      ...issue,
      path: issue.path ? `snapshot.${issue.path}` : "snapshot",
    })),
    ...validateView(packet.snapshot, packet.view).map(issue => ({
      ...issue,
      path: issue.path ? `view.${issue.path}` : "view",
    })),
  ];
  if (packet.kind !== NEIGHBORHOOD_PACKET_KIND) {
    issues.push({ path: "kind", message: `expected ${NEIGHBORHOOD_PACKET_KIND}` });
  }
  if (packet.schemaVersion !== NEIGHBORHOOD_PACKET_VERSION) {
    issues.push({ path: "schemaVersion", message: `expected ${NEIGHBORHOOD_PACKET_VERSION}` });
  }
  return issues;
}

export function isNeighborhoodPacket(value: unknown): value is ArchitectureNeighborhoodPacket {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return record.kind === NEIGHBORHOOD_PACKET_KIND
    && record.schemaVersion === NEIGHBORHOOD_PACKET_VERSION
    && typeof record.focusEntityId === "string"
    && typeof record.snapshot === "object"
    && typeof record.view === "object";
}
