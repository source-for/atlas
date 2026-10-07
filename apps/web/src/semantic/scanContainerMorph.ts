import { scanCodeRevealWindow, type ScanCodeRevealWindow } from './scanCodeRevealWindow';
import { C4_CAMERA_LIMITS, C4_ZOOM_BANDS, type SceneSnapshot } from '@okie/scene-compiler';
import type { AtlasScene, Camera } from '../renderer/types';
import { semanticBounds } from '../renderer/goldenC4Scene';
import { composeSemanticZoomCamera, idleSemanticLens, semanticLensSessionDetail, semanticLensZoomProgress, type SemanticLensSession } from './semanticLens';
import { semanticLevelSession } from './semanticLensEngine';

const detailOrder = ['context', 'container', 'component', 'code'] as const;

function retainedDetailsThrough(detail: string) {
  const index = detailOrder.indexOf(detail as typeof detailOrder[number]);
  return new Set(detailOrder.slice(0, Math.max(0, index) + 1));
}

/** Keep the visible L1/L2 geometry while installing a bounded L3 neighborhood.
 * Both endpoints then live in one retained scene, as they do for the L1→L2 morph.
 * The incoming files retain their full layout; preview pills are not the endpoint.
 */
export function retainScanDetailMorphSource(
  source: AtlasScene,
  target: AtlasScene,
  sourceDetail: typeof detailOrder[number],
): AtlasScene {
  const from = source.projection;
  const to = target.projection;
  const oldProtocol = source.protocolSnapshot as SceneSnapshot | undefined;
  const newProtocol = target.protocolSnapshot as SceneSnapshot | undefined;
  if (!from || !to || !oldProtocol || !newProtocol) return target;
  const retainedDetails = retainedDetailsThrough(sourceDetail);
  const retained = (id: string) => [...retainedDetails].some(detail => id.endsWith(`:${detail}`));
  const oldObjects = new Map(oldProtocol.objects.map(object => [object.id, object]));
  const objects = newProtocol.objects.map(object => ({
    ...object,
    representations: [
      ...object.representations.filter(representation => !retained(representation.id)),
      ...(oldObjects.get(object.id)?.representations ?? object.representations)
        .filter(representation => retained(representation.id)),
    ],
  }));
  const objectIds = new Set(objects.map(object => object.id));
  for (const object of oldProtocol.objects) {
    const representations = object.representations.filter(representation => retained(representation.id));
    if (!objectIds.has(object.id) && representations.length) objects.push({ ...object, representations });
  }
  const retainedPathIds = new Set([...retainedDetails].flatMap(detail => from.relationIdsByDetail[detail]));
  const bounds = { ...to.boundsByEntityIdAndDetail };
  for (const [id, previous] of Object.entries(from.boundsByEntityIdAndDetail)) {
    bounds[id] = {
      ...bounds[id],
      ...Object.fromEntries([...retainedDetails]
        .filter(detail => previous[detail])
        .map(detail => [detail, previous[detail]!])),
    };
  }
  const entityIds = new Set(target.entities.map(entity => entity.id));
  const retainedEntityIds = new Set([...retainedDetails].flatMap(detail => from.entityIdsByDetail[detail]));
  const paths = [
    ...newProtocol.paths.filter(path => !retainedPathIds.has(path.id)),
    ...oldProtocol.paths.filter(path => retainedPathIds.has(path.id)),
  ];
  // The source's maps name every object it held, including finer-band ones this scene
  // drops. A selection left on one of those must not resolve to an object the renderer
  // was never given: the engine rejects the whole visibility filter (CLA-401).
  const finalObjectIds = new Set(objects.map(object => object.id));
  const finalPathIds = new Set(paths.map(path => path.id));
  const sourceEntityVisuals = Object.fromEntries(Object.entries(from.semanticToVisualEntityId)
    .filter(([, visualId]) => finalObjectIds.has(visualId)));
  const sourceVisualEntities = Object.fromEntries(Object.entries(from.visualToSemanticEntityId)
    .filter(([visualId]) => finalObjectIds.has(visualId)));
  const sourceRelationVisuals = Object.fromEntries(Object.entries(from.semanticToVisualRelationIds)
    .map(([id, visualIds]) => [id, visualIds.filter(visualId => finalPathIds.has(visualId))] as const)
    .filter(([, visualIds]) => visualIds.length > 0));
  const sourceVisualRelations = Object.fromEntries(Object.entries(from.visualToSemanticRelationIds)
    .filter(([visualId]) => finalPathIds.has(visualId)));
  const world = [oldProtocol.worldBounds, newProtocol.worldBounds];
  const x = Math.min(...world.map(rect => rect.x));
  const y = Math.min(...world.map(rect => rect.y));
  return {
    ...target,
    protocolPatch: undefined,
    entities: [...target.entities, ...source.entities.filter(entity => !entityIds.has(entity.id) && retainedEntityIds.has(entity.id))],
    protocolSnapshot: {
      ...newProtocol,
      worldBounds: { x, y, width: Math.max(...world.map(rect => rect.x + rect.width)) - x, height: Math.max(...world.map(rect => rect.y + rect.height)) - y },
      objects,
      paths,
    } satisfies SceneSnapshot,
    projection: {
      ...to,
      semanticToVisualEntityId: { ...sourceEntityVisuals, ...to.semanticToVisualEntityId },
      visualToSemanticEntityId: { ...sourceVisualEntities, ...to.visualToSemanticEntityId },
      semanticToVisualRelationIds: { ...sourceRelationVisuals, ...to.semanticToVisualRelationIds },
      visualToSemanticRelationIds: { ...sourceVisualRelations, ...to.visualToSemanticRelationIds },
      boundsByEntityIdAndDetail: bounds,
      entityIdsByDetail: { ...to.entityIdsByDetail, ...Object.fromEntries([...retainedDetails].map(detail => [detail, from.entityIdsByDetail[detail]])) },
      relationIdsByDetail: { ...to.relationIdsByDetail, ...Object.fromEntries([...retainedDetails].map(detail => [detail, from.relationIdsByDetail[detail]])) },
      projectedRelationsByDetail: { ...to.projectedRelationsByDetail, ...Object.fromEntries([...retainedDetails].map(detail => [detail, from.projectedRelationsByDetail[detail]])) },
    },
  };
}

/**
 * Retain an adjacent source band while its bounded replacement is revealed.
 * This is deliberately a one-owner bridge: it never widens the scan compile.
 */
export function createScanDetailMorph(
  source: AtlasScene,
  target: AtlasScene,
  focusId: string,
  sourceDetail: typeof detailOrder[number],
  targetDetail: typeof detailOrder[number],
  startZoom: number,
  sourceSession?: SemanticLensSession,
  frozenWindow?: ScanCodeRevealWindow,
) {
  const sourceIndex = detailOrder.indexOf(sourceDetail);
  const targetIndex = detailOrder.indexOf(targetDetail);
  if (targetIndex !== sourceIndex + 1) return undefined;
  const scene = retainScanDetailMorphSource(source, target, sourceDetail);
  const sourceBounds = semanticBounds(scene, focusId, sourceDetail);
  const targetBounds = semanticBounds(scene, focusId, targetDetail);
  const targetSession = semanticLevelSession(scene, targetDetail, [focusId]);
  const entry = targetSession.settled.at(-1);
  const resolvedSourceSession = sourceSession
    ? { ...sourceSession, active: idleSemanticLens(), focusTransfer: undefined }
    : { ...targetSession, settled: targetSession.settled.slice(0, -1), active: idleSemanticLens() };
  if (!sourceBounds || !targetBounds || entry?.targetId !== focusId || entry.currentDetail !== sourceDetail
    || semanticLensSessionDetail(resolvedSourceSession) !== sourceDetail) return undefined;
  const codeWindow = targetDetail === 'code' && target.targetAspect !== undefined
    ? frozenWindow ?? scanCodeRevealWindow(sourceBounds, target.scanCodeSafeWidth) : undefined;
  if (codeWindow) startZoom = codeWindow.startZoom;
  const fullZoom = codeWindow?.fullZoom ?? Math.min(C4_CAMERA_LIMITS.maxZoom, Math.max(C4_ZOOM_BANDS[targetIndex]!.enterZoom, startZoom * 1.65));
  if (fullZoom <= startZoom) return undefined;
  return {
    scene, sourceScene: source, focusId, sourceDetail, targetDetail, sourceBounds, targetBounds, startZoom, fullZoom, codeWindow,
    sourceSession: resolvedSourceSession,
    targetSession, entry, progress: 0, baselineProgress: 0,
  };
}

/** Compatibility name for the L2→L3 specialization. */
export function retainContainerMorphSource(source: AtlasScene, target: AtlasScene): AtlasScene {
  return retainScanDetailMorphSource(source, target, 'container');
}

/** The shortest zoom ratio a container expansion may span, so it is still an expansion and not a cut. */
export const SCAN_CONTAINER_MORPH_MIN_SPAN = 1.2;

/**
 * The L2→L3 specialization. Its end is capped at the earliest L3→L4 arm zoom among the
 * container's files (CLA-404): the code handoff cannot start until this expansion is
 * complete, and a container with few, large files otherwise reaches its files' whole code
 * window while still expanding. `codeSafeWidth` is the width the code windows are measured in.
 *
 * Two floors win over the cap: the minimum span, and the component band's enter zoom (a
 * completed expansion must not sit below the band it arrived in). When the expansion starts
 * at or past the arm zoom the code reveal is therefore still late, only sooner. On a narrow
 * safe width (a phone) that is the normal case: the files' whole code window lies below
 * the zoom at which the expansion starts.
 */
export function createScanContainerMorph(source: AtlasScene, target: AtlasScene, focusId: string, startZoom: number, codeSafeWidth?: number) {
  const morph = createScanDetailMorph(source, target, focusId, 'container', 'component', startZoom);
  if (!morph) return undefined;
  let earliestArm = Infinity;
  for (const entity of target.entities) {
    if (entity.parentId !== focusId) continue;
    const arm = scanCodeRevealWindow(semanticBounds(morph.scene, entity.id, 'component'), codeSafeWidth)?.armZoom;
    if (arm !== undefined && arm < earliestArm) earliestArm = arm;
  }
  morph.fullZoom = Math.min(morph.fullZoom,
    Math.max(earliestArm, morph.startZoom * SCAN_CONTAINER_MORPH_MIN_SPAN, C4_ZOOM_BANDS[detailOrder.indexOf('component')]!.enterZoom));
  return morph;
}

export type ScanContainerMorph = NonNullable<ReturnType<typeof createScanContainerMorph>>;
export type ScanDetailMorph = NonNullable<ReturnType<typeof createScanDetailMorph>>;

/** A rail/search/deeplink can arrive at a deep band without the wheel bridge. */
export function shouldStartScanContainerReverseMorph(input: {
  direction: 'inward' | 'outward' | 'none';
  currentDetail: string;
  currentRootId: string;
  viewRootId: string;
  activeTargetId: string | undefined;
}): boolean {
  return input.direction === 'outward'
    && (input.currentDetail === 'component' || input.currentDetail === 'code')
    && input.currentRootId !== input.viewRootId
    && input.activeTargetId === input.currentRootId;
}

/** Reconstruct both endpoints before a cold deep view starts contracting. */
export function createScanReverseMorph(source: AtlasScene, target: AtlasScene, focusId: string, detail: 'component' | 'code', arrivalZoom?: number) {
  const band = C4_ZOOM_BANDS[detailOrder.indexOf(detail)]!;
  // L4 entry begins above its eligibility floor; its expanded endpoint is
  // farther in. Using enterZoom as the full endpoint would collapse the file
  // below the ordinary L3 range before revealing its peers.
  const startZoom = detail === 'code' ? band.enterZoom + band.hysteresis : band.enterZoom / 1.65;
  const morph = createScanDetailMorph(source, target, focusId,
    detail === 'code' ? 'component' : 'container', detail, startZoom);
  if (!morph) return undefined;
  // Saved lenses restore a settled endpoint even below the usual full zoom.
  // Anchor that endpoint to the pre-input camera, rather than jumping halfway
  // through a fixed interval on the first outward event.
  if (!(detail === 'code' && target.targetAspect !== undefined) && arrivalZoom !== undefined && Number.isFinite(arrivalZoom) && arrivalZoom > 0 && arrivalZoom < morph.fullZoom) {
    morph.fullZoom = arrivalZoom;
    morph.startZoom = arrivalZoom / 1.65;
  }
  morph.progress = 1;
  morph.baselineProgress = 1;
  return morph;
}

export function scanContainerMorphOwnsSession(morph: ScanDetailMorph, session: SemanticLensSession): boolean {
  return session.baseDetail === morph.sourceSession.baseDetail
    && session.settled.length <= morph.targetSession.settled.length
    && session.settled.every((entry, index) => entry.targetId === morph.targetSession.settled[index]?.targetId)
    && (session.active.phase === 'idle'
      || (session.active.targetId === morph.focusId && session.active.nextDetail === morph.targetDetail));
}

/** Idle callbacks can receive an already-adopted camera. Never apply its offset twice. */
export function scanContainerMorphCamera(morph: ScanDetailMorph, progress: number, raw: Camera, idleRendered?: Camera): Camera {
  if (idleRendered && progress === morph.progress) return idleRendered;
  return composeSemanticZoomCamera(raw, {
    sourceBounds: morph.sourceBounds,
    targetBounds: morph.targetBounds,
    progress,
    baselineProgress: morph.baselineProgress,
  });
}

/** Same geometric blend in either direction; stopping the wheel never advances it. */
export function sampleScanContainerMorph(morph: ScanDetailMorph, zoom: number, progressCeiling = 1): { progress: number; session: SemanticLensSession } {
  const entering = semanticLensZoomProgress(zoom, morph.startZoom, morph.fullZoom);
  const leaving = morph.codeWindow
    ? semanticLensZoomProgress(zoom, morph.codeWindow.leaveStartZoom, morph.codeWindow.leaveFullZoom) : entering;
  // A continuous play operator: reversals within the frozen deadband retain the
  // same geometry, opacity and ownership; only scan L3→L4 opts into this memory.
  const progress = Math.min(progressCeiling, Math.max(entering, Math.min(morph.progress, leaving)));
  if (progress <= 0) return { progress: 0, session: morph.sourceSession };
  return {
    progress,
    session: progress >= 1 ? morph.targetSession : {
      ...morph.sourceSession,
      active: { ...morph.entry, phase: progress < morph.progress ? 'reversing' : 'revealing', progress, assistBlend: 0 },
    },
  };
}
