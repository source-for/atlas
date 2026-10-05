import { scanCodeRevealWindow } from '../semantic/scanCodeRevealWindow';
import {
  buildC4ProjectionBundle,
  c4CodeChildSlots,
  c4ScanComponentCardFace,
  materializeArchitectureAuthoring,
  selectC4BandProjection,
  validateStory,
  type C4ProjectionBundle,
  type ArchitectureSnapshot,
  type ArchitectureAuthoringDocument,
  type ArchitectureEntity,
  type ArchitectureStory,
  type ArchitectureView,
  type C4Band,
  type ContainmentEntity,
  type EntityKind,
  type NodeLayout,
  type SourceRef,
} from '@okie/architecture';
import {
  GOLDEN_WORKTREE_REVISION,
  compileAuthoredC4Scene,
  compileC4Scene,
  coverageRevealZoomWindow,
  diffSceneSnapshots,
  goldenSnapshot,
  goldenStory,
  goldenView,
  NO_SUMMARY_SUPPLIED,
  type SceneSnapshot,
} from '@okie/scene-compiler';
import { scanCompileFocusForBand, scanEntityHasChildren, scanEntityIsInSubtree, scanSubtreeMembership } from './lazyBandCompile';
import type { AtlasScene, Camera, EntityKind as AtlasEntityKind, OmittedEdge, OmittedNode, OmittedRelation, ScopedCompileInfo, SceneEntity, SceneRelation, SemanticDetail } from './types';

const bands: readonly C4Band[] = ['context', 'container', 'component', 'code'];

function atlasKind(kind: EntityKind): AtlasEntityKind {
  if (kind === 'person') return 'person';
  if (kind === 'container') return 'container';
  if (kind === 'dataStore') return 'store';
  if (kind === 'queue') return 'queue';
  if (kind === 'component' || kind === 'code') return 'component';
  return 'system';
}

function humanKind(kind: EntityKind): string {
  const labels: Record<EntityKind, string> = {
    person: 'Person',
    softwareSystem: 'Software system',
    externalSystem: 'External system',
    container: 'Container',
    dataStore: 'Data store',
    queue: 'Queue',
    component: 'Component',
    code: 'Source',
    boundary: 'Boundary',
  };
  return labels[kind];
}

function detailForKind(kind: EntityKind): SemanticDetail {
  if (kind === 'container' || kind === 'dataStore' || kind === 'queue') return 'container';
  if (kind === 'component') return 'component';
  if (kind === 'code') return 'code';
  return 'context';
}

export function entityForScene(
  entity: ArchitectureEntity,
  boundsByBand: Partial<Record<C4Band, { x: number; y: number; width: number; height: number }>>,
): SceneEntity {
  const detail = detailForKind(entity.kind);
  const bounds = boundsByBand[detail]
    ?? bands.flatMap(band => boundsByBand[band] ? [boundsByBand[band]!] : [])[0]
    ?? { x: 0, y: 0, width: 1, height: 1 };
  const sourceRefs = entity.sourceRefs.map(source => ({
    path: source.path,
    ...(source.symbol ? { symbol: source.symbol } : {}),
    ...(source.startLine !== undefined ? { startLine: source.startLine } : {}),
    ...(source.endLine !== undefined ? { endLine: source.endLine } : {}),
    revision: source.commitSha,
  }));
  return {
    id: entity.id,
    ...(entity.parentId ? { parentId: entity.parentId } : {}),
    name: entity.name,
    kind: atlasKind(entity.kind),
    kindLabel: humanKind(entity.kind),
    detail,
    responsibility: entity.responsibility?.trim() ? entity.responsibility : NO_SUMMARY_SUPPLIED,
    ...(entity.technology?.length ? { technology: entity.technology.join(' · ') } : {}),
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    ...(sourceRefs[0] ? { source: sourceRefs[0].path } : {}),
    ...(sourceRefs.length ? { sourceRefs } : {}),
    ...(entity.sourceExcerpts?.length ? {
      sourceExcerpts: entity.sourceExcerpts.map(excerpt => ({
        ...excerpt,
        lines: [...excerpt.lines],
      })),
    } : {}),
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
  };
}

export type AppStoryPlanStep = {
  id: string;
  title: string;
  narration: string;
  focusEntityIds: string[];
  traceRelationIds: string[];
  reveal: SemanticDetail;
  sourceRefs: SourceRef[];
  authoredHoldMs?: number;
};

export type AppStoryPlan = {
  id: string;
  snapshotId: string;
  viewId: string;
  title: string;
  steps: AppStoryPlanStep[];
};

function storyReveal(snapshot: ArchitectureSnapshot, step: ArchitectureStory['steps'][number]): SemanticDetail {
  if (step.reveal) return step.reveal;
  const ranks = step.focusEntityIds.map(id => {
    const entity = snapshot.entities.find(candidate => candidate.id === id);
    return entity ? bands.indexOf(detailForKind(entity.kind)) : 0;
  });
  return bands[Math.max(0, ...ranks)]!;
}

/** Resolves semantic authoring into the complete host playback contract. */
export function compileAppStoryPlan(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  story: ArchitectureStory,
  options: { allowMissingFocus?: boolean } = {},
): AppStoryPlan {
  const issues = validateStory(snapshot, view, story).filter(issue => {
    if (!options.allowMissingFocus) return true;
    return !/not in view|does not cite snapshot evidence|not connected to a focused entity/u.test(issue.message);
  });
  if (issues.length) {
    throw new Error(`Cannot prepare invalid app story: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  return {
    id: story.id,
    snapshotId: story.snapshotId,
    viewId: story.viewId,
    title: story.title,
    steps: story.steps.map(step => ({
      id: step.id,
      title: step.title,
      narration: step.narration,
      focusEntityIds: [...step.focusEntityIds],
      traceRelationIds: [...(step.traceRelationIds ?? [])],
      reveal: storyReveal(snapshot, step),
      sourceRefs: (step.sourceRefs ?? []).map(source => ({ ...source })),
      ...(step.durationMs !== undefined ? { authoredHoldMs: step.durationMs } : {}),
    })),
  };
}

export const goldenAppStory = compileAppStoryPlan(goldenSnapshot, goldenView, goldenStory);

export type C4SceneOptions = {
  /** Worker diagnostics receives fixed milestones only, never semantic data. */
  onPhase?: (phase: 'projection' | 'layout' | 'adapter') => void;
  baseSnapshot: ArchitectureSnapshot;
  rootEntityId: string;
  focusEntityId: string;
  familyId: string;
  sceneId: string;
  title: string;
  subtitle: string;
  frozenRevision: string;
  previous?: AtlasScene;
  authoring?: ArchitectureAuthoringDocument;
  /** Scoped-compile options (scan mode); omitted for the golden fixture so its
   *  compile stays byte-identical. */
  maxBand?: C4Band;
  maxEdgesPerBand?: number;
  maxGridNodes?: number;
  maxNodesPerBand?: number;
  pageCodeLandmarks?: boolean;
  /** CLA-120: L2 landmark file-pill cap per container. Omitted for golden. */
  maxL2PreviewPillsPerOwner?: number;
  residentWorldBounds?: { x: number; y: number; width: number; height: number };
  keepEntityIds?: readonly string[];
  /** Aspect-aware packing target (scan mode, task #30); omitted for the golden fixture
   *  so its compile stays byte-identical. Applied at all repo sizes (a per-mode opt-in,
   *  independent of the scoped-compile size gates). */
  targetAspect?: number;
  scanCodeSafeWidth?: number;
  /** Size gate value for the dev diagnostics line (scan mode); display-only. */
  bandDepthThreshold?: number;
  /** Published child counts so owners reserve nested footprints (CLA-81). */
  childCounts?: Readonly<Record<string, number>>;
  unpublishedChildren?: readonly ContainmentEntity[];
};

/**
 * Resolves the relations dropped from routing under an edge budget into an
 * enumerable "+N more" list (from/to names + unioned evidence paths). Empty when
 * no band carries omittedEdgeIds (the golden fixture and any unbounded scope).
 */
export function resolveOmittedRelations(bundle: C4ProjectionBundle, snapshot: ArchitectureSnapshot): OmittedRelation[] {
  const omittedEdgeIds = [...new Set(Object.values(bundle.projectionById).flatMap(projection => projection.omittedEdgeIds ?? []))].sort();
  if (!omittedEdgeIds.length) return [];
  const nameById = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
  const relationById = new Map(snapshot.relations.map(relation => [relation.id, relation]));
  const byRelationId = new Map<string, OmittedRelation>();
  for (const edgeId of omittedEdgeIds) {
    const edge = bundle.visualEdgeById[edgeId];
    for (const relationId of bundle.index.relationIdsByVisualEdgeId[edgeId] ?? []) {
      if (byRelationId.has(relationId)) continue;
      const relation = relationById.get(relationId);
      const fromId = (edge && bundle.index.entityIdByVisualNodeId[edge.fromVisualId]) ?? relation?.from ?? '';
      const toId = (edge && bundle.index.entityIdByVisualNodeId[edge.toVisualId]) ?? relation?.to ?? '';
      byRelationId.set(relationId, {
        relationId,
        fromName: nameById.get(fromId) ?? fromId,
        toName: nameById.get(toId) ?? toId,
        label: relation?.label ?? edge?.label ?? relation?.kind ?? 'relates to',
        evidencePaths: [...new Set((relation?.evidence ?? []).map(evidence => evidence.source.path))].sort(),
      });
    }
  }
  return [...byRelationId.values()].sort((left, right) => left.relationId.localeCompare(right.relationId));
}

/**
 * Resolves L3/L4 nodes the camera-resident window kept out of the compiled
 * scene. Empty when no band carries omittedNodeIds (golden / unbounded).
 */
export function resolveOmittedNodes(bundle: C4ProjectionBundle, snapshot: ArchitectureSnapshot): OmittedNode[] {
  const nameById = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
  const parentById = new Map(snapshot.entities.map(entity => [entity.id, entity.parentId]));
  return bands.flatMap(band => {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]];
    return [...(projection?.omittedNodeIds ?? [])].sort().flatMap(visualId => {
      const node = bundle.visualNodeById[visualId];
      const entityId = node?.entity.logicalId ?? bundle.index.entityIdByVisualNodeId[visualId];
      if (!entityId) return [];
      const parentId = parentById.get(entityId);
      return [{
        entityId,
        detail: band as SemanticDetail,
        name: nameById.get(entityId) ?? node?.name ?? entityId,
        ...(parentId ? { parentId } : {}),
      }];
    });
  });
}

/**
 * Resolves the same drop as {@link resolveOmittedRelations}, keyed by visual edge
 * and band instead of by relation. The inspector needs the projected endpoint IDs
 * to attribute "+N more" to the selected card; the relation-keyed list only carries
 * display names and collapses an edge omitted in several bands into one row.
 */
export function resolveOmittedEdges(bundle: C4ProjectionBundle, snapshot: ArchitectureSnapshot): OmittedEdge[] {
  const nameById = new Map(snapshot.entities.map(entity => [entity.id, entity.name]));
  const relationById = new Map(snapshot.relations.map(relation => [relation.id, relation]));
  return bands.flatMap(band => {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]];
    return [...(projection?.omittedEdgeIds ?? [])].sort().flatMap(edgeId => {
      const edge = bundle.visualEdgeById[edgeId];
      if (!edge) return [];
      const relationIds = bundle.index.relationIdsByVisualEdgeId[edgeId] ?? [];
      const fromId = bundle.index.entityIdByVisualNodeId[edge.fromVisualId] ?? '';
      const toId = bundle.index.entityIdByVisualNodeId[edge.toVisualId] ?? '';
      return [{
        edgeId,
        detail: band as SemanticDetail,
        fromId,
        toId,
        fromName: nameById.get(fromId) ?? fromId,
        toName: nameById.get(toId) ?? toId,
        label: edge.label || relationById.get(relationIds[0] ?? '')?.kind || 'relates to',
        relationCount: relationIds.length,
        ...(relationIds.length ? { semanticIds: [...relationIds] } : {}),
      }];
    });
  });
}

function entityLayoutHintsForCodePaging(
  previous: AtlasScene | undefined,
  snapshot: ArchitectureSnapshot,
): Record<string, NodeLayout> | undefined {
  const fromPrevious: Record<string, NodeLayout> = {};
  for (const [id, bands] of Object.entries(previous?.projection?.boundsByEntityIdAndDetail ?? {})) {
    const bounds = bands.component ?? bands.container ?? bands.context ?? bands.code;
    if (bounds) fromPrevious[id] = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }
  if (!Object.keys(fromPrevious).length) return undefined;
  // A code window needs every sibling's canonical grid slot to choose a late
  // symbol. These are bounds only: no omitted code objects, routes, or meshes
  // are compiled. The compiler consumes the same slot helper on materialize.
  for (const owner of snapshot.entities) {
    if (owner.kind !== 'component') continue;
    const codeOwner = previous?.projection?.boundsByEntityIdAndDetail[owner.id]?.code;
    if (!codeOwner) continue;
    const childIds = snapshot.entities
      .filter(entity => entity.parentId === owner.id && entity.kind === 'code')
      .map(entity => entity.id);
    Object.assign(fromPrevious, c4CodeChildSlots(codeOwner, childIds));
  }
  return fromPrevious;
}

function childCountsForCodePaging(
  snapshot: ArchitectureSnapshot,
  published: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const entity of snapshot.entities) {
    if (!entity.parentId) continue;
    counts[entity.parentId] = (counts[entity.parentId] ?? 0) + 1;
  }
  // Published scan counts can include children deliberately omitted from the
  // local snapshot, so they remain authoritative when present.
  return { ...counts, ...published };
}

/**
 * Compiles an architecture snapshot into the renderer scene + projection bundle.
 * Shared by the golden fixture and any live-loaded fixture (e.g. scanned
 * snapshots); fixture-specific labels/ids arrive through options so the compile
 * path (buildC4ProjectionBundle → compileC4Scene) stays identical for both.
 */
export function createC4Scene(options: C4SceneOptions): AtlasScene {
  const { baseSnapshot, authoring, previous } = options;
  const snapshot = authoring
    ? materializeArchitectureAuthoring(baseSnapshot, authoring)
    : baseSnapshot;
  let entityLayoutHints = options.pageCodeLandmarks
    ? entityLayoutHintsForCodePaging(previous, snapshot)
    : undefined;
  // A cold L4 URL has no previous component face to place its code window.
  // Build one bounded, unwindowed landmark scene first; its aligned L3 face is
  // then the coordinate space for the real camera-window selection. The
  // preflight retains the ordinary code cap, so it never materializes the full
  // repository's source meshes.
  if (options.pageCodeLandmarks && options.residentWorldBounds && !entityLayoutHints) {
    const landmark = createC4Scene({
      ...options,
      previous: undefined,
      residentWorldBounds: undefined,
      keepEntityIds: undefined,
    });
    entityLayoutHints = entityLayoutHintsForCodePaging(landmark, snapshot);
  }
  const buildOptions = {
    rootEntityId: options.rootEntityId,
    focusEntityId: options.focusEntityId,
    familyId: options.familyId,
    ...(options.maxBand ? { maxBand: options.maxBand } : {}),
    ...(options.maxEdgesPerBand !== undefined ? { maxEdgesPerBand: options.maxEdgesPerBand } : {}),
    ...(options.maxGridNodes !== undefined ? { maxGridNodes: options.maxGridNodes } : {}),
    ...(options.maxNodesPerBand !== undefined ? { maxNodesPerBand: options.maxNodesPerBand } : {}),
    ...(options.pageCodeLandmarks ? { pageCodeLandmarks: true } : {}),
    ...(options.maxL2PreviewPillsPerOwner !== undefined
      ? { maxL2PreviewPillsPerOwner: options.maxL2PreviewPillsPerOwner }
      : {}),
    ...(entityLayoutHints ? { entityLayoutHints } : {}),
    ...(options.residentWorldBounds ? { residentWorldBounds: options.residentWorldBounds } : {}),
    ...(options.keepEntityIds ? { keepEntityIds: options.keepEntityIds } : {}),
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
  };
  options.onPhase?.('projection');
  const authoredProjections = buildC4ProjectionBundle(snapshot, buildOptions);
  const previousSnapshot = previous?.protocolSnapshot as SceneSnapshot | undefined;
  const revision = previousSnapshot && previousSnapshot.sceneId === `scene:${baseSnapshot.repositoryId}:c4`
    ? previousSnapshot.revision + 1
    : 1;
  const scoped = options.maxBand !== undefined
    || options.maxEdgesPerBand !== undefined
    || options.maxGridNodes !== undefined
    || options.maxNodesPerBand !== undefined
    || options.residentWorldBounds !== undefined;
  const compileOptions = {
    revision,
    ...(options.maxGridNodes !== undefined ? { maxGridNodes: options.maxGridNodes } : {}),
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
    ...((options.pageCodeLandmarks || options.childCounts)
      ? { childCounts: options.pageCodeLandmarks
        ? childCountsForCodePaging(snapshot, options.childCounts)
        : options.childCounts }
      : {}),
    ...(options.unpublishedChildren?.length ? { unpublishedChildren: options.unpublishedChildren } : {}),
  };
  options.onPhase?.('layout');
  const compiled = authoring
    ? compileAuthoredC4Scene(baseSnapshot, authoring, buildOptions, compileOptions)
    // routeOverrides:[] is a no-op for routing but makes compileC4Scene return route
    // diagnostics, so the scan diagnostics line can surface the direct-fallback count.
    : compileC4Scene(snapshot, authoredProjections, scoped ? { ...compileOptions, routeOverrides: [] } : compileOptions);
  options.onPhase?.('adapter');
  const directFallbackCount = (compiled.routeDiagnostics ?? [])
    .filter(diagnostic => diagnostic.routerDiagnostic === 'direct-fallback').length;
  const projections = compiled.projections;
  const semanticToVisualEntityId = Object.fromEntries(Object.entries(projections.index.visualNodeIdsByEntityId)
    .flatMap(([entityId, visualIds]) => visualIds[0] ? [[entityId, visualIds[0]]] : []));
  const visualToSemanticEntityId = { ...projections.index.entityIdByVisualNodeId };
  const focusedCodeWindow = options.targetAspect !== undefined
    && snapshot.entities.find(entity => entity.id === options.focusEntityId)?.kind === 'component'
    ? scanCodeRevealWindow(
      // A bootstrap system scene contains compact preview pills, not the L3
      // peer face. Cold code restoration must use the same painted L3 face
      // as descent from the owning container, never that reserved/preview box.
      previous?.rootEntityId === snapshot.entities.find(entity => entity.id === options.focusEntityId)?.parentId
        ? previous?.projection?.boundsByEntityIdAndDetail[options.focusEntityId]?.component
          ?? c4ScanComponentCardFace(options.targetAspect)
        : c4ScanComponentCardFace(options.targetAspect), options.scanCodeSafeWidth) : undefined;
  if (focusedCodeWindow) {
    const ownsCode = scanSubtreeMembership(snapshot, options.focusEntityId);
    for (const object of compiled.scene.objects) {
      const id = visualToSemanticEntityId[object.id];
      if (!id || !ownsCode(id)) continue;
      for (const representation of object.representations) {
        if (representation.id !== `${object.id}:code`) continue;
        representation.lod = { ...representation.lod, minZoom: focusedCodeWindow.startZoom,
          fadeWidth: focusedCodeWindow.fullZoom - focusedCodeWindow.startZoom };
      }
    }
    const ownedPaths = new Set(selectC4BandProjection(projections, 'code').edges.filter(edge =>
      ownsCode(visualToSemanticEntityId[edge.fromVisualId] ?? '') && ownsCode(visualToSemanticEntityId[edge.toVisualId] ?? '')).map(edge => edge.id));
    for (const path of compiled.scene.paths) if (ownedPaths.has(path.id)) path.lod = { ...path.lod,
      minZoom: focusedCodeWindow.startZoom, fadeWidth: focusedCodeWindow.fullZoom - focusedCodeWindow.startZoom };
  }
  const visualToSemanticRelationIds = { ...projections.index.relationIdsByVisualEdgeId };
  const semanticToVisualRelationIds = { ...projections.index.visualEdgeIdsByRelationId };
  const entityIdsByDetail = Object.fromEntries(bands.map(band => {
    const projection = selectC4BandProjection(projections, band);
    return [band, projection.nodes.map(node => node.entity.logicalId)];
  })) as Record<SemanticDetail, string[]>;
  const relationIdsByDetail = Object.fromEntries(bands.map(band => {
    const projection = selectC4BandProjection(projections, band);
    return [band, projection.edges.map(edge => edge.id)];
  })) as Record<SemanticDetail, string[]>;
  const protocolPathById = new Map(compiled.scene.paths.map(path => [path.id, path]));
  const projectedRelationsByDetail = Object.fromEntries(bands.map(band => {
    const projection = selectC4BandProjection(projections, band);
    const relations: SceneRelation[] = projection.edges.map(edge => ({
      id: edge.id,
      from: projections.index.entityIdByVisualNodeId[edge.fromVisualId]!,
      to: projections.index.entityIdByVisualNodeId[edge.toVisualId]!,
      arrow: protocolPathById.get(edge.id)?.arrow ?? 'end',
      routePoints: edge.route.points.map(point => ({ ...point })),
      label: edge.label,
      kindLabel: edge.kind,
      semanticIds: edge.relations.map(relation => relation.logicalId),
    }));
    return [band, relations];
  })) as Record<SemanticDetail, SceneRelation[]>;
  const entities = snapshot.entities.map(entity => entityForScene(
    entity,
    projections.index.boundsByEntityIdAndBand[entity.id] ?? {},
  ));
  const semanticTransitionsByEntityId = Object.fromEntries(entities.map(entity => {
    const visualId = semanticToVisualEntityId[entity.id];
    const object = compiled.scene.objects.find(candidate => candidate.id === visualId);
    const transitions = bands.slice(1).flatMap((nextDetail, index) => {
      const currentDetail = bands[index]!;
      const source = object?.representations.find(representation => representation.id === `${visualId}:${currentDetail}`);
      const target = object?.representations.find(representation => representation.id === `${visualId}:${nextDetail}`);
      const currentBounds = projections.index.boundsByEntityIdAndBand[entity.id]?.[currentDetail];
      const nextBounds = projections.index.boundsByEntityIdAndBand[entity.id]?.[nextDetail];
      if (!source || !target || !currentBounds || !nextBounds) return [];
      const nextBand = compiled.zoomPolicy.bands.find(band => band.detail === nextDetail)!;
      const largestTargetText = target.primitives.reduce((largest, primitive) =>
        primitive.kind === 'text' ? Math.max(largest, primitive.fontSize) : largest, 0);
      // Scan mode (targetAspect set): the reveal runway follows the coverage contract —
      // children start revealing when the owner's expanded box would cover
      // COVERAGE_REVEAL.start of the nominal viewport, never later than the band's own
      // enter/fade window. A large scanned owner otherwise outgrows the screen long
      // before the fixed band runway begins (user report: "empty node past full screen").
      // Same box and math as the compiler's coverageRevealLod → one reveal moment.
      // Golden/demo (no targetAspect) keeps the band runway byte-identically.
      const revealWindow = options.targetAspect !== undefined
        ? coverageRevealZoomWindow(nextBounds, nextDetail, options.targetAspect)
        : undefined;
      return [[nextDetail, {
        currentDetail,
        nextDetail,
        sourceRepresentationId: source.id,
        targetRepresentationId: target.id,
        enterCoverage: { major: 0.72, minor: 0.42 },
        commitCoverage: { major: 0.78, minor: 0.46 },
        fullCoverage: { major: 0.84, minor: 0.50 },
        leaveCoverage: { major: 0.58, minor: 0.30 },
        minimumCssSize: {
          width: Math.max(320, largestTargetText * 10),
          height: Math.max(180, largestTargetText * 4),
        },
        minZoom: nextDetail === 'code' && entity.id === options.focusEntityId && focusedCodeWindow
          ? focusedCodeWindow.startZoom : revealWindow?.minZoom ?? nextBand.enterZoom,
        fullZoom: Math.min(
          compiled.zoomPolicy.maxZoom,
          nextDetail === 'code' && entity.id === options.focusEntityId && focusedCodeWindow
            ? focusedCodeWindow.fullZoom : revealWindow?.fullZoom ?? nextBand.enterZoom + nextBand.fadeWidth,
        ),
        hysteresis: nextDetail === 'code' && entity.id === options.focusEntityId && focusedCodeWindow
          ? focusedCodeWindow.startZoom - focusedCodeWindow.leaveStartZoom : nextBand.hysteresis,
        transitionMs: 180,
        dwellMs: 80,
        pointerInsetPx: 24,
      }]];
    });
    return [entity.id, Object.fromEntries(transitions)];
  }));
  const omittedRelations = resolveOmittedRelations(authoredProjections, snapshot);
  const omittedEdges = resolveOmittedEdges(authoredProjections, snapshot);
  const omittedNodes = resolveOmittedNodes(authoredProjections, snapshot);
  const scopedCompile: ScopedCompileInfo | undefined = scoped ? {
    ...(options.maxBand !== undefined ? { maxBand: options.maxBand } : {}),
    ...(options.maxEdgesPerBand !== undefined ? { maxEdgesPerBand: options.maxEdgesPerBand } : {}),
    ...(options.maxGridNodes !== undefined ? { maxGridNodes: options.maxGridNodes } : {}),
    ...(options.maxNodesPerBand !== undefined ? { maxNodesPerBand: options.maxNodesPerBand } : {}),
    entityCount: snapshot.entities.length,
    bandDepthThreshold: options.bandDepthThreshold ?? 0,
    directFallbackCount,
  } : undefined;
  const scene: AtlasScene = {
    id: options.sceneId,
    title: options.title,
    subtitle: options.subtitle,
    rootEntityId: options.focusEntityId,
    frozenRevision: options.frozenRevision,
    ...(omittedRelations.length ? { omittedRelations } : {}),
    ...(omittedEdges.length ? { omittedEdges } : {}),
    ...(omittedNodes.length ? { omittedNodes } : {}),
    ...(scopedCompile ? { scopedCompile } : {}),
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
    ...(options.scanCodeSafeWidth !== undefined ? { scanCodeSafeWidth: options.scanCodeSafeWidth } : {}),
    entities,
    relations: snapshot.relations.map(relation => ({
      id: relation.id,
      from: relation.from,
      to: relation.to,
      ...(relation.label ? { label: relation.label } : {}),
      kindLabel: relation.kind,
      ...(relation.technology ? { protocol: relation.technology } : {}),
    })),
    regions: [],
    protocolSnapshot: compiled.scene,
    projection: {
      familyId: projections.family.id,
      semanticToVisualEntityId,
      visualToSemanticEntityId,
      semanticToVisualRelationIds,
      visualToSemanticRelationIds,
      boundsByEntityIdAndDetail: projections.index.boundsByEntityIdAndBand,
      entityIdsByDetail,
      relationIdsByDetail,
      projectedRelationsByDetail,
      semanticTransitionsByEntityId,
      zoomPolicy: {
        minZoom: compiled.zoomPolicy.minZoom,
        maxZoom: compiled.zoomPolicy.maxZoom,
        bands: compiled.zoomPolicy.bands.map(band => ({ ...band })),
      },
    },
  };
  if (previousSnapshot && previousSnapshot.sceneId === compiled.scene.sceneId) {
    // Root changes are paired with camera motion in the shell. Geometry is
    // patched once; keeping interpolation out of the static scene avoids a
    // full WebGPU/WebGL2 mesh rebuild on every animation frame.
    scene.protocolPatch = diffSceneSnapshots(previousSnapshot, compiled.scene);
  }
  return scene;
}

export function createGoldenC4Scene(
  focusEntityId = 'system:okie',
  previous?: AtlasScene,
  authoring?: ArchitectureAuthoringDocument,
): AtlasScene {
  return createC4Scene({
    baseSnapshot: goldenSnapshot,
    rootEntityId: 'system:okie',
    focusEntityId,
    familyId: `view-family:okie-golden:${focusEntityId}`,
    sceneId: 'okie-golden-c4',
    title: 'Okie architecture atlas',
    subtitle: `frozen worktree fixture · ${GOLDEN_WORKTREE_REVISION}`,
    frozenRevision: GOLDEN_WORKTREE_REVISION,
    previous,
    authoring,
  });
}

export function semanticBounds(scene: AtlasScene, entityId: string, detail: SemanticDetail) {
  return scene.projection?.boundsByEntityIdAndDetail[entityId]?.[detail];
}

/**
 * CLA-104: a camera-tile refresh after L2→L3 handoff can look at the reserved
 * owner-shell interior and page every file-component out of the compiled scene.
 * Keep the unwindowed neighborhood when the windowed compile would drop that graph.
 */
export function scanWindowedCompileDropsPeerGraph(
  current: AtlasScene,
  next: AtlasScene,
  ownerId: string,
  detail: SemanticDetail,
): boolean {
  const drops = (band: SemanticDetail) =>
    scanDeeperBandHasPeerCards(current, ownerId, band)
    && !scanDeeperBandHasPeerCards(next, ownerId, band);
  // Dropping the current band's peer graph, or stripping L4 landmarks during
  // an L3 camera settle, would leave wheel with no code targets to morph into.
  if (detail === 'context' || detail === 'container' || detail === 'component' || detail === 'code') {
    return drops('component') || drops('code');
  }
  return false;
}

/**
 * True when `ownerId` has at least one descendant card at `detail` in the
 * compiled scene. CLA-81 reserved owner shells publish bounds at the next
 * band without those peer cards — that is not a laid-out C4 map.
 */
export function scanDeeperBandHasPeerCards(
  scene: AtlasScene,
  ownerId: string,
  detail: SemanticDetail,
): boolean {
  const listed = scene.projection?.entityIdsByDetail?.[detail];
  const visible = listed ? new Set(listed) : undefined;
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  return scene.entities.some(entity => {
    if (entity.id === ownerId || (entity.detail ?? 'context') !== detail) return false;
    if (visible && !visible.has(entity.id)) return false;
    let current: SceneEntity | undefined = entity;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.id === ownerId) return true;
      seen.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  });
}

/**
 * CLA-106: sibling container-rank cards still in the compiled L3 neighborhood
 * (same parent as `focusContainerId`, with world bounds). Empty when the
 * scene re-rooted into a void.
 */
export function scanPeerContainerIds(scene: AtlasScene, focusContainerId: string): string[] {
  const focus = scene.entities.find(entity => entity.id === focusContainerId);
  if (!focus?.parentId) return [];
  const visible = new Set([
    ...(scene.projection?.entityIdsByDetail.container ?? []),
    ...(scene.projection?.entityIdsByDetail.component ?? []),
  ]);
  return scene.entities
    .filter(entity => {
      if (entity.id === focusContainerId || entity.parentId !== focus.parentId) return false;
      if (entity.kind !== 'container' && entity.kind !== 'store' && entity.kind !== 'queue') return false;
      if (visible.size && !visible.has(entity.id)) return false;
      return Boolean(
        semanticBounds(scene, entity.id, 'component')
        ?? semanticBounds(scene, entity.id, 'container'),
      );
    })
    .map(entity => entity.id)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * The band a scan-mode "Open inside" must recompile into when the target's deeper
 * scope was scoped OUT of the current scene, or undefined when a plain lens drill
 * suffices. Children are read from the snapshot when provided (the compiled scene
 * is per-neighborhood and may omit descendants). Returns undefined for a leaf,
 * a childless target, or a target whose deeper band is ALREADY laid out as peer
 * cards in *this* neighborhood (compile root is the target). A reserved owner
 * shell (bounds without descendant peers) is not laid out. CLA-107 still
 * pre-places L3 pills in the system scene; Open inside a container returns
 * the deeper band (explicit drill). CLA-117 wheel matches that drill for fat
 * L2 shells — pills are not a laid-out neighborhood. Pure — never compiles.
 */
export function scanDrillDeeperDetail(
  scene: AtlasScene,
  target: SceneEntity,
  snapshot?: ArchitectureSnapshot,
): SemanticDetail | undefined {
  const deeper = bands[bands.indexOf(target.detail ?? 'context') + 1];
  if (!deeper) return undefined;
  const hasChildren = snapshot
    ? scanEntityHasChildren(snapshot, target.id)
    : scene.entities.some(entity => entity.parentId === target.id);
  if (!hasChildren) return undefined;
  if (semanticBounds(scene, target.id, deeper) && scanDeeperBandHasPeerCards(scene, target.id, deeper)) {
    // Already compiled this neighborhood. Landmarks in a parent (system) scene
    // are not the container graph — Open inside still drills. CLA-117 wheel
    // follows the same rule for fat L2 shells with resident pills.
    if (!scene.rootEntityId || scene.rootEntityId === target.id) return undefined;
  }
  return deeper;
}

/**
 * CLA-104/117: continuous-zoom compile target for scan mode.
 *
 * L1 already includes container bounds (`maxBand: container`), so L1→L2 wheel
 * stays in the current scene (stable identities + representation crossfade).
 * CLA-107/109 still pre-place L3/L4 pills inside compact L2 tiles on small
 * repos, but those pills are not a laid-out neighborhood: zooming a fat
 * container past L2→L3 must re-root that container (same outcome as Open
 * inside). Stay only when the current compile focus already *is* that
 * neighborhood. From the system L2 scene, L2→L4 overshoot still opens the
 * container at component — never a file from that L2 shell. After the re-root,
 * a later settle/wheel at code zoom is ordinary L3→L4 (CLA-65) *inside that
 * opened container* (CLA-122) — not a CLA-106 peer's file under the pointer.
 * Pure — never compiles. Undefined when the current scene already shows that
 * band's peer graph, or the focused container has no children to open.
 */
export function scanZoomCompileHandoff(
  scene: AtlasScene,
  snapshot: ArchitectureSnapshot,
  preferredEntityId: string,
  viewRootId: string,
  detail: SemanticDetail,
  currentCompileFocus = scene.rootEntityId ?? viewRootId,
): { detail: SemanticDetail; compileFocus: string } | undefined {
  let compileFocus = scanCompileFocusForBand(snapshot, preferredEntityId, detail, viewRootId);
  if (detail === 'context' || detail === 'container') {
    return compileFocus === currentCompileFocus ? undefined : { detail, compileFocus };
  }
  // CLA-117: resident pills under the L2 system root are not a container
  // neighborhood. Wheel into a code-bearing package re-roots that package
  // at L3 (Open inside). L2→L4 overshoot must not jump into a file.
  if (currentCompileFocus === viewRootId) {
    const containerFocus = scanCompileFocusForBand(snapshot, preferredEntityId, 'component', viewRootId);
    if (containerFocus !== viewRootId && scanEntityHasChildren(snapshot, containerFocus)) {
      return { detail: 'component', compileFocus: containerFocus };
    }
    return undefined;
  }
  // CLA-122: already inside an opened container. Do not re-root L3→L4 into a
  // sibling container's file (those shells stay in world space after CLA-106).
  if (!scanEntityIsInSubtree(snapshot, compileFocus, currentCompileFocus)) {
    compileFocus = scanCompileFocusForBand(snapshot, currentCompileFocus, detail, viewRootId);
  }
  if (compileFocus === currentCompileFocus && scanDeeperBandHasPeerCards(scene, compileFocus, detail)) {
    return undefined;
  }
  if (detail === 'component' && !scanEntityHasChildren(snapshot, compileFocus)) return undefined;
  return { detail, compileFocus };
}

type ScanZoomPoint = { x: number; y: number };
type ScanZoomViewport = { width: number; height: number };

function scanZoomWorldPoint(
  pointer: ScanZoomPoint,
  camera: Camera,
  viewport: ScanZoomViewport,
): ScanZoomPoint {
  const zoom = camera.zoom > 0 ? camera.zoom : 1;
  return {
    x: camera.x + (pointer.x - viewport.width / 2) / zoom,
    y: camera.y + (pointer.y - viewport.height / 2) / zoom,
  };
}

function scanZoomBoundsContain(bounds: ScanZoomPoint & ScanZoomViewport, point: ScanZoomPoint) {
  return point.x >= bounds.x
    && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y
    && point.y <= bounds.y + bounds.height;
}

/**
 * CLA-105: current-band entity under the wheel/pinch pointer. Prefers the
 * smallest containing bounds so a nested container wins over the system shell.
 * Undefined when the pointer misses every current-band card.
 */
export function scanZoomEntityUnderPointer(
  scene: AtlasScene,
  camera: Camera,
  viewport: ScanZoomViewport,
  pointer: ScanZoomPoint | undefined,
  currentDetail: SemanticDetail,
): string | undefined {
  if (!pointer || !scene.projection) return undefined;
  const visible = new Set(scene.projection.entityIdsByDetail[currentDetail] ?? []);
  const world = scanZoomWorldPoint(pointer, camera, viewport);
  let best: { id: string; area: number } | undefined;
  for (const entity of scene.entities) {
    if (!visible.has(entity.id)) continue;
    const bounds = scene.projection.boundsByEntityIdAndDetail[entity.id]?.[currentDetail];
    if (!bounds || !(bounds.width > 0) || !(bounds.height > 0)) continue;
    if (!scanZoomBoundsContain(bounds, world)) continue;
    const area = bounds.width * bounds.height;
    if (!best || area < best.area || (area === best.area && entity.id.localeCompare(best.id) < 0)) {
      best = { id: entity.id, area };
    }
  }
  return best?.id;
}

/**
 * CLA-105: pointer-over entity when that entity can compile-handoff; otherwise
 * the inspector/fallback selection so the CLA-104 selected-container path stays.
 * CLA-122: once a container neighborhood is open, only a card inside that
 * neighborhood (or the container itself) may steal the pointer — a CLA-106
 * peer shell under the wheel must not become the L4 compile target.
 */
export function scanZoomHandoffPreferredId(
  scene: AtlasScene,
  snapshot: ArchitectureSnapshot,
  viewRootId: string,
  detail: SemanticDetail,
  currentCompileFocus: string,
  camera: Camera,
  viewport: ScanZoomViewport,
  pointer: ScanZoomPoint | undefined,
  currentDetail: SemanticDetail,
  fallbackId: string,
): string {
  const underPointer = scanZoomEntityUnderPointer(scene, camera, viewport, pointer, currentDetail);
  const inOpenedNeighborhood = !underPointer
    || currentCompileFocus === viewRootId
    || scanEntityIsInSubtree(snapshot, underPointer, currentCompileFocus);
  if (underPointer && inOpenedNeighborhood
    && scanZoomCompileHandoff(scene, snapshot, underPointer, viewRootId, detail, currentCompileFocus)) {
    return underPointer;
  }
  return fallbackId;
}
