import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  ArchitectureStory,
  ArchitectureView,
  EdgeLayout,
  NodeLayout,
  SourceExcerpt,
  SourceRef,
  StoryDetail,
} from './model.js';
import { compareText } from './text-order.js';

export const NORMALIZED_ARCHITECTURE_VERSION = 1 as const;

export type NormalizedTable =
  | 'repository'
  | 'snapshot'
  | 'entity'
  | 'relation'
  | 'sourceRef'
  | 'evidence'
  | 'view'
  | 'layout'
  | 'nodePlacement'
  | 'edgeRoute'
  | 'zoomPolicy'
  | 'zoomBand'
  | 'story'
  | 'storyKeyframe';

export type Ident<T extends NormalizedTable = NormalizedTable> = readonly [T, string];

export function ident<T extends NormalizedTable>(table: T, id: string): Ident<T> {
  return [table, id];
}

export type NormalizedRepository = {
  id: string;
  latestSnapshot: Ident<'snapshot'>;
};

export type NormalizedSnapshot = {
  id: string;
  repository: Ident<'repository'>;
  commitSha: string;
  generatedAt: string;
  entities: Ident<'entity'>[];
  relations: Ident<'relation'>[];
};

export type NormalizedEntity = Omit<ArchitectureEntity, 'id' | 'parentId' | 'sourceRefs'> & {
  id: string;
  logicalId: string;
  snapshot: Ident<'snapshot'>;
  parent?: Ident<'entity'>;
  sourceRefs: Ident<'sourceRef'>[];
};

export type NormalizedRelation = Omit<ArchitectureRelation, 'id' | 'from' | 'to' | 'evidence'> & {
  id: string;
  logicalId: string;
  snapshot: Ident<'snapshot'>;
  from: Ident<'entity'>;
  to: Ident<'entity'>;
  evidence: Ident<'evidence'>[];
};

export type NormalizedSourceRef = SourceRef & {
  id: string;
  repository: Ident<'repository'>;
};

export type NormalizedEvidence = {
  id: string;
  source: Ident<'sourceRef'>;
  reason?: string;
};

export type NormalizedView = {
  id: string;
  snapshot: Ident<'snapshot'>;
  name: string;
  rootEntity: Ident<'entity'>;
  entities: Ident<'entity'>[];
  relations: Ident<'relation'>[];
  layout: Ident<'layout'>;
  zoomPolicy: Ident<'zoomPolicy'>;
};

export type NormalizedLayout = {
  id: string;
  view: Ident<'view'>;
  snapshot: Ident<'snapshot'>;
  nodePlacements: Ident<'nodePlacement'>[];
  edgeRoutes: Ident<'edgeRoute'>[];
};

export type NormalizedNodePlacement = {
  id: string;
  layout: Ident<'layout'>;
  entity: Ident<'entity'>;
  bounds: NodeLayout;
};

export type NormalizedEdgeRoute = {
  id: string;
  layout: Ident<'layout'>;
  relation: Ident<'relation'>;
  route: EdgeLayout;
};

export type NormalizedZoomPolicy = {
  id: string;
  bands: Ident<'zoomBand'>[];
};

export type NormalizedZoomBand = {
  id: string;
  detail: StoryDetail;
  enterZoom: number;
  exitZoom: number | null;
  crossfadeFraction: number;
};

export type NormalizedStory = {
  id: string;
  snapshot: Ident<'snapshot'>;
  view: Ident<'view'>;
  title: string;
  keyframes: Ident<'storyKeyframe'>[];
};

export type NormalizedStoryKeyframe = {
  id: string;
  story: Ident<'story'>;
  title: string;
  focusEntities: Ident<'entity'>[];
  traceRelations: Ident<'relation'>[];
  reveal?: StoryDetail;
  narration: string;
  sourceRefs: Ident<'sourceRef'>[];
  transitionMs: number;
  holdMs: number;
  easing: 'easeInOut';
};

export type NormalizedArchitecture = {
  schemaVersion: typeof NORMALIZED_ARCHITECTURE_VERSION;
  repositoryById: Record<string, NormalizedRepository>;
  snapshotById: Record<string, NormalizedSnapshot>;
  entityById: Record<string, NormalizedEntity>;
  relationById: Record<string, NormalizedRelation>;
  sourceRefById: Record<string, NormalizedSourceRef>;
  evidenceById: Record<string, NormalizedEvidence>;
  viewById: Record<string, NormalizedView>;
  layoutById: Record<string, NormalizedLayout>;
  nodePlacementById: Record<string, NormalizedNodePlacement>;
  edgeRouteById: Record<string, NormalizedEdgeRoute>;
  zoomPolicyById: Record<string, NormalizedZoomPolicy>;
  zoomBandById: Record<string, NormalizedZoomBand>;
  storyById: Record<string, NormalizedStory>;
  storyKeyframeById: Record<string, NormalizedStoryKeyframe>;
};

export type NormalizeArchitectureInput = {
  snapshot: ArchitectureSnapshot;
  views?: readonly ArchitectureView[];
  stories?: readonly ArchitectureStory[];
};

const defaultZoomPolicyId = 'zoom-policy:c4-default';
const defaultBands: NormalizedZoomBand[] = [
  { id: 'zoom-band:context', detail: 'context', enterZoom: 0, exitZoom: 1.16, crossfadeFraction: 0.12 },
  { id: 'zoom-band:container', detail: 'container', enterZoom: 1.16, exitZoom: 3.35, crossfadeFraction: 0.12 },
  { id: 'zoom-band:component', detail: 'component', enterZoom: 3.35, exitZoom: 7.1, crossfadeFraction: 0.12 },
  { id: 'zoom-band:code', detail: 'code', enterZoom: 7.1, exitZoom: null, crossfadeFraction: 0.12 },
];

function qualifiedId(snapshotId: string, logicalId: string) {
  return `${snapshotId}::${logicalId}`;
}

function sourceId(source: SourceRef) {
  return `source:${JSON.stringify([
    source.commitSha,
    source.path,
    source.symbol ?? '',
    source.startLine ?? null,
    source.endLine ?? null,
  ])}`;
}

function sourceExcerptId(excerpt: SourceExcerpt) {
  return JSON.stringify([
    excerpt.frozenRevision,
    excerpt.path,
    excerpt.symbol ?? '',
    excerpt.startLine,
    excerpt.endLine,
    excerpt.highlightLine,
    excerpt.language,
    excerpt.text,
  ]);
}

function cloneSourceExcerpt(excerpt: SourceExcerpt): SourceExcerpt {
  return { ...excerpt, lines: [...excerpt.lines] };
}

function evidenceId(source: SourceRef, reason: string | undefined) {
  return `evidence:${sourceId(source)}:${JSON.stringify(reason ?? '')}`;
}

function sorted<T>(values: readonly T[], key: (value: T) => string) {
  return [...values].sort((left, right) => compareText(key(left), key(right)));
}

export function normalizeArchitecture({ snapshot, views = [], stories = [] }: NormalizeArchitectureInput): NormalizedArchitecture {
  const repositoryById: Record<string, NormalizedRepository> = {
    [snapshot.repositoryId]: {
      id: snapshot.repositoryId,
      latestSnapshot: ident('snapshot', snapshot.id),
    },
  };
  const sourceRefById: Record<string, NormalizedSourceRef> = {};
  const evidenceById: Record<string, NormalizedEvidence> = {};

  const registerSource = (source: SourceRef) => {
    const id = sourceId(source);
    sourceRefById[id] ??= { id, repository: ident('repository', snapshot.repositoryId), ...source };
    return ident('sourceRef', id);
  };
  const registerEvidence = (source: SourceRef, reason?: string) => {
    const id = evidenceId(source, reason);
    evidenceById[id] ??= {
      id,
      source: registerSource(source),
      ...(reason ? { reason } : {}),
    };
    return ident('evidence', id);
  };

  const entityById: Record<string, NormalizedEntity> = {};
  for (const entity of sorted(snapshot.entities, value => value.id)) {
    const id = qualifiedId(snapshot.id, entity.id);
    entityById[id] = {
      id,
      logicalId: entity.id,
      snapshot: ident('snapshot', snapshot.id),
      kind: entity.kind,
      name: entity.name,
      sourceRefs: sorted(entity.sourceRefs, value => sourceId(value)).map(registerSource),
      ...(entity.sourceExcerpts?.length ? {
        sourceExcerpts: sorted(entity.sourceExcerpts, value => sourceExcerptId(value)).map(cloneSourceExcerpt),
      } : {}),
      ...(entity.lineageId ? { lineageId: entity.lineageId } : {}),
      ...(entity.parentId ? { parent: ident('entity', qualifiedId(snapshot.id, entity.parentId)) } : {}),
      ...(entity.responsibility ? { responsibility: entity.responsibility } : {}),
      ...(entity.technology ? { technology: [...entity.technology] } : {}),
      ...(entity.tags ? { tags: [...entity.tags] } : {}),
      ...(entity.owners?.length ? { owners: [...entity.owners] } : {}),
      ...(entity.cyclomaticComplexity !== undefined ? { cyclomaticComplexity: entity.cyclomaticComplexity } : {}),
      ...(entity.coverageFileHitRate !== undefined ? { coverageFileHitRate: entity.coverageFileHitRate } : {}),
      ...(entity.coverageUntestedRanges?.length ? {
        coverageUntestedRanges: entity.coverageUntestedRanges.map(range => ({
          startLine: range.startLine,
          endLine: range.endLine,
        })),
      } : {}),
      ...(entity.untestedBehaviours?.length ? {
        untestedBehaviours: entity.untestedBehaviours.map(item => ({
          startLine: item.startLine,
          endLine: item.endLine,
          behaviour: item.behaviour,
        })),
      } : {}),
      ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
      ...(entity.fingerprint ? { fingerprint: entity.fingerprint } : {}),
    };
  }

  const relationById: Record<string, NormalizedRelation> = {};
  for (const relation of sorted(snapshot.relations, value => value.id)) {
    const id = qualifiedId(snapshot.id, relation.id);
    relationById[id] = {
      id,
      logicalId: relation.id,
      snapshot: ident('snapshot', snapshot.id),
      from: ident('entity', qualifiedId(snapshot.id, relation.from)),
      to: ident('entity', qualifiedId(snapshot.id, relation.to)),
      kind: relation.kind,
      evidence: sorted(relation.evidence, value => evidenceId(value.source, value.reason))
        .map(value => registerEvidence(value.source, value.reason)),
      ...(relation.lineageId ? { lineageId: relation.lineageId } : {}),
      ...(relation.fingerprint ? { fingerprint: relation.fingerprint } : {}),
      ...(relation.label ? { label: relation.label } : {}),
      ...(relation.technology ? { technology: relation.technology } : {}),
      ...(relation.optional !== undefined ? { optional: relation.optional } : {}),
      ...(relation.confidence !== undefined ? { confidence: relation.confidence } : {}),
    };
  }

  const snapshotById: Record<string, NormalizedSnapshot> = {
    [snapshot.id]: {
      id: snapshot.id,
      repository: ident('repository', snapshot.repositoryId),
      commitSha: snapshot.commitSha,
      generatedAt: snapshot.generatedAt,
      entities: Object.keys(entityById).sort().map(id => ident('entity', id)),
      relations: Object.keys(relationById).sort().map(id => ident('relation', id)),
    },
  };

  const zoomBandById = Object.fromEntries(defaultBands.map(band => [band.id, band]));
  const zoomPolicyById: Record<string, NormalizedZoomPolicy> = {
    [defaultZoomPolicyId]: {
      id: defaultZoomPolicyId,
      bands: defaultBands.map(band => ident('zoomBand', band.id)),
    },
  };
  const viewById: Record<string, NormalizedView> = {};
  const layoutById: Record<string, NormalizedLayout> = {};
  const nodePlacementById: Record<string, NormalizedNodePlacement> = {};
  const edgeRouteById: Record<string, NormalizedEdgeRoute> = {};
  for (const view of sorted(views.filter(value => value.snapshotId === snapshot.id), value => value.id)) {
    const layoutId = `layout:${view.id}:${snapshot.id}`;
    const placementRefs: Ident<'nodePlacement'>[] = [];
    for (const logicalId of Object.keys(view.layout.nodes).sort()) {
      const bounds = view.layout.nodes[logicalId];
      if (!bounds) continue;
      const id = `placement:${layoutId}:${logicalId}`;
      nodePlacementById[id] = {
        id,
        layout: ident('layout', layoutId),
        entity: ident('entity', qualifiedId(snapshot.id, logicalId)),
        bounds: { ...bounds },
      };
      placementRefs.push(ident('nodePlacement', id));
    }
    const routeRefs: Ident<'edgeRoute'>[] = [];
    for (const logicalId of Object.keys(view.layout.edges ?? {}).sort()) {
      const route = view.layout.edges?.[logicalId];
      if (!route) continue;
      const id = `route:${layoutId}:${logicalId}`;
      edgeRouteById[id] = {
        id,
        layout: ident('layout', layoutId),
        relation: ident('relation', qualifiedId(snapshot.id, logicalId)),
        route: { points: route.points.map(point => ({ ...point })) },
      };
      routeRefs.push(ident('edgeRoute', id));
    }
    layoutById[layoutId] = {
      id: layoutId,
      view: ident('view', view.id),
      snapshot: ident('snapshot', snapshot.id),
      nodePlacements: placementRefs,
      edgeRoutes: routeRefs,
    };
    viewById[view.id] = {
      id: view.id,
      snapshot: ident('snapshot', snapshot.id),
      name: view.name,
      rootEntity: ident('entity', qualifiedId(snapshot.id, view.rootEntityId)),
      entities: [...new Set(view.entityIds)].sort().map(id => ident('entity', qualifiedId(snapshot.id, id))),
      relations: [...new Set(view.relationIds)].sort().map(id => ident('relation', qualifiedId(snapshot.id, id))),
      layout: ident('layout', layoutId),
      zoomPolicy: ident('zoomPolicy', defaultZoomPolicyId),
    };
  }

  const storyById: Record<string, NormalizedStory> = {};
  const storyKeyframeById: Record<string, NormalizedStoryKeyframe> = {};
  for (const story of sorted(stories.filter(value => value.snapshotId === snapshot.id), value => value.id)) {
    const keyframes: Ident<'storyKeyframe'>[] = [];
    for (const step of story.steps) {
      const id = `${story.id}::${step.id}`;
      storyKeyframeById[id] = {
        id,
        story: ident('story', story.id),
        title: step.title,
        focusEntities: [...new Set(step.focusEntityIds)].sort().map(value => ident('entity', qualifiedId(snapshot.id, value))),
        traceRelations: [...new Set(step.traceRelationIds ?? [])].sort().map(value => ident('relation', qualifiedId(snapshot.id, value))),
        narration: step.narration,
        sourceRefs: sorted(step.sourceRefs ?? [], value => sourceId(value)).map(registerSource),
        transitionMs: 1_800,
        holdMs: step.durationMs ?? 0,
        easing: 'easeInOut',
        ...(step.reveal ? { reveal: step.reveal } : {}),
      };
      keyframes.push(ident('storyKeyframe', id));
    }
    storyById[story.id] = {
      id: story.id,
      snapshot: ident('snapshot', snapshot.id),
      view: ident('view', story.viewId),
      title: story.title,
      keyframes,
    };
  }

  return {
    schemaVersion: NORMALIZED_ARCHITECTURE_VERSION,
    repositoryById,
    snapshotById,
    entityById,
    relationById,
    sourceRefById,
    evidenceById,
    viewById,
    layoutById,
    nodePlacementById,
    edgeRouteById,
    zoomPolicyById,
    zoomBandById,
    storyById,
    storyKeyframeById,
  };
}

export type NormalizedIndexes = {
  entityBySnapshotAndLogicalId: ReadonlyMap<string, NormalizedEntity>;
  relationBySnapshotAndLogicalId: ReadonlyMap<string, NormalizedRelation>;
  childrenByEntityId: ReadonlyMap<string, readonly NormalizedEntity[]>;
  outgoingByEntityId: ReadonlyMap<string, readonly NormalizedRelation[]>;
  incomingByEntityId: ReadonlyMap<string, readonly NormalizedRelation[]>;
};

function indexKey(snapshotId: string, logicalId: string) {
  return `${snapshotId}\u0000${logicalId}`;
}

function appendIndex<T>(target: Map<string, T[]>, key: string, value: T) {
  const values = target.get(key) ?? [];
  values.push(value);
  target.set(key, values);
}

export function buildNormalizedIndexes(state: NormalizedArchitecture): NormalizedIndexes {
  const entityBySnapshotAndLogicalId = new Map<string, NormalizedEntity>();
  const relationBySnapshotAndLogicalId = new Map<string, NormalizedRelation>();
  const childrenByEntityId = new Map<string, NormalizedEntity[]>();
  const outgoingByEntityId = new Map<string, NormalizedRelation[]>();
  const incomingByEntityId = new Map<string, NormalizedRelation[]>();
  for (const entity of Object.values(state.entityById)) {
    entityBySnapshotAndLogicalId.set(indexKey(entity.snapshot[1], entity.logicalId), entity);
    if (entity.parent) appendIndex(childrenByEntityId, entity.parent[1], entity);
  }
  for (const relation of Object.values(state.relationById)) {
    relationBySnapshotAndLogicalId.set(indexKey(relation.snapshot[1], relation.logicalId), relation);
    appendIndex(outgoingByEntityId, relation.from[1], relation);
    appendIndex(incomingByEntityId, relation.to[1], relation);
  }
  for (const values of [...childrenByEntityId.values(), ...outgoingByEntityId.values(), ...incomingByEntityId.values()]) {
    values.sort((left, right) => compareText(left.id, right.id));
  }
  return { entityBySnapshotAndLogicalId, relationBySnapshotAndLogicalId, childrenByEntityId, outgoingByEntityId, incomingByEntityId };
}

function sourceFromRow(row: NormalizedSourceRef): SourceRef {
  return {
    path: row.path,
    commitSha: row.commitSha,
    ...(row.symbol ? { symbol: row.symbol } : {}),
    ...(row.startLine !== undefined ? { startLine: row.startLine } : {}),
    ...(row.endLine !== undefined ? { endLine: row.endLine } : {}),
  };
}

export function selectArchitectureSnapshot(state: NormalizedArchitecture, snapshotId: string): ArchitectureSnapshot {
  const snapshot = state.snapshotById[snapshotId];
  if (!snapshot) throw new Error(`Unknown normalized snapshot ${snapshotId}`);
  const entities: ArchitectureEntity[] = snapshot.entities.map(([, id]) => {
    const entity = state.entityById[id];
    if (!entity) throw new Error(`Missing normalized entity ${id}`);
    return {
      id: entity.logicalId,
      ...(entity.lineageId ? { lineageId: entity.lineageId } : {}),
      kind: entity.kind,
      name: entity.name,
      sourceRefs: entity.sourceRefs.map(([, sourceId]) => sourceFromRow(state.sourceRefById[sourceId]!)),
      ...(entity.sourceExcerpts?.length ? {
        sourceExcerpts: sorted(entity.sourceExcerpts, value => sourceExcerptId(value)).map(cloneSourceExcerpt),
      } : {}),
      ...(entity.parent ? { parentId: state.entityById[entity.parent[1]]!.logicalId } : {}),
      ...(entity.responsibility ? { responsibility: entity.responsibility } : {}),
      ...(entity.technology ? { technology: [...entity.technology] } : {}),
      ...(entity.tags ? { tags: [...entity.tags] } : {}),
      ...(entity.owners?.length ? { owners: [...entity.owners] } : {}),
      ...(entity.cyclomaticComplexity !== undefined ? { cyclomaticComplexity: entity.cyclomaticComplexity } : {}),
      ...(entity.coverageFileHitRate !== undefined ? { coverageFileHitRate: entity.coverageFileHitRate } : {}),
      ...(entity.coverageUntestedRanges?.length ? {
        coverageUntestedRanges: entity.coverageUntestedRanges.map(range => ({
          startLine: range.startLine,
          endLine: range.endLine,
        })),
      } : {}),
      ...(entity.untestedBehaviours?.length ? {
        untestedBehaviours: entity.untestedBehaviours.map(item => ({
          startLine: item.startLine,
          endLine: item.endLine,
          behaviour: item.behaviour,
        })),
      } : {}),
      ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
      ...(entity.fingerprint ? { fingerprint: entity.fingerprint } : {}),
    };
  });
  const relations: ArchitectureRelation[] = snapshot.relations.map(([, id]) => {
    const relation = state.relationById[id];
    if (!relation) throw new Error(`Missing normalized relation ${id}`);
    return {
      id: relation.logicalId,
      ...(relation.lineageId ? { lineageId: relation.lineageId } : {}),
      ...(relation.fingerprint ? { fingerprint: relation.fingerprint } : {}),
      from: state.entityById[relation.from[1]]!.logicalId,
      to: state.entityById[relation.to[1]]!.logicalId,
      kind: relation.kind,
      evidence: relation.evidence.map(([, evidenceId]) => {
        const evidence = state.evidenceById[evidenceId]!;
        return {
          source: sourceFromRow(state.sourceRefById[evidence.source[1]]!),
          ...(evidence.reason ? { reason: evidence.reason } : {}),
        };
      }),
      ...(relation.label ? { label: relation.label } : {}),
      ...(relation.technology ? { technology: relation.technology } : {}),
      ...(relation.optional !== undefined ? { optional: relation.optional } : {}),
      ...(relation.confidence !== undefined ? { confidence: relation.confidence } : {}),
    };
  });
  return {
    schemaVersion: 1,
    id: snapshot.id,
    repositoryId: snapshot.repository[1],
    commitSha: snapshot.commitSha,
    generatedAt: snapshot.generatedAt,
    entities,
    relations,
  };
}

export function selectArchitectureView(state: NormalizedArchitecture, viewId: string): ArchitectureView {
  const view = state.viewById[viewId];
  if (!view) throw new Error(`Unknown normalized view ${viewId}`);
  const layout = state.layoutById[view.layout[1]];
  if (!layout) throw new Error(`Missing normalized layout ${view.layout[1]}`);
  const nodes: Record<string, NodeLayout> = {};
  for (const [, placementId] of layout.nodePlacements) {
    const placement = state.nodePlacementById[placementId]!;
    nodes[state.entityById[placement.entity[1]]!.logicalId] = { ...placement.bounds };
  }
  const edges: Record<string, EdgeLayout> = {};
  for (const [, routeId] of layout.edgeRoutes) {
    const route = state.edgeRouteById[routeId]!;
    edges[state.relationById[route.relation[1]]!.logicalId] = { points: route.route.points.map(point => ({ ...point })) };
  }
  return {
    schemaVersion: 1,
    id: view.id,
    snapshotId: view.snapshot[1],
    name: view.name,
    rootEntityId: state.entityById[view.rootEntity[1]]!.logicalId,
    entityIds: view.entities.map(([, id]) => state.entityById[id]!.logicalId),
    relationIds: view.relations.map(([, id]) => state.relationById[id]!.logicalId),
    layout: { nodes, edges },
  };
}

export function selectArchitectureStory(state: NormalizedArchitecture, storyId: string): ArchitectureStory {
  const story = state.storyById[storyId];
  if (!story) throw new Error(`Unknown normalized story ${storyId}`);
  return {
    schemaVersion: 1,
    id: story.id,
    snapshotId: story.snapshot[1],
    viewId: story.view[1],
    title: story.title,
    steps: story.keyframes.map(([, id]) => {
      const keyframe = state.storyKeyframeById[id]!;
      return {
        id: id.slice(`${story.id}::`.length),
        title: keyframe.title,
        focusEntityIds: keyframe.focusEntities.map(([, entityId]) => state.entityById[entityId]!.logicalId),
        narration: keyframe.narration,
        ...(keyframe.holdMs > 0 ? { durationMs: keyframe.holdMs } : {}),
        ...(keyframe.traceRelations.length ? {
          traceRelationIds: keyframe.traceRelations.map(([, relationId]) => state.relationById[relationId]!.logicalId),
        } : {}),
        ...(keyframe.reveal ? { reveal: keyframe.reveal } : {}),
        ...(keyframe.sourceRefs.length ? {
          sourceRefs: keyframe.sourceRefs.map(([, sourceId]) => sourceFromRow(state.sourceRefById[sourceId]!)),
        } : {}),
      };
    }),
  };
}

export function selectScopedView(state: NormalizedArchitecture, viewId: string, rootEntityId: string): ArchitectureView {
  const view = selectArchitectureView(state, viewId);
  const snapshot = selectArchitectureSnapshot(state, view.snapshotId);
  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  if (!view.entityIds.includes(rootEntityId)) throw new Error(`Root ${rootEntityId} is outside normalized view ${viewId}`);
  const included = new Set<string>([rootEntityId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entity of snapshot.entities) {
      if (entity.parentId && included.has(entity.parentId) && view.entityIds.includes(entity.id) && !included.has(entity.id)) {
        included.add(entity.id);
        changed = true;
      }
    }
  }
  let parent = entityById.get(rootEntityId)?.parentId;
  while (parent && view.entityIds.includes(parent)) {
    included.add(parent);
    parent = entityById.get(parent)?.parentId;
  }
  const containmentScope = new Set(included);
  for (const relation of snapshot.relations) {
    if (!view.relationIds.includes(relation.id)) continue;
    if (containmentScope.has(relation.from) && view.entityIds.includes(relation.to)) included.add(relation.to);
    if (containmentScope.has(relation.to) && view.entityIds.includes(relation.from)) included.add(relation.from);
  }
  const entityIds = view.entityIds.filter(id => included.has(id));
  const relationIds = view.relationIds.filter(id => {
    const relation = snapshot.relations.find(candidate => candidate.id === id);
    return Boolean(relation && included.has(relation.from) && included.has(relation.to));
  });
  const nodes = Object.fromEntries(entityIds.map(id => [id, view.layout.nodes[id]!]).filter(([, bounds]) => bounds));
  const edges = Object.fromEntries(relationIds.map(id => [id, view.layout.edges?.[id]]).filter(([, route]) => route));
  return { ...view, rootEntityId, entityIds, relationIds, layout: { nodes, edges } };
}
