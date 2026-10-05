import { C4_ZOOM_BANDS } from '@okie/scene-compiler';
import type { AtlasScene, Camera, ProjectionOverride, SceneEntity, SemanticDetail } from '../renderer/types';
import { ATLAS_CAMERA_BOUNDS } from '../renderer/cameraBounds';
import type { SafeArea, ViewportSize } from '../storyFraming';

export const SEMANTIC_LENS_POLICY = {
  armCoverage: { major: 0.42, minor: 0.18 },
  commitCoverage: { major: 0.46, minor: 0.20 },
  fullCoverage: { major: 0.52, minor: 0.24 },
  reverseCoverage: { major: 0.34, minor: 0.14 },
  dwellMs: 90,
  retargetDwellMs: 80,
  retargetContainmentPx: 24,
  retargetProgressLimit: 0.5,
  reverseZoomDelta: 0.04,
  desktopAssistMs: 260,
  mobileAssistMs: 320,
  maxCenterBlend: 0.68,
  maxSettledZoomCorrection: 0.06,
  mobileIntentRatio: 0.12,
} as const;

// Derived from the compiler's zoom policy so the lens fallback can never drift from it
// (review finding: fallback zoom-policy copies). Values are identical to the previous literals.
const enterZoomForBand = (detail: Exclude<SemanticDetail, 'context'>): number => {
  const band = C4_ZOOM_BANDS.find(candidate => candidate.detail === detail);
  if (!band) throw new Error(`C4 zoom policy is missing the ${detail} band`);
  return band.enterZoom;
};

export const SEMANTIC_LENS_ENTER_ZOOM: Record<Exclude<SemanticDetail, 'context'>, number> = {
  container: enterZoomForBand('container'),
  component: enterZoomForBand('component'),
  code: enterZoomForBand('code'),
};

export type LensCoverage = { major: number; minor: number };
export type SemanticLensPhase = 'idle' | 'armed' | 'revealing' | 'settled' | 'reversing';
export type LensPoint = { x: number; y: number };
type LensBounds = { x: number; y: number; width: number; height: number };

export const SEMANTIC_OWNER_SAFE_PADDING_PX = 24;

export type SemanticLensTarget = {
  id: string;
  currentDetail: SemanticDetail;
  nextDetail: Exclude<SemanticDetail, 'context'>;
  enterZoom: number;
  /** Authored per-representation hysteresis around this target's viewport-derived enter zoom. */
  hysteresis?: number;
  policy?: {
    sourceRepresentationId?: string;
    targetRepresentationId?: string;
    enterCoverage: LensCoverage;
    commitCoverage: LensCoverage;
    fullCoverage: LensCoverage;
    leaveCoverage: LensCoverage;
    minimumCssSize: { width: number; height: number };
    /** Zoom runway used to scale the incoming branch from its owner box to full geometry. */
    fullZoom?: number;
    transitionMs: number;
    dwellMs: number;
    pointerInsetPx: number;
  };
  coverage: LensCoverage;
  /** Half-CSS-pixel allowance expressed as a viewport coverage ratio. */
  coverageTolerance?: number;
  /** Minimum distance from the pointer/centroid to the candidate boundary. */
  containmentPx: number;
};

export type SemanticLensState = {
  phase: SemanticLensPhase;
  targetId?: string;
  currentDetail?: SemanticDetail;
  nextDetail?: Exclude<SemanticDetail, 'context'>;
  progress: number;
  assistBlend: number;
  armedAtMs?: number;
  armedZoom?: number;
  candidateId?: string;
  candidateSinceMs?: number;
  reversingAtMs?: number;
  reverseFromProgress?: number;
  transitionMs?: number;
  dwellMs?: number;
};

export type SemanticLensPathEntry = {
  targetId: string;
  currentDetail: SemanticDetail;
  nextDetail: Exclude<SemanticDetail, 'context'>;
};

export type SemanticLensSession = {
  baseDetail: SemanticDetail;
  settled: SemanticLensPathEntry[];
  active: SemanticLensState;
  focusTransfer?: {
    sourceEntries: SemanticLensPathEntry[];
    targetId: string;
    depth: number;
    progress: number;
  };
};

export type SemanticLensSample = {
  nowMs: number;
  zoom: number;
  direction: 'inward' | 'outward' | 'none';
  /** Coverage for the locked branch; remains stable when the pointer crosses a sibling. */
  activeTarget?: SemanticLensTarget;
  /** Pointer/centroid candidate used only for initial targeting and guarded retargeting. */
  candidateTarget?: SemanticLensTarget;
  /** Backwards-compatible shorthand used as both active and candidate target. */
  target?: SemanticLensTarget;
  mobile?: boolean;
  reducedMotion?: boolean;
  /** True only after the wheel/pinch gesture has gone quiet and its camera is settled. */
  gestureSettled?: boolean;
  /** Raw zoom at the start of the current wheel/pinch gesture. */
  gestureStartZoom?: number;
  cancel?: boolean;
};

export const idleSemanticLens = (): SemanticLensState => ({
  phase: 'idle',
  progress: 0,
  assistBlend: 0,
});

export const idleSemanticLensSession = (baseDetail: SemanticDetail): SemanticLensSession => ({
  baseDetail,
  settled: [],
  active: idleSemanticLens(),
});

function ownsIncomingRepresentation(progress: number) {
  return progress + 1e-9 >= .5;
}

/** Freezes the canonical lens path before a direct pan takes camera ownership. */
export function stabilizeSemanticLensSessionForPan(session: SemanticLensSession): SemanticLensSession {
  const active = session.active;
  const promote = active.phase !== 'idle'
    && ownsIncomingRepresentation(active.progress)
    && active.targetId
    && active.currentDetail
    && active.nextDetail
    && !session.settled.some(entry => entry.targetId === active.targetId);
  return {
    ...session,
    settled: promote
      ? [...session.settled, { targetId: active.targetId!, currentDetail: active.currentDetail!, nextDetail: active.nextDetail! }]
      : session.settled,
    active: idleSemanticLens(),
  };
}

function entryState(entry: SemanticLensPathEntry): SemanticLensState {
  return {
    phase: 'settled',
    targetId: entry.targetId,
    currentDetail: entry.currentDetail,
    nextDetail: entry.nextDetail,
    progress: 1,
    assistBlend: SEMANTIC_LENS_POLICY.maxCenterBlend,
  };
}

export function semanticLensSessionDetail(session: SemanticLensSession): SemanticDetail {
  if (session.active.phase !== 'idle' && session.active.currentDetail && session.active.nextDetail) {
    return ownsIncomingRepresentation(session.active.progress) ? session.active.nextDetail : session.active.currentDetail;
  }
  return session.settled.at(-1)?.nextDetail ?? session.baseDetail;
}

export function semanticLensSessionPresentationState(session: SemanticLensSession): SemanticLensState {
  return session.active.phase !== 'idle'
    ? session.active
    : session.settled.length > 0
      ? entryState(session.settled.at(-1)!)
      : idleSemanticLens();
}

/** Pure stack reducer: inward settles one deeper entry; outward reverses/pops one entry. */
export function reduceSemanticLensSession(session: SemanticLensSession, sample: SemanticLensSample): SemanticLensSession {
  if (sample.cancel) return idleSemanticLensSession(session.baseDetail);
  if (session.active.phase !== 'idle') {
    const active = reduceSemanticLens(session.active, sample);
    if (active.phase === 'settled') {
      const entry = active.targetId && active.currentDetail && active.nextDetail
        ? { targetId: active.targetId, currentDetail: active.currentDetail, nextDetail: active.nextDetail }
        : undefined;
      return entry && !session.settled.some(settled => settled.targetId === entry.targetId)
        ? { ...session, settled: [...session.settled, entry], active: idleSemanticLens() }
        : { ...session, active: idleSemanticLens() };
    }
    return { ...session, active };
  }
  if (sample.direction === 'outward' && session.settled.length > 0) {
    const deepest = session.settled.at(-1)!;
    const target = sample.activeTarget ?? sample.target;
    if (target?.id === deepest.targetId
      && target.policy?.fullZoom !== undefined
      && sample.zoom + 1e-9 >= target.policy.fullZoom) {
      return session;
    }
    const settled = session.settled.slice(0, -1);
    const active = reduceSemanticLens(entryState(deepest), sample);
    return { ...session, settled, active };
  }
  const active = reduceSemanticLens(idleSemanticLens(), sample);
  return { ...session, active };
}

export function semanticLensPathIds(session: SemanticLensSession): string[] {
  return session.settled.map(entry => entry.targetId);
}

export function semanticLensCanonicalPathIds(session: SemanticLensSession): string[] {
  const ids = [...new Set(semanticLensPathIds(session))];
  return ownsIncomingRepresentation(session.active.progress) && session.active.targetId && !ids.includes(session.active.targetId)
    ? [...ids, session.active.targetId]
    : ids;
}

/** Keeps the morphing branch's screen center fixed as its world-space bounds change. */
export function compensateSemanticMorphCamera(
  raw: Camera,
  sourceBounds: LensBounds,
  targetBounds: LensBounds,
  progress: number,
  baselineProgress = 0,
): Camera {
  const sourceCenter = {
    x: sourceBounds.x + sourceBounds.width / 2,
    y: sourceBounds.y + sourceBounds.height / 2,
  };
  const targetCenter = {
    x: targetBounds.x + targetBounds.width / 2,
    y: targetBounds.y + targetBounds.height / 2,
  };
  const amount = clamp01(progress) - clamp01(baselineProgress);
  return {
    x: raw.x + amount * (targetCenter.x - sourceCenter.x),
    y: raw.y + amount * (targetCenter.y - sourceCenter.y),
    zoom: raw.zoom,
  };
}

function containmentScreenShift(
  minimum: number,
  maximum: number,
  safeMinimum: number,
  safeMaximum: number,
): number {
  if (maximum - minimum > safeMaximum - safeMinimum) {
    // An owner larger than the safe window is a surface the user is INSIDE, not a
    // card to frame. Recentring it on settle yanked the view away from whatever the
    // user had zoomed toward (direct user feedback; the Google-Maps rule: a zoom
    // never moves your anchor). Only close a gap that would show dead space beyond
    // an owner edge, by the exact edge-to-edge amount — a covering owner stays put.
    if (minimum > safeMinimum) return safeMinimum - minimum;
    if (maximum < safeMaximum) return safeMaximum - maximum;
    return 0;
  }
  if (minimum < safeMinimum) return safeMinimum - minimum;
  if (maximum > safeMaximum) return safeMaximum - maximum;
  return 0;
}

/**
 * Translates a camera by the smallest amount required to keep one semantic
 * owner inside the measured safe viewport — or, when the owner outgrows the
 * viewport, to keep the viewport inside the OWNER (gap-closing only, never a
 * recentre). Zoom is deliberately never changed. Callers opt in from semantic
 * zoom/framing paths; ordinary pan remains free.
 */
export function containSemanticOwnerCamera(
  camera: Camera,
  ownerBounds: LensBounds,
  viewport: ViewportSize,
  safeArea: SafeArea,
  padding = SEMANTIC_OWNER_SAFE_PADDING_PX,
): Camera {
  const safeLeft = safeArea.left + padding;
  const safeRight = Math.max(safeLeft, viewport.width - safeArea.right - padding);
  const safeTop = safeArea.top + padding;
  const safeBottom = Math.max(safeTop, viewport.height - safeArea.bottom - padding);
  const left = viewport.width / 2 + (ownerBounds.x - camera.x) * camera.zoom;
  const top = viewport.height / 2 + (ownerBounds.y - camera.y) * camera.zoom;
  const right = left + ownerBounds.width * camera.zoom;
  const bottom = top + ownerBounds.height * camera.zoom;
  const shiftX = containmentScreenShift(left, right, safeLeft, safeRight);
  const shiftY = containmentScreenShift(top, bottom, safeTop, safeBottom);
  if (shiftX === 0 && shiftY === 0) return camera;
  return {
    x: camera.x - shiftX / camera.zoom,
    y: camera.y - shiftY / camera.zoom,
    zoom: camera.zoom,
  };
}

export function interpolateSemanticOwnerBounds(
  source: LensBounds,
  target: LensBounds,
  progress: number,
): LensBounds {
  const amount = clamp01(progress);
  return {
    x: source.x + (target.x - source.x) * amount,
    y: source.y + (target.y - source.y) * amount,
    width: source.width + (target.width - source.width) * amount,
    height: source.height + (target.height - source.height) * amount,
  };
}

/** Owner-morph endpoints for one semantic zoom sample (present only mid-reveal). */
export type SemanticZoomMorph = {
  sourceBounds: LensBounds;
  targetBounds: LensBounds;
  progress: number;
  baselineProgress: number;
};

/**
 * The camera a semantic wheel/pinch zoom sample renders at.
 *
 * The user's anchor is authoritative for the WHOLE gesture, settle included: a
 * zoom never translates the camera (the Google-Maps rule — direct user feedback,
 * superseding task #32's settle-frame containment landing, whose residual
 * pull-in/gap-close still read as "auto pan after zooming"). The only adjustment
 * is the owner-morph reflow pin — not a recentre: it keeps the entity under the
 * pointer visually stable as its representation bounds reflow between bands.
 * Owner containment (containSemanticOwnerCamera) remains an EXPLICIT-navigation
 * affordance — band rail, drills, framing — and no zoom path applies it. Pure.
 */
export function composeSemanticZoomCamera(cursorCamera: Camera, morph?: SemanticZoomMorph): Camera {
  if (!morph) return cursorCamera;
  return compensateSemanticMorphCamera(
    cursorCamera,
    morph.sourceBounds,
    morph.targetBounds,
    morph.progress,
    morph.baselineProgress,
  );
}

/** Removes one branch's structural morph offset at the start of a new gesture. */
export function rebaseSemanticMorphCamera(
  rendered: Camera,
  sourceBounds: LensBounds,
  targetBounds: LensBounds,
  progress: number,
): Camera {
  const sourceCenter = {
    x: sourceBounds.x + sourceBounds.width / 2,
    y: sourceBounds.y + sourceBounds.height / 2,
  };
  const targetCenter = {
    x: targetBounds.x + targetBounds.width / 2,
    y: targetBounds.y + targetBounds.height / 2,
  };
  const amount = clamp01(progress);
  return {
    x: rendered.x - amount * (targetCenter.x - sourceCenter.x),
    y: rendered.y - amount * (targetCenter.y - sourceCenter.y),
    zoom: rendered.zoom,
  };
}

function canonicalVisibleEntries(session: SemanticLensSession): SemanticLensPathEntry[] {
  const entries = [...session.settled];
  if (ownsIncomingRepresentation(session.active.progress)
    && session.active.targetId
    && session.active.currentDetail
    && session.active.nextDetail
    && !entries.some(entry => entry.targetId === session.active.targetId)) {
    entries.push({
      targetId: session.active.targetId,
      currentDetail: session.active.currentDetail,
      nextDetail: session.active.nextDetail,
    });
  }
  return entries;
}

export type SemanticGhostEntity = {
  id: string;
  depth: number;
  detail: SemanticDetail;
  opacity: number;
};

export type SemanticSilhouetteEntity = {
  id: string;
  parentGhostId: string;
  depth: number;
  detail: SemanticDetail;
  opacity: number;
};

const GHOST_SIBLING_OPACITY = [.24, .13, .07] as const;
const GHOST_OBJECT_CAP = 128;
const GHOST_PATH_CAP = 64;
const SILHOUETTE_OPACITY = .14;
const SILHOUETTE_PER_GHOST_CAP = 8;
const SILHOUETTE_TOTAL_CAP = 48;

function ghostEntitiesForEntries(scene: AtlasScene, entries: readonly SemanticLensPathEntry[]): SemanticGhostEntity[] {
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  const primary = entries.at(-1)
    ? new Set(semanticLensBranchEntityIds(scene, entries.at(-1)!.targetId, entries.at(-1)!.nextDetail))
    : new Set<string>();
  const ancestors = new Set(entries.map(entry => entry.targetId));
  const ghosts = new Map<string, SemanticGhostEntity>();
  const firstDepth = Math.max(0, entries.length - GHOST_SIBLING_OPACITY.length);
  for (let depth = firstDepth; depth < entries.length; depth += 1) {
    const entry = entries[depth]!;
    const target = byId.get(entry.targetId);
    if (!target) continue;
    const opacity = GHOST_SIBLING_OPACITY[entries.length - 1 - depth] ?? GHOST_SIBLING_OPACITY.at(-1)!;
    const siblings = scene.entities
      .filter(entity => entity.id !== target.id
        && entity.detail === entry.currentDetail
        && entity.parentId === target.parentId
        && Boolean(scene.projection?.boundsByEntityIdAndDetail[entity.id]?.[entry.currentDetail]))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const sibling of siblings) {
      if (primary.has(sibling.id) || ancestors.has(sibling.id) || ghosts.has(sibling.id)) continue;
      ghosts.set(sibling.id, { id: sibling.id, depth, detail: entry.currentDetail, opacity });
      if (ghosts.size >= GHOST_OBJECT_CAP) return [...ghosts.values()];
    }
  }
  return [...ghosts.values()];
}

export function semanticLensSessionGhostEntities(scene: AtlasScene, session: SemanticLensSession): SemanticGhostEntity[] {
  return ghostEntitiesForEntries(scene, canonicalVisibleEntries(session));
}

function silhouetteEntitiesForEntries(
  scene: AtlasScene,
  entries: readonly SemanticLensPathEntry[],
  ghosts = ghostEntitiesForEntries(scene, entries),
): SemanticSilhouetteEntity[] {
  const silhouettes: SemanticSilhouetteEntity[] = [];
  const excluded = new Set([
    ...entries.map(entry => entry.targetId),
    ...ghosts.map(ghost => ghost.id),
  ]);
  for (const ghost of ghosts.filter(candidate => candidate.opacity === .24).sort((left, right) => left.id.localeCompare(right.id))) {
    const detail = entries[ghost.depth]?.nextDetail;
    if (!detail) continue;
    const children = scene.entities
      .filter(entity => entity.parentId === ghost.id
        && entity.detail === detail
        && !excluded.has(entity.id)
        && Boolean(scene.projection?.boundsByEntityIdAndDetail[entity.id]?.[detail]))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, SILHOUETTE_PER_GHOST_CAP);
    for (const child of children) {
      silhouettes.push({ id: child.id, parentGhostId: ghost.id, depth: ghost.depth, detail, opacity: SILHOUETTE_OPACITY });
      excluded.add(child.id);
      if (silhouettes.length >= SILHOUETTE_TOTAL_CAP) return silhouettes;
    }
  }
  return silhouettes;
}

export function semanticLensSessionSilhouetteEntities(scene: AtlasScene, session: SemanticLensSession): SemanticSilhouetteEntity[] {
  const entries = canonicalVisibleEntries(session);
  return silhouetteEntitiesForEntries(scene, entries);
}

function semanticEntitiesForEntries(scene: AtlasScene, entries: readonly SemanticLensPathEntry[]) {
  if (!entries.length) {
    return {
      primary: new Set(scene.projection?.entityIdsByDetail.context ?? scene.entities.map(entity => entity.id)),
      ancestors: new Set<string>(),
      ghosts: [] as SemanticGhostEntity[],
      silhouettes: [] as SemanticSilhouetteEntity[],
      detail: 'context' as SemanticDetail,
    };
  }
  const deepest = entries.at(-1)!;
  const ghosts = ghostEntitiesForEntries(scene, entries);
  return {
    primary: new Set(semanticLensBranchEntityIds(scene, deepest.targetId, deepest.nextDetail)),
    ancestors: new Set(entries.slice(0, -1).map(entry => entry.targetId)),
    ghosts,
    silhouettes: silhouetteEntitiesForEntries(scene, entries, ghosts),
    detail: deepest.nextDetail as SemanticDetail,
  };
}

export function semanticLensSessionVisibleEntityIds(scene: AtlasScene, session: SemanticLensSession): string[] {
  const entries = canonicalVisibleEntries(session);
  if (!entries.length) return [...(scene.projection?.entityIdsByDetail[session.baseDetail] ?? scene.entities.map(entity => entity.id))].sort();
  const ownershipSets = [entries, ...(session.focusTransfer ? [session.focusTransfer.sourceEntries] : [])]
    .map(value => semanticEntitiesForEntries(scene, value));
  return [...new Set(ownershipSets.flatMap(ownership => [
    ...ownership.primary,
    ...ownership.ancestors,
    ...ownership.ghosts.map(ghost => ghost.id),
    ...ownership.silhouettes.map(silhouette => silhouette.id),
  ]))].sort();
}

export function semanticLensSessionVisibleRelationIds(scene: AtlasScene, session: SemanticLensSession): string[] {
  const entries = canonicalVisibleEntries(session);
  if (!entries.length) return [...(scene.projection?.relationIdsByDetail[session.baseDetail] ?? scene.relations.map(relation => relation.id))].sort();
  const relationIds = [entries, ...(session.focusTransfer ? [session.focusTransfer.sourceEntries] : [])].flatMap(entrySet => {
    const ownership = semanticEntitiesForEntries(scene, entrySet);
    const primaryRelations = (scene.projection?.projectedRelationsByDetail[ownership.detail] ?? [])
      .filter(relation => ownership.primary.has(relation.from) && ownership.primary.has(relation.to))
      .map(relation => relation.id);
    const ghostRelations: string[] = [];
    for (let depth = 0; depth < entrySet.length; depth += 1) {
      const entry = entrySet[depth]!;
      const ghosts = new Set(ownership.ghosts.filter(ghost => ghost.depth === depth).map(ghost => ghost.id));
      if (!ghosts.size) continue;
      const contextual = new Set([entry.targetId, ...ghosts]);
      for (const relation of scene.projection?.projectedRelationsByDetail[entry.currentDetail] ?? []) {
        if (contextual.has(relation.from) && contextual.has(relation.to)
          && (ghosts.has(relation.from) || ghosts.has(relation.to))) ghostRelations.push(relation.id);
        if (ghostRelations.length >= GHOST_PATH_CAP) break;
      }
      if (ghostRelations.length >= GHOST_PATH_CAP) break;
    }
    return [...primaryRelations, ...ghostRelations];
  });
  return [...new Set(relationIds)].sort();
}

export function validateSemanticLensPath(
  scene: AtlasScene,
  baseDetail: SemanticDetail,
  targetIds: readonly string[],
): { entries: SemanticLensPathEntry[]; truncated: boolean } {
  const baseIndex = detailIndex(baseDetail);
  const entries: SemanticLensPathEntry[] = [];
  const seen = new Set<string>();
  for (const targetId of targetIds) {
    const currentDetail = (['context', 'container', 'component', 'code'] as const)[baseIndex + entries.length];
    const nextDetail = (['context', 'container', 'component', 'code'] as const)[baseIndex + entries.length + 1] as Exclude<SemanticDetail, 'context'> | undefined;
    if (!currentDetail || !nextDetail || seen.has(targetId)) break;
    const visible = new Set(scene.projection?.entityIdsByDetail[currentDetail] ?? []);
    const previous = entries.at(-1);
    const withinPrevious = !previous
      || new Set(semanticLensBranchEntityIds(scene, previous.targetId, currentDetail)).has(targetId);
    const expandable = descendantsInDetail(scene, targetId, nextDetail).some(entity => entity.id !== targetId);
    const hasBounds = Boolean(scene.projection?.boundsByEntityIdAndDetail[targetId]?.[currentDetail]
      && scene.projection?.boundsByEntityIdAndDetail[targetId]?.[nextDetail]);
    if (!visible.has(targetId) || !withinPrevious || !expandable || !hasBounds) break;
    entries.push({ targetId, currentDetail, nextDetail });
    seen.add(targetId);
  }
  return { entries, truncated: entries.length !== targetIds.length };
}

/**
 * Validates a persisted settled path against both its branch and the camera that
 * accompanies it. A URL may be written while an earlier lens still owns the
 * projection; restoring that path below its entry runway would otherwise show a
 * deeper settled band at an L1 camera.
 *
 * Keep the authored hysteresis runway. In the small ambiguity band immediately
 * below `minZoom`, a saved settled endpoint remains coherent with an outward
 * gesture that has not crossed its leave threshold yet. `fullZoom` is not a
 * restore requirement: cold deep views intentionally restore below it.
 */
export function validateRestoredSemanticLensPath(
  scene: AtlasScene,
  baseDetail: SemanticDetail,
  targetIds: readonly string[],
  zoom: number,
): { entries: SemanticLensPathEntry[]; truncated: boolean } {
  const structural = validateSemanticLensPath(scene, baseDetail, targetIds);
  if (!Number.isFinite(zoom)) return structural;
  const entries: SemanticLensPathEntry[] = [];
  const final = structural.entries.at(-1);
  const focusedCode = scene.targetAspect !== undefined && scene.scanCodeSafeWidth !== undefined
    && final !== undefined && final.targetId === scene.rootEntityId && final.nextDetail === 'code'
    ? scene.projection?.semanticTransitionsByEntityId?.[final.targetId]?.code : undefined;
  // A narrow map can reveal the focused code face before an ancestor's desktop
  // runway. Structural validation still applies; the exact deeper endpoint's
  // authored leave threshold owns its already traversed ancestors on restoration.
  const ownsFocusedCode = focusedCode?.minZoom !== undefined
    && zoom + (focusedCode.hysteresis ?? 0) + 1e-9 >= focusedCode.minZoom;
  for (const entry of structural.entries) {
    const authored = scene.projection?.semanticTransitionsByEntityId?.[entry.targetId]?.[entry.nextDetail];
    const protocol = scene.protocolSnapshot as ProtocolProjectionScene | undefined;
    const visualId = scene.projection?.semanticToVisualEntityId[entry.targetId];
    const representation = protocol?.objects.find(object => object.id === visualId)
      ?.representations.find(candidate => candidate.id === `${visualId}:${entry.nextDetail}`);
    const band = C4_ZOOM_BANDS.find(candidate => candidate.detail === entry.nextDetail);
    // Match target measurement: authored transitions first, then the protocol
    // representation LOD, then the shared C4 band policy for sparse imports.
    const minZoom = authored?.minZoom ?? representation?.lod?.minZoom ?? band?.enterZoom;
    const hysteresis = authored?.hysteresis ?? representation?.lod?.hysteresis ?? band?.hysteresis ?? 0;
    if (!ownsFocusedCode && minZoom !== undefined && zoom + hysteresis + 1e-9 < minZoom) break;
    entries.push(entry);
  }
  return { entries, truncated: structural.truncated || entries.length !== structural.entries.length };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function semanticLensCoverageProgress(
  coverage: LensCoverage,
  commitCoverage: LensCoverage = SEMANTIC_LENS_POLICY.commitCoverage,
  fullCoverage: LensCoverage = SEMANTIC_LENS_POLICY.fullCoverage,
): number {
  const major = (coverage.major - commitCoverage.major)
    / Math.max(Number.EPSILON, fullCoverage.major - commitCoverage.major);
  const minor = (coverage.minor - commitCoverage.minor)
    / Math.max(Number.EPSILON, fullCoverage.minor - commitCoverage.minor);
  return clamp01(Math.min(major, minor));
}

/** Progress through an authored semantic handoff, independent of viewport aspect ratio. */
export function semanticLensZoomProgress(zoom: number, enterZoom: number, fullZoom: number): number {
  if (zoom <= 0 || enterZoom <= 0 || fullZoom <= enterZoom) {
    return clamp01((zoom - enterZoom) / Math.max(Number.EPSILON, fullZoom - enterZoom));
  }
  return clamp01(Math.log(zoom / enterZoom) / Math.log(fullZoom / enterZoom));
}

export function semanticLensCoverage(width: number, height: number, safeWidth: number, safeHeight: number): LensCoverage {
  const horizontal = safeWidth > 0 ? Math.max(0, width) / safeWidth : 0;
  const vertical = safeHeight > 0 ? Math.max(0, height) / safeHeight : 0;
  return { major: Math.max(horizontal, vertical), minor: Math.min(horizontal, vertical) };
}

function armEligible(target: SemanticLensTarget, zoom: number) {
  const coverage = target.policy?.enterCoverage ?? SEMANTIC_LENS_POLICY.armCoverage;
  const epsilon = target.coverageTolerance ?? 1e-9;
  return zoom + 1e-9 >= target.enterZoom
    && target.containmentPx >= (target.policy?.pointerInsetPx ?? SEMANTIC_LENS_POLICY.retargetContainmentPx)
    && (target.policy?.fullZoom !== undefined
      || (target.coverage.major + epsilon >= coverage.major
        && target.coverage.minor + epsilon >= coverage.minor));
}

function commitEligible(target: SemanticLensTarget, zoom?: number) {
  if (target.policy?.fullZoom !== undefined) return (zoom ?? target.enterZoom) >= target.enterZoom;
  const coverage = target.policy?.commitCoverage ?? SEMANTIC_LENS_POLICY.commitCoverage;
  const epsilon = target.coverageTolerance ?? 1e-9;
  return target.coverage.major + epsilon >= coverage.major
    && target.coverage.minor + epsilon >= coverage.minor;
}

function fullCoverage(target: SemanticLensTarget, zoom?: number) {
  if (target.policy?.fullZoom !== undefined) return (zoom ?? target.enterZoom) >= target.policy.fullZoom;
  const coverage = target.policy?.fullCoverage ?? SEMANTIC_LENS_POLICY.fullCoverage;
  const epsilon = target.coverageTolerance ?? 1e-9;
  return target.coverage.major + epsilon >= coverage.major
    && target.coverage.minor + epsilon >= coverage.minor;
}

function shouldReverse(target: SemanticLensTarget | undefined, state: SemanticLensState, zoom: number) {
  const enterZoom = target?.enterZoom
    ?? (state.nextDetail ? SEMANTIC_LENS_ENTER_ZOOM[state.nextDetail] : Number.POSITIVE_INFINITY);
  const leaveCoverage = target?.policy?.leaveCoverage ?? SEMANTIC_LENS_POLICY.reverseCoverage;
  return zoom < enterZoom - (target?.hysteresis ?? SEMANTIC_LENS_POLICY.reverseZoomDelta)
    || !target
    || (target.policy?.fullZoom === undefined
      && (target.coverage.major <= leaveCoverage.major
        || target.coverage.minor <= leaveCoverage.minor));
}

function assistBlend(phase: SemanticLensPhase, progress: number, reducedMotion: boolean) {
  if (reducedMotion || phase === 'idle') return 0;
  if (phase === 'armed') return 0;
  return SEMANTIC_LENS_POLICY.maxCenterBlend * clamp01(progress);
}

function stateForTarget(target: SemanticLensTarget, nowMs: number, zoom: number): SemanticLensState {
  return {
    phase: 'armed',
    targetId: target.id,
    currentDetail: target.currentDetail,
    nextDetail: target.nextDetail,
    progress: 0,
    assistBlend: 0,
    armedAtMs: nowMs,
    armedZoom: zoom,
    ...(target.policy?.transitionMs ? { transitionMs: target.policy.transitionMs } : {}),
    ...(target.policy?.dwellMs !== undefined ? { dwellMs: target.policy.dwellMs } : {}),
  };
}

function resolveRetarget(state: SemanticLensState, sample: SemanticLensSample): SemanticLensState {
  const target = sample.candidateTarget ?? sample.target;
  if (!target || target.id === state.targetId || state.progress >= SEMANTIC_LENS_POLICY.retargetProgressLimit) {
    return { ...state, candidateId: undefined, candidateSinceMs: undefined };
  }
  if (target.containmentPx < (target.policy?.pointerInsetPx ?? SEMANTIC_LENS_POLICY.retargetContainmentPx)) {
    return { ...state, candidateId: undefined, candidateSinceMs: undefined };
  }
  if (state.candidateId !== target.id) {
    return { ...state, candidateId: target.id, candidateSinceMs: sample.nowMs };
  }
  if (sample.nowMs - (state.candidateSinceMs ?? sample.nowMs) < SEMANTIC_LENS_POLICY.retargetDwellMs) return state;
  return stateForTarget(target, sample.nowMs, sample.zoom);
}

/** Pure branch-local semantic-lens policy. It never changes selection/root or pushes history. */
export function reduceSemanticLens(state: SemanticLensState, sample: SemanticLensSample): SemanticLensState {
  if (sample.cancel) return idleSemanticLens();
  const reducedMotion = sample.reducedMotion === true;
  if (state.phase === 'idle') {
    const candidate = sample.candidateTarget ?? sample.target;
    const mobileIntent = !sample.mobile || (sample.gestureStartZoom !== undefined
      && (sample.zoom - sample.gestureStartZoom) / Math.max(sample.gestureStartZoom, Number.EPSILON) >= SEMANTIC_LENS_POLICY.mobileIntentRatio);
    return sample.direction === 'inward' && mobileIntent && candidate && armEligible(candidate, sample.zoom)
      ? stateForTarget(candidate, sample.nowMs, sample.zoom)
      : state;
  }

  if (state.phase === 'armed' && sample.direction === 'outward') return idleSemanticLens();

  const retargeted = resolveRetarget(state, sample);
  if (retargeted.targetId !== state.targetId) return retargeted;
  const activeSample = sample.activeTarget ?? sample.target;
  const target = activeSample?.id === retargeted.targetId ? activeSample : undefined;
  const pointerOnDifferentCandidate = !target && (sample.candidateTarget ?? sample.target)?.id !== retargeted.targetId;
  const authoredZoomProgress = target?.policy?.fullZoom !== undefined
    ? semanticLensZoomProgress(sample.zoom, target.enterZoom, target.policy.fullZoom)
    : undefined;

  // Authored zoom transitions are geometric and direction-independent: the
  // same camera zoom always resolves to the same representation blend.
  if (authoredZoomProgress !== undefined && state.phase === 'reversing') {
    if (sample.direction !== 'inward' && authoredZoomProgress <= 1e-9) return idleSemanticLens();
    if (sample.direction === 'inward') {
      return {
        ...state,
        phase: authoredZoomProgress >= 1 ? 'settled' : 'revealing',
        progress: authoredZoomProgress,
        assistBlend: assistBlend(authoredZoomProgress >= 1 ? 'settled' : 'revealing', authoredZoomProgress, reducedMotion),
        reversingAtMs: undefined,
        reverseFromProgress: undefined,
      };
    }
    return {
      ...state,
      phase: 'reversing',
      progress: authoredZoomProgress,
      assistBlend: assistBlend('reversing', authoredZoomProgress, reducedMotion),
      reversingAtMs: undefined,
      reverseFromProgress: undefined,
    };
  }
  if (authoredZoomProgress !== undefined
    && sample.direction === 'outward'
    && state.phase !== 'armed') {
    if (authoredZoomProgress <= 1e-9) return idleSemanticLens();
    return {
      ...state,
      phase: 'reversing',
      progress: authoredZoomProgress,
      assistBlend: assistBlend('reversing', authoredZoomProgress, reducedMotion),
      reversingAtMs: undefined,
      reverseFromProgress: undefined,
    };
  }
  const reverse = pointerOnDifferentCandidate ? false : shouldReverse(target, retargeted, sample.zoom);
  const coverageProgress = target
    ? authoredZoomProgress !== undefined
      ? authoredZoomProgress
      : semanticLensCoverageProgress(
          target.coverage,
          target.policy?.commitCoverage,
          target.policy?.fullCoverage,
        )
    : 0;

  if ((reverse || (sample.direction === 'outward' && state.phase !== 'armed')) && sample.direction !== 'inward') {
    if (state.phase === 'reversing') {
      const duration = state.transitionMs
        ?? (sample.mobile ? SEMANTIC_LENS_POLICY.mobileAssistMs : SEMANTIC_LENS_POLICY.desktopAssistMs);
      const elapsed = sample.nowMs - (state.reversingAtMs ?? sample.nowMs);
      const progress = Math.max(0, (state.reverseFromProgress ?? state.progress) * (1 - elapsed / duration));
      if (reverse || progress <= 0 || sample.zoom < (target?.enterZoom ?? Number.POSITIVE_INFINITY) - SEMANTIC_LENS_POLICY.reverseZoomDelta) {
        return idleSemanticLens();
      }
      return {
        ...state,
        progress,
        assistBlend: assistBlend('reversing', progress, reducedMotion),
      };
    }
    if (reverse || sample.zoom < (target?.enterZoom ?? Number.POSITIVE_INFINITY) - SEMANTIC_LENS_POLICY.reverseZoomDelta) {
      return idleSemanticLens();
    }
    return {
      ...state,
      phase: 'reversing',
      progress: state.progress,
      assistBlend: assistBlend('reversing', state.progress, reducedMotion),
      reversingAtMs: sample.nowMs,
      reverseFromProgress: state.progress,
    };
  }

  if (pointerOnDifferentCandidate) return retargeted;

  if (state.phase === 'armed') {
    if (!target || !armEligible(target, sample.zoom)) return state;
    const dwelled = sample.nowMs - (state.armedAtMs ?? sample.nowMs) >= (state.dwellMs ?? SEMANTIC_LENS_POLICY.dwellMs);
    const intended = (sample.direction === 'inward' || sample.gestureSettled === true)
      && (!sample.mobile || sample.gestureStartZoom !== undefined);
    if (!dwelled || !intended || !commitEligible(target, sample.zoom)) return state;
    if ((reducedMotion && sample.gestureSettled) || (!reducedMotion && fullCoverage(target, sample.zoom))) {
      return { ...state, phase: 'settled', progress: 1, assistBlend: 0, candidateId: undefined, candidateSinceMs: undefined };
    }
    if (reducedMotion) return state;
    return {
      ...state,
      phase: 'revealing',
      progress: coverageProgress,
      assistBlend: assistBlend('revealing', coverageProgress, false),
      candidateId: undefined,
      candidateSinceMs: undefined,
    };
  }

  if (state.phase === 'reversing' && sample.direction === 'inward' && target && commitEligible(target, sample.zoom)) {
    const progress = fullCoverage(target, sample.zoom) ? 1 : coverageProgress;
    return {
      ...state,
      phase: progress >= 1 ? 'settled' : 'revealing',
      progress,
      assistBlend: assistBlend(progress >= 1 ? 'settled' : 'revealing', progress, reducedMotion),
      reversingAtMs: undefined,
      reverseFromProgress: undefined,
    };
  }

  if ((state.phase === 'revealing' || state.phase === 'settled') && target) {
    const progress = fullCoverage(target, sample.zoom) ? 1 : Math.max(state.progress, coverageProgress);
    return {
      ...state,
      phase: progress >= 1 ? 'settled' : 'revealing',
      progress,
      assistBlend: assistBlend(progress >= 1 ? 'settled' : 'revealing', progress, reducedMotion),
    };
  }
  return state;
}

export function settledSemanticLensId(state: SemanticLensState): string | undefined {
  return state.phase === 'settled' || ownsIncomingRepresentation(state.progress) ? state.targetId : undefined;
}

export function semanticLensUrl(url: string | URL, state: SemanticLensState): string {
  const next = new URL(url.toString());
  const id = settledSemanticLensId(state);
  if (id) next.searchParams.set('lens', id);
  else next.searchParams.delete('lens');
  return next.toString();
}

function detailIndex(detail: SemanticDetail) {
  return (['context', 'container', 'component', 'code'] as const).indexOf(detail);
}

function descendantsInDetail(scene: AtlasScene, targetId: string, detail: SemanticDetail) {
  const visible = new Set(scene.projection?.entityIdsByDetail[detail] ?? []);
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
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

function screenRect(bounds: { x: number; y: number; width: number; height: number }, camera: Camera, viewport: ViewportSize) {
  return {
    x: viewport.width / 2 + (bounds.x - camera.x) * camera.zoom,
    y: viewport.height / 2 + (bounds.y - camera.y) * camera.zoom,
    width: bounds.width * camera.zoom,
    height: bounds.height * camera.zoom,
  };
}

function containsPoint(rect: { x: number; y: number; width: number; height: number }, point: LensPoint) {
  return point.x >= rect.x && point.x <= rect.x + rect.width && point.y >= rect.y && point.y <= rect.y + rect.height;
}

function containmentPx(rect: { x: number; y: number; width: number; height: number }, point: LensPoint) {
  if (!containsPoint(rect, point)) return -1;
  return Math.min(point.x - rect.x, rect.x + rect.width - point.x, point.y - rect.y, rect.y + rect.height - point.y);
}

export type SemanticGhostFocusTarget = SemanticGhostEntity & {
  screenArea: number;
};

/** Finds only prior-layer sibling context under the stationary safe center. */
export function findSemanticGhostFocusTarget(
  scene: AtlasScene,
  session: SemanticLensSession,
  camera: Camera,
  viewport: ViewportSize,
  safeArea: SafeArea,
  insetPx = 32,
): SemanticGhostFocusTarget | undefined {
  if (session.active.phase !== 'idle' || session.focusTransfer) return undefined;
  const center = {
    x: safeArea.left + (viewport.width - safeArea.left - safeArea.right) / 2,
    y: safeArea.top + (viewport.height - safeArea.top - safeArea.bottom) / 2,
  };
  return semanticLensSessionGhostEntities(scene, session)
    .filter(ghost => ghost.opacity === .24)
    .flatMap(ghost => {
      const bounds = scene.projection?.boundsByEntityIdAndDetail[ghost.id]?.[ghost.detail];
      if (!bounds) return [];
      const rect = screenRect(bounds, camera, viewport);
      if (containmentPx(rect, center) < insetPx) return [];
      const targetIds = [...session.settled.slice(0, ghost.depth).map(entry => entry.targetId), ghost.id];
      const validated = validateSemanticLensPath(scene, session.baseDetail, targetIds);
      if (validated.truncated || validated.entries.length !== ghost.depth + 1) return [];
      return [{ ...ghost, screenArea: rect.width * rect.height }];
    })
    .sort((left, right) => right.depth - left.depth
      || left.screenArea - right.screenArea
      || left.id.localeCompare(right.id))[0];
}

export function transferSemanticLensFocus(
  scene: AtlasScene,
  session: SemanticLensSession,
  target: Pick<SemanticGhostFocusTarget, 'id' | 'depth'>,
): SemanticLensSession {
  if (session.active.phase !== 'idle' || target.depth < 0 || target.depth >= session.settled.length) return session;
  const targetIds = [...session.settled.slice(0, target.depth).map(entry => entry.targetId), target.id];
  const validated = validateSemanticLensPath(scene, session.baseDetail, targetIds);
  if (validated.truncated || validated.entries.length !== target.depth + 1) return session;
  return {
    ...session,
    settled: validated.entries,
    active: idleSemanticLens(),
    focusTransfer: {
      sourceEntries: session.settled,
      targetId: target.id,
      depth: target.depth,
      progress: 0,
    },
  };
}

export function settleSemanticLensPanFocus(
  scene: AtlasScene,
  session: SemanticLensSession,
  camera: Camera,
  viewport: ViewportSize,
  safeArea: SafeArea,
  stationaryMs: number,
): SemanticLensSession {
  if (stationaryMs < 160) return session;
  const target = findSemanticGhostFocusTarget(scene, session, camera, viewport, safeArea);
  return target ? transferSemanticLensFocus(scene, session, target) : session;
}

export function advanceSemanticLensFocusTransfer(session: SemanticLensSession, progress: number): SemanticLensSession {
  if (!session.focusTransfer) return session;
  const amount = clamp01(progress);
  return amount >= 1
    ? { ...session, focusTransfer: undefined }
    : { ...session, focusTransfer: { ...session.focusTransfer, progress: amount } };
}

/** Zoom at which the currently rendered parent occupies the authored viewport share. */
export function semanticLensCoverageEnterZoom(
  bounds: { width: number; height: number },
  safeWidth: number,
  safeHeight: number,
  coverage: LensCoverage = SEMANTIC_LENS_POLICY.armCoverage,
): number {
  const horizontalAtOne = Math.max(Number.EPSILON, bounds.width / Math.max(1, safeWidth));
  const verticalAtOne = Math.max(Number.EPSILON, bounds.height / Math.max(1, safeHeight));
  const minorRequirement = Math.max(coverage.minor / horizontalAtOne, coverage.minor / verticalAtOne);
  const majorRequirement = Math.min(coverage.major / horizontalAtOne, coverage.major / verticalAtOne);
  return Math.max(minorRequirement, majorRequirement);
}

function semanticLensTargetZoomPolicy(
  scene: AtlasScene,
  targetId: string,
  nextDetail: Exclude<SemanticDetail, 'context'>,
  currentBounds: LensBounds,
  safeWidth: number,
  safeHeight: number,
  collectDiagnostics = false,
) {
  const authored = scene.projection?.semanticTransitionsByEntityId?.[targetId]?.[nextDetail];
  const protocol = scene.protocolSnapshot as ProtocolProjectionScene | undefined;
  const visualId = scene.projection?.semanticToVisualEntityId[targetId];
  const representation = protocol?.objects.find(object => object.id === visualId)
    ?.representations.find(candidate => candidate.id === `${visualId}:${nextDetail}`);
  const viewMaxZoom = scene.projection?.zoomPolicy?.maxZoom ?? ATLAS_CAMERA_BOUNDS.maxZoom;
  const attainableCoverage = semanticLensCoverage(
    currentBounds.width * viewMaxZoom,
    currentBounds.height * viewMaxZoom,
    safeWidth,
    safeHeight,
  );
  const reachable = (coverage: LensCoverage): LensCoverage => ({
    major: Math.min(coverage.major, attainableCoverage.major),
    minor: Math.min(coverage.minor, attainableCoverage.minor),
  });
  const requestedEnterCoverage = authored?.enterCoverage ?? SEMANTIC_LENS_POLICY.armCoverage;
  const requestedLeaveCoverage = authored?.leaveCoverage ?? SEMANTIC_LENS_POLICY.reverseCoverage;
  // Authored golden transitions use a fixed camera runway. Coverage remains useful
  // telemetry, but must not move a semantic threshold when the viewport aspect changes.
  const enterCoverage = authored ? requestedEnterCoverage : reachable(requestedEnterCoverage);
  const commitCoverage = authored
    ? authored.commitCoverage
    : reachable(SEMANTIC_LENS_POLICY.commitCoverage);
  const fullCoverage = authored
    ? authored.fullCoverage
    : reachable(SEMANTIC_LENS_POLICY.fullCoverage);
  // If enter is capped by view max, preserve the authored enter/leave gap. Capping
  // leave to the same attainable value would reverse an armed lens at exact max zoom.
  const reachableLeaveCoverage = {
    major: Math.min(requestedLeaveCoverage.major, Math.max(0, enterCoverage.major
      - Math.max(0, requestedEnterCoverage.major - requestedLeaveCoverage.major))),
    minor: Math.min(requestedLeaveCoverage.minor, Math.max(0, enterCoverage.minor
      - Math.max(0, requestedEnterCoverage.minor - requestedLeaveCoverage.minor))),
  };
  const leaveCoverage = authored ? authored.leaveCoverage : reachableLeaveCoverage;
  const authoredMinimumCssSize = authored?.minimumCssSize ?? { width: 160, height: 84 };
  const minimumCssSize = {
    width: Math.min(authoredMinimumCssSize.width, currentBounds.width * viewMaxZoom),
    height: Math.min(authoredMinimumCssSize.height, currentBounds.height * viewMaxZoom),
  };
  const fallbackEnterZoom = representation?.lod?.minZoom ?? SEMANTIC_LENS_ENTER_ZOOM[nextDetail];
  const minimumCssZoom = Math.max(
    minimumCssSize.width / Math.max(1, currentBounds.width),
    minimumCssSize.height / Math.max(1, currentBounds.height),
  );
  const coverageZoom = authored && !collectDiagnostics ? undefined
    : semanticLensCoverageEnterZoom(currentBounds, safeWidth, safeHeight, enterCoverage);
  const unclampedEnterZoom = authored?.minZoom ?? Math.max(fallbackEnterZoom, minimumCssZoom, coverageZoom!);
  const enterZoom = Math.min(viewMaxZoom, unclampedEnterZoom);
  const hysteresis = authored?.hysteresis ?? representation?.lod?.hysteresis ?? SEMANTIC_LENS_POLICY.reverseZoomDelta;
  const diagnostics = collectDiagnostics ? {
    currentBounds: { ...currentBounds }, nextBounds: { ...scene.projection!.boundsByEntityIdAndDetail[targetId]![nextDetail]! },
    safeWidth, safeHeight, authoredMinimum: authored?.minZoom ?? null,
    lodMinimum: representation?.lod?.minZoom ?? null, fallbackMinimum: fallbackEnterZoom,
    minimumCssZoom, coverageZoom: coverageZoom!, unclampedEnterZoom, viewMaxZoom, enterZoom,
    leaveZoom: enterZoom - hysteresis, fullZoom: authored?.fullZoom ?? null,
    commitCoverageZoom: semanticLensCoverageEnterZoom(currentBounds, safeWidth, safeHeight, commitCoverage),
    fullCoverageZoom: semanticLensCoverageEnterZoom(currentBounds, safeWidth, safeHeight, fullCoverage),
    dominantTerms: authored ? ['authored-minimum'] : [
      ...(fallbackEnterZoom === unclampedEnterZoom ? [representation?.lod?.minZoom === undefined ? 'band-minimum' : 'lod-minimum'] : []),
      ...(minimumCssZoom === unclampedEnterZoom ? ['minimum-css-size'] : []),
      ...(coverageZoom === unclampedEnterZoom ? ['current-card-coverage'] : []),
    ],
    commitGate: authored?.fullZoom === undefined ? 'current-card-coverage' : 'enter-zoom',
    fullGate: authored?.fullZoom === undefined ? 'current-card-coverage' : 'full-zoom',
    enterCoverage, commitCoverage, fullCoverage, leaveCoverage, minimumCssSize,
    pointerInsetPx: authored?.pointerInsetPx ?? SEMANTIC_LENS_POLICY.retargetContainmentPx,
    dwellMs: authored?.dwellMs ?? SEMANTIC_LENS_POLICY.dwellMs,
  } : undefined;
  return {
    enterZoom,
    hysteresis,
    ...(diagnostics ? { diagnostics } : {}),
    policy: {
      ...(authored?.sourceRepresentationId ? { sourceRepresentationId: authored.sourceRepresentationId } : {}),
      ...(authored?.targetRepresentationId ? { targetRepresentationId: authored.targetRepresentationId } : {}),
      enterCoverage,
      commitCoverage,
      fullCoverage,
      leaveCoverage,
      minimumCssSize,
      ...(authored?.fullZoom !== undefined ? { fullZoom: authored.fullZoom } : {}),
      transitionMs: authored?.transitionMs ?? SEMANTIC_LENS_POLICY.desktopAssistMs,
      dwellMs: authored?.dwellMs ?? SEMANTIC_LENS_POLICY.dwellMs,
      pointerInsetPx: authored?.pointerInsetPx ?? SEMANTIC_LENS_POLICY.retargetContainmentPx,
    },
  };
}

/** One-shot, read-only diagnostics for local/dev attribution; never sampled or logged by the runtime.
 * Thresholds do not prove candidate eligibility: pointer containment and descendants also gate targeting. */
export function semanticLensTargetZoomDiagnostics(
  scene: AtlasScene,
  targetId: string,
  currentDetail: SemanticDetail,
  viewport: ViewportSize,
  safeArea: SafeArea,
) {
  const nextDetail = (['context', 'container', 'component', 'code'] as const)[detailIndex(currentDetail) + 1] as Exclude<SemanticDetail, 'context'> | undefined;
  const currentBounds = scene.projection?.boundsByEntityIdAndDetail[targetId]?.[currentDetail];
  const nextBounds = nextDetail && scene.projection?.boundsByEntityIdAndDetail[targetId]?.[nextDetail];
  if (!nextDetail || !currentBounds || !nextBounds) return undefined;
  const safeWidth = Math.max(1, viewport.width - safeArea.left - safeArea.right);
  const safeHeight = Math.max(1, viewport.height - safeArea.top - safeArea.bottom);
  return { currentDetail, nextDetail, ...semanticLensTargetZoomPolicy(
    scene, targetId, nextDetail, currentBounds, safeWidth, safeHeight, true,
  ).diagnostics! };
}

export function findSemanticLensTarget(
  scene: AtlasScene,
  currentDetail: SemanticDetail,
  camera: Camera,
  viewport: ViewportSize,
  safeArea: SafeArea,
  pointer: LensPoint | undefined,
  fallbackIds: readonly string[] = [],
  eligibleIds?: ReadonlySet<string>,
  excludedIds?: ReadonlySet<string>,
): SemanticLensTarget | undefined {
  const index = detailIndex(currentDetail);
  const nextDetail = (['context', 'container', 'component', 'code'] as const)[index + 1] as Exclude<SemanticDetail, 'context'> | undefined;
  if (!nextDetail || !scene.projection) return undefined;
  const safeCenter = {
    x: safeArea.left + (viewport.width - safeArea.left - safeArea.right) / 2,
    y: safeArea.top + (viewport.height - safeArea.top - safeArea.bottom) / 2,
  };
  const probes = [pointer, safeCenter, ...fallbackIds.map(id => {
    const bounds = scene.projection!.boundsByEntityIdAndDetail[id]?.[currentDetail];
    if (!bounds) return undefined;
    const rect = screenRect(bounds, camera, viewport);
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })].filter((point): point is LensPoint => Boolean(point));
  const visible = new Set(scene.projection.entityIdsByDetail[currentDetail]);
  const candidates = scene.entities.filter(entity => visible.has(entity.id)
    && (!eligibleIds || eligibleIds.has(entity.id))
    && (!excludedIds || !excludedIds.has(entity.id))
    && descendantsInDetail(scene, entity.id, nextDetail).some(child => child.id !== entity.id))
    .sort((left, right) => detailIndex(right.detail ?? currentDetail) - detailIndex(left.detail ?? currentDetail)
      || right.id.localeCompare(left.id));
  const safeWidth = Math.max(1, viewport.width - safeArea.left - safeArea.right);
  const safeHeight = Math.max(1, viewport.height - safeArea.top - safeArea.bottom);
  for (const probe of probes) {
    for (const entity of candidates) {
      const currentBounds = scene.projection.boundsByEntityIdAndDetail[entity.id]?.[currentDetail];
      const nextBounds = scene.projection.boundsByEntityIdAndDetail[entity.id]?.[nextDetail];
      if (!currentBounds || !nextBounds) continue;
      const currentRect = screenRect(currentBounds, camera, viewport);
      if (!containsPoint(currentRect, probe)) continue;
      const containedBy = containmentPx(currentRect, probe);
      if (containedBy < SEMANTIC_LENS_POLICY.retargetContainmentPx) continue;
      const zoomPolicy = semanticLensTargetZoomPolicy(
        scene,
        entity.id,
        nextDetail,
        currentBounds,
        safeWidth,
        safeHeight,
      );
      return {
        id: entity.id,
        currentDetail,
        nextDetail,
        ...zoomPolicy,
        coverage: semanticLensCoverage(currentRect.width, currentRect.height, safeWidth, safeHeight),
        coverageTolerance: 0.5 / Math.max(1, Math.min(safeWidth, safeHeight)),
        containmentPx: containedBy,
      };
    }
  }
  // O3 snap-to-nearest (task #37, scan-mode): under aspect packing an owner shell can be far
  // larger than a child, so a continuous wheel zoom often lands the cursor in the interior
  // PADDING between children — no candidate contains it, the band never advances, and the user
  // zooms into blank space. When the primary probe sits INSIDE the collective extent of the
  // eligible children (i.e. within the owner interior, just off a child), advance toward the
  // NEAREST child instead of stalling. Deterministic: nearest by squared probe→rect distance,
  // ties broken by the pre-sorted candidate order. The snapped child reports containmentPx =
  // its pointer-inset so armEligible/resolveRetarget accept it; enterZoom/coverage are computed
  // identically, so the reveal threshold is unchanged. Gated to scan (scene.targetAspect set),
  // so the golden/demo lens behaviour is byte-identical.
  const snapProbe = probes[0];
  if (scene.targetAspect !== undefined && snapProbe) {
    let union: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
    let nearest: { entity: SceneEntity; currentBounds: LensBounds; currentRect: LensBounds; distanceSq: number } | undefined;
    for (const entity of candidates) {
      const currentBounds = scene.projection.boundsByEntityIdAndDetail[entity.id]?.[currentDetail];
      const nextBounds = scene.projection.boundsByEntityIdAndDetail[entity.id]?.[nextDetail];
      if (!currentBounds || !nextBounds) continue;
      const rect = screenRect(currentBounds, camera, viewport);
      union = union
        ? {
            minX: Math.min(union.minX, rect.x),
            minY: Math.min(union.minY, rect.y),
            maxX: Math.max(union.maxX, rect.x + rect.width),
            maxY: Math.max(union.maxY, rect.y + rect.height),
          }
        : { minX: rect.x, minY: rect.y, maxX: rect.x + rect.width, maxY: rect.y + rect.height };
      const dx = Math.max(rect.x - snapProbe.x, 0, snapProbe.x - (rect.x + rect.width));
      const dy = Math.max(rect.y - snapProbe.y, 0, snapProbe.y - (rect.y + rect.height));
      const distanceSq = dx * dx + dy * dy;
      if (!nearest || distanceSq < nearest.distanceSq) nearest = { entity, currentBounds, currentRect: rect, distanceSq };
    }
    if (nearest && union
      && snapProbe.x >= union.minX && snapProbe.x <= union.maxX
      && snapProbe.y >= union.minY && snapProbe.y <= union.maxY) {
      const zoomPolicy = semanticLensTargetZoomPolicy(scene, nearest.entity.id, nextDetail, nearest.currentBounds, safeWidth, safeHeight);
      const pointerInset = zoomPolicy.policy?.pointerInsetPx ?? SEMANTIC_LENS_POLICY.retargetContainmentPx;
      return {
        id: nearest.entity.id,
        currentDetail,
        nextDetail,
        ...zoomPolicy,
        coverage: semanticLensCoverage(nearest.currentRect.width, nearest.currentRect.height, safeWidth, safeHeight),
        coverageTolerance: 0.5 / Math.max(1, Math.min(safeWidth, safeHeight)),
        containmentPx: Math.max(pointerInset, containmentPx(nearest.currentRect, snapProbe)),
      };
    }
  }
  return undefined;
}

/** Measures a locked target independently of the current pointer candidate. */
export function measureSemanticLensTarget(
  scene: AtlasScene,
  targetId: string,
  currentDetail: SemanticDetail,
  camera: Camera,
  viewport: ViewportSize,
  safeArea: SafeArea,
  pointer?: LensPoint,
): SemanticLensTarget | undefined {
  const index = detailIndex(currentDetail);
  const nextDetail = (['context', 'container', 'component', 'code'] as const)[index + 1] as Exclude<SemanticDetail, 'context'> | undefined;
  const currentBounds = scene.projection?.boundsByEntityIdAndDetail[targetId]?.[currentDetail];
  const nextBounds = nextDetail && scene.projection?.boundsByEntityIdAndDetail[targetId]?.[nextDetail];
  if (!nextDetail || !currentBounds || !nextBounds) return undefined;
  const safeWidth = Math.max(1, viewport.width - safeArea.left - safeArea.right);
  const safeHeight = Math.max(1, viewport.height - safeArea.top - safeArea.bottom);
  const currentRect = screenRect(currentBounds, camera, viewport);
  // The pointer gates containment only while it is actually INSIDE the locked target.
  // A cursor-anchored zoom can grow the target past the whole viewport while the
  // pointer world-point stays just outside its rect; measuring containment against
  // that pointer left an armed lens uncommittable forever (zoomed into a blank
  // interior). Outside the rect, the target's own centre is the honest probe.
  const probe = pointer && containsPoint(currentRect, pointer) ? pointer : {
    x: currentRect.x + currentRect.width / 2,
    y: currentRect.y + currentRect.height / 2,
  };
  const zoomPolicy = semanticLensTargetZoomPolicy(
    scene,
    targetId,
    nextDetail,
    currentBounds,
    safeWidth,
    safeHeight,
  );
  return {
    id: targetId,
    currentDetail,
    nextDetail,
    ...zoomPolicy,
    coverage: semanticLensCoverage(currentBounds.width * camera.zoom, currentBounds.height * camera.zoom, safeWidth, safeHeight),
    coverageTolerance: 0.5 / Math.max(1, Math.min(safeWidth, safeHeight)),
    containmentPx: containmentPx(currentRect, probe),
  };
}

export function semanticLensScopeIds(scene: AtlasScene, targetId: string, nextDetail: SemanticDetail): string[] {
  const scope = new Set(descendantsInDetail(scene, targetId, nextDetail).map(entity => entity.id));
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  let ancestor = byId.get(targetId)?.parentId;
  for (let count = 0; ancestor && count < 2; count += 1) {
    scope.add(ancestor);
    ancestor = byId.get(ancestor)?.parentId;
  }
  return [...scope].sort();
}

type ProtocolProjectionScene = {
  objects: Array<{
    id: string;
    representations: Array<{
      id: string;
      lod?: { minZoom: number; hysteresis: number };
    }>;
  }>;
  paths: Array<{ id: string }>;
};

export function semanticLensBranchEntityIds(scene: AtlasScene, targetId: string, nextDetail: SemanticDetail): string[] {
  return descendantsInDetail(scene, targetId, nextDetail).map(entity => entity.id).sort();
}

/** Returns only live descendants, excluding the already-settled branch root itself. */
export function semanticLensStrictDescendantIds(scene: AtlasScene, targetId: string, detail: SemanticDetail): string[] {
  return descendantsInDetail(scene, targetId, detail)
    .filter(entity => entity.id !== targetId)
    .map(entity => entity.id)
    .sort();
}

/** Explicitly owns one semantic band so native global LOD cannot leak another band. */
export function semanticBaseProjectionOverride(scene: AtlasScene, detail: SemanticDetail): ProjectionOverride | undefined {
  const protocol = scene.protocolSnapshot as ProtocolProjectionScene | undefined;
  if (!protocol?.objects || !protocol.paths || !scene.projection) return undefined;
  const visiblePaths = new Set(scene.projection.projectedRelationsByDetail[detail].map(relation => relation.id));
  const objects = protocol.objects.map(object => {
    const representationId = object.representations.find(candidate => candidate.id === `${object.id}:${detail}`)?.id;
    return {
      objectId: object.id,
      ...(representationId ? { sourceRepresentationId: representationId, targetRepresentationId: representationId } : {}),
    };
  });
  return {
    id: `semantic-base:${detail}`,
    progress: 1,
    objects,
    paths: protocol.paths.map(path => ({
      pathId: path.id,
      sourceOpacity: visiblePaths.has(path.id) ? 1 : 0,
      targetOpacity: visiblePaths.has(path.id) ? 1 : 0,
    })),
  };
}

/** Maps semantic lens ownership onto every retained visual object/path. */
export function semanticLensProjectionOverride(scene: AtlasScene, state: SemanticLensState): ProjectionOverride | undefined {
  if (state.phase === 'idle' || !state.targetId || !state.currentDetail || !state.nextDetail || !scene.projection) return undefined;
  const protocol = scene.protocolSnapshot as ProtocolProjectionScene | undefined;
  if (!protocol?.objects || !protocol.paths) return undefined;
  const branch = new Set(semanticLensBranchEntityIds(scene, state.targetId, state.nextDetail));
  const sourceEntities = new Set(scene.projection.entityIdsByDetail[state.currentDetail]);
  const sourceRelations = scene.projection.projectedRelationsByDetail[state.currentDetail];
  const targetRelations = scene.projection.projectedRelationsByDetail[state.nextDetail];
  const sourcePathIds = new Set(sourceRelations.map(relation => relation.id));
  const targetPathIds = new Set(targetRelations.map(relation => relation.id));
  const sourceInternalPathIds = new Set(sourceRelations
    .filter(relation => branch.has(relation.from) && branch.has(relation.to))
    .map(relation => relation.id));
  const targetInternalPathIds = new Set(targetRelations
    .filter(relation => branch.has(relation.from) && branch.has(relation.to))
    .map(relation => relation.id));
  const boundaryObjectId = scene.projection.semanticToVisualEntityId[state.targetId];
  if (!boundaryObjectId) return undefined;
  const authoredTransition = scene.projection.semanticTransitionsByEntityId?.[state.targetId]?.[state.nextDetail];
  const morphObjectIds = new Set<string>();
  const representation = (object: ProtocolProjectionScene['objects'][number], detail: SemanticDetail) => {
    if (object.id === boundaryObjectId && authoredTransition) {
      if (detail === state.currentDetail) return authoredTransition.sourceRepresentationId;
      if (detail === state.nextDetail) return authoredTransition.targetRepresentationId;
    }
    return object.representations.find(candidate => candidate.id === `${object.id}:${detail}`)?.id;
  };
  const labelPathId = (objectId: string) => objectId.startsWith('relation-label:')
    ? objectId.slice('relation-label:'.length)
    : undefined;

  const objects = protocol.objects.map(object => {
    const entityId = scene.projection!.visualToSemanticEntityId[object.id];
    const sourceRepresentationId = representation(object, state.currentDetail!);
    const targetRepresentationId = representation(object, state.nextDetail!);
    const relationPathId = labelPathId(object.id);
    if (entityId && branch.has(entityId)) {
      if (targetRepresentationId) morphObjectIds.add(object.id);
      return { objectId: object.id, ...(sourceRepresentationId ? { sourceRepresentationId } : {}), ...(targetRepresentationId ? { targetRepresentationId } : {}) };
    }
    if (relationPathId && (sourceInternalPathIds.has(relationPathId) || targetInternalPathIds.has(relationPathId))) {
      if (targetRepresentationId && (sourceInternalPathIds.has(relationPathId) || targetInternalPathIds.has(relationPathId))) {
        morphObjectIds.add(object.id);
      }
      return {
        objectId: object.id,
        ...(sourceInternalPathIds.has(relationPathId) && sourceRepresentationId ? { sourceRepresentationId } : {}),
        ...(targetInternalPathIds.has(relationPathId) && targetRepresentationId ? { targetRepresentationId } : {}),
      };
    }
    if (sourceRepresentationId && (!entityId || sourceEntities.has(entityId))) {
      return { objectId: object.id, sourceRepresentationId };
    }
    return { objectId: object.id };
  });

  const morphPathIds = new Set([...sourceInternalPathIds, ...targetInternalPathIds]);
  const paths = protocol.paths.map(path => {
    return {
      pathId: path.id,
      sourceOpacity: sourcePathIds.has(path.id) ? 1 : 0,
      targetOpacity: targetInternalPathIds.has(path.id) ? 1 : 0,
    };
  });
  morphObjectIds.add(boundaryObjectId);
  return {
    id: `semantic-lens:${state.targetId}:${state.currentDetail}:${state.nextDetail}`,
    progress: state.progress,
    objects,
    paths,
    morph: {
      boundaryObjectId,
      objectIds: [...morphObjectIds].sort(),
      pathIds: [...morphPathIds].filter(id => targetPathIds.has(id) || sourcePathIds.has(id)).sort(),
    },
  };
}

type SemanticObjectContract = {
  /** Obsolete ancestor geometry must not cross an expanding branch, even mid-blend. */
  suppressDuringTransition?: boolean;
  representationId?: string;
  opacity: number;
  contentOpacity: number;
  pickable: boolean;
  pickPriority: number;
};

type SemanticPathContract = { opacity: number; detail?: SemanticDetail };

function semanticContractsForEntries(
  scene: AtlasScene,
  protocol: ProtocolProjectionScene,
  baseDetail: SemanticDetail,
  entries: readonly SemanticLensPathEntry[],
) {
  const representation = (objectId: string, detail: SemanticDetail) => protocol.objects
    .find(object => object.id === objectId)?.representations
    .find(candidate => candidate.id === `${objectId}:${detail}`)?.id;
  const ownership = entries.length
    ? semanticEntitiesForEntries(scene, entries)
    : {
        primary: new Set(scene.projection?.entityIdsByDetail[baseDetail] ?? []),
        ancestors: new Set<string>(),
        ghosts: [] as SemanticGhostEntity[],
        silhouettes: [] as SemanticSilhouetteEntity[],
        detail: baseDetail,
      };
  const ghosts = new Map(ownership.ghosts.map(ghost => [ghost.id, ghost]));
  const silhouettes = new Map(ownership.silhouettes.map(silhouette => [silhouette.id, silhouette]));
  const ancestorDetails = new Map(entries.slice(0, -1).map(entry => [entry.targetId, entry.currentDetail]));
  const focusId = entries.at(-1)?.targetId;
  const focusBounds = focusId ? scene.projection?.boundsByEntityIdAndDetail[focusId]?.[ownership.detail] : undefined;
  const objectContracts = new Map<string, SemanticObjectContract>();
  for (const object of protocol.objects) {
    const entityId = scene.projection?.visualToSemanticEntityId[object.id];
    if (!entityId) continue;
    if (ownership.primary.has(entityId)) {
      objectContracts.set(object.id, {
        representationId: representation(object.id, ownership.detail),
        opacity: 1,
        contentOpacity: 1,
        pickable: true,
        pickPriority: 1_000 + detailIndex(ownership.detail) * 100,
      });
      continue;
    }
    const ancestorDetail = ancestorDetails.get(entityId);
    if (ownership.ancestors.has(entityId) && ancestorDetail) {
      const bounds = scene.projection?.boundsByEntityIdAndDetail[entityId]?.[ancestorDetail];
      // Independently laid-out deeper scopes can outgrow a retained ancestor.
      // Omit its obsolete shell instead of drawing a selected border through the
      // incoming branch. Selection and inspector identity remain unchanged.
      const enclosesFocus = !bounds || !focusBounds || (
        bounds.x <= focusBounds.x + .001 && bounds.y <= focusBounds.y + .001
        && bounds.x + bounds.width >= focusBounds.x + focusBounds.width - .001
        && bounds.y + bounds.height >= focusBounds.y + focusBounds.height - .001
      );
      objectContracts.set(object.id, {
        ...(enclosesFocus ? { representationId: representation(object.id, ancestorDetail) } : {}),
        opacity: enclosesFocus ? .32 : 0,
        suppressDuringTransition: !enclosesFocus,
        contentOpacity: 0,
        pickable: false,
        pickPriority: 0,
      });
      continue;
    }
    const ghost = ghosts.get(entityId);
    if (ghost) {
      objectContracts.set(object.id, {
        // Background context keeps its own band geometry. Selecting the deeper
        // band's representation here makes unrelated siblings rearrange during
        // the focused owner's morph and detaches them from retained old routes.
        representationId: representation(object.id, ghost.detail),
        opacity: ghost.opacity,
        contentOpacity: ghost.opacity === .24 ? ghost.opacity : 0,
        pickable: ghost.opacity === .24,
        pickPriority: 500 + detailIndex(ghost.detail) * 100 + ghost.depth,
      });
      continue;
    }
    const silhouette = silhouettes.get(entityId);
    if (silhouette) {
      objectContracts.set(object.id, {
        representationId: representation(object.id, silhouette.detail),
        opacity: silhouette.opacity,
        contentOpacity: 0,
        pickable: false,
        pickPriority: 0,
      });
      continue;
    }
    objectContracts.set(object.id, { opacity: 0, contentOpacity: 0, pickable: false, pickPriority: 0 });
  }

  const pathContracts = new Map<string, SemanticPathContract>();
  if (!entries.length) {
    for (const relation of scene.projection?.projectedRelationsByDetail[baseDetail] ?? []) {
      pathContracts.set(relation.id, { opacity: 1, detail: baseDetail });
    }
  } else {
    for (const relation of scene.projection?.projectedRelationsByDetail[ownership.detail] ?? []) {
      if (ownership.primary.has(relation.from) && ownership.primary.has(relation.to)) {
        pathContracts.set(relation.id, { opacity: 1, detail: ownership.detail });
      }
    }
    let ghostPathCount = 0;
    for (let depth = 0; depth < entries.length && ghostPathCount < GHOST_PATH_CAP; depth += 1) {
      const entry = entries[depth]!;
      const depthGhosts = new Set(ownership.ghosts.filter(ghost => ghost.depth === depth).map(ghost => ghost.id));
      const contextual = new Set([entry.targetId, ...depthGhosts]);
      for (const relation of scene.projection?.projectedRelationsByDetail[entry.currentDetail] ?? []) {
        if (contextual.has(relation.from) && contextual.has(relation.to)
          && (depthGhosts.has(relation.from) || depthGhosts.has(relation.to))) {
          pathContracts.set(relation.id, { opacity: .10, detail: entry.currentDetail });
          ghostPathCount += 1;
          if (ghostPathCount >= GHOST_PATH_CAP) break;
        }
      }
    }
  }

  for (const object of protocol.objects) {
    if (!object.id.startsWith('relation-label:')) continue;
    const path = pathContracts.get(object.id.slice('relation-label:'.length));
    objectContracts.set(object.id, path
      ? {
          representationId: path.detail ? representation(object.id, path.detail) : undefined,
          opacity: path.opacity,
          contentOpacity: path.opacity,
          pickable: false,
          pickPriority: 0,
        }
      : { opacity: 0, contentOpacity: 0, pickable: false, pickPriority: 0 });
  }
  return { objects: objectContracts, paths: pathContracts };
}

/** Fade context before the expanding focus reaches it; never relocate it. */
export function semanticBackgroundVisibility(background: LensBounds, focus: LensBounds): number {
  const separation = Math.max(
    background.x - (focus.x + focus.width), focus.x - (background.x + background.width),
    background.y - (focus.y + focus.height), focus.y - (background.y + background.height),
  );
  const fadeDistance = Math.max(1, Math.min(background.width, background.height) * .08);
  const amount = clamp01(separation / fadeDistance);
  return amount * amount * (3 - 2 * amount);
}

/** Composes all settled branch expansions and at most one active transition into one native override. */
export function semanticLensSessionProjectionOverride(scene: AtlasScene, session: SemanticLensSession, deferBackgroundVisibility = false): ProjectionOverride | undefined {
  const protocol = scene.protocolSnapshot as ProtocolProjectionScene | undefined;
  if (!protocol?.objects || !protocol.paths || !scene.projection) return undefined;
  const activeEntry = session.active.phase !== 'idle'
    && session.active.targetId && session.active.currentDetail && session.active.nextDetail
    ? {
        targetId: session.active.targetId,
        currentDetail: session.active.currentDetail,
        nextDetail: session.active.nextDetail,
      }
    : undefined;
  const sourceEntries = session.focusTransfer?.sourceEntries ?? session.settled;
  const targetEntries = activeEntry ? [...session.settled, activeEntry] : session.settled;
  const source = semanticContractsForEntries(scene, protocol, session.baseDetail, sourceEntries);
  const target = semanticContractsForEntries(scene, protocol, session.baseDetail, targetEntries);
  const active = activeEntry ? semanticLensProjectionOverride(scene, session.active) : undefined;
  // A source-band edge that leaves the owner being expanded has no stable
  // geometry once that owner becomes its independently laid-out child graph.
  // Keeping it for the normal source→target fade draws the old route straight
  // through the incoming grid. Suppress only paths with no target-band
  // continuation: internal paths remain available to the incoming branch.
  const targetPathIds = new Set(activeEntry
    ? scene.projection.projectedRelationsByDetail[activeEntry.nextDetail].map(relation => relation.id)
    : []);
  const obsoleteBoundarySourcePathIds = new Set(activeEntry
    ? scene.projection.projectedRelationsByDetail[activeEntry.currentDetail]
      .filter(relation => (relation.from === activeEntry.targetId || relation.to === activeEntry.targetId)
        && !targetPathIds.has(relation.id))
      .map(relation => relation.id)
    : []);
  const progress = active ? session.active.progress : session.focusTransfer?.progress ?? 1;
  const transferKey = session.focusTransfer
    ? `transfer:${session.focusTransfer.sourceEntries.at(-1)?.targetId ?? 'base'}>${session.focusTransfer.targetId}:${session.focusTransfer.depth}`
    : undefined;
  const projection: ProjectionOverride = {
    id: `semantic-path:${session.baseDetail}:${session.settled.map(entry => entry.targetId).join('>') || 'base'}:${active?.id ?? transferKey ?? 'settled'}`,
    progress,
    objects: protocol.objects.map(object => {
      const to = target.objects.get(object.id) ?? { opacity: 0, contentOpacity: 0, pickable: false, pickPriority: 0 };
      const from = to.suppressDuringTransition ? to
        : source.objects.get(object.id) ?? { opacity: 0, contentOpacity: 0, pickable: false, pickPriority: 0 };
      return {
        objectId: object.id,
        ...(from.representationId ? { sourceRepresentationId: from.representationId } : {}),
        ...(to.representationId ? { targetRepresentationId: to.representationId } : {}),
        sourceOpacity: from.opacity,
        targetOpacity: to.opacity,
        sourceContentOpacity: from.contentOpacity,
        targetContentOpacity: to.contentOpacity,
        sourcePickable: from.pickable,
        targetPickable: to.pickable,
        sourcePickPriority: from.pickPriority,
        targetPickPriority: to.pickPriority,
      };
    }),
    paths: protocol.paths.map(path => {
      const suppressSourcePath = obsoleteBoundarySourcePathIds.has(path.id);
      return {
        pathId: path.id,
        sourceOpacity: suppressSourcePath ? 0 : source.paths.get(path.id)?.opacity ?? 0,
        targetOpacity: suppressSourcePath ? 0 : target.paths.get(path.id)?.opacity ?? 0,
      };
    }),
    ...(active?.morph ? { morph: active.morph } : {}),
  };
  return deferBackgroundVisibility ? projection : applySemanticBackgroundVisibility(scene, session, projection);
}

/** Apply progress-dependent visibility after reusing the immutable topology. */
export function applySemanticBackgroundVisibility(scene: AtlasScene, session: SemanticLensSession, projection: ProjectionOverride): ProjectionOverride {
  if (!scene.projection) return projection;
  const activeEntry = session.active.phase !== 'idle' && session.active.targetId && session.active.currentDetail && session.active.nextDetail
    ? { targetId: session.active.targetId, currentDetail: session.active.currentDetail, nextDetail: session.active.nextDetail }
    : undefined;
  const sourceEntries = session.focusTransfer?.sourceEntries ?? session.settled;
  const targetEntries = activeEntry ? [...session.settled, activeEntry] : session.settled;
  const progress = projection.progress;
  const focusEntry = targetEntries.at(-1);
  const focusSource = focusEntry ? scene.projection.boundsByEntityIdAndDetail[focusEntry.targetId]?.[focusEntry.currentDetail] : undefined;
  const focusTarget = focusEntry ? scene.projection.boundsByEntityIdAndDetail[focusEntry.targetId]?.[focusEntry.nextDetail] : undefined;
  const focusBounds = focusSource && focusTarget && activeEntry
    ? interpolateSemanticOwnerBounds(focusSource, focusTarget, progress)
    : focusTarget;
  const backgroundVisibilityFor = (entries: readonly SemanticLensPathEntry[], focus: LensBounds | undefined) => {
    const visibility = new Map<string, number>();
    if (!focus) return visibility;
    for (const ghost of ghostEntitiesForEntries(scene, entries)) {
      const bounds = scene.projection!.boundsByEntityIdAndDetail[ghost.id]?.[ghost.detail];
      const visualId = scene.projection!.semanticToVisualEntityId[ghost.id];
      if (bounds && visualId) {
        // Older context also remains behind already-expanded ancestors. Using
        // only the smallest new focus would reveal it at the next zoom's p=0.
        const envelopes = entries.slice(ghost.depth).map((entry, index, relevant) =>
          index === relevant.length - 1 ? focus
            : scene.projection!.boundsByEntityIdAndDetail[entry.targetId]?.[entry.nextDetail]);
        visibility.set(visualId, Math.min(...envelopes.map(envelope =>
          envelope ? semanticBackgroundVisibility(bounds, envelope) : 1)));
      }
    }
    for (const silhouette of silhouetteEntitiesForEntries(scene, entries)) {
      const parentVisual = scene.projection!.semanticToVisualEntityId[silhouette.parentGhostId];
      const visualId = scene.projection!.semanticToVisualEntityId[silhouette.id];
      if (visualId) visibility.set(visualId, visibility.get(parentVisual) ?? 1);
    }
    for (const relations of Object.values(scene.projection!.projectedRelationsByDetail)) {
      for (const relation of relations) {
        const from = scene.projection!.semanticToVisualEntityId[relation.from];
        const to = scene.projection!.semanticToVisualEntityId[relation.to];
        const amount = Math.min(visibility.get(from) ?? 1, visibility.get(to) ?? 1);
        visibility.set(relation.id, amount);
        visibility.set(`relation-label:${relation.id}`, amount);
      }
    }
    return visibility;
  };
  // Wheel morphs share one current focus envelope. Explicit focus transfers
  // blend the two endpoint contracts, including visibility, to avoid flashes
  // when the transfer starts or settles. Minimap geometry uses the same packet.
  const targetVisibility = backgroundVisibilityFor(targetEntries, focusBounds);
  const sourceFocusEntry = sourceEntries.at(-1);
  const sourceFocusBounds = sourceFocusEntry
    ? scene.projection.boundsByEntityIdAndDetail[sourceFocusEntry.targetId]?.[sourceFocusEntry.nextDetail]
    : undefined;
  const sourceVisibility = session.focusTransfer
    ? backgroundVisibilityFor(sourceEntries, sourceFocusBounds)
    : targetVisibility;
  return {
    ...projection,
    objects: projection.objects.map(object => {
      const from = sourceVisibility.get(object.objectId) ?? 1;
      const to = targetVisibility.get(object.objectId) ?? 1;
      return { ...object,
        sourceOpacity: (object.sourceOpacity ?? (object.sourceRepresentationId ? 1 : 0)) * from,
        targetOpacity: (object.targetOpacity ?? (object.targetRepresentationId ? 1 : 0)) * to,
        sourceContentOpacity: (object.sourceContentOpacity ?? object.sourceOpacity ?? 1) * from,
        targetContentOpacity: (object.targetContentOpacity ?? object.targetOpacity ?? 1) * to,
        sourcePickable: object.sourcePickable !== false && from > .001,
        targetPickable: object.targetPickable !== false && to > .001,
      };
    }),
    paths: projection.paths.map(path => ({ ...path,
      sourceOpacity: path.sourceOpacity * (sourceVisibility.get(path.pathId) ?? 1),
      targetOpacity: path.targetOpacity * (targetVisibility.get(path.pathId) ?? 1),
    })),
  };
}
