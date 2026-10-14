/**
 * CLA-207: deterministic shortest-path exploration over one semantic snapshot.
 *
 * Directed edges come only from relations whose kind the caller names, plus
 * opt-in parent→child containment. Kinds are never merged or inferred. On a
 * pair joined by both, an observed relation (smallest id) wins over
 * evidence-free containment. The canonical path is the fewest-hop path with the
 * lexicographically smallest entity-ID sequence (code-unit order).
 *
 * `endpointScope: "subtree"` widens each endpoint to itself plus its parentId
 * descendants (like c4.ts lifting relations), so container→container queries
 * can route through components; the path then starts and ends at the resolved
 * descendants. Shuffling entities or relations yields an identical result. A
 * found path is a static claim, never runtime proof.
 */
import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  EntityId,
  Evidence,
  RelationId,
  RelationKind,
  SnapshotId,
} from "./model.js";
import { compareText } from "./text-order.js";

export const PATH_EXPLORATION_VERSION = 1 as const;
export const PATH_EXPLORATION_DEFAULT_MAX_HOPS = 64;
/** Never imply runtime execution. */
export const PATH_EXPLORATION_CLAIM = "staticObservedRelations" as const;
export const PATH_EXPLORATION_DISCLAIMER =
  "This path follows statically observed relations in one snapshot. It does not show that this path runs at runtime.";

export type PathGraphCoverage = "complete" | "partial";
export type PathEndpointScope = "exact" | "subtree";

export type PathExplorationQuery = {
  fromEntityId: EntityId;
  toEntityId: EntityId;
  /** Explicit eligible kinds; nothing is inferred from an empty list. */
  relationKinds: readonly RelationKind[];
  /** Adds parent→child edges from `entity.parentId`. Default false. */
  includeParentContainment?: boolean;
  /** `partial` when the snapshot is a truncated neighborhood; unreachability is then never claimed. */
  graphCoverage: PathGraphCoverage;
  /** Positive integer; default PATH_EXPLORATION_DEFAULT_MAX_HOPS. */
  maxHops?: number;
  /** `subtree` also accepts parentId descendants of either endpoint. Default `exact`. */
  endpointScope?: PathEndpointScope;
};

export type NormalizedPathExplorationQuery = {
  fromEntityId: EntityId;
  toEntityId: EntityId;
  relationKinds: RelationKind[];
  includeParentContainment: boolean;
  graphCoverage: PathGraphCoverage;
  maxHops: number;
  endpointScope: PathEndpointScope;
};

export type PathHopVia = "relation" | "parentContainment";

export type PathHopLimit =
  | "noEvidence"
  | "evidenceWithoutLineRange"
  | "evidenceFromOtherCommit"
  | "optionalRelation"
  | "unscoredConfidence"
  | "structuralContainment";

export type PathHop = {
  index: number;
  fromEntityId: EntityId;
  toEntityId: EntityId;
  /** `contains` for parentContainment hops. */
  kind: RelationKind;
  via: PathHopVia;
  /** Chosen relation; absent for parentContainment. */
  relationId?: RelationId;
  /** Other eligible relations for the same from→to, canonical order (parallel edges). Never includes relationId. */
  parallelRelationIds: RelationId[];
  label?: string;
  evidence: Evidence[];
  confidence?: number;
  limits: PathHopLimit[];
};

export type PathResultLimit = "partialGraph" | "hopsWithoutEvidence";

export type PathUnavailableReason =
  | "unknownFromEntity"
  | "unknownToEntity"
  | "noEligibleKinds"
  | "invalidQuery"
  | "invalidSnapshot"
  | "endpointNotLoaded"
  | "nestedEndpoints"
  | "noEligibleRelations"
  | "partialGraph"
  | "hopLimit";

type PathResultBase = {
  version: typeof PATH_EXPLORATION_VERSION;
  snapshotId: SnapshotId;
  commitSha: string;
  query: NormalizedPathExplorationQuery;
  claim: typeof PATH_EXPLORATION_CLAIM;
  /** Relations of the eligible kinds whose from/to is not in the snapshot. */
  ignoredDanglingRelationCount: number;
};

export type PathExplorationFound = PathResultBase & {
  status: "found";
  /** First and last are the resolved endpoints (descendants under subtree scope). */
  entityIds: EntityId[];
  relationIds: RelationId[];
  hops: PathHop[];
  limits: PathResultLimit[];
  /** Eligible kinds with no traversable relation in the snapshot, sorted. */
  absentRelationKinds: RelationKind[];
};
export type PathExplorationUnreachable = PathResultBase & {
  status: "unreachable";
  exploredEntityCount: number;
  absentRelationKinds: RelationKind[];
};
export type PathExplorationUnavailable = PathResultBase & {
  status: "unavailable";
  reason: PathUnavailableReason;
  message: string;
};
export type PathExplorationResult = PathExplorationFound | PathExplorationUnreachable | PathExplorationUnavailable;

const RELATION_KIND_SET: ReadonlySet<string> = new Set(Object.keys({
  uses: true,
  calls: true,
  reads: true,
  writes: true,
  publishes: true,
  subscribes: true,
  contains: true,
  dependsOn: true,
  returns: true,
  duplicates: true,
} satisfies Record<RelationKind, true>));

const HOP_LIMIT_ORDER: readonly PathHopLimit[] = [
  "noEvidence",
  "evidenceWithoutLineRange",
  "evidenceFromOtherCommit",
  "optionalRelation",
  "unscoredConfidence",
  "structuralContainment",
];

type PathEdge =
  | { via: "parentContainment" }
  | { via: "relation"; relation: ArchitectureRelation };

/** Observed relations (by id, then kind) before evidence-free structural containment. */
function compareEdges(left: PathEdge, right: PathEdge): number {
  if (left.via !== "relation" || right.via !== "relation") {
    return (left.via === "relation" ? 0 : 1) - (right.via === "relation" ? 0 : 1);
  }
  return compareText(left.relation.id, right.relation.id) || compareText(left.relation.kind, right.relation.kind);
}

function normalizeQuery(query: PathExplorationQuery): NormalizedPathExplorationQuery {
  const kinds = Array.isArray(query.relationKinds) ? query.relationKinds : [];
  return {
    fromEntityId: query.fromEntityId,
    toEntityId: query.toEntityId,
    relationKinds: [...new Set(kinds)].sort(compareText),
    includeParentContainment: query.includeParentContainment === true,
    graphCoverage: query.graphCoverage,
    maxHops: query.maxHops === undefined ? PATH_EXPLORATION_DEFAULT_MAX_HOPS : query.maxHops,
    endpointScope: query.endpointScope === undefined ? "exact" : query.endpointScope,
  };
}

function invalidQueryMessage(query: PathExplorationQuery, normalized: NormalizedPathExplorationQuery): string | undefined {
  if (typeof query.fromEntityId !== "string" || typeof query.toEntityId !== "string") {
    return "fromEntityId and toEntityId must be strings.";
  }
  if (!Array.isArray(query.relationKinds)) return "relationKinds must be an array.";
  const unknownKind = normalized.relationKinds.findIndex(kind => !RELATION_KIND_SET.has(kind));
  if (unknownKind >= 0) return `Unknown relation kind "${String(normalized.relationKinds[unknownKind])}".`;
  if (normalized.graphCoverage !== "complete" && normalized.graphCoverage !== "partial") {
    return 'graphCoverage must be "complete" or "partial".';
  }
  if (!Number.isInteger(normalized.maxHops) || normalized.maxHops < 1) return "maxHops must be a positive integer.";
  if (normalized.endpointScope !== "exact" && normalized.endpointScope !== "subtree") {
    return 'endpointScope must be "exact" or "subtree".';
  }
  return undefined;
}

function buildAdjacency(
  snapshot: ArchitectureSnapshot,
  entityIds: ReadonlySet<EntityId>,
  query: NormalizedPathExplorationQuery,
): { adjacency: Map<EntityId, Map<EntityId, PathEdge[]>>; dangling: number; presentKinds: Set<string> } {
  const adjacency = new Map<EntityId, Map<EntityId, PathEdge[]>>();
  const add = (from: EntityId, to: EntityId, edge: PathEdge): void => {
    let targets = adjacency.get(from);
    if (!targets) adjacency.set(from, targets = new Map());
    const edges = targets.get(to);
    if (edges) edges.push(edge);
    else targets.set(to, [edge]);
  };
  const kinds = new Set<string>(query.relationKinds);
  const presentKinds = new Set<string>();
  let dangling = 0;
  for (const relation of snapshot.relations) {
    if (!kinds.has(relation.kind)) continue;
    if (!entityIds.has(relation.from) || !entityIds.has(relation.to)) {
      dangling += 1;
      continue;
    }
    presentKinds.add(relation.kind);
    add(relation.from, relation.to, { via: "relation", relation });
  }
  if (query.includeParentContainment) {
    for (const entity of snapshot.entities) {
      if (entity.parentId !== undefined && entity.parentId !== entity.id && entityIds.has(entity.parentId)) {
        add(entity.parentId, entity.id, { via: "parentContainment" });
      }
    }
  }
  for (const targets of adjacency.values()) {
    for (const edges of targets.values()) {
      edges.sort(compareEdges);
    }
  }
  return { adjacency, dangling, presentKinds };
}

function copyEvidence(evidence: Evidence): Evidence {
  return { ...evidence, source: { ...evidence.source } };
}

function hopFor(index: number, from: EntityId, to: EntityId, edges: readonly PathEdge[], commitSha: string): PathHop {
  const chosen = edges[0]!;
  const parallelRelationIds = edges.slice(1).flatMap(edge => edge.via === "relation" ? [edge.relation.id] : []);
  if (chosen.via === "parentContainment") {
    return {
      index,
      fromEntityId: from,
      toEntityId: to,
      kind: "contains",
      via: "parentContainment",
      parallelRelationIds,
      evidence: [],
      limits: ["noEvidence", "structuralContainment"],
    };
  }
  const relation = chosen.relation;
  const limits = new Set<PathHopLimit>();
  if (relation.evidence.length === 0) limits.add("noEvidence");
  if (relation.evidence.some(item => item.source.startLine === undefined)) limits.add("evidenceWithoutLineRange");
  if (relation.evidence.some(item => item.source.commitSha !== commitSha)) limits.add("evidenceFromOtherCommit");
  if (relation.optional === true) limits.add("optionalRelation");
  if (relation.confidence === undefined) limits.add("unscoredConfidence");
  return {
    index,
    fromEntityId: from,
    toEntityId: to,
    kind: relation.kind,
    via: "relation",
    relationId: relation.id,
    parallelRelationIds,
    ...(relation.label !== undefined ? { label: relation.label } : {}),
    evidence: relation.evidence.map(copyEvidence),
    ...(relation.confidence !== undefined ? { confidence: relation.confidence } : {}),
    limits: HOP_LIMIT_ORDER.filter(limit => limits.has(limit)),
  };
}

/** Entity plus its parentId descendants; cycle-safe, sorted by id. */
function subtreeOf(root: EntityId, children: ReadonlyMap<EntityId, EntityId[]>): EntityId[] {
  const seen = new Set<EntityId>([root]);
  const stack = [root];
  while (stack.length > 0) {
    for (const child of children.get(stack.pop()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      stack.push(child);
    }
  }
  return [...seen].sort(compareText);
}

export function explorePath(snapshot: ArchitectureSnapshot, query: PathExplorationQuery): PathExplorationResult {
  const normalized = normalizeQuery(query);
  let dangling = 0;
  const base = (): PathResultBase => ({
    version: PATH_EXPLORATION_VERSION,
    snapshotId: snapshot.id,
    commitSha: snapshot.commitSha,
    query: normalized,
    claim: PATH_EXPLORATION_CLAIM,
    ignoredDanglingRelationCount: dangling,
  });
  const unavailable = (reason: PathUnavailableReason, message: string): PathExplorationUnavailable => ({
    ...base(),
    status: "unavailable",
    reason,
    message,
  });

  const invalid = invalidQueryMessage(query, normalized);
  if (invalid !== undefined) return unavailable("invalidQuery", invalid);
  const entityIds = new Set(snapshot.entities.map((entity: ArchitectureEntity) => entity.id));
  const graph = buildAdjacency(snapshot, entityIds, normalized);
  const { adjacency } = graph;
  dangling = graph.dangling;
  if (entityIds.size !== snapshot.entities.length || new Set(snapshot.relations.map(item => item.id)).size !== snapshot.relations.length) {
    return unavailable("invalidSnapshot", "The snapshot has duplicate entity or relation ids.");
  }
  const partial = normalized.graphCoverage === "partial";
  const { fromEntityId: from, toEntityId: to } = normalized;
  for (const [id, reason] of [[from, "unknownFromEntity"], [to, "unknownToEntity"]] as const) {
    if (entityIds.has(id)) continue;
    return partial
      ? unavailable("endpointNotLoaded", `Entity "${id}" is not loaded in this partial graph.`)
      : unavailable(reason, `Entity "${id}" is not in snapshot ${snapshot.id}.`);
  }

  const absentRelationKinds = normalized.relationKinds.filter(kind => !graph.presentKinds.has(kind));
  const found = (entityPath: EntityId[]): PathExplorationFound => {
    const hops = entityPath.slice(1).map((target, index) => {
      const source = entityPath[index]!;
      return hopFor(index, source, target, adjacency.get(source)!.get(target)!, snapshot.commitSha);
    });
    const limits: PathResultLimit[] = [];
    if (partial && hops.length > 0) limits.push("partialGraph");
    if (hops.some(hop => hop.limits.includes("noEvidence"))) limits.push("hopsWithoutEvidence");
    return {
      ...base(),
      status: "found",
      entityIds: entityPath,
      relationIds: hops.flatMap(hop => hop.relationId !== undefined ? [hop.relationId] : []),
      hops,
      limits,
      absentRelationKinds,
    };
  };
  if (from === to) return found([from]);
  if (normalized.relationKinds.length === 0 && !normalized.includeParentContainment) {
    return unavailable("noEligibleKinds", "No relation kinds or containment were selected.");
  }

  let sources = [from];
  let targets = new Set([to]);
  if (normalized.endpointScope === "subtree") {
    const children = new Map<EntityId, EntityId[]>();
    for (const entity of snapshot.entities) {
      if (entity.parentId === undefined) continue;
      const siblings = children.get(entity.parentId);
      if (siblings) siblings.push(entity.id);
      else children.set(entity.parentId, [entity.id]);
    }
    sources = subtreeOf(from, children);
    targets = new Set(subtreeOf(to, children));
    if (targets.has(from) || sources.includes(to)) {
      return unavailable("nestedEndpoints", `"${from}" and "${to}" are nested; their subtrees overlap.`);
    }
  }
  if (adjacency.size === 0) {
    return unavailable("noEligibleRelations", "The snapshot has no traversable relations of the selected kinds.");
  }

  const sortedNeighbors = new Map<EntityId, EntityId[]>();
  for (const [source, edges] of adjacency) sortedNeighbors.set(source, [...edges.keys()].sort(compareText));
  const parent = new Map<EntityId, EntityId>();
  const depth = new Map<EntityId, number>(sources.map(source => [source, 0]));
  const queue = [...sources];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head]!;
    const nextDepth = depth.get(current)! + 1;
    for (const neighbor of sortedNeighbors.get(current) ?? []) {
      if (depth.has(neighbor)) continue;
      depth.set(neighbor, nextDepth);
      parent.set(neighbor, current);
      if (!targets.has(neighbor)) {
        queue.push(neighbor);
        continue;
      }
      if (nextDepth > normalized.maxHops) {
        return unavailable("hopLimit", `A path exists but is longer than ${normalized.maxHops} hops.`);
      }
      const entityPath = [neighbor];
      for (let step = parent.get(neighbor); step !== undefined; step = parent.get(step)) entityPath.push(step);
      return found(entityPath.reverse());
    }
  }

  if (partial) {
    return unavailable(
      "partialGraph",
      "No path in the loaded partial graph; entities outside it may still connect these endpoints.",
    );
  }
  return { ...base(), status: "unreachable", exploredEntityCount: depth.size, absentRelationKinds };
}
