import {
  ARCHITECTURE_SCHEMA_VERSION,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type EntityId,
  type Point,
  type RelationId,
  type RelationKind,
  type StoryDetail,
} from './model.js';
import type { OrthogonalSide } from './orthogonal-router.js';
import type { ValidationIssue } from './validation.js';
import { compareText } from './text-order.js';

export const ARCHITECTURE_AUTHORING_VERSION = 1 as const;

/** A user-owned semantic relation. Extracted evidence remains in the snapshot. */
export type AuthoredRelation = {
  id: RelationId;
  from: EntityId;
  to: EntityId;
  kind: RelationKind;
  label?: string;
  technology?: string;
  optional?: boolean;
};

export type RelationRouteIntent = {
  sourcePort?: OrthogonalSide;
  targetPort?: OrthogonalSide;
  /** Ordered world-space guides. The router passes through them orthogonally. */
  waypoints: Point[];
};

export type RelationRouteOverrideScope = {
  viewId: string;
  detail: StoryDetail;
  relationId: RelationId;
  /** Pins an aggregate when the current projection edge is known. */
  visualEdgeId?: string;
};

export type RelationRouteOverride = RelationRouteOverrideScope & {
  id: string;
  intent: RelationRouteIntent;
};

/** Durable user intent; this document is stored separately from extracted facts. */
export type ArchitectureAuthoringDocument = {
  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;
  authoringVersion: typeof ARCHITECTURE_AUTHORING_VERSION;
  repositoryId: string;
  relations: AuthoredRelation[];
  deletedRelationIds: RelationId[];
  routeOverrides: RelationRouteOverride[];
};

export type ArchitectureAuthoringCommand =
  | { type: 'put-relation'; relation: AuthoredRelation }
  | { type: 'delete-relation'; relationId: RelationId }
  | { type: 'put-route-override'; override: RelationRouteOverride }
  | { type: 'reset-route-override'; overrideId: string };

export type ArchitectureAuthoringChange = {
  document: ArchitectureAuthoringDocument;
  /** Exact immutable pre-command value; suitable for an undo stack. */
  undo: ArchitectureAuthoringDocument;
};

const DETAILS = new Set<StoryDetail>(['context', 'container', 'component', 'code']);
const PORTS = new Set<OrthogonalSide>(['top', 'right', 'bottom', 'left']);
const RELATION_KINDS = new Set<RelationKind>([
  'uses', 'calls', 'reads', 'writes', 'publishes', 'subscribes', 'contains', 'dependsOn', 'returns',
]);

function cloneRelation(relation: AuthoredRelation): AuthoredRelation {
  return {
    id: relation.id,
    from: relation.from,
    to: relation.to,
    kind: relation.kind,
    ...(relation.label !== undefined ? { label: relation.label } : {}),
    ...(relation.technology !== undefined ? { technology: relation.technology } : {}),
    ...(relation.optional !== undefined ? { optional: relation.optional } : {}),
  };
}

function cloneIntent(intent: RelationRouteIntent): RelationRouteIntent {
  return {
    ...(intent.sourcePort !== undefined ? { sourcePort: intent.sourcePort } : {}),
    ...(intent.targetPort !== undefined ? { targetPort: intent.targetPort } : {}),
    waypoints: intent.waypoints.map(point => ({ x: point.x, y: point.y })),
  };
}

function cloneOverride(override: RelationRouteOverride): RelationRouteOverride {
  return {
    id: override.id,
    viewId: override.viewId,
    detail: override.detail,
    relationId: override.relationId,
    ...(override.visualEdgeId !== undefined ? { visualEdgeId: override.visualEdgeId } : {}),
    intent: cloneIntent(override.intent),
  };
}

export function canonicalArchitectureAuthoringDocument(
  document: ArchitectureAuthoringDocument,
): ArchitectureAuthoringDocument {
  const relations = [...new Map(document.relations.map(value => [value.id, cloneRelation(value)])).values()]
    .sort((left, right) => compareText(left.id, right.id));
  const deletedRelationIds = [...new Set(document.deletedRelationIds)].sort(compareText);
  const routeOverrides = [...new Map(document.routeOverrides.map(value => [value.id, cloneOverride(value)])).values()]
    .sort((left, right) => compareText(left.id, right.id));
  return {
    schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
    authoringVersion: ARCHITECTURE_AUTHORING_VERSION,
    repositoryId: document.repositoryId,
    relations,
    deletedRelationIds,
    routeOverrides,
  };
}

export function createArchitectureAuthoringDocument(repositoryId: string): ArchitectureAuthoringDocument {
  return canonicalArchitectureAuthoringDocument({
    schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
    authoringVersion: ARCHITECTURE_AUTHORING_VERSION,
    repositoryId,
    relations: [],
    deletedRelationIds: [],
    routeOverrides: [],
  });
}

export function relationRouteOverrideId(scope: RelationRouteOverrideScope): string {
  const aggregate = scope.visualEdgeId ? `:${encodeURIComponent(scope.visualEdgeId)}` : '';
  return `relation-route:${encodeURIComponent(scope.viewId)}:${scope.detail}:${encodeURIComponent(scope.relationId)}${aggregate}`;
}

export function applyArchitectureAuthoringCommand(
  source: ArchitectureAuthoringDocument,
  command: ArchitectureAuthoringCommand,
): ArchitectureAuthoringChange {
  const undo = canonicalArchitectureAuthoringDocument(source);
  const document = canonicalArchitectureAuthoringDocument(source);
  if (command.type === 'put-relation') {
    document.relations = [
      ...document.relations.filter(value => value.id !== command.relation.id),
      cloneRelation(command.relation),
    ];
    document.deletedRelationIds = document.deletedRelationIds.filter(id => id !== command.relation.id);
  } else if (command.type === 'delete-relation') {
    document.relations = document.relations.filter(value => value.id !== command.relationId);
    document.deletedRelationIds = [...document.deletedRelationIds, command.relationId];
    document.routeOverrides = document.routeOverrides.filter(value => value.relationId !== command.relationId);
  } else if (command.type === 'put-route-override') {
    document.routeOverrides = [
      ...document.routeOverrides.filter(value => value.id !== command.override.id),
      cloneOverride(command.override),
    ];
  } else {
    document.routeOverrides = document.routeOverrides.filter(value => value.id !== command.overrideId);
  }
  return { document: canonicalArchitectureAuthoringDocument(document), undo };
}

export function serializeArchitectureAuthoringDocument(document: ArchitectureAuthoringDocument): string {
  return `${JSON.stringify(canonicalArchitectureAuthoringDocument(document), null, 2)}\n`;
}

/** Applies user relation shadows/tombstones without mutating the extracted snapshot. */
export function materializeArchitectureAuthoring(
  snapshot: ArchitectureSnapshot,
  authoring: ArchitectureAuthoringDocument,
): ArchitectureSnapshot {
  const deleted = new Set(authoring.deletedRelationIds);
  const authored = new Map(authoring.relations.map(relation => [relation.id, relation]));
  const extracted = new Map(snapshot.relations.map(relation => [relation.id, relation]));
  const ids = [...new Set([...snapshot.relations.map(value => value.id), ...authoring.relations.map(value => value.id)])]
    .filter(id => !deleted.has(id))
    .sort(compareText);
  const relations: ArchitectureRelation[] = ids.map(id => {
    const user = authored.get(id);
    const original = extracted.get(id);
    if (!user) {
      return {
        ...original!,
        evidence: original!.evidence.map(value => ({ ...value, source: { ...value.source } })),
      };
    }
    return {
      id: user.id,
      lineageId: original?.lineageId ?? `user:${user.id}`,
      from: user.from,
      to: user.to,
      kind: user.kind,
      ...(user.label !== undefined ? { label: user.label } : {}),
      ...(user.technology !== undefined ? { technology: user.technology } : {}),
      ...(user.optional !== undefined ? { optional: user.optional } : {}),
      evidence: original?.evidence.map(value => ({ ...value, source: { ...value.source } })) ?? [],
    };
  });
  return {
    ...snapshot,
    entities: snapshot.entities.map(entity => ({
      ...entity,
      sourceRefs: entity.sourceRefs.map(value => ({ ...value })),
      ...(entity.sourceExcerpts ? { sourceExcerpts: entity.sourceExcerpts.map(value => ({
        ...value,
        lines: [...value.lines],
      })) } : {}),
    })),
    relations,
  };
}

export function validateArchitectureAuthoringDocument(
  snapshot: ArchitectureSnapshot,
  document: ArchitectureAuthoringDocument,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (document.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) {
    issues.push({ path: 'schemaVersion', message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });
  }
  if (document.authoringVersion !== ARCHITECTURE_AUTHORING_VERSION) {
    issues.push({ path: 'authoringVersion', message: `expected ${ARCHITECTURE_AUTHORING_VERSION}` });
  }
  if (document.repositoryId !== snapshot.repositoryId) {
    issues.push({ path: 'repositoryId', message: 'does not match snapshot repository' });
  }
  const entityIds = new Set(snapshot.entities.map(value => value.id));
  const seenRelations = new Set<string>();
  document.relations.forEach((relation, index) => {
    const path = `relations[${index}]`;
    if (!relation.id.trim()) issues.push({ path: `${path}.id`, message: 'must not be blank' });
    if (seenRelations.has(relation.id)) issues.push({ path: `${path}.id`, message: `duplicate relation id: ${relation.id}` });
    seenRelations.add(relation.id);
    if (!entityIds.has(relation.from)) issues.push({ path: `${path}.from`, message: `unknown entity: ${relation.from}` });
    if (!entityIds.has(relation.to)) issues.push({ path: `${path}.to`, message: `unknown entity: ${relation.to}` });
    if (relation.from === relation.to) issues.push({ path, message: 'relation endpoints must differ' });
    if (!RELATION_KINDS.has(relation.kind)) issues.push({ path: `${path}.kind`, message: 'unsupported relation kind' });
    if (relation.label !== undefined && !relation.label.trim()) issues.push({ path: `${path}.label`, message: 'must not be blank' });
  });
  const effectiveIds = new Set(materializeArchitectureAuthoring(snapshot, document).relations.map(value => value.id));
  const seenOverrides = new Set<string>();
  document.routeOverrides.forEach((override, index) => {
    const path = `routeOverrides[${index}]`;
    if (seenOverrides.has(override.id)) issues.push({ path: `${path}.id`, message: `duplicate route override id: ${override.id}` });
    seenOverrides.add(override.id);
    if (override.id !== relationRouteOverrideId(override)) issues.push({ path: `${path}.id`, message: 'must equal the canonical scope id' });
    if (!override.viewId.trim()) issues.push({ path: `${path}.viewId`, message: 'must not be blank' });
    if (!DETAILS.has(override.detail)) issues.push({ path: `${path}.detail`, message: 'must be a C4 detail' });
    if (!effectiveIds.has(override.relationId)) issues.push({ path: `${path}.relationId`, message: `unknown effective relation: ${override.relationId}` });
    if (override.visualEdgeId !== undefined && !override.visualEdgeId.trim()) issues.push({ path: `${path}.visualEdgeId`, message: 'must not be blank' });
    if (override.intent.sourcePort !== undefined && !PORTS.has(override.intent.sourcePort)) issues.push({ path: `${path}.intent.sourcePort`, message: 'must be a valid orthogonal side' });
    if (override.intent.targetPort !== undefined && !PORTS.has(override.intent.targetPort)) issues.push({ path: `${path}.intent.targetPort`, message: 'must be a valid orthogonal side' });
    if (override.intent.sourcePort === undefined && override.intent.targetPort === undefined && override.intent.waypoints.length === 0) {
      issues.push({ path: `${path}.intent`, message: 'must specify a preferred port or waypoint' });
    }
    if (override.intent.waypoints.length > 8) issues.push({ path: `${path}.intent.waypoints`, message: 'must contain at most 8 guides' });
    override.intent.waypoints.forEach((point, pointIndex) => {
      if (!Number.isFinite(point.x)) issues.push({ path: `${path}.intent.waypoints[${pointIndex}].x`, message: 'must be finite' });
      if (!Number.isFinite(point.y)) issues.push({ path: `${path}.intent.waypoints[${pointIndex}].y`, message: 'must be finite' });
    });
  });
  return issues;
}
