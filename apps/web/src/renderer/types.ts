export type EntityKind = 'person' | 'system' | 'container' | 'component' | 'store' | 'queue';

export type SemanticDetail = 'context' | 'container' | 'component' | 'code';

export type SceneSourceRef = {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  revision: string;
};

export type SceneSourceExcerpt = {
  path: string;
  symbol?: string;
  language: 'typescript' | 'tsx' | 'javascript' | 'rust' | 'json' | 'markdown' | 'text';
  startLine: number;
  endLine: number;
  highlightLine: number;
  frozenRevision: string;
  lines: string[];
  text: string;
};

export type SceneEntity = {
  id: string;
  parentId?: string;
  name: string;
  kind: EntityKind;
  kindLabel?: string;
  detail?: SemanticDetail;
  responsibility: string;
  technology?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence?: number;
  source?: string;
  sourceRefs?: SceneSourceRef[];
  sourceExcerpts?: SceneSourceExcerpt[];
  tags?: string[];
  /** Observed CODEOWNERS (or equivalent) path owners. Omitted when the repo has none. */
  owners?: string[];
  /** Observed McCabe cyclomatic complexity. Omitted when the entity is not function-like. */
  cyclomaticComplexity?: number;
  /** Observed lcov file hit rate (0–1). Omitted when no sidecar covers this file. */
  coverageFileHitRate?: number;
  /** Observed untested instrumented ranges overlapping this code entity. */
  coverageUntestedRanges?: Array<{ startLine: number; endLine: number }>;
  /** Enrichment-named untested behaviours grounded in those ranges. */
  untestedBehaviours?: Array<{ startLine: number; endLine: number; behaviour: string }>;
};

export type SceneRelation = {
  id: string;
  from: string;
  to: string;
  arrow?: 'none' | 'end' | 'both';
  /** Canonical band-specific world-space polyline, copied from the compiled projection route. */
  routePoints?: Array<{ x: number; y: number }>;
  label?: string;
  kindLabel?: string;
  semanticIds?: string[];
  protocol?: string;
};

export type SceneRegion = {
  id: string;
  name: string;
  showLabel?: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
};

/** A relation the scan-mode scoped compile kept out of routing (over the per-band
 *  edge budget), still enumerable for the inspector "+N more" affordance. */
export type OmittedRelation = {
  relationId: string;
  fromName: string;
  toName: string;
  label: string;
  evidencePaths: string[];
};

/** An L3/L4 node the camera-resident window kept out of the compiled scene,
 *  still enumerable for inspector "+N more". */
export type OmittedNode = {
  entityId: string;
  detail: SemanticDetail;
  name: string;
  parentId?: string;
};

/** The unrouted counterpart of a drawn edge: same band, same projected endpoints,
 *  but over the per-band edge budget so the canvas never drew it. Endpoint IDs let
 *  the selected card report exactly its own "+N more". */
export type OmittedEdge = {
  edgeId: string;
  detail: SemanticDetail;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  label: string;
  /** Canonical relations collapsed into this edge. */
  relationCount: number;
  /** Relation ids collapsed into this unrouted edge, when the compile recorded them. */
  semanticIds?: string[];
};

/** Dev-mode observability for the scan scoped compile (absent when unbounded). */
export type ScopedCompileInfo = {
  maxBand?: SemanticDetail;
  maxEdgesPerBand?: number;
  maxGridNodes?: number;
  maxNodesPerBand?: number;
  entityCount: number;
  bandDepthThreshold: number;
  directFallbackCount: number;
};

/** Set when the scan-mode compile guard refused an unbounded above-hang-guard
 *  focus (a full-graph compile — the deep-link hang vector) and substituted a
 *  safe scoped scene. Dev-diagnostics only; absent on a normal scoped compile. */
export type ScanGuardRefusal = {
  /** The focus the caller asked for (would have compiled the whole graph). */
  requestedFocusId: string;
  /** Entities in the requested focus scope (cheaply counted, no compile). */
  entityCount: number;
  /** Relations touching the requested focus scope. */
  relationCount: number;
  /** The safe focus actually compiled instead (the scoped top scene). */
  fallbackFocusId: string;
};

/** Set when a scan-mode "Open inside" re-entered the guarded compile seam because
 *  the target's deeper band was scoped out of the current neighborhood (so a lens
 *  drill would dead-end). Dev-diagnostics only; absent on a plain lens drill. */
export type ScanDrillRecompile = {
  /** The entity drilled into (now the recompiled scene's focus/root). */
  targetId: string;
  /** The band that was absent and is now compiled. */
  deeperDetail: SemanticDetail;
};

export type AtlasScene = {
  id: string;
  title: string;
  subtitle: string;
  entities: SceneEntity[];
  relations: SceneRelation[];
  regions: SceneRegion[];
  /** Precompiled protocol payloads (for example stress fixtures) pass through to WASM unchanged. */
  protocolSnapshot?: unknown;
  /** Optional stable-ID patch used when an explicit drill changes the projection family. */
  protocolPatch?: unknown;
  rootEntityId?: string;
  frozenRevision?: string;
  /** Relations dropped from routing under a scan-mode edge budget (absent otherwise). */
  omittedRelations?: OmittedRelation[];
  /** The same drop, keyed by visual edge and projected endpoints (absent otherwise). */
  omittedEdges?: OmittedEdge[];
  /** L3/L4 cards the camera-resident window did not compile (inspector +N more). */
  omittedNodes?: OmittedNode[];
  /** Scan-mode scoped-compile decision, surfaced in the dev diagnostics panel. */
  scopedCompile?: ScopedCompileInfo;
  /** Aspect-preset target the scene was compiled with (scan mode, tasks #30/#33). Present
   *  ⇒ coverage-based reveal is active, so explicit framings land the focus at its
   *  children's reveal coverage instead of the band floor. Absent for demo/golden. */
  targetAspect?: number;
  scanCodeSafeWidth?: number;
  /** Present when the scan compile guard refused the requested focus and fell
   *  back to a safe scene (dev diagnostics only; absent normally). */
  scanGuardRefusal?: ScanGuardRefusal;
  /** Present when a scan drill recompiled a scoped-out deeper neighborhood (dev
   *  diagnostics only; absent on a plain lens drill). */
  scanDrillRecompile?: ScanDrillRecompile;
  projection?: {
    /** Compiler projection-family identifier used to scope durable route intent. */
    familyId?: string;
    semanticToVisualEntityId: Record<string, string>;
    visualToSemanticEntityId: Record<string, string>;
    semanticToVisualRelationIds: Record<string, string[]>;
    visualToSemanticRelationIds: Record<string, string[]>;
    boundsByEntityIdAndDetail: Record<string, Partial<Record<SemanticDetail, { x: number; y: number; width: number; height: number }>>>;
    entityIdsByDetail: Record<SemanticDetail, string[]>;
    relationIdsByDetail: Record<SemanticDetail, string[]>;
    projectedRelationsByDetail: Record<SemanticDetail, SceneRelation[]>;
    zoomPolicy?: {
      minZoom: number;
      maxZoom: number;
      bands: Array<{
        detail: SemanticDetail;
        enterZoom: number;
        exitZoom: number | null;
        focusZoom: number;
        fadeWidth: number;
        hysteresis: number;
      }>;
    };
    semanticTransitionsByEntityId?: Record<string, Partial<Record<Exclude<SemanticDetail, 'context'>, {
      currentDetail: SemanticDetail;
      nextDetail: Exclude<SemanticDetail, 'context'>;
      sourceRepresentationId: string;
      targetRepresentationId: string;
      enterCoverage: { major: number; minor: number };
      commitCoverage: { major: number; minor: number };
      fullCoverage: { major: number; minor: number };
      leaveCoverage: { major: number; minor: number };
      minimumCssSize: { width: number; height: number };
      minZoom: number;
      /** Authored camera zoom where the incoming representation owns the branch completely. */
      fullZoom: number;
      hysteresis: number;
      transitionMs: number;
      dwellMs: number;
      pointerInsetPx: number;
    }>>>;
  };
};

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type RenderState = {
  selectedId?: string;
  focusedIds: Set<string>;
  /** Temporary endpoint emphasis for a selected/route-edited relation; not semantic-lens ownership. */
  relationFocusIds?: Set<string>;
  activeRelationIds: Set<string>;
  /** Semantic relationships that receive animated flow particles independently of emphasis. */
  flowRelationIds: Set<string>;
  reduceMotion: boolean;
  animate: boolean;
  visibilityMode: 'all' | 'dim' | 'isolate';
  projectionOverride?: ProjectionOverride;
  cinematicTransition?: {
    id: string;
    positionMs: number;
    durationMs: number;
    visualProgress: number;
    departureProgress: number;
    sourceFocusedIds: readonly string[];
    targetFocusedIds: readonly string[];
    sourceRelationIds: readonly string[];
    targetRelationIds: readonly string[];
  };
};

export type ProjectionOverride = {
  id: string;
  progress: number;
  objects: ProjectionObjectOverride[];
  paths: ProjectionPathOverride[];
  morph?: ProjectionMorphOverride;
};

export type ProjectionObjectOverride = {
  objectId: string;
  sourceRepresentationId?: string;
  targetRepresentationId?: string;
  /** Projection-local opacity, independent of story/selection visibility. */
  sourceOpacity?: number;
  targetOpacity?: number;
  /** Text/icon content weight. Defaults to the matching object opacity. */
  sourceContentOpacity?: number;
  targetContentOpacity?: number;
  /** Projection-local hit policy. Ghost context can remain visible without stealing ancestor picks. */
  sourcePickable?: boolean;
  targetPickable?: boolean;
  /** Higher values win overlapping projection-local picks. */
  sourcePickPriority?: number;
  targetPickPriority?: number;
};

export type ProjectionPathOverride = {
  pathId: string;
  sourceOpacity: number;
  targetOpacity: number;
};

export type ProjectionMorphOverride = {
  boundaryObjectId: string;
  objectIds: string[];
  pathIds: string[];
};

export type VisibleSceneState = {
  objectIds: string[];
  relationIds: string[];
};

export type RendererLodState = {
  objectId: string;
  current: string;
  previous?: string;
  progress: number;
  currentWeight: number;
  previousWeight: number;
  transitioning: boolean;
  durationMs: number;
};

export type RendererDiagnostics = {
  requestedBackend: string;
  activeBackend: string;
  gpuAccelerated: boolean;
  entityCount: number;
  relationCount: number;
  lastFrameMs: number;
  message: string;
  visibleEntities?: number;
  visibleRelations?: number;
  candidateEntities?: number;
  candidateRelations?: number;
  culledEntities?: number;
  culledRelations?: number;
  drawCalls?: number;
  meshRebuilt?: boolean;
  meshBuildMs?: number;
  geometryUploadBytes?: number;
  geometryBufferUploads?: number;
  glyphQuads?: number;
  deferredTextPrimitives?: number;
  deferredIconPrimitives?: number;
  frameP50Ms?: number;
  frameP95Ms?: number;
  frameP99Ms?: number;
  frameSampleCount?: number;
  totalFrameCount?: number;
  frameWindowIncludesInitialBuild?: boolean;
  staticMeshRevision?: number;
  staticGeometryUploadBytes?: number;
  staticGeometryBufferUploads?: number;
  cumulativeStaticGeometryUploadBytes?: number;
  cumulativeStaticGeometryBufferUploads?: number;
  dynamicIndexUploadBytes?: number;
  dynamicIndexBufferUploads?: number;
  cumulativeDynamicIndexUploadBytes?: number;
  cumulativeDynamicIndexBufferUploads?: number;
  dynamicStyleUploadBytes?: number;
  dynamicStyleBufferUploads?: number;
  cumulativeDynamicStyleUploadBytes?: number;
  cumulativeDynamicStyleBufferUploads?: number;
  flowUploadBytes?: number;
  cumulativeFlowUploadBytes?: number;
  uniformUploadBytes?: number;
  cumulativeUniformUploadBytes?: number;
  lodUniformUploadBytes?: number;
  cumulativeLodUniformUploadBytes?: number;
  residentPartitionTotal?: number;
  residentPartitionActive?: number;
  residentPartitionDrawn?: number;
  residentObjectCount?: number;
  residentPathCount?: number;
  partitionCacheHits?: number;
  partitionCacheMisses?: number;
  partitionCacheEvictions?: number;
  drawRangeCount?: number;
};

export type PickResult =
  | { kind: 'entity'; id: string }
  | { kind: 'relation'; id: string };

export interface AtlasRenderer {
  readonly kind: string;
  setScene(scene: AtlasScene): void;
  setCamera(camera: Camera): void;
  setRenderState(state: RenderState): void;
  resize(width: number, height: number, devicePixelRatio: number): void;
  render(timeMs: number): void;
  pick(screenX: number, screenY: number): PickResult | undefined;
  visibleScene(): VisibleSceneState;
  lodState(): RendererLodState | undefined;
  diagnostics(): RendererDiagnostics;
  dispose(): void;
}
