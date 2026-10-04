import { prepareLoadedLevelScene, prepareLevelSceneWithDeadline, clearLevelScenePreparation, levelScenePreparationPending, runLevelSceneGesture, LEVEL_SCENE_PREPARING } from './renderer/levelScenePreparation';
import { compileCurrentGeneration } from './renderer/compileCurrentGeneration';
import { initialSceneBandsMatch } from './renderer/initialSceneCompatibility';
import { recordAtlasFirstFrame } from './performance/loadTimings';
import { DiagramActionHelp } from './diagram/DiagramActionHelp';
import { architectureStoryFromAppPlan, optionalDiagramResult } from './diagram/namedFlow';
import { parseAppRoute } from './renderer/route';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import {
  applyArchitectureAuthoringCommand,
  buildC4ProjectionBundle,
  cameraWorldRect,
  createArchitectureAuthoringDocument,
  expandRectByTileRing,
  relationRouteOverrideId,
  validateC4NotationCompleteness,
  viewportNeighborhoodCacheKey,
  type ArchitectureAuthoringCommand,
  type ArchitectureAuthoringDocument,
  type RelationRouteOverride,
} from '@okie/architecture';
import {
  compileC4DynamicFlowArtifact,
  goldenSnapshot,
  goldenView,
  serializeDynamicFlowMermaid,
} from '@okie/scene-compiler';
import {
  ActivityIcon, ArrowIcon, CheckIcon, ChevronIcon, CloseIcon, CodeIcon, FileIcon, FitIcon,
  ImageIcon, InfoIcon, LayersIcon, PanelIcon, PauseIcon, PlayIcon, RestartIcon, SearchIcon, ShareIcon,
  SourceForMark, SparkIcon, ZoomInIcon, ZoomOutIcon,
} from './icons';
import { captureSceneBlob, downloadBlob, screenshotFilename } from './renderer/sceneScreenshot';
import { Minimap } from './minimap';
import { publishLiveCamera } from './liveCameraBridge';
import { createZoomMotionTrace } from './zoomMotionTrace';
import { copyViewLink } from './diagram/copyViewLink';
import {
  MAIN_DIAGRAM_SURFACE_ID,
  activateDiagramSurface,
  closeDiagramSurface,
  createDiagramWorkspace,
  diagramWorkspaceSurfaces,
  openDerivedDiagramSurface,
  updateDiagramSurfaceSession,
  type DerivedDiagramKind,
  type DiagramSurface,
  type DiagramSurfaceSession,
  type DerivedDiagramSurface,
} from './diagram/diagramWorkspace';
import { ArchitectureBriefView } from './inspector/ArchitectureBriefView';
import { ComponentImplementation, ContextualOverviewView } from './inspector/ContextualOverviewView';
import { buildContextualOverview } from './inspector/contextualOverview';
import { canonicalRelationshipGroupsForEntity } from './relations/canonicalRelationshipInventory';
import { SemanticDiagramSurface } from './diagram/SemanticDiagramSurface';
import { ImportMermaidDialog } from './diagram/ImportMermaidDialog';
import { compileImportedMermaidScene } from './diagram/compileImportedMermaid';
import { importMermaidToAtlas, type ImportedMermaidAtlas } from './diagram/importMermaid';
import { createNavigationHistoryController, type NavigationHistoryController } from './navigation/historyController';
import {
  canonicalNavigationState,
  navigationStateFromUrl,
  serializeNavigationState,
  type NavigationDefaults,
  type NavigationState,
  type SemanticDetail,
} from './navigation/navigationState';
import { createGoldenC4Scene, goldenAppStory, scanDeeperBandHasPeerCards, scanDrillDeeperDetail, scanWindowedCompileDropsPeerGraph, scanZoomCompileHandoff, scanZoomEntityUnderPointer, scanZoomHandoffPreferredId, semanticBounds, type AppStoryPlan, type AppStoryPlanStep } from './renderer/goldenC4Scene';
import { createSceneRequestOwner, ownsNeighborhoodSceneCache, ownsScenePublication, readNeighborhoodScene, retainNeighborhoodScene } from './renderer/sceneRequestOwner';
import { cacheableNeighborhoodScene, scanCompileFocusForBand, scanEntityHasChildren, scanNextBand, scanPrefetchFocusIds } from './renderer/lazyBandCompile';
import { getActiveScanFixture, scanKeepsResidentL3Landmarks } from './renderer/fixtureBundle';
import { createRenderer, recoverRenderer, type RendererSession } from './renderer/createRenderer';
import { createCameraPublisher, createCameraPublicationEchoGuard, panCamera, shouldAdoptExternalCameraAsRaw, zoomCameraAt, zoomCameraByFactor, type CameraPublisher, type CameraPublicationEchoGuard } from './renderer/cameraController';
import { semanticRenderFrame, type SemanticRenderPacket } from './renderer/semanticRenderPacket';
import {
  ATLAS_CAMERA_BOUNDS,
  clampAtlasCameraZoom,
  semanticLevelAtZoom,
} from './renderer/cameraBounds';
import { createDemandFrameScheduler, type DemandFrameScheduler } from './renderer/demandFrameScheduler';
import { createInspectorFlightFrameSink, type InspectorFlightFrameSink } from './renderer/inspectorFlightFrameSink';
import { brandHomeLinkProps, EMBED_FRAME_IDLE_KICK_MS, initialInspectorOpen, isEmbedChrome, isEmbedQueryFlag, isFramedBrowsingContext, isUsableAtlasViewport, listenForWebGlContextLoss } from './renderer/gpuLoss';
import { listenForGesturePinch, listenForWheel } from './renderer/wheelInput';
import { createWheelIntentClassifier, PINCH_DELTA_CLAMP, PINCH_ZOOM_GAIN, wheelSampleFromEvent, wheelZoomFactor, type WheelIntent } from './renderer/wheelIntent';
import { presentBackend } from './renderer/backendPresentation';
import { presentClaimProvenance } from './provenance/presentation';
import { relationOrSetFocusPresentation, selectedProjectedRelationForFocus } from './relations/relationFocus';
import { PathExplorer } from './relations/PathExplorer';
import { evidenceExcerpt, explorePathView, isKnownRelationKind, navigationPathFromDraft, pathDraftFromNavigation, pathGraphCoverage, setPathEndpoint, setPathOption, swapPathEndpoints, togglePathKind, type PathDraft, type PathEvidenceView, type PathHopView } from './relations/pathExploration';
import { canonicalRelationForInspection, resolveRelationshipReveal } from './relations/relationshipReveal';
import { SourceViewer, portableRepositoryRevisionUrl, type LocalWorkspaceContext } from './diagram/SourceViewer';
import { getActivePortableAtlas } from './portable/runtime';
import { EmbedAtlasControl, useEmbedAtlasAvailability } from './embedPopover';
import { SourceRepoLink } from './sourceRepoLink';
import { resolveExplanationExcerpt } from './explanation/explanationSource';
import { getDraftPreviewContext } from './operator/previewContext';
import { OperatorMenuLink } from './operator/OperatorMenuLink';
import { buildArchitectureBrief, clampInspectorWidth, defaultInspectorWidth, inspectorAcceptedSummary, inspectorCanShowSource, inspectorDiagramCount, inspectorEntityLead, inspectorCyclomatic, inspectorCoverage, inspectorDuplicates, inspectorUntestedBehaviours, formatCoverageRange, inspectorNotationDetailsView, inspectorNotationScope, inspectorPathOwners, inspectorSecondaryCopy, inspectorTabForEntity, inspectorWidthRange, inspectorWidthStorageKey, presentInspectorNotationDiagnostics, selectedEntityReframePlan, selectedRelationPresentation, type InspectorTab } from './inspector/inspectorSupport';
import { inspectorHistoryRestorePlan, popInspectorHistory, pushInspectorHistory, type InspectorHistorySubject } from './inspector/inspectorHistory';
import { createInspectorNeighborhoodRequest, inspectorNavigationIdentity } from './inspector/inspectorNeighborhoodRequest';
import { readDemoQuery } from './renderer/query';
import { loadStressFixture } from './renderer/stressFixture';
import type { AtlasRenderer, AtlasScene, Camera, PickResult, RendererDiagnostics, RendererLodState, SceneEntity, SceneRelation, SceneSourceExcerpt } from './renderer/types';
import type { ProjectionOverride } from './renderer/types';
import {
  composeSemanticZoomCamera, type SemanticZoomMorph,
  containSemanticOwnerCamera,
  advanceSemanticLensFocusTransfer,
  findSemanticLensTarget,
  idleSemanticLens,
  idleSemanticLensSession,
  measureSemanticLensTarget,
  reduceSemanticLensSession,
  semanticLensBranchEntityIds,
  semanticLensCanonicalPathIds,
  semanticLensSessionDetail,
  semanticLensSessionPresentationState,
  semanticLensSessionProjectionOverride,
  applySemanticBackgroundVisibility,
  semanticLensSessionVisibleEntityIds,
  semanticLensSessionVisibleRelationIds,
  stabilizeSemanticLensSessionForPan,
  validateRestoredSemanticLensPath,
  type LensPoint,
  type SemanticLensSession,
  type SemanticLensState,
} from './semantic/semanticLens';
import { createScanContainerMorph, createScanDetailMorph, createScanReverseMorph, retainScanDetailMorphSource, sampleScanContainerMorph, scanContainerMorphCamera, scanContainerMorphOwnsSession, shouldStartScanContainerReverseMorph, type ScanDetailMorph } from './semantic/scanContainerMorph';
import { explorerEntitiesForView } from './entityExplorer';
import { defaultSearchSuggestions } from './searchSuggestions';
import { useWorkerSearch } from './search/useWorkerSearch';
import { beginRenderTiming } from './performance/renderTimings';
import { recordSearchTiming } from './performance/workerTimings';
import { askOwnsKeystrokes, askOverlayPresent, keystrokeOwnedByTextEntry, searchOwnsKeystrokes, shouldOpenAskAtlas, shouldOpenSearch, shouldToggleDevMode } from './shortcuts';
import {
  ASK_NOT_CONNECTED_LIVE_MESSAGE,
  ASK_PROBE_TIMEOUT_MS,
  ASK_REQUEST_TIMEOUT_MS,
  accountInitials,
  ASK_MAP_MIN_CARD_PX, appendAskAnswer, askFramedCluster, askPanelOverlayEdge, askShowOnMapPlan, keepNewerAskThread, type AskMapPlan,
  askCitationChips,
  askSignInHref,
  atlasSourceRepositoryUrl,
  buildAskContext,
  fetchAskAuth,
  isAskUnauthorized,
  loadAskThread,
  probeAskConnection,
  resolveAskAtlasIdentity,
  submitAskQuestion,
  type AskAuthView,
  type AskThreadView,
} from './ask/askAtlas';
import { readLocalAskThread, writeLocalAskThread } from './ask/localAskThreads';
import { askMapShouldCaptureReturn, askMapStepIsCurrent, askMapViewShouldReset, askPanelReframeDue } from './ask/askMapSession';
// CLA-265: the Ask panel body; App owns its state and the map actions it triggers.
import { AskPanel } from './ask/AskPanel';
import { relationshipFlowPolicy } from './relations/relationshipFlow';
import { canvasAnimationPolicy, type CanvasPointerInteraction } from './canvasAnimationPolicy';
import { createCameraFlightController, easeCameraFlight, reconcileRenderedCamera, type CameraFlightController, type CameraFlightSample } from './cameraFlightController';
import { isolateNeighborhoodIds, storyFocusPresentation, storyStepSelectedId } from './storyFocus';
import { RelationshipAuthoringOverlay } from './editor/RelationshipAuthoringOverlay';
import { CanvasHoverHud, canvasHoverHudModel, samePickResult } from './canvasHoverHud';
import { commitGesture, createGestureHistory, redoGesture, undoGesture, type GestureHistory } from './editor/gestureHistory';
import {
  automaticRelationshipRoute,
  attachOrthogonalRouteEndpoints,
  authoringBoundsForDetail,
  closestSegmentHandle,
  connectionPortPoint,
  nearestConnectionPort,
  previewOrthogonalSegmentGuide,
  relationshipRouteGeometryForScene,
  routeIsObstacleSafe,
  routingObstaclesForEndpoints,
  screenToWorld,
  worldToScreen,
  type AuthoringPoint,
  type ConnectionPort,
  type GuidedRelationshipRouteIntent,
  type GuidedRoutePreview,
  type RelationshipRouteGeometry,
} from './editor/relationshipInteraction';
import { frameEntities, frameSemanticEntities, measuredStorySafeArea, storySafeArea, type SafeArea, type ViewportSize } from './storyFraming';
import {
  compensateSemanticInspectorFlightCamera,
  frameContextArrivalCamera, frameProjectionScope, frameStoryStepCamera, frameVisibleProjection,
  levels,
  retargetCameraForSemanticBand,
  scanZoomHandoffCamera,
  scopeFitsSafeViewport,
  semanticDetails,
  semanticInspectorFlightKind,
  semanticInspectorFlightProgress,
  semanticInspectorFlightSession,
  semanticInspectorHierarchyPlan,
  semanticInspectorRawCameraTarget,
  semanticLevelSession,
  semanticOpenNextLayer,
  semanticPanFocusPlan,
  semanticSessionFrameCamera,
  semanticSourceSession,
  type SemanticInspectorFlightKind,
} from './semantic/semanticLensEngine';
import {
  STORY_ARRIVAL_SETTLE_MS,
  createStoryFlight,
  resumeStoryFlight,
  sampleStoryFlight,
  type StoryFlight,
  type StoryFlightSample,
} from './storyPlayback';
import {
  decodeStoryPosition,
  encodeStoryPosition,
  selectStoryPlan,
  storyDurationLabel,
  storyStepDuration,
} from './storyCatalog';
import { atlasEnrichmentStatus, atlasIdentityFromLocation, atlasTourPlaying, bindAtlasChromeActions, registerWebMcpAtlasTools, type AtlasChromeActions } from './webmcp';

// A scanned snapshot (fixture=scan) is fetched, validated and compiled before App
// is imported (see main.tsx); when present it drives the app through the same
// slots as the golden fixture. Undefined for the golden/stress fixtures.
let scanFixture = getActiveScanFixture();
let activeSnapshot = scanFixture?.snapshot ?? goldenSnapshot;
let activeView = scanFixture?.view ?? goldenView;
let defaultStory = scanFixture?.story ?? goldenAppStory;
let storyCatalog = scanFixture?.stories?.length ? scanFixture.stories : [defaultStory];

/** Bootstrap calls this only while App is unmounted, before mounting a replacement atlas. */
export function refreshAppScanFixture() {
  scanFixture = getActiveScanFixture();
  activeSnapshot = scanFixture?.snapshot ?? goldenSnapshot;
  activeView = scanFixture?.view ?? goldenView;
  defaultStory = scanFixture?.story ?? goldenAppStory;
  storyCatalog = scanFixture?.stories?.length ? scanFixture.stories : [defaultStory];
}

// Recompiles the active fixture for a new focus/root (drill-in, restore). Scanned
// snapshots are read-only in R1, so the dev-mode authoring overlay stays golden-only.
function activeCreateScene(
  focusEntityId: string,
  previous?: AtlasScene,
  authoring?: ArchitectureAuthoringDocument,
  residency?: { worldBounds?: { x: number; y: number; width: number; height: number }; keepEntityIds?: readonly string[] },
): AtlasScene {
  return scanFixture
    ? scanFixture.createScene(focusEntityId, previous, residency)
    : createGoldenC4Scene(focusEntityId, previous, authoring);
}

const defaultCamera: Camera = { x: 1_080, y: 375, zoom: levels[0]!.zoom };

function diagramTabDomId(surfaceId: string) {
  return `diagram-tab-${surfaceId.replace(/[^a-z0-9_-]+/gi, '-')}`;
}

const preservedNavigationParams = ['backend', 'embed', 'fixture', 'seed'] as const;
const zoomMotionTrace = createZoomMotionTrace({ maxSamples: 10_000 });
const configuredRepositoryRoot = import.meta.env.VITE_OKIE_REPOSITORY_ROOT?.trim() || undefined;

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

export function getLevel(zoom: number, previous?: number) {
  return semanticLevelAtZoom(zoom, previous);
}

function summarizeIds(ids: readonly string[], maximumInlineIds = 48) {
  let hash = 2_166_136_261;
  for (const id of ids) {
    for (let index = 0; index < id.length; index += 1) {
      hash = Math.imul(hash ^ id.charCodeAt(index), 16_777_619) >>> 0;
    }
    hash = Math.imul(hash ^ 31, 16_777_619) >>> 0;
  }
  return ids.length <= maximumInlineIds
    ? { count: ids.length, hash: hash.toString(16).padStart(8, '0'), ids }
    : { count: ids.length, hash: hash.toString(16).padStart(8, '0'), sample: ids.slice(0, 8) };
}

function stressLoadingScene(): AtlasScene {
  return {
    id: 'stress-loading',
    title: 'Loading stress fixture…',
    subtitle: 'deterministic · lazy renderer payload',
    entities: [{ id: 'stress-loading', name: 'Preparing 5k scene', kind: 'system', responsibility: 'Loading the generated renderer stress fixture', x: -110, y: -65, width: 220, height: 130, confidence: 1 }],
    relations: [],
    regions: [],
  };
}

function browserSafeAreaInsets(): SafeArea {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:fixed;pointer-events:none;visibility:hidden;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
  document.body.append(probe);
  const style = getComputedStyle(probe);
  const insets = {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  };
  probe.remove();
  return insets;
}

type StoryPhase = 'idle' | 'flight' | 'arrival' | 'hold' | 'paused' | 'interrupted';
type StoryCanonicalPhase = 'flight' | 'arrival' | 'hold';
type ActiveStoryFlight = {
  id: string;
  step: number;
  flight: StoryFlight;
  sourceFocusedIds: string[];
  targetFocusedIds: string[];
  sourceRelationIds: string[];
  targetRelationIds: string[];
  sourceSession: SemanticLensSession;
  targetSession: SemanticLensSession;
  playAfterArrival: boolean;
};

type PendingInspectorCameraFlight = {
  sourceSession: SemanticLensSession;
  targetSession: SemanticLensSession;
  targetId: string;
  kind: SemanticInspectorFlightKind;
  semanticProgress: number;
  navigation: NavigationState;
  historyMode: 'replace';
};

type CanvasViewportProps = {
  cameraPublicationGuard: CameraPublicationEchoGuard;
  /** Inspector flights write directly to the canvas; React commits their settled endpoint. */
  inspectorFlightCameraRef: { current: InspectorFlightFrameSink | undefined };
  semanticRenderPacketRef: { current: SemanticRenderPacket | undefined };
  semanticLensSession: SemanticLensSession;
  scene: AtlasScene;
  camera: Camera;
  setCamera: (updater: (camera: Camera) => Camera) => void;
  selectedId?: string;
  onPick: (result: PickResult) => void;
  onOpenInside: (entityId: string) => void;
  focusedIds: Set<string>;
  relationFocusIds: Set<string>;
  activeRelationIds: Set<string>;
  flowRelationIds: Set<string>;
  requestedBackend: string;
  reduceMotion: boolean;
  animationActive: boolean;
  inspectorFlightActive: boolean;
  onDiagnostics: (diagnostics: RendererDiagnostics) => void;
  onViewportChange: (viewport: ViewportSize) => void;
  onCameraSettled: (camera: Camera) => void;
  onNavigationFlush: (camera: Camera) => void;
  onInteractionStart: (reason: string, camera: Camera) => void;
  onCameraFlightCancel: () => void;
  onLensCancel: (reason: string, camera: Camera) => void;
  onLensPan: (camera: Camera) => void;
  onSemanticZoomBurstStart: (camera: Camera) => Camera;
  /** CLA-104: neighborhood swap changes world space; consume as the burst raw camera. */
  scanZoomAdoptRawRef: { current: Camera | undefined };
  onLodState: (state: RendererLodState | undefined) => void;
  visibilityMode: 'all' | 'dim' | 'isolate';
  flowActive: boolean;
  projectionOverride?: ProjectionOverride;
  onSemanticZoom: (sample: { camera: Camera; renderedCamera?: Camera; pointer: LensPoint; direction: 'inward' | 'outward' | 'none'; gestureSettled: boolean; mobile: boolean; gestureStartZoom?: number }) => Camera;
  cinematicTransition?: NonNullable<import('./renderer/types').RenderState['cinematicTransition']>;
  authoringTool: 'select' | 'connect';
  authoringEnabled: boolean;
  authoringDetail: SemanticDetail;
  authoringEntityIds: ReadonlySet<string>;
  selectedRelationId?: string;
  onCreateRelationship: (gesture: {
    from: string;
    to: string;
    sourcePort: ConnectionPort;
    targetPort: ConnectionPort;
    routePoints: AuthoringPoint[];
  }) => void;
  onGuideRelationship: (gesture: {
    relationId: string;
    visualRelationId: string;
    detail: SemanticDetail;
    intent: GuidedRelationshipRouteIntent;
  }) => void;
};

function CanvasViewport({ cameraPublicationGuard, inspectorFlightCameraRef, semanticRenderPacketRef, semanticLensSession, scene, camera, setCamera, selectedId, onPick, onOpenInside, focusedIds, relationFocusIds, activeRelationIds, flowRelationIds, requestedBackend, reduceMotion, animationActive, inspectorFlightActive, flowActive, projectionOverride, onSemanticZoom, cinematicTransition, onDiagnostics, onViewportChange, onCameraSettled, onNavigationFlush, onInteractionStart, onCameraFlightCancel, onLensCancel, onLensPan, onSemanticZoomBurstStart, onLodState, scanZoomAdoptRawRef, visibilityMode, authoringTool, authoringEnabled, authoringDetail, authoringEntityIds, selectedRelationId, onCreateRelationship, onGuideRelationship }: CanvasViewportProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<AtlasRenderer | undefined>(undefined);
  const liveCameraRef = useRef(camera);
  const rawCameraRef = useRef(camera);
  const stateRef = useRef({ scene, semanticLensSession, selectedId, focusedIds, relationFocusIds, activeRelationIds, flowRelationIds, reduceMotion, animationActive, inspectorFlightActive, flowActive, projectionOverride, cinematicTransition, visibilityMode });
  const pointerRef = useRef<{ id: number; startX: number; startY: number; x: number; y: number; moved: boolean } | undefined>(undefined);
  const authoringPointerRef = useRef<
    | { kind: 'connection'; id: number; from: string; sourcePort: ConnectionPort }
    | { kind: 'guide'; id: number; relationId: string; visualRelationId: string; detail: SemanticDetail; segmentIndex: number; originalPoints: AuthoringPoint[]; from: string; to: string; routing: RelationshipRouteGeometry }
    | undefined
  >(undefined);
  const touchPointersRef = useRef(new Map<number, LensPoint>());
  const pinchRef = useRef<{ distance: number; centroid: LensPoint; startZoom: number; moved: boolean } | undefined>(undefined);
  const pinchSettleTimerRef = useRef<number | undefined>(undefined);
  const panSettleTimerRef = useRef<number | undefined>(undefined);
  const semanticAssistRafRef = useRef<number | undefined>(undefined);
  const semanticAssistUntilRef = useRef(0);
  const semanticAssistSampleRef = useRef<{ pointer: LensPoint; mobile: boolean; gestureStartZoom?: number } | undefined>(undefined);
  const settleGlideRafRef = useRef<number | undefined>(undefined);
  const semanticZoomBurstActiveRef = useRef(false);
  const consumeScanZoomAdoptRaw = (keepZoom?: number): Camera | undefined => {
    const pending = scanZoomAdoptRawRef.current;
    if (!pending) return undefined;
    scanZoomAdoptRawRef.current = undefined;
    const adopted = keepZoom === undefined ? pending : { x: pending.x, y: pending.y, zoom: keepZoom };
    rawCameraRef.current = adopted;
    return adopted;
  };
  const sizeRef = useRef({ width: 1, height: 1 });
  const [overlaySize, setOverlaySize] = useState({ width: 1, height: 1 });
  const [hoveredPick, setHoveredPick] = useState<PickResult>();
  const [connectionDraft, setConnectionDraft] = useState<{
    from: string;
    sourcePort: ConnectionPort;
    to?: string;
    targetPort?: ConnectionPort;
    points: AuthoringPoint[];
    safe: boolean;
  }>();
  const [guideDraft, setGuideDraft] = useState<(GuidedRoutePreview & { relationId: string; segmentIndex: number })>();
  const connectionDraftRef = useRef(connectionDraft);
  const guideDraftRef = useRef(guideDraft);
  const updateConnectionDraft = (next: typeof connectionDraft) => {
    connectionDraftRef.current = next;
    setConnectionDraft(next);
  };
  const updateGuideDraft = (next: typeof guideDraft) => {
    guideDraftRef.current = next;
    setGuideDraft(next);
  };
  const selectedProjectedRelation = useMemo(
    () => selectedProjectedRelationForFocus(scene, selectedRelationId, projectionOverride, authoringDetail),
    [authoringDetail, projectionOverride, scene, selectedRelationId],
  );
  const selectedProjectedRoute = useMemo(() => {
    const projected = selectedProjectedRelation?.relation;
    const detail = selectedProjectedRelation?.detail;
    if (!projected?.routePoints || !detail) return undefined;
    const sourceBounds = authoringBoundsForDetail(scene, projected.from, detail);
    const targetBounds = authoringBoundsForDetail(scene, projected.to, detail);
    return sourceBounds && targetBounds
      ? attachOrthogonalRouteEndpoints(projected.routePoints, { source: sourceBounds, target: targetBounds })
      : projected.routePoints.map(point => ({ ...point }));
  }, [scene, selectedProjectedRelation]);
  const schedulerRef = useRef<DemandFrameScheduler | undefined>(undefined);
  useEffect(() => {
    if (authoringEnabled) return;
    authoringPointerRef.current = undefined;
    updateConnectionDraft(undefined);
    updateGuideDraft(undefined);
    syncContinuousRendering();
    schedulerRef.current?.wake();
  }, [authoringEnabled]);
  const cameraPublisherRef = useRef<CameraPublisher | undefined>(undefined);
  const applyLiveCameraRef = useRef<(camera: Camera) => void>(next => { liveCameraRef.current = next; });
  const syncExternalCameraRef = useRef<(camera: Camera) => void>(next => { liveCameraRef.current = next; });
  const setCameraRef = useRef(setCamera);
  const onCameraSettledRef = useRef(onCameraSettled);
  const onNavigationFlushRef = useRef(onNavigationFlush);
  const onInteractionStartRef = useRef(onInteractionStart);
  const onCameraFlightCancelRef = useRef(onCameraFlightCancel);
  const onLensCancelRef = useRef(onLensCancel);
  const onLensPanRef = useRef(onLensPan);
  const onSemanticZoomBurstStartRef = useRef(onSemanticZoomBurstStart);
  const onLodStateRef = useRef(onLodState);
  const onSemanticZoomRef = useRef(onSemanticZoom);
  stateRef.current = { scene, semanticLensSession, selectedId, focusedIds, relationFocusIds, activeRelationIds, flowRelationIds, reduceMotion, animationActive, inspectorFlightActive, flowActive, projectionOverride, cinematicTransition, visibilityMode };
  setCameraRef.current = setCamera;
  onCameraSettledRef.current = onCameraSettled;
  onNavigationFlushRef.current = onNavigationFlush;
  onInteractionStartRef.current = onInteractionStart;
  onCameraFlightCancelRef.current = onCameraFlightCancel;
  onLensCancelRef.current = onLensCancel;
  onLensPanRef.current = onLensPan;
  onSemanticZoomBurstStartRef.current = onSemanticZoomBurstStart;
  onLodStateRef.current = onLodState;
  onSemanticZoomRef.current = onSemanticZoom;

  function syncContinuousRendering() {
    const current = stateRef.current;
    schedulerRef.current?.setContinuous(canvasAnimationPolicy({
      reducedMotion: current.reduceMotion,
      animationActive: current.animationActive,
      flowActive: current.flowActive,
      pointerInteraction: currentPointerInteraction(),
    }).continuous);
  }

  function currentPointerInteraction(): CanvasPointerInteraction {
    if (authoringPointerRef.current) return 'authoring-drag';
    return pointerRef.current?.moved ? 'camera-pan' : 'idle';
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: AtlasRenderer | undefined;
    let disposed = false;
    let recovering = false;
    const abortController = new AbortController();
    let detachLossListener = () => {};
    let detachWheelListener = () => {};
    let detachGesturePinch = () => {};
    let semanticZoomSettleTimer: number | undefined;
    let lastSemanticPointer: LensPoint | undefined;
    let lastResize = { width: 0, height: 0, physicalWidth: 0, physicalHeight: 0 };
    let lastDiagnostics = '';
    const publisher = createCameraPublisher(next => {
      cameraPublicationGuard.markPublished(next);
      setCameraRef.current(() => next);
      onCameraSettledRef.current(next);
    });
    cameraPublisherRef.current = publisher;

    const resizeRenderer = () => {
      renderer?.resize(sizeRef.current.width, sizeRef.current.height, window.devicePixelRatio);
    };

    const framed = isFramedBrowsingContext();
    const scheduler = createDemandFrameScheduler(time => {
      if (disposed || !renderer) return;
      const current = stateRef.current;
      const animation = canvasAnimationPolicy({
        reducedMotion: current.reduceMotion,
        animationActive: current.animationActive,
        flowActive: current.flowActive,
        pointerInteraction: currentPointerInteraction(),
      });
      const resolvedFrame = semanticRenderFrame(semanticRenderPacketRef.current, liveCameraRef.current, {
        revision: 0,
        camera: liveCameraRef.current,
        scene: current.scene,
        semanticSession: current.semanticLensSession,
        projectionOverride: current.projectionOverride,
      });
      if (resolvedFrame.acknowledged) semanticRenderPacketRef.current = undefined;
      const frame = resolvedFrame.frame;
      try {
        const renderTiming = beginRenderTiming();
        renderer.setScene(frame.scene);
        renderTiming?.('render-scene');
        renderer.setCamera(frame.camera);
        renderer.setRenderState({
          selectedId: current.selectedId,
          focusedIds: current.focusedIds,
          relationFocusIds: current.relationFocusIds,
          activeRelationIds: current.activeRelationIds,
          flowRelationIds: current.flowRelationIds,
          reduceMotion: current.reduceMotion,
          animate: animation.animateFlow,
          visibilityMode: current.visibilityMode,
          ...(frame.projectionOverride ? { projectionOverride: frame.projectionOverride } : {}),
          ...(current.cinematicTransition ? { cinematicTransition: current.cinematicTransition } : {}),
        });
        renderTiming?.('render-state');
        renderer.render(time);
        if (frame.scene.id !== 'stress-loading' && renderer.kind !== 'unsupported') recordAtlasFirstFrame();
        renderTiming?.('render-draw');
        publishLiveCamera(frame.camera, {
          scene: frame.scene,
          projectionOverride: frame.projectionOverride,
          reduceMotion: current.reduceMotion,
        });
        renderTiming?.('render-publish');
        if (zoomMotionTrace.isRecording()) zoomMotionTrace.recordFrame({
          timeMs: time,
          camera: frame.camera,
          projectionProgress: frame.projectionOverride?.progress,
          projectionId: frame.projectionOverride?.id,
          semanticRevision: frame.revision,
          sceneId: frame.scene.id,
          sceneRootId: frame.scene.rootEntityId,
          residentCountsByDetail: {
            context: frame.scene.projection?.entityIdsByDetail.context.length ?? 0,
            container: frame.scene.projection?.entityIdsByDetail.container.length ?? 0,
            component: frame.scene.projection?.entityIdsByDetail.component.length ?? 0,
            code: frame.scene.projection?.entityIdsByDetail.code.length ?? 0,
          },
          renderer: renderer.kind,
          viewport: sizeRef.current,
        });
        const lodState = renderer.lodState();
        onLodStateRef.current(lodState);
        if (lodState?.transitioning && !current.reduceMotion) schedulerRef.current?.wake();
      } catch (error) {
        void recoverFromLoss(error);
      }
    }, {
      requestFrame: callback => requestAnimationFrame(callback),
      cancelFrame: handle => cancelAnimationFrame(handle),
      ...(framed ? {
        requestIdleKick: callback => window.setTimeout(callback, EMBED_FRAME_IDLE_KICK_MS),
        cancelIdleKick: handle => window.clearTimeout(handle),
      } : {}),
    });
    schedulerRef.current = scheduler;

    const updateSize = (width: number, height: number) => {
      width = Math.max(1, width);
      height = Math.max(1, height);
      const dpr = Math.min(Math.max(window.devicePixelRatio, 1), 2);
      const physicalWidth = Math.max(1, Math.round(width * dpr));
      const physicalHeight = Math.max(1, Math.round(height * dpr));
      if (
        width === lastResize.width
        && height === lastResize.height
        && physicalWidth === lastResize.physicalWidth
        && physicalHeight === lastResize.physicalHeight
      ) return;
      const viewportChanged = width !== lastResize.width || height !== lastResize.height;
      lastResize = { width, height, physicalWidth, physicalHeight };
      sizeRef.current = { width, height };
      setOverlaySize({ width, height });
      if (viewportChanged) onViewportChange({ width, height });
      resizeRenderer();
      scheduler.wake();
    };

    const publishDiagnostics = (force = false) => {
      if (!renderer) return;
      // This timer feeds React-only diagnostics. Avoid interrupting an imperative
      // camera flight; installation and recovery pass force=true and stay immediate.
      if (!force && stateRef.current.inspectorFlightActive) return;
      try {
        const next = renderer.diagnostics();
        const snapshot = JSON.stringify(next);
        if (!force && snapshot === lastDiagnostics) return;
        lastDiagnostics = snapshot;
        onDiagnostics(next);
      } catch (error) {
        void recoverFromLoss(error);
      }
    };

    const observer = new ResizeObserver(([entry]) => {
      updateSize(entry.contentRect.width, entry.contentRect.height);
    });
    observer.observe(host);

    const wheelClassifier = createWheelIntentClassifier();
    let gesturePinchActive = false;
    // Every wheel/gesture sample is direct manipulation: it supersedes a pending
    // drag/wheel pan settle, a settle glide and any transient inspector camera
    // flight (cancelInspectorCameraFlight is a no-op when none is pending).
    const beginCanvasWheelInput = () => {
      if (panSettleTimerRef.current !== undefined) {
        window.clearTimeout(panSettleTimerRef.current);
        panSettleTimerRef.current = undefined;
      }
      cancelSettleGlide();
      onCameraFlightCancelRef.current();
    };
    const settleSemanticWheelZoom = (glide: boolean) => {
      if (semanticZoomSettleTimer !== undefined) window.clearTimeout(semanticZoomSettleTimer);
      semanticZoomSettleTimer = undefined;
      if (!lastSemanticPointer) return;
      // The settle landing must be the gesture's only remaining camera writer:
      // with the assist loop still running, its next frame re-applied the
      // uncontained raw camera and reverted the landing (end-of-zoom flicker).
      cancelAssistAnimation();
      consumeScanZoomAdoptRaw();
      const settled = onSemanticZoomRef.current({
        camera: rawCameraRef.current,
        renderedCamera: liveCameraRef.current,
        pointer: lastSemanticPointer,
        direction: 'none',
        gestureSettled: true,
        mobile: false,
      });
      if (glide) {
        animateSettleGlide(settled);
        return;
      }
      applyLiveCameraRef.current(settled);
      rawCameraRef.current = { ...settled };
    };
    const semanticWheelZoom = (pointer: LensPoint, zoomFactor: number, direction: 'inward' | 'outward') => {
      if (semanticZoomSettleTimer === undefined) {
        cancelAssistAnimation();
        semanticZoomBurstActiveRef.current = true;
        rawCameraRef.current = onSemanticZoomBurstStartRef.current(liveCameraRef.current);
      }
      onInteractionStartRef.current('Zoomed the map', liveCameraRef.current);
      const zoomed = zoomCameraByFactor(rawCameraRef.current, pointer.x, pointer.y, sizeRef.current, zoomFactor);
      const next = onSemanticZoomRef.current({ camera: zoomed, renderedCamera: liveCameraRef.current, pointer, direction, gestureSettled: false, mobile: false });
      const adopted = consumeScanZoomAdoptRaw(zoomed.zoom);
      rawCameraRef.current = adopted ?? zoomed;
      applyLiveCameraRef.current(adopted ?? next);
      animateSemanticAssist(pointer, false);
      lastSemanticPointer = pointer;
      if (semanticZoomSettleTimer !== undefined) window.clearTimeout(semanticZoomSettleTimer);
      semanticZoomSettleTimer = window.setTimeout(() => settleSemanticWheelZoom(true), 120);
    };
    // Trackpad two-finger scroll pans with a pointer drag's 160 ms lens settle.
    // Unlike drag-pan it interrupts a guided story, as wheel input always has
    // (CLA-326): otherwise a running story flight overrides the user's scroll.
    // A pan arriving while a zoom burst is still unsettled lands that zoom first
    // (without the glide, which the pan would cancel), so the semantic lens
    // always receives its gestureSettled sample.
    const wheelPan = (intent: Extract<WheelIntent, { kind: 'pan' }>) => {
      if (semanticZoomSettleTimer !== undefined) settleSemanticWheelZoom(false);
      cancelAssistAnimation();
      // A scan zoom handoff's pending raw camera predates this pan; a later zoom
      // adopting it would snap the camera back to the pre-pan position.
      consumeScanZoomAdoptRaw();
      setHoveredPick(undefined);
      onInteractionStartRef.current('Scrolled the map', liveCameraRef.current);
      const next = panCamera(liveCameraRef.current, -intent.dx, -intent.dy);
      rawCameraRef.current = next;
      applyLiveCameraRef.current(next);
      panSettleTimerRef.current = window.setTimeout(() => {
        panSettleTimerRef.current = undefined;
        onLensPanRef.current({ ...liveCameraRef.current });
      }, 160);
    };

    const installSession = (session: RendererSession) => {
      detachLossListener();
      detachWheelListener();
      detachGesturePinch();
      gesturePinchActive = false;
      wheelClassifier.reset();
      renderer = session.renderer;
      rendererRef.current = renderer;
      detachLossListener = listenForWebGlContextLoss(session.canvas, message => { void recoverFromLoss(message); });
      detachWheelListener = listenForWheel(session.canvas, event => {
        // Reads deltaMode first (Firefox reports pixels once the deltas are read).
        const sample = wheelSampleFromEvent(event);
        const intent = wheelClassifier.classify(sample);
        // Safari may pair its gesture events with ctrlKey wheels; the gesture owns that pinch.
        if (gesturePinchActive && intent.kind === 'zoom' && (sample.ctrlKey || sample.metaKey)) return;
        beginCanvasWheelInput();
        const bounds = session.canvas.getBoundingClientRect();
        const pointer = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        const zoomFactor = intent.kind === 'zoom' ? wheelZoomFactor(intent) : undefined;
        if (zoomMotionTrace.isRecording()) zoomMotionTrace.recordInput({
          timeMs: sample.timeStamp,
          deltaX: sample.deltaX,
          deltaY: sample.deltaY,
          deltaMode: sample.deltaMode,
          pointerX: pointer.x,
          pointerY: pointer.y,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          viewport: sizeRef.current,
          devicePixelRatio: window.devicePixelRatio,
          intent: intent.kind === 'pan' ? 'pan' : intent.source,
          ...(zoomFactor === undefined ? {} : { zoomFactor }),
        });
        if (intent.kind === 'pan') wheelPan(intent);
        else semanticWheelZoom(pointer, zoomFactor!, intent.deltaY < 0 ? 'inward' : 'outward');
      });
      let gestureLastScale = 1;
      detachGesturePinch = listenForGesturePinch(session.canvas, {
        onStart: () => {
          gesturePinchActive = true;
          gestureLastScale = 1;
        },
        onChange: sample => {
          const rawFactor = sample.scale / gestureLastScale;
          gestureLastScale = sample.scale;
          if (!Number.isFinite(rawFactor) || rawFactor === 1) return;
          const limit = Math.exp(PINCH_DELTA_CLAMP * PINCH_ZOOM_GAIN);
          const zoomFactor = Math.min(limit, Math.max(1 / limit, rawFactor));
          beginCanvasWheelInput();
          const bounds = session.canvas.getBoundingClientRect();
          const pointer = { x: sample.clientX - bounds.left, y: sample.clientY - bounds.top };
          if (zoomMotionTrace.isRecording()) zoomMotionTrace.recordInput({
            timeMs: sample.timeStamp,
            deltaX: 0,
            deltaY: 0,
            deltaMode: 0,
            pointerX: pointer.x,
            pointerY: pointer.y,
            ctrlKey: false,
            metaKey: false,
            shiftKey: false,
            altKey: false,
            viewport: sizeRef.current,
            devicePixelRatio: window.devicePixelRatio,
            intent: 'gesture',
            zoomFactor,
          });
          semanticWheelZoom(pointer, zoomFactor, zoomFactor > 1 ? 'inward' : 'outward');
        },
        onEnd: () => {
          gesturePinchActive = false;
          gestureLastScale = 1;
        },
      });
      resizeRenderer();
      syncContinuousRendering();
      scheduler.wake();
      publishDiagnostics(true);
    };

    const recoverFromLoss = async (error: unknown) => {
      if (recovering || disposed || !host.isConnected) return;
      recovering = true;
      const reason = error instanceof Error ? error.message : String(error);
      const failedBackend = renderer?.kind ?? requestedBackend;
      const previousRenderer = renderer;
      detachLossListener();
      detachWheelListener();
      detachGesturePinch();
      detachLossListener = () => {};
      detachWheelListener = () => {};
      detachGesturePinch = () => {};
      renderer = undefined;
      rendererRef.current = undefined;
      lastDiagnostics = '';
      onDiagnostics({
        requestedBackend,
        activeBackend: 'recovering',
        gpuAccelerated: false,
        entityCount: stateRef.current.scene.entities.length,
        relationCount: stateRef.current.scene.relations.length,
        lastFrameMs: 0,
        message: `${failedBackend} surface lost: ${reason} Replacing the canvas and restoring renderer state.`,
      });
      try { previousRenderer?.dispose(); } catch { /* A lost device may reject disposal; the canvas is replaced regardless. */ }
      try {
        const session = await recoverRenderer(host, requestedBackend, failedBackend, reason, abortController.signal);
        if (disposed) {
          session.renderer.dispose();
          return;
        }
        installSession(session);
      } catch (recoveryError) {
        if (!disposed) {
          onDiagnostics({
            requestedBackend,
            activeBackend: 'unsupported',
            gpuAccelerated: false,
            entityCount: stateRef.current.scene.entities.length,
            relationCount: stateRef.current.scene.relations.length,
            lastFrameMs: 0,
            message: `Renderer recovery failed: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
          });
        }
      } finally {
        recovering = false;
      }
    };

    const applyCamera = (next: Camera, publish: boolean) => {
      const zoomChanged = Math.abs(next.zoom - liveCameraRef.current.zoom) > Number.EPSILON;
      liveCameraRef.current = { ...next };
      try {
        renderer?.setCamera(liveCameraRef.current);
      } catch (error) {
        void recoverFromLoss(error);
      }
      if (zoomChanged && !stateRef.current.reduceMotion) scheduler.animateUntil(performance.now() + 220);
      else scheduler.wake();
      if (publish) publisher.schedule(liveCameraRef.current);
    };
    const applyLiveCamera = (next: Camera) => applyCamera(next, true);
    applyLiveCameraRef.current = applyLiveCamera;
    const inspectorFlightSink = createInspectorFlightFrameSink({
      readLiveCamera: () => liveCameraRef.current,
      cancelPublishedCamera: () => publisher.cancel(),
      cancelSemanticZoomSettle: () => {
        if (semanticZoomSettleTimer !== undefined) window.clearTimeout(semanticZoomSettleTimer);
        semanticZoomSettleTimer = undefined;
        lastSemanticPointer = undefined;
      },
      cancelSemanticAssist: cancelAssistAnimation,
      cancelSettleGlide,
      cancelGestureSettles: () => {
        if (pinchSettleTimerRef.current !== undefined) window.clearTimeout(pinchSettleTimerRef.current);
        if (panSettleTimerRef.current !== undefined) window.clearTimeout(panSettleTimerRef.current);
        pinchSettleTimerRef.current = undefined;
        panSettleTimerRef.current = undefined;
      },
      clearPendingRawAdoption: () => { consumeScanZoomAdoptRaw(); },
      rebaseRawCamera: camera => { rawCameraRef.current = { ...camera }; },
      applyFrame: next => applyCamera(next, false),
    });
    inspectorFlightCameraRef.current = inspectorFlightSink;
    syncExternalCameraRef.current = next => {
      // Publishing a settled snapshot is a notification, not a new camera command.
      // React may echo it after a more recent wheel frame has already rendered.
      if (cameraPublicationGuard.consumePublished(next)) return;
      publisher.cancel();
      cancelSettleGlide();
      const zoomChanged = Math.abs(next.zoom - liveCameraRef.current.zoom) > Number.EPSILON;
      liveCameraRef.current = { ...next };
      if (shouldAdoptExternalCameraAsRaw(
        stateRef.current.projectionOverride?.id,
        semanticZoomBurstActiveRef.current,
      )) rawCameraRef.current = { ...next };
      try {
        renderer?.setCamera(liveCameraRef.current);
      } catch (error) {
        void recoverFromLoss(error);
      }
      if (zoomChanged && !stateRef.current.reduceMotion) scheduler.animateUntil(performance.now() + 220);
      else scheduler.wake();
    };

    const diagnosticsTimer = window.setInterval(() => {
      if (disposed) return;
      publishDiagnostics();
    }, 500);
    const flushNavigation = () => {
      const flushed = publisher.flush();
      if (!flushed) onNavigationFlushRef.current(liveCameraRef.current);
    };
    window.addEventListener('atlas:flush-navigation', flushNavigation);

    void createRenderer(host, requestedBackend, abortController.signal).then(session => {
      if (disposed) {
        session.renderer.dispose();
        return;
      }
      const bounds = host.getBoundingClientRect();
      updateSize(bounds.width, bounds.height);
      installSession(session);
    }).catch(error => {
      if (disposed) return;
      void recoverFromLoss(error);
    });

    return () => {
      disposed = true;
      abortController.abort();
      window.clearInterval(diagnosticsTimer);
      if (semanticZoomSettleTimer !== undefined) window.clearTimeout(semanticZoomSettleTimer);
      window.removeEventListener('atlas:flush-navigation', flushNavigation);
      scheduler.dispose();
      publisher.cancel();
      observer.disconnect();
      detachLossListener();
      detachWheelListener();
      detachGesturePinch();
      renderer?.dispose();
      rendererRef.current = undefined;
      if (schedulerRef.current === scheduler) schedulerRef.current = undefined;
      if (cameraPublisherRef.current === publisher) cameraPublisherRef.current = undefined;
      if (inspectorFlightCameraRef.current === inspectorFlightSink) inspectorFlightCameraRef.current = undefined;
      host.replaceChildren();
    };
  }, [requestedBackend, onDiagnostics, onViewportChange]);

  useEffect(() => {
    syncExternalCameraRef.current(camera);
  }, [camera]);

  useEffect(() => () => {
    if (pinchSettleTimerRef.current !== undefined) window.clearTimeout(pinchSettleTimerRef.current);
    if (panSettleTimerRef.current !== undefined) window.clearTimeout(panSettleTimerRef.current);
    if (semanticAssistRafRef.current !== undefined) window.cancelAnimationFrame(semanticAssistRafRef.current);
    if (settleGlideRafRef.current !== undefined) window.cancelAnimationFrame(settleGlideRafRef.current);
  }, []);

  useEffect(() => {
    syncContinuousRendering();
    schedulerRef.current?.wake();
    if (projectionOverride?.id.endsWith(':base') && !semanticZoomBurstActiveRef.current) cancelAssistAnimation();
  }, [scene, selectedId, focusedIds, relationFocusIds, activeRelationIds, flowRelationIds, animationActive, flowActive, projectionOverride, cinematicTransition, reduceMotion, visibilityMode]);

  function cancelAssistAnimation() {
    if (semanticAssistRafRef.current !== undefined) window.cancelAnimationFrame(semanticAssistRafRef.current);
    semanticAssistRafRef.current = undefined;
    semanticAssistUntilRef.current = 0;
    semanticAssistSampleRef.current = undefined;
    semanticZoomBurstActiveRef.current = false;
  }

  function cancelSettleGlide() {
    if (settleGlideRafRef.current !== undefined) window.cancelAnimationFrame(settleGlideRafRef.current);
    settleGlideRafRef.current = undefined;
  }

  /**
   * Eases the camera onto a gesture-settle landing (owner containment). The settle
   * correction used to be applied as a hard cut while the assist loop kept writing the
   * uncontained camera — a one-frame jump that immediately reverted (user report:
   * "flickers of layout shift at the end of the zoom"). The caller must stop the
   * assist loop first so this glide is the gesture's only remaining camera writer.
   */
  function animateSettleGlide(target: Camera) {
    cancelSettleGlide();
    const from = { ...liveCameraRef.current };
    const screenShift = Math.hypot(target.x - from.x, target.y - from.y) * target.zoom;
    if (stateRef.current.reduceMotion || (screenShift < 1 && Math.abs(Math.log(target.zoom / from.zoom)) < 0.001)) {
      applyLiveCameraRef.current(target);
      rawCameraRef.current = { ...target };
      return;
    }
    const startedAtMs = performance.now();
    const durationMs = 200;
    const tick = (nowMs: number) => {
      const eased = easeCameraFlight((nowMs - startedAtMs) / durationMs);
      applyLiveCameraRef.current({
        x: from.x + (target.x - from.x) * eased,
        y: from.y + (target.y - from.y) * eased,
        zoom: from.zoom * Math.exp(Math.log(target.zoom / from.zoom) * eased),
      });
      if (nowMs - startedAtMs >= durationMs) {
        settleGlideRafRef.current = undefined;
        rawCameraRef.current = { ...liveCameraRef.current };
        return;
      }
      settleGlideRafRef.current = window.requestAnimationFrame(tick);
    };
    settleGlideRafRef.current = window.requestAnimationFrame(tick);
  }

  function animateSemanticAssist(pointer: LensPoint, mobile: boolean, gestureStartZoom?: number) {
    semanticAssistSampleRef.current = { pointer, mobile, ...(gestureStartZoom !== undefined ? { gestureStartZoom } : {}) };
    semanticAssistUntilRef.current = Math.max(semanticAssistUntilRef.current, performance.now() + (mobile ? 320 : 260));
    if (semanticAssistRafRef.current !== undefined) return;
    const tick = (now: number) => {
      const sample = semanticAssistSampleRef.current;
      if (!sample || now > semanticAssistUntilRef.current) {
        const adopted = consumeScanZoomAdoptRaw();
        if (adopted) applyLiveCameraRef.current(adopted);
        else rawCameraRef.current = { ...liveCameraRef.current };
        semanticZoomBurstActiveRef.current = false;
        semanticAssistRafRef.current = undefined;
        return;
      }
      consumeScanZoomAdoptRaw();
      const next = onSemanticZoomRef.current({
        camera: rawCameraRef.current,
        renderedCamera: liveCameraRef.current,
        pointer: sample.pointer,
        direction: 'none',
        gestureSettled: false,
        mobile: sample.mobile,
        ...(sample.gestureStartZoom !== undefined ? { gestureStartZoom: sample.gestureStartZoom } : {}),
      });
      applyLiveCameraRef.current(next);
      semanticAssistRafRef.current = window.requestAnimationFrame(tick);
    };
    semanticAssistRafRef.current = window.requestAnimationFrame(tick);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (panSettleTimerRef.current !== undefined) {
      window.clearTimeout(panSettleTimerRef.current);
      panSettleTimerRef.current = undefined;
    }
    cancelSettleGlide();
    event.currentTarget.setPointerCapture(event.pointerId);
    const viewportBounds = event.currentTarget.getBoundingClientRect();
    const screenPoint = { x: event.clientX - viewportBounds.left, y: event.clientY - viewportBounds.top };
    rendererRef.current?.pick(screenPoint.x, screenPoint.y);
    if (authoringEnabled && event.pointerType !== 'touch') {
      if (authoringTool === 'connect') {
        const portHit = [...authoringEntityIds].flatMap(entityId => {
          const bounds = authoringBoundsForDetail(scene, entityId, authoringDetail);
          if (!bounds) return [];
          return (['top', 'right', 'bottom', 'left'] as const).map(port => {
            const portScreen = worldToScreen(connectionPortPoint(bounds, port), liveCameraRef.current, sizeRef.current);
            return { entityId, bounds, port, distance: Math.hypot(portScreen.x - screenPoint.x, portScreen.y - screenPoint.y) };
          });
        }).filter(value => value.distance <= 16)
          .sort((left, right) => left.distance - right.distance || `${left.entityId}:${left.port}`.localeCompare(`${right.entityId}:${right.port}`))[0];
        if (portHit) {
          const start = connectionPortPoint(portHit.bounds, portHit.port);
          authoringPointerRef.current = { kind: 'connection', id: event.pointerId, from: portHit.entityId, sourcePort: portHit.port };
          syncContinuousRendering();
          pointerRef.current = undefined;
          updateConnectionDraft({ from: portHit.entityId, sourcePort: portHit.port, points: [start, start], safe: true });
          onInteractionStartRef.current('Created a relationship', liveCameraRef.current);
          return;
        }
      }
      if (authoringTool === 'select' && selectedRelationId) {
        const projected = selectedProjectedRelation?.relation;
        const detail = selectedProjectedRelation?.detail;
        const routing = projected && detail ? relationshipRouteGeometryForScene(scene, projected, detail) : undefined;
        const handle = selectedProjectedRoute && closestSegmentHandle(selectedProjectedRoute, screenPoint, liveCameraRef.current, sizeRef.current);
        if (projected && detail && routing && selectedProjectedRoute && handle) {
          authoringPointerRef.current = {
            kind: 'guide',
            id: event.pointerId,
            relationId: selectedRelationId,
            visualRelationId: projected.id,
            detail,
            segmentIndex: handle.segmentIndex,
            originalPoints: selectedProjectedRoute,
            from: projected.from,
            to: projected.to,
            routing,
          };
          syncContinuousRendering();
          pointerRef.current = undefined;
          updateGuideDraft({
            relationId: selectedRelationId,
            segmentIndex: handle.segmentIndex,
            points: selectedProjectedRoute.map(point => ({ ...point })),
            applied: false,
            diagnostic: 'applied',
          });
          onInteractionStartRef.current('Guided a relationship route', liveCameraRef.current);
          return;
        }
      }
    }
    if (event.pointerType === 'touch') {
      touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointersRef.current.size >= 2) {
        const [first, second] = [...touchPointersRef.current.values()];
        if (pinchSettleTimerRef.current !== undefined) {
          window.clearTimeout(pinchSettleTimerRef.current);
          pinchSettleTimerRef.current = undefined;
        }
        cancelAssistAnimation();
        semanticZoomBurstActiveRef.current = true;
        rawCameraRef.current = onSemanticZoomBurstStartRef.current(liveCameraRef.current);
        pinchRef.current = {
          distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
          centroid: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
          startZoom: rawCameraRef.current.zoom,
          moved: false,
        };
        pointerRef.current = undefined;
        return;
      }
    }
    pointerRef.current = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      moved: false,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const authoringPointer = authoringPointerRef.current;
    if (authoringPointer && authoringPointer.id === event.pointerId) {
      const viewportBounds = event.currentTarget.getBoundingClientRect();
      const screenPoint = { x: event.clientX - viewportBounds.left, y: event.clientY - viewportBounds.top };
      const world = screenToWorld(screenPoint, liveCameraRef.current, sizeRef.current);
      const interactionDetail = authoringPointer.kind === 'guide' ? authoringPointer.detail : authoringDetail;
      const activeBounds = (scene.projection?.entityIdsByDetail[interactionDetail] ?? [])
        .flatMap(entityId => {
          const bounds = authoringBoundsForDetail(scene, entityId, interactionDetail);
          return bounds ? [{ id: entityId, bounds }] : [];
        });
      if (authoringPointer.kind === 'connection') {
        const picked = rendererRef.current?.pick(screenPoint.x, screenPoint.y);
        const targetPortHit = [...authoringEntityIds]
          .filter(entityId => entityId !== authoringPointer.from)
          .flatMap(entityId => {
            const bounds = authoringBoundsForDetail(scene, entityId, authoringDetail);
            if (!bounds) return [];
            return (['top', 'right', 'bottom', 'left'] as const).map(port => {
              const portScreen = worldToScreen(connectionPortPoint(bounds, port), liveCameraRef.current, sizeRef.current);
              return { entityId, port, distance: Math.hypot(portScreen.x - screenPoint.x, portScreen.y - screenPoint.y) };
            });
          }).filter(value => value.distance <= 16)
          .sort((left, right) => left.distance - right.distance || `${left.entityId}:${left.port}`.localeCompare(`${right.entityId}:${right.port}`))[0];
        const targetId = targetPortHit?.entityId
          ?? (picked?.kind === 'entity' && picked.id !== authoringPointer.from && authoringEntityIds.has(picked.id)
            ? picked.id
            : undefined);
        const sourceBounds = authoringBoundsForDetail(scene, authoringPointer.from, authoringDetail)!;
        if (targetId) {
          const targetBounds = authoringBoundsForDetail(scene, targetId, authoringDetail)!;
          const targetPort = targetPortHit?.port ?? nearestConnectionPort(targetBounds, world);
          try {
            const points = automaticRelationshipRoute(
              sourceBounds,
              targetBounds,
              routingObstaclesForEndpoints(activeBounds, authoringPointer.from, targetId),
              { sourcePort: authoringPointer.sourcePort, targetPort },
              8 / (scene.projection?.zoomPolicy?.bands.find(band => band.detail === authoringDetail)?.focusZoom ?? 1),
            );
            updateConnectionDraft({
              from: authoringPointer.from,
              sourcePort: authoringPointer.sourcePort,
              to: targetId,
              targetPort,
              points,
              safe: true,
            });
          } catch {
            const current = connectionDraftRef.current;
            if (current) updateConnectionDraft({ ...current, to: undefined, targetPort: undefined, safe: false });
          }
        } else {
          const start = connectionPortPoint(sourceBounds, authoringPointer.sourcePort);
          const elbow = Math.abs(world.x - start.x) >= Math.abs(world.y - start.y)
            ? { x: world.x, y: start.y }
            : { x: start.x, y: world.y };
          const candidate = [start, elbow, world];
          const safe = routeIsObstacleSafe(
            candidate,
            routingObstaclesForEndpoints(activeBounds, authoringPointer.from).map(value => value.bounds),
          );
          updateConnectionDraft({ from: authoringPointer.from, sourcePort: authoringPointer.sourcePort, points: candidate, safe });
        }
        return;
      }
      const preview = previewOrthogonalSegmentGuide(
        authoringPointer.originalPoints,
        authoringPointer.segmentIndex,
        world,
        authoringPointer.routing.obstacles.map(value => value.bounds),
        { source: authoringPointer.routing.source, target: authoringPointer.routing.target },
        authoringPointer.routing,
      );
      updateGuideDraft({ ...preview, relationId: authoringPointer.relationId, segmentIndex: authoringPointer.segmentIndex });
      return;
    }
    if (event.pointerType === 'touch' && touchPointersRef.current.has(event.pointerId)) {
      touchPointersRef.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointersRef.current.size >= 2) {
        const [first, second] = [...touchPointersRef.current.values()];
        const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
        const centroid = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
        const previous = pinchRef.current ?? { distance, centroid, startZoom: rawCameraRef.current.zoom, moved: false };
        const ratio = distance / previous.distance;
        const bounds = event.currentTarget.getBoundingClientRect();
        const pointer = { x: centroid.x - bounds.left, y: centroid.y - bounds.top };
        const zoomed = zoomCameraAt(rawCameraRef.current, pointer.x, pointer.y, sizeRef.current, -Math.log(ratio) / 0.0012);
        const direction = ratio > 1 ? 'inward' : ratio < 1 ? 'outward' : 'none';
        if (!previous.moved && Math.abs(Math.log(ratio)) > .002) {
          onCameraFlightCancelRef.current();
          onInteractionStartRef.current('Pinched the map', liveCameraRef.current);
        }
        const next = onSemanticZoomRef.current({ camera: zoomed, renderedCamera: liveCameraRef.current, pointer, direction, gestureSettled: false, mobile: true, gestureStartZoom: previous.startZoom });
        const adopted = consumeScanZoomAdoptRaw(zoomed.zoom);
        rawCameraRef.current = adopted ?? zoomed;
        applyLiveCameraRef.current(adopted ?? next);
        animateSemanticAssist(pointer, true, previous.startZoom);
        pinchRef.current = { distance, centroid, startZoom: previous.startZoom, moved: previous.moved || Math.abs(Math.log(ratio)) > .002 };
        return;
      }
    }
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) {
      updateHoverPick(event);
      return;
    }
    let dx = event.clientX - pointer.x;
    let dy = event.clientY - pointer.y;
    if (!pointer.moved) {
      if (Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) <= 3) return;
      pointer.moved = true;
      setHoveredPick(undefined);
      rawCameraRef.current = { ...liveCameraRef.current };
      cancelAssistAnimation();
      onCameraFlightCancelRef.current();
      syncContinuousRendering();
      dx = event.clientX - pointer.startX;
      dy = event.clientY - pointer.startY;
    }
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    const next = panCamera(liveCameraRef.current, dx, dy);
    rawCameraRef.current = next;
    applyLiveCameraRef.current(next);
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const authoringPointer = authoringPointerRef.current;
    if (authoringPointer && authoringPointer.id === event.pointerId) {
      const committedConnectionDraft = connectionDraftRef.current;
      const committedGuideDraft = guideDraftRef.current;
      if (authoringPointer.kind === 'connection' && committedConnectionDraft?.to && committedConnectionDraft.targetPort && committedConnectionDraft.safe) {
        onCreateRelationship({
          from: authoringPointer.from,
          to: committedConnectionDraft.to,
          sourcePort: authoringPointer.sourcePort,
          targetPort: committedConnectionDraft.targetPort,
          routePoints: committedConnectionDraft.points.map(point => ({ ...point })),
        });
      } else if (authoringPointer.kind === 'guide' && committedGuideDraft?.applied && committedGuideDraft.intent) {
        onGuideRelationship({
          relationId: authoringPointer.relationId,
          visualRelationId: authoringPointer.visualRelationId,
          detail: authoringPointer.detail,
          intent: committedGuideDraft.intent,
        });
      }
      authoringPointerRef.current = undefined;
      updateConnectionDraft(undefined);
      updateGuideDraft(undefined);
      syncContinuousRendering();
      schedulerRef.current?.wake();
      return;
    }
    if (event.pointerType === 'touch') {
      const wasPinching = pinchRef.current;
      touchPointersRef.current.delete(event.pointerId);
      if (wasPinching) {
        if (touchPointersRef.current.size < 2) {
          const bounds = event.currentTarget.getBoundingClientRect();
          const pointer = { x: wasPinching.centroid.x - bounds.left, y: wasPinching.centroid.y - bounds.top };
          if (pinchSettleTimerRef.current !== undefined) window.clearTimeout(pinchSettleTimerRef.current);
          pinchSettleTimerRef.current = window.setTimeout(() => {
            // Same single-writer rule as the wheel settle: stop the assist loop, then
            // glide onto the landing. The publisher commits after the glide's last frame,
            // so the previous explicit flush (which would recall the pre-glide camera
            // through the external sync and cancel the glide) is no longer wanted.
            cancelAssistAnimation();
            consumeScanZoomAdoptRaw();
            const next = onSemanticZoomRef.current({ camera: rawCameraRef.current, renderedCamera: liveCameraRef.current, pointer, direction: 'none', gestureSettled: true, mobile: true, gestureStartZoom: wasPinching.startZoom });
            animateSettleGlide(next);
            pinchSettleTimerRef.current = undefined;
          }, 120);
          pinchRef.current = undefined;
        }
        return;
      }
    }
    const pointer = pointerRef.current;
    if (!pointer || pointer.id !== event.pointerId) return;
    if (!pointer.moved) {
      const bounds = event.currentTarget.getBoundingClientRect();
      const picked = rendererRef.current?.pick(event.clientX - bounds.left, event.clientY - bounds.top);
      if (picked) onPick(picked);
    } else {
      const settledCamera = { ...liveCameraRef.current };
      panSettleTimerRef.current = window.setTimeout(() => {
        onLensPanRef.current(settledCamera);
        panSettleTimerRef.current = undefined;
      }, 160);
    }
    pointerRef.current = undefined;
    syncContinuousRendering();
    schedulerRef.current?.wake();
    cameraPublisherRef.current?.flush();
    if (event.pointerType !== 'touch') updateHoverPick(event);
  }

  function updateHoverPick(event: { currentTarget: HTMLDivElement; clientX: number; clientY: number; pointerType?: string }) {
    if (event.pointerType === 'touch' || pointerRef.current?.moved || pinchRef.current || authoringPointerRef.current) {
      setHoveredPick(previous => previous ? undefined : previous);
      return;
    }
    const bounds = event.currentTarget.getBoundingClientRect();
    const next = rendererRef.current?.pick(event.clientX - bounds.left, event.clientY - bounds.top);
    setHoveredPick(previous => samePickResult(previous, next) ? previous : next);
  }

  function pickAt(event: { currentTarget: HTMLDivElement; clientX: number; clientY: number }) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return rendererRef.current?.pick(event.clientX - bounds.left, event.clientY - bounds.top);
  }

  const hoverHud = canvasHoverHudModel({
    pick: hoveredPick,
    scene,
    camera: liveCameraRef.current,
    viewport: overlaySize,
    detail: authoringDetail,
    suppress: (authoringEnabled && authoringTool === 'connect')
      || Boolean(authoringPointerRef.current)
      || Boolean(pointerRef.current?.moved)
      || Boolean(pinchRef.current),
  });

  return (
    <div
      aria-label="Interactive architecture map. Double-click a node or press Enter on the selected node to open inside. Use the entity explorer after the canvas for keyboard navigation."
      className={`atlas-canvas ${authoringEnabled && authoringTool === 'connect' ? 'authoring-connect' : ''}`}
      data-testid="atlas-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={event => { const picked = pickAt(event); if (picked?.kind === 'entity') { onPick(picked); onOpenInside(picked.id); } }}
      onKeyDown={event => { if (searchOwnsKeystrokes(event.target)) return; // search keystrokes are never canvas intent
        if (event.key === 'Escape' && (askOwnsKeystrokes(event.target) || askOverlayPresent(document))) return; // Ask overlay owns Escape
        if (event.key === 'Escape') { cancelAssistAnimation(); onLensCancelRef.current('escape', liveCameraRef.current); return; }
        if (event.key === 'Enter' && selectedId) { event.preventDefault(); onOpenInside(selectedId); }
      }}
      onPointerCancel={event => {
        if (panSettleTimerRef.current !== undefined) window.clearTimeout(panSettleTimerRef.current);
        panSettleTimerRef.current = undefined;
        touchPointersRef.current.delete(event.pointerId);
        pinchRef.current = undefined;
        pointerRef.current = undefined;
        authoringPointerRef.current = undefined;
        updateConnectionDraft(undefined);
        updateGuideDraft(undefined);
        setHoveredPick(undefined);
        syncContinuousRendering();
        schedulerRef.current?.wake();
        cameraPublisherRef.current?.flush();
      }}
      onPointerLeave={() => setHoveredPick(undefined)}
      role="img"
      tabIndex={0}
    >
      <div className="atlas-renderer-host" ref={hostRef}/>
      {hoverHud && <CanvasHoverHud model={hoverHud}/>}
      {authoringEnabled && <RelationshipAuthoringOverlay
        boundsByEntityId={Object.fromEntries((scene.projection?.entityIdsByDetail[authoringDetail] ?? scene.entities.map(entity => entity.id)).flatMap(entityId => {
          const bounds = authoringBoundsForDetail(scene, entityId, authoringDetail);
          return bounds ? [[entityId, bounds]] : [];
        }))}
        camera={liveCameraRef.current}
        draft={connectionDraft
          ? { points: connectionDraft.points, safe: connectionDraft.safe }
          : guideDraft ? { points: guideDraft.points, safe: guideDraft.applied } : undefined}
        portEntityIds={[...new Set([
          ...(authoringTool === 'connect' && hoveredPick?.kind === 'entity' && authoringEntityIds.has(hoveredPick.id) ? [hoveredPick.id] : []),
          ...(authoringTool === 'connect' && selectedId && authoringEntityIds.has(selectedId) ? [selectedId] : []),
          ...(connectionDraft ? [connectionDraft.from, ...(connectionDraft.to ? [connectionDraft.to] : [])] : []),
        ])]}
        selectedRoute={authoringTool === 'select'
          ? guideDraft ? undefined : selectedProjectedRoute
          : undefined}
        viewport={overlaySize}
      />}
    </div>
  );
}

export function App() {
  const query = useMemo(() => readDemoQuery(window.location.search), []);
  const draftPreviewContext = getDraftPreviewContext();
  const initialCameraExplicit = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has('cx') || params.has('cy') || params.has('z');
  }, []);
  const [importedAtlas, setImportedAtlas] = useState<ImportedMermaidAtlas | undefined>();
  const importedAtlasRef = useRef(importedAtlas);
  importedAtlasRef.current = importedAtlas;
  const [importMermaidOpen, setImportMermaidOpen] = useState(false);
  const [importMermaidSource, setImportMermaidSource] = useState('');
  const [importMermaidError, setImportMermaidError] = useState<string>();
  const goldenScene = useMemo(() => activeCreateScene(scanFixture?.navigation.rootEntityId ?? 'system:okie'), []);
  const navigationDefaults = useMemo<NavigationDefaults>(() => {
    const identity = query.fixture === 'stress'
      ? { repositoryId: 'repo:renderer-stress', snapshotId: `snapshot:stress:${query.seed}`, viewId: 'view:stress:overview', rootEntityId: 'stress-loading' }
      : scanFixture?.navigation ?? { repositoryId: 'repo:okie-golden', snapshotId: 'snapshot:okie-golden-worktree-v1', viewId: 'view:okie-golden-hierarchy', rootEntityId: 'system:okie' };
    return {
      ...identity,
      selectedId: identity.rootEntityId,
      camera: scanFixture ? (frameContextArrivalCamera(goldenScene) ?? defaultCamera) : defaultCamera,
      detail: semanticDetails[getLevel(defaultCamera.zoom)],
      minZoom: ATLAS_CAMERA_BOUNDS.minZoom,
      maxZoom: ATLAS_CAMERA_BOUNDS.maxZoom,
    };
  }, [goldenScene, query.fixture, query.seed]);
  const navigationUrlOptions = useMemo(() => {
    const demoEntityIds = query.fixture === 'stress'
      ? undefined
      : new Set(goldenScene.entities.map(entity => entity.id));
    return {
      preserveParams: preservedNavigationParams,
      references: {
        hasSnapshot: (id: string) => id === navigationDefaults.snapshotId || id === importedAtlas?.snapshot.id,
        hasView: (id: string) => id === navigationDefaults.viewId || id === `view:${importedAtlas?.snapshot.id}`,
        hasEntity: (id: string) => demoEntityIds?.has(id) || importedAtlas?.snapshot.entities.some(entity => entity.id === id) || query.fixture === 'stress',
        hasStory: (id: string) => storyCatalog.some(plan => plan.id === id),
        hasRelationKind: isKnownRelationKind,
      },
    };
  }, [goldenScene.entities, importedAtlas, navigationDefaults, query.fixture]);
  const initialNavigation = useMemo(() => navigationStateFromUrl(
    window.location.href,
    navigationDefaults,
    navigationUrlOptions,
  ).state, [navigationDefaults, navigationUrlOptions]);
  const [activeStoryId, setActiveStoryId] = useState(() => selectStoryPlan(storyCatalog, initialNavigation.story?.id).id);
  const story = selectStoryPlan(storyCatalog, activeStoryId);
  const storyId = story.id;
  const [scene, setScene] = useState<AtlasScene>(() => query.fixture === 'stress' ? stressLoadingScene() : goldenScene);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const [fixtureError, setFixtureError] = useState<string>();
  const reduceMotion = useReducedMotion();
  const detailsOpenerRef = useRef<HTMLButtonElement | null>(null);
  const detailsPanelRef = useRef<HTMLElement | null>(null);
  const diagramAddMenuRef = useRef<HTMLDetailsElement | null>(null);
  const screenshotMenuRef = useRef<HTMLDetailsElement | null>(null);
  const overviewTabRef = useRef<HTMLButtonElement | null>(null);
  const sourceTabRef = useRef<HTMLButtonElement | null>(null);
  const detailsTabRef = useRef<HTMLButtonElement | null>(null);
  const inspectorSelectionRef = useRef(initialNavigation.selectedId);
  const inspectorReframeGenerationRef = useRef(0);
  const initialEnrichmentAbortRef = useRef<AbortController | undefined>(undefined);
  const levelCompileAbortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const fixture = scanFixture;
    return () => {
      levelCompileAbortRef.current?.abort();
      fixture?.disposeSceneWorker();
    };
  }, []);
  const neighborhoodScenesRef = useRef<Map<string, AtlasScene>>(new Map());
  const preparedSceneGenerationsRef = useRef(new WeakMap<AtlasScene, number>());
  const askButtonRef = useRef<HTMLButtonElement | null>(null);
  const askInputRef = useRef<HTMLTextAreaElement | null>(null);
  const askAbortRef = useRef<AbortController | undefined>(undefined);
  const atlasChromeRef = useRef<AtlasChromeActions>({
    hasEntity: () => false,
    selectEntity: () => {},
    setC4Level: () => {},
    isolate: () => {},
    startOverviewTour: () => {},
    openAsk: () => {},
    askSignedIn: () => false,
    readContext: () => ({
      atlas: { fixtureId: 'okie' },
      c4Level: 'context',
      selectedEntityId: null,
      tourPlaying: false,
      enrichmentStatus: 'none',
      scanAvailable: false,
      askAvailable: false,
    }),
  });
  const shareButtonRef = useRef<HTMLButtonElement | null>(null);
  const visibilityControlRef = useRef<HTMLButtonElement | null>(null);
  const shareFallbackRef = useRef<HTMLInputElement | null>(null);
  const shareFeedbackTimerRef = useRef<number | undefined>(undefined);
  const historyControllerRef = useRef<NavigationHistoryController | undefined>(undefined);
  const semanticControlTimerRef = useRef<number | undefined>(undefined);
  const initialMapFitAppliedRef = useRef(initialCameraExplicit);
  const navigationRestoreGenerationRef = useRef(0);
  const restoringNavigationRef = useRef(false);
  const storyOriginAvailableRef = useRef(false);
  const isolationOriginRef = useRef<{
    camera: Camera;
    selectedId: string;
    pickedRelationId?: string;
    visibilityMode: 'all' | 'dim';
  } | undefined>(undefined);
  const lodReplayRef = useRef<RendererLodState | undefined>(undefined);
  const [camera, updateCamera] = useState<Camera>(initialNavigation.camera);
  const renderedCameraRef = useRef(camera);
  const cameraPublicationGuardRef = useRef(createCameraPublicationEchoGuard());
  const previousReactCameraRef = useRef(camera);
  const pendingInspectorCameraFlightRef = useRef<PendingInspectorCameraFlight | undefined>(undefined);
  const inspectorCameraFlightControllerRef = useRef<CameraFlightController | undefined>(undefined);
  const inspectorFlightCameraRef = useRef<InspectorFlightFrameSink | undefined>(undefined);
  const [inspectorFlightActive, setInspectorFlightActive] = useState(false);
  inspectorCameraFlightControllerRef.current ??= createCameraFlightController(
    () => renderedCameraRef.current,
    next => {
      renderedCameraRef.current = next;
      // The canvas and minimap consume this frame through the live-camera bridge.
      // Publishing React state here made every animation frame re-render the shell.
      const sink = inspectorFlightCameraRef.current;
      if (sink) sink.render(next);
      else updateCamera(next);
    },
  );
  renderedCameraRef.current = reconcileRenderedCamera(
    renderedCameraRef.current,
    camera,
    inspectorCameraFlightControllerRef.current.isActive() || cameraPublicationGuardRef.current.isPublished(camera),
    previousReactCameraRef.current,
  );
  previousReactCameraRef.current = camera;
  const [explicitInspectorSelection, setExplicitInspectorSelection] = useState(initialNavigation.selectedId !== initialNavigation.rootEntityId);
  const [selectedId, setSelectedId] = useState(initialNavigation.selectedId);
  const [pathDraft, setPathDraft] = useState<PathDraft | undefined>(() => pathDraftFromNavigation(initialNavigation.path));
  const pathDraftRef = useRef(pathDraft);
  pathDraftRef.current = pathDraft;
  const openPathExcerptRef = useRef((_entityId: string, _excerpt: SceneSourceExcerpt) => {});
  const [pathLoadEpoch, setPathLoadEpoch] = useState(0);
  const [navigationIdentity, setNavigationIdentity] = useState(() => ({
    repositoryId: initialNavigation.repositoryId,
    snapshotId: initialNavigation.snapshotId,
    viewId: initialNavigation.viewId,
    rootEntityId: initialNavigation.rootEntityId,
    filterId: initialNavigation.filterId,
  }));
  const navigationIdentityRef = useRef(navigationIdentity);
  navigationIdentityRef.current = navigationIdentity;
  const gestureSceneRequestRef = useRef(createSceneRequestOwner());
  const viewportSceneRequestRef = useRef(createSceneRequestOwner());
  const viewportRequestedTileRef = useRef<string | undefined>(undefined);
  const neighborhoodSceneGenerationRef = useRef<{ fixture: unknown; generation: number } | undefined>(undefined);
  const zoomHandoffGenerationRef = useRef(0);
  const zoomHandoffInflightRef = useRef<{ detail: SemanticDetail; compileFocus: string } | undefined>(undefined);
  const scanZoomPointerRef = useRef<LensPoint | undefined>(undefined);
  const scanZoomAdoptRawRef = useRef<Camera | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useState(() => initialInspectorOpen());
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => scanFixture ? 'overview' : 'details');
  const [inspectorHistory, setInspectorHistory] = useState<InspectorHistorySubject[]>([]);
  const [expandedRelationshipGroups, setExpandedRelationshipGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedDetailLists, setExpandedDetailLists] = useState<ReadonlySet<string>>(() => new Set());
  const [detailsWidth, setDetailsWidth] = useState(() => {
    let stored = Number.NaN;
    try {
      stored = Number.parseFloat(localStorage.getItem(inspectorWidthStorageKey(initialNavigation.repositoryId)) ?? '');
    } catch {
      // Storage can be unavailable in privacy modes; use the repository default.
    }
    return clampInspectorWidth(Number.isFinite(stored) ? stored : defaultInspectorWidth(window.innerWidth), window.innerWidth);
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [zoomTraceRecording, setZoomTraceRecording] = useState(false);
  const [lastZoomTrace, setLastZoomTrace] = useState<string>();
  // Diagnostics/dev mode: hidden by default, toggled with Shift+Alt+D, persisted across
  // reloads. When off, the shell hides the renderer pill/diagnostics, the Edit/View mode
  // toggle (authoring stays view-only), and the Create-diagram menu.
  const [devMode, setDevMode] = useState(() => {
    try { return localStorage.getItem('okie.devMode') === '1'; } catch { return false; }
  });
  const [diagnostics, setDiagnostics] = useState<RendererDiagnostics>({ requestedBackend: query.backend, activeBackend: 'initializing', gpuAccelerated: false, entityCount: 0, relationCount: 0, lastFrameMs: 0, message: 'Renderer is initializing.' });
  const [storyStep, setStoryStep] = useState(() => initialNavigation.story?.id === storyId
    ? Math.min(story.steps.length - 1, initialNavigation.story.step)
    : -1);
  const [storyPlaying, setStoryPlaying] = useState(false);
  const initialCinematicPosition = initialNavigation.story?.id === storyId
    ? decodeStoryPosition(story, initialNavigation.story.step, initialNavigation.story.positionMs)
    : { phase: 'hold' as const, elapsedMs: 0 };
  const initialStoryElapsed = initialCinematicPosition.phase === 'hold'
    ? initialCinematicPosition.elapsedMs
    : 0;
  const [storyElapsedMs, setStoryElapsedMs] = useState(initialStoryElapsed);
  const storyElapsedRef = useRef(initialStoryElapsed);
  const storyStartedAtRef = useRef<number | undefined>(undefined);
  const [storyPhase, setStoryPhase] = useState<StoryPhase>(initialNavigation.story?.id === storyId ? 'paused' : 'idle');
  const pausedStoryPhaseRef = useRef<StoryCanonicalPhase>(initialCinematicPosition.phase);
  const pausedStoryPhaseElapsedRef = useRef(initialCinematicPosition.elapsedMs);
  const [storyFlightSample, setStoryFlightSample] = useState<StoryFlightSample>();
  const storyFlightRef = useRef<ActiveStoryFlight | undefined>(undefined);
  const [storyFlightEpoch, setStoryFlightEpoch] = useState(0);
  const arrivalStartedAtRef = useRef<number | undefined>(undefined);
  const arrivalPlayAfterRef = useRef(false);
  const [arrivalElapsedMs, setArrivalElapsedMs] = useState(0);
  const [returnToStoryFrameRequired, setReturnToStoryFrameRequired] = useState(false);
  const [storyInterruption, setStoryInterruption] = useState<string>();
  const [storySelectionOverride, setStorySelectionOverride] = useState(false);
  const [visibilityMode, setVisibilityMode] = useState<'all' | 'dim' | 'isolate'>('all');
  const [liveMessage, setLiveMessage] = useState('Architecture atlas loaded.');
  const [initialDetailLoading, setInitialDetailLoading] = useState(Boolean(scanFixture?.boot === 'neighborhood' && activeSnapshot.entities.length > 128));
  const [askOpen, setAskOpen] = useState(false);
  const [askDocked, setAskDocked] = useState(false);
  const [inspectorAskActive, setInspectorAskActive] = useState(false);
  const askTabRef = useRef<HTMLButtonElement>(null);
  const [question, setQuestion] = useState('');
  const [askConnected, setAskConnected] = useState(false);
  const [askWarmingUp, setAskWarmingUp] = useState(false);
  const [askPending, setAskPending] = useState<string>(); // the question in flight, shown once in the thread
  const [askLatestTurnId, setAskLatestTurnId] = useState<string>();
  const [askMapFocus, setAskMapFocus] = useState<{ key: string; turnId: string; entityIds: string[]; relationIds: string[] }>();
  // Ask "Show on map" is async (load → drill → settle → isolate); every user navigation bumps the
  // generation so a superseded Show never acts (askMapStepIsCurrent). See the Show section below.
  const askMapGenerationRef = useRef(0);
  const askMapInFlightRef = useRef(false);
  const cancelAskMapShow = () => { askMapGenerationRef.current += 1; askMapInFlightRef.current = false; };
  // Gesture-only reframe for the Ask panel (askPanelReframeDue): open / submit bump the request.
  const [askReframeRequest, setAskReframeRequest] = useState(0);
  const requestAskReframe = () => setAskReframeRequest(request => request + 1);
  const [askError, setAskError] = useState<string>();
  const [askAuth, setAskAuth] = useState<AskAuthView>();
  const [askThread, setAskThread] = useState<AskThreadView>();
  const askAccountRef = useRef<string | undefined>(undefined);
  askAccountRef.current = askAuth?.authenticated ? askAuth.accountId : undefined;
  const askThreadRef = useRef<AskThreadView | undefined>(undefined);
  askThreadRef.current = askThread;
  const [viewport, setViewport] = useState<ViewportSize>(() => ({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight - 68) }));
  useEffect(() => { cancelGestureSceneRequests(); }, [viewport.width, viewport.height]);
  const [measuredSafeArea, setMeasuredSafeArea] = useState<SafeArea>(() => storySafeArea({ width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight - 68) }));
  const [safeAreaEpoch, setSafeAreaEpoch] = useState(0);
  const [pickedRelationId, setPickedRelationId] = useState<string>();
  const [diagramWorkspace, setDiagramWorkspace] = useState(() => createDiagramWorkspace({
    camera: { ...initialNavigation.camera },
    selectedId: initialNavigation.selectedId,
    inspector: {
      open: initialInspectorOpen(),
      tab: scanFixture ? 'overview' : 'details',
      subjectId: initialNavigation.selectedId,
    },
  }));
  const diagramSurfaces = useMemo(() => diagramWorkspaceSurfaces(diagramWorkspace), [diagramWorkspace]);
  const activeDiagramSurface = diagramWorkspace.surfaces[diagramWorkspace.activeSurfaceId]!;
  const mainDiagramActive = activeDiagramSurface.kind === 'main';
  const [interactionMode, setInteractionMode] = useState<'view' | 'edit'>('view');
  useEffect(() => {
    try { localStorage.setItem('okie.devMode', devMode ? '1' : '0'); } catch { /* storage unavailable */ }
    if (!devMode) { setInteractionMode('view'); setDiagnosticsOpen(false); }
  }, [devMode]);
  const [authoringTool, setAuthoringTool] = useState<'select' | 'connect'>('select');
  const [authoringHistory, setAuthoringHistory] = useState<GestureHistory<ArchitectureAuthoringDocument>>(
    () => createGestureHistory(createArchitectureAuthoringDocument(initialNavigation.repositoryId)),
  );
  const authoringHistoryRef = useRef(authoringHistory);
  authoringHistoryRef.current = authoringHistory;
  const authoredRelationSequenceRef = useRef(1);
  const [shareFeedback, setShareFeedback] = useState<{ tone: 'success' | 'error'; message: string; url: string }>();
  const [settledNavigation, setSettledNavigation] = useState(initialNavigation);
  const [cameraSettledEpoch, setCameraSettledEpoch] = useState(0);
  const [semanticLensSession, setSemanticLensSession] = useState<SemanticLensSession>(() => {
    const baseIndex = initialNavigation.detail ? semanticDetails.indexOf(initialNavigation.detail) : -1;
    const baseDetail = baseIndex >= 0 ? semanticDetails[baseIndex] : 'context';
    const lensScene = query.fixture === 'stress' || initialNavigation.rootEntityId === goldenScene.rootEntityId
      ? goldenScene
      : activeCreateScene(initialNavigation.rootEntityId, goldenScene);
    const settled = validateRestoredSemanticLensPath(
      lensScene,
      baseDetail,
      initialNavigation.lensPath ?? [],
      initialNavigation.camera.zoom,
    ).entries;
    return { baseDetail, settled, active: idleSemanticLens() };
  });
  const semanticLensSessionRef = useRef(semanticLensSession);
  // An inspector flight owns this ref between its initial and terminal React
  // commits. Diagnostics or other incidental renders must not restore its
  // initial session over the frame-local semantic packet.
  if (!inspectorCameraFlightControllerRef.current?.isActive()) semanticLensSessionRef.current = semanticLensSession;
  const semanticFocusTransferRafRef = useRef<number | undefined>(undefined);
  const semanticMorphStateRef = useRef<SemanticLensState | undefined>(undefined);
  const semanticMorphBaselineRef = useRef(0);
  const scanContainerMorphRef = useRef<ScanDetailMorph | undefined>(undefined);
  const scanViewportInteractionRef = useRef<'zoom' | 'pan' | undefined>(undefined);
  const semanticRenderPacketRef = useRef<SemanticRenderPacket | undefined>(undefined);
  const semanticRenderRevisionRef = useRef(0);
  const semanticRenderTopologyRef = useRef<{ key: string; scene: AtlasScene; projection: ProjectionOverride | undefined } | undefined>(undefined);
  const semanticLens = semanticLensSessionPresentationState(semanticLensSession);

  const selected = useMemo(() => scene.entities.find(entity => entity.id === selectedId) ?? scene.entities[0], [scene.entities, selectedId]);
  useEffect(() => () => { levelCompileAbortRef.current?.abort(); initialEnrichmentAbortRef.current?.abort(); }, [scene, selectedId]);
  useEffect(() => () => { cancelGestureSceneRequests(); }, [scene, selectedId]);
  const pickedRelation = useMemo(() => pickedRelationId ? scene.relations.find(relation => relation.id === pickedRelationId) ?? canonicalRelationForInspection(activeSnapshot, pickedRelationId) : undefined, [activeSnapshot, pickedRelationId, scene.relations]);
  const pickedRelationPresentation = useMemo(() => pickedRelation ? selectedRelationPresentation(scene, pickedRelation, pickedRelation.from) : undefined, [pickedRelation, scene]);
  const pickedCanonicalRelation = activeSnapshot.relations.find(relation => relation.id === pickedRelationId);
  const selectedExcerpt = selected.sourceExcerpts?.[0];
  const sourceAvailable = inspectorCanShowSource(selected, { pickedRelation: Boolean(pickedRelation) });
  const selectedExposure = activeSnapshot.entities.find(entity => entity.id === selected.id)?.exposure ?? [];
  const selectedSummary = inspectorAcceptedSummary(selected);
  const selectedOwners = inspectorPathOwners(selected);
  const selectedCyclomatic = inspectorCyclomatic(selected);
  const selectedCoverage = inspectorCoverage(selected);
  const selectedUntestedBehaviours = inspectorUntestedBehaviours(selected);
  const selectedDuplicates = useMemo(
    () => inspectorDuplicates(selected.id, activeSnapshot.relations, activeSnapshot.entities),
    [activeSnapshot.entities, activeSnapshot.relations, selected.id],
  );
  const localWorkspace = useMemo<LocalWorkspaceContext | undefined>(() => {
    const injected = (window as Window & { __OKIE_LOCAL_WORKSPACE__?: LocalWorkspaceContext }).__OKIE_LOCAL_WORKSPACE__;
    return injected ?? (configuredRepositoryRoot ? { repositoryRoot: configuredRepositoryRoot } : undefined);
  }, []);
  const selectedProvenance = useMemo(() => presentClaimProvenance({
    origin: 'inferred',
    evidenceCount: selected.sourceRefs?.length ?? 0,
    ...(selected.confidence !== undefined ? { confidence: selected.confidence } : {}),
  }), [selected.confidence, selected.sourceRefs]);
  const selectedChildren = useMemo(
    () => scene.entities.filter(entity => entity.parentId === selected.id),
    [scene.entities, selected.id],
  );
  const inspectorChildren = useMemo(() => [...new Map([...selectedChildren, ...activeSnapshot.entities.filter(entity => entity.parentId === selected.id)].map(entity => [entity.id, { id: entity.id, name: entity.name }])).values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)), [selectedChildren, selected.id]);
  const inspectorNeighborhoodRequest = useRef(createInspectorNeighborhoodRequest());
  const inspectorNeighborhoodFixture = useRef(scanFixture);
  inspectorNeighborhoodFixture.current = scanFixture;
  useEffect(() => () => inspectorNeighborhoodRequest.current.cancel(), [scanFixture]);
  async function openInspectorChild(id: string) {
    cancelGestureSceneRequests();
    inspectorNeighborhoodRequest.current.cancel();
    const resident = scene.entities.find(entity => entity.id === id);
    const residentPlan = resident && semanticInspectorHierarchyPlan(scene, id, viewport, measureCurrentMapSafeArea(), semanticLensSessionRef.current, renderedCameraRef.current);
    // Code declarations always need the owner-rooted L4 compile below. A
    // resident generic hierarchy plan only frames the current parent shell.
    if (resident?.detail !== 'code' && resident && residentPlan) { navigateInspectorHierarchy(resident); return; }
    const initialNavigation = inspectorNavigationIdentity(navigationRef.current);
    const initialSelection = inspectorSelectionRef.current;
    await inspectorNeighborhoodRequest.current.run(
      () => scanFixture?.ensureNeighborhood(id) ?? Promise.resolve(),
      () => inspectorNeighborhoodFixture.current === scanFixture
        && inspectorNavigationIdentity(navigationRef.current) === initialNavigation && inspectorSelectionRef.current === initialSelection,
      () => {
        const target = activeSnapshot.entities.find(entity => entity.id === id);
        const focusId = target?.kind === 'code' ? target.parentId ?? id : id;
        // A captured declaration reached from an implementation link must enter
        // the owner's canonical L4 scope. The generic hierarchy flight frames
        // its parent shell but cannot install the scan drill's component root.
        if (target?.kind === 'code' && focusId !== id) {
          // Match the inspector link's normal panel navigation before the
          // canonical drill preserves that entry for its destination.
          if (!inspectorCameraFlightControllerRef.current?.isActive()) updateInspectorHistoryForNavigation('panel');
          openInsideLoaded(focusId, 'preserve', id);
          return;
        }
        // Snapshot membership is broader than the current drawable window. A
        // declaration may exist in scene.entities but have no L4 representation.
        // Compile its owner and explicitly retain it before planning the drill.
        const compiled = scanFixture
          ? activeCreateScene(focusId, sceneRef.current, undefined, { keepEntityIds: [id] })
          : composeScene(focusId, sceneRef.current, authoringHistoryRef.current.present);
        const entity = compiled.entities.find(candidate => candidate.id === id);
        if (!entity) { setLiveMessage('This child is captured but its map is unavailable.'); return; }
        setScene(compiled);
        navigateInspectorHierarchy(entity, compiled);
      },
    );
  }
  const omittedChildNodes = useMemo(
    () => (scene.omittedNodes ?? []).filter(node => node.parentId === selected.id),
    [scene.omittedNodes, selected.id],
  );
  const selectedParent = useMemo(
    () => selected.parentId ? scene.entities.find(entity => entity.id === selected.parentId) : undefined,
    [scene.entities, selected.parentId],
  );
  const selectedHasChildren = scanFixture
    ? scanEntityHasChildren(activeSnapshot, selected.id)
    : selectedChildren.length > 0;
  const selectedLevel = Math.max(0, semanticDetails.indexOf(selected.detail ?? 'context'));
  const selectedLevelLabel = `${levels[selectedLevel]?.short ?? 'L1'} · ${(selected.kindLabel ?? selected.detail ?? selected.kind).toUpperCase()}`;
  const detailsWidthRange = inspectorWidthRange(window.innerWidth);
  useEffect(() => {
    if (inspectorSelectionRef.current === selected.id) return;
    inspectorSelectionRef.current = selected.id;
  }, [selected.detail, selected.id, selected.sourceExcerpts, selected.sourceRefs]);
  useEffect(() => {
    if (getActivePortableAtlas() || !scanFixture || inspectorTab !== 'source' || selected.detail !== 'code') return;
    if (selected.sourceExcerpts?.length) return;
    let cancelled = false;
    void scanFixture.ensureExcerpts(selected.id).then(excerpts => {
      if (cancelled || !excerpts?.length) return;
      setScene(current => ({
        ...current,
        entities: current.entities.map(entity => entity.id === selected.id
          ? { ...entity, sourceExcerpts: excerpts.map(excerpt => ({ ...excerpt, lines: [...excerpt.lines] })) }
          : entity),
      }));
    });
    return () => { cancelled = true; };
  }, [inspectorTab, selected.detail, selected.id, selected.sourceExcerpts]);
  useEffect(() => () => inspectorCameraFlightControllerRef.current?.dispose(), []);
  useEffect(() => {
    setDetailsWidth(current => clampInspectorWidth(current, window.innerWidth));
  }, [viewport.width]);
  useEffect(() => {
    try {
      localStorage.setItem(inspectorWidthStorageKey(navigationIdentity.repositoryId), String(detailsWidth));
    } catch {
      // Storage can be unavailable in privacy modes; resizing still works for the session.
    }
  }, [detailsWidth, navigationIdentity.repositoryId]);
  const currentStory = storyStep >= 0 ? story.steps[storyStep] : undefined;
  const activeStoryFlight = storyFlightRef.current;
  const storyCanonicalPhase: StoryCanonicalPhase = storyPhase === 'flight' || storyPhase === 'arrival' || storyPhase === 'hold'
    ? storyPhase
    : pausedStoryPhaseRef.current;
  const storyPhaseElapsedMs = storyCanonicalPhase === 'flight'
    ? storyFlightSample?.elapsedMs ?? pausedStoryPhaseElapsedRef.current
    : storyCanonicalPhase === 'arrival'
      ? arrivalElapsedMs
      : storyElapsedMs;
  const storyPositionMs = storyStep < 0
    ? 0
    : encodeStoryPosition(
        story,
        storyStep,
        storyCanonicalPhase,
        storyPhaseElapsedMs,
        activeStoryFlight?.flight.canonicalDurationMs,
      );
  const storyTraveling = Boolean(activeStoryFlight && storyCanonicalPhase === 'flight' && !storySelectionOverride);
  const activeLevelRef = useRef(initialNavigation.detail
    ? Math.max(0, semanticDetails.indexOf(initialNavigation.detail))
    : getLevel(initialNavigation.camera.zoom));
  const activeLevel = Math.max(0, semanticDetails.indexOf(semanticLensSessionDetail(semanticLensSession)));
  const baseDetail = semanticLensSession.baseDetail;
  const architectureBrief = useMemo(() => buildArchitectureBrief({
    snapshot: activeSnapshot,
    childCounts: scanFixture?.childCounts,
  }), [activeSnapshot.entities, activeSnapshot.relations,
    scanFixture?.childCounts]);
  const contextualOverview = useMemo(
    () => buildContextualOverview(activeSnapshot, explicitInspectorSelection ? selected.id : semanticLensCanonicalPathIds(semanticLensSession).at(-1) ?? navigationIdentity.rootEntityId),
    [activeSnapshot.entities, activeSnapshot.relations, selected.id, explicitInspectorSelection, semanticLensSession, navigationIdentity.rootEntityId],
  );
  const activeDetail = semanticDetails[activeLevel];
  const activeDerivedScopeId = activeDiagramSurface.kind === 'main'
    ? undefined
    : activeDiagramSurface.entityIds[0];
  const activeDerivedScope = activeDerivedScopeId
    ? scene.entities.find(entity => entity.id === activeDerivedScopeId)
    : undefined;
  const activeDiagramDetail = activeDiagramSurface.kind === 'code'
    ? 'code'
    : activeDerivedScope?.detail ?? activeDetail;
  const activeDiagramScopeId = activeDerivedScope
    ? activeDiagramSurface.kind === 'code'
      ? activeDerivedScope.detail === 'component'
        ? activeDerivedScope.id
        : activeDerivedScope.parentId ?? navigationIdentity.rootEntityId
      : activeDiagramDetail === 'component' || activeDiagramDetail === 'code'
      ? activeDerivedScope.parentId ?? navigationIdentity.rootEntityId
      : activeDiagramDetail === 'container' || activeDerivedScope.id !== navigationIdentity.rootEntityId
        ? navigationIdentity.rootEntityId
        : activeDerivedScope.id
    : semanticLensCanonicalPathIds(semanticLensSession).at(-1) ?? navigationIdentity.rootEntityId;
  const notationDiagnostics = useMemo(() => query.fixture === 'stress' ? [] : validateC4NotationCompleteness({
    snapshot: activeSnapshot,
    view: activeView,
    diagramType: activeDiagramDetail,
    title: activeDiagramSurface.kind === 'main' ? scene.title : activeDiagramSurface.title,
    scopeEntityId: activeDiagramScopeId,
  }), [activeDiagramDetail, activeDiagramScopeId, activeDiagramSurface.kind, activeDiagramSurface.title, query.fixture, scene.title]);
  const notationPresentation = useMemo(
    () => presentInspectorNotationDiagnostics(notationDiagnostics, {
      scope: inspectorNotationScope({
        selectedId: selected.id,
        bandEntityIds: scene.projection?.entityIdsByDetail[activeDetail ?? 'context'] ?? [],
        entities: scene.entities,
        relations: activeSnapshot.relations,
      }),
    }),
    [activeDetail, notationDiagnostics, scene.entities, scene.projection, selected.id],
  );
  const notationDetails = useMemo(
    () => inspectorNotationDetailsView(notationPresentation, devMode ? 'diagnostics' : 'user'),
    [devMode, notationPresentation],
  );
  const activeDynamicFlowResult = useMemo(() => {
    if (query.fixture === 'stress' || activeDiagramSurface.kind === 'main' || activeDiagramSurface.kind === 'code' || activeDiagramSurface.kind === 'dependency' || activeDiagramSurface.kind === 'source') return undefined;
    const scopeEntityId = activeDiagramSurface.entityIds[0];
    const scopeEntity = activeSnapshot.entities.find(entity => entity.id === scopeEntityId);
    if (!scopeEntity) return undefined;
    const namedStory = storyCatalog.find(story => story.id === activeDiagramSurface.storyId);
    if (!namedStory) return undefined;
    const dynamicStory = architectureStoryFromAppPlan(namedStory);
    // Derived flow/Mermaid projections build the bundle directly (not via the
    // scan createScene seam), so scope them through the same per-focus options
    // (per-kind maxBand at every size) so this bypass path can never compile
    // the full graph either.
    return optionalDiagramResult(() => {
    const scoped = scanFixture?.scopeCompileOptions(scopeEntityId) ?? {};
    const projections = buildC4ProjectionBundle(activeSnapshot, {
      rootEntityId: activeView.rootEntityId,
      focusEntityId: scopeEntityId,
      familyId: `view-family:dynamic:${scopeEntityId}`,
      ...scoped,
    });
    return compileC4DynamicFlowArtifact(activeSnapshot, activeView, dynamicStory, projections);
    });
  }, [activeDiagramDetail, activeDerivedScopeId, activeDiagramSurface.kind, activeDiagramSurface.kind !== 'main' ? activeDiagramSurface.storyId : undefined, query.fixture]);
  const activeDynamicFlowArtifact = activeDynamicFlowResult?.artifact;
  const activeMermaidSource = activeDiagramSurface.kind === 'mermaid' && activeDynamicFlowArtifact
    ? serializeDynamicFlowMermaid(activeDynamicFlowArtifact)
    : undefined;
  const lensTopologyKey = `${semanticLensSession.baseDetail}|${semanticLensSession.settled.map(entry => `${entry.targetId}:${entry.currentDetail}:${entry.nextDetail}`).join('>')}|${semanticLensSession.active.targetId ?? ''}:${semanticLensSession.active.currentDetail ?? ''}:${semanticLensSession.active.nextDetail ?? ''}|${semanticLensSession.focusTransfer?.sourceEntries.map(entry => entry.targetId).join('>') ?? ''}>${semanticLensSession.focusTransfer?.targetId ?? ''}:${semanticLensSession.focusTransfer?.depth ?? ''}`;
  const projectionTopology = useMemo(() => semanticLensSessionProjectionOverride(scene, {
    ...semanticLensSession,
    active: { ...semanticLensSession.active, progress: 0 },
  }, true), [lensTopologyKey, scene]);
  const projectionOverride = useMemo(() => projectionTopology ? applySemanticBackgroundVisibility(scene, semanticLensSession, {
    ...projectionTopology,
    progress: semanticLensSession.active.phase === 'idle'
      ? semanticLensSession.focusTransfer?.progress ?? 1
      : semanticLensSession.active.progress,
  }) : undefined, [projectionTopology, scene, semanticLensSession]);
  const activeProjectionEntityIds = useMemo(
    () => semanticLensSessionVisibleEntityIds(scene, semanticLensSession),
    [scene, semanticLensSession],
  );
  const activeProjectionRelationIds = useMemo(
    () => semanticLensSessionVisibleRelationIds(scene, semanticLensSession),
    [scene, semanticLensSession],
  );
  const authoringEnabled = query.fixture !== 'stress'
    && semanticLensSession.active.phase === 'idle'
    && semanticLensSession.focusTransfer === undefined
    && !storyTraveling;
  const editingEnabled = interactionMode === 'edit' && authoringEnabled;
  const authoringEntityIds = useMemo(
    () => new Set(activeProjectionEntityIds),
    [activeProjectionEntityIds],
  );
  const authoringViewId = scene.projection?.familyId ?? navigationIdentity.viewId;
  const selectedProjectedRelation = useMemo(
    () => selectedProjectedRelationForFocus(scene, pickedRelationId, projectionOverride, activeDetail),
    [activeDetail, pickedRelationId, projectionOverride, scene],
  );
  const selectedAuthoringDetail = selectedProjectedRelation?.detail ?? activeDetail;
  const selectedRouteOverride = useMemo(() => pickedRelationId
    ? authoringHistory.present.routeOverrides.find(override => override.viewId === authoringViewId
      && override.detail === selectedAuthoringDetail
      && override.relationId === pickedRelationId)
    : undefined, [authoringHistory.present.routeOverrides, authoringViewId, pickedRelationId, selectedAuthoringDetail]);
  const backendPresentation = presentBackend(diagnostics);
  const storyFocus = useMemo(() => storyFocusPresentation(
    selected.id,
    currentStory?.focusEntityIds ?? [],
    currentStory?.traceRelationIds ?? [],
    {
      storyOpen: currentStory !== undefined && storyPhase !== 'idle',
      selectionOverride: storySelectionOverride,
      ...(pickedRelationId ? { pickedRelationId } : {}),
    },
  ), [currentStory, pickedRelationId, selected.id, storyPhase, storySelectionOverride]);
  // CLA-208: scan snapshots grow in place as neighborhoods load, so re-run on size and scene changes.
  // Imported Mermaid atlases are not explored (their snapshot is not the inspector's); hide rather than mislead.
  const pathAvailable = query.fixture !== 'stress' && !importedAtlas;
  const pathView = useMemo(
    () => pathDraft && pathAvailable ? explorePathView(activeSnapshot, pathDraft, pathGraphCoverage({ scanBoot: scanFixture?.boot })) : undefined,
    [pathDraft, pathAvailable, pathLoadEpoch, scene, activeSnapshot.entities.length, activeSnapshot.relations.length],
  );
  const pathParentById = useMemo(() => new Map(activeSnapshot.entities.map(entity => [entity.id, entity.parentId])), [pathLoadEpoch, scene, activeSnapshot.entities.length]);
  const pathFocus = useMemo(() => pathView?.reveal && { key: pathView.reveal.relationIds.join('|') || pathView.reveal.entityIds.join('|'), ...pathView.reveal }, [pathView]);
  const focusPickedRelationId = currentStory === undefined || storyPhase === 'idle' || storySelectionOverride ? pickedRelationId : undefined;
  const focusPath = currentStory === undefined || storyPhase === 'idle' || storySelectionOverride ? (askMapFocus && visibilityMode === 'isolate' ? askMapFocus : pathFocus) : undefined;
  const relationFocus = useMemo(
    () => relationOrSetFocusPresentation(scene, focusPickedRelationId, focusPath, projectionOverride, activeDetail, pathParentById),
    [activeDetail, focusPath, focusPickedRelationId, pathParentById, projectionOverride, scene],
  );
  function publishSemanticRenderPacket(camera: Camera, packetScene = sceneRef.current, session = semanticLensSessionRef.current) {
    const key = `${session.baseDetail}|${session.settled.map(entry => `${entry.targetId}:${entry.currentDetail}:${entry.nextDetail}`).join('>')}|${session.active.targetId ?? ''}:${session.active.currentDetail ?? ''}:${session.active.nextDetail ?? ''}|${session.focusTransfer?.sourceEntries.map(entry => entry.targetId).join('>') ?? ''}>${session.focusTransfer?.targetId ?? ''}:${session.focusTransfer?.depth ?? ''}`;
    const cached = semanticRenderTopologyRef.current;
    const topology = cached?.scene === packetScene && cached.key === key
      ? cached.projection
      : semanticLensSessionProjectionOverride(packetScene, { ...session, active: { ...session.active, progress: 0 } }, true);
    if (!cached || cached.scene !== packetScene || cached.key !== key) {
      semanticRenderTopologyRef.current = { key, scene: packetScene, projection: topology };
    }
    const semanticProjection = topology ? applySemanticBackgroundVisibility(packetScene, session, {
      ...topology,
      progress: session.active.phase === 'idle'
        ? session.focusTransfer?.progress ?? 1
        : session.active.progress,
    }) : undefined;
    const relationProjection = relationOrSetFocusPresentation(
      packetScene,
      focusPickedRelationId,
      focusPath,
      semanticProjection,
      semanticLensSessionDetail(session),
      pathParentById,
    ).projectionOverride;
    semanticRenderPacketRef.current = {
      revision: ++semanticRenderRevisionRef.current,
      camera: { ...camera },
      scene: packetScene,
      semanticSession: session,
      ...(relationProjection ? { projectionOverride: relationProjection } : {}),
    };
  }
  const rendererSelectedId = storyFocus.selectedId;
  const visibilityFocusIds = useMemo(
    () => new Set([...storyFocus.requiredIds, ...relationFocus.endpointIds]),
    [relationFocus.endpointIds, storyFocus.requiredIds],
  );
  const isolatedEntityIds = useMemo(
    () => isolateNeighborhoodIds(scene.entities, visibilityFocusIds, { liftCodeStoryFocus: currentStory !== undefined && storyPhase !== 'idle' && !storySelectionOverride }),
    [currentStory, scene.entities, storyPhase, storySelectionOverride, visibilityFocusIds],
  );
  const isolatedEntityIdSet = useMemo(() => new Set(isolatedEntityIds), [isolatedEntityIds]);
  const focusedIds = visibilityMode === 'isolate' ? isolatedEntityIdSet : storyFocus.focusedIds;
  const activeRelationIds = useMemo(
    () => new Set([...storyFocus.relationIds, ...relationFocus.relationIds]),
    [relationFocus.relationIds, storyFocus.relationIds],
  );
  // The inspector inventories canonical relationships for the selected entity,
  // including evidence that is outside the current projected map neighborhood.
  const canonicalRelationshipGroups = useMemo(
    () => canonicalRelationshipGroupsForEntity(activeSnapshot, scene, new Set(activeProjectionRelationIds), selected.id, new Set(activeProjectionEntityIds.filter(id => visibilityMode !== 'isolate' || isolatedEntityIdSet.has(id)))),
    [activeProjectionEntityIds, activeProjectionRelationIds, activeSnapshot, isolatedEntityIdSet, scene, selected.id, visibilityMode],
  );
  const namedDiagramStories = storyCatalog.filter(story => story.id !== defaultStory.id && story.steps.length > 1 && story.steps.some(step => step.focusEntityIds.includes(selected.id)) && story.steps.every(step => step.sourceRefs.length > 0 && step.traceRelationIds.length > 0));
  const hasDependencyDiagram = scene.relations.some(relation => (relation.from === selected.id || relation.to === selected.id) && scene.entities.some(entity => entity.id === relation.from) && scene.entities.some(entity => entity.id === relation.to));
  const hasCodeStructureDiagram = selected.detail === 'component'
    && selectedChildren.some(child => child.detail === 'code');
  useEffect(() => {
    setExpandedRelationshipGroups(new Set());
    setExpandedDetailLists(new Set());
  }, [selected.id]);
  const breadcrumbState = useMemo(() => {
    const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
    const chain: SceneEntity[] = [];
    const root = byId.get(navigationIdentity.rootEntityId) ?? selected;
    let current: SceneEntity | undefined = root;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      chain.unshift(current);
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    let descendant: SceneEntity | undefined;
    current = selected;
    visited.clear();
    while (current && !visited.has(current.id)) {
      if (current.id === root.id) {
        descendant = selected.id === root.id ? undefined : selected;
        break;
      }
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return { chain, descendant };
  }, [navigationIdentity.rootEntityId, scene.entities, selected]);
  const workerSearch = useWorkerSearch(scene.entities, search, searchOpen, recordSearchTiming);
  const searchEntityById = useMemo(() => new Map(searchOpen && search.trim() ? scene.entities.map(entity => [entity.id, entity] as const) : []), [scene.entities, searchOpen, Boolean(search.trim())]);
  const searchResults = useMemo(() => search.trim()
    ? workerSearch.ids.flatMap(id => { const entity = searchEntityById.get(id); return entity ? [entity] : []; })
    : defaultSearchSuggestions(scene, {
      selectedId,
      rootId: navigationIdentity.rootEntityId,
      breadcrumbIds: breadcrumbState.chain.map(entity => entity.id),
    }), [breadcrumbState, navigationIdentity.rootEntityId, scene, search, searchEntityById, selectedId, workerSearch.ids]);
  const searchPending = Boolean(search.trim()) && (workerSearch.status === 'building' || workerSearch.status === 'searching');
  const explorerEntities = useMemo(
    () => explorerEntitiesForView(scene, {
      detail: activeDetail ?? 'context',
      selected,
      settledTargetIds: semanticLensSession.settled.map(entry => entry.targetId),
      visibleIds: activeProjectionEntityIds,
    }),
    [activeDetail, activeProjectionEntityIds, scene, selected, semanticLensSession.settled],
  );
  const askAtlasIdentity = resolveAskAtlasIdentity({
    pathname: window.location.pathname,
    search: window.location.search,
    commitSha: activeSnapshot.commitSha,
  });
  const portableAtlas = getActivePortableAtlas();
  const sourceRepositoryUrl = portableAtlas ? portableRepositoryRevisionUrl(portableAtlas.repository) : atlasSourceRepositoryUrl(askAtlasIdentity);
  const embedAtlas = useEmbedAtlasAvailability(Boolean(portableAtlas)); // CLA-329: public atlases only; reacts to the publication index
  const askReturnPath = `${window.location.pathname}${window.location.search}`;
  const askSignedIn = askAuth?.authenticated === true; const askHidden = askAuth === undefined || askAuth.askEnabled === false; // CLA-266: no Ask affordance before /api/auth/me answers or when the deployment disables Ask
  const isolatedRelationIds = useMemo(
    () => scene.relations
      .filter(relation => isolatedEntityIdSet.has(relation.from) && isolatedEntityIdSet.has(relation.to))
      .map(relation => relation.id),
    [scene.relations, isolatedEntityIdSet],
  );
  const visibleExplorerEntities = useMemo(
    () => visibilityMode === 'isolate' && !storyTraveling
      ? explorerEntities.filter(entity => isolatedEntityIdSet.has(entity.id))
      : explorerEntities,
    [explorerEntities, isolatedEntityIdSet, storyTraveling, visibilityMode],
  );
  const sceneObjectSummary = useMemo(
    () => summarizeIds(scene.entities.map(entity => entity.id)),
    [scene.entities],
  );
  const sceneRelationSummary = useMemo(
    () => summarizeIds(scene.relations.map(relation => relation.id)),
    [scene.relations],
  );
  const isolatedObjectSummary = useMemo(() => summarizeIds(isolatedEntityIds), [isolatedEntityIds]);
  const isolatedRelationSummary = useMemo(() => summarizeIds(isolatedRelationIds), [isolatedRelationIds]);
  const flightOwnsPresentation = storyTraveling;
  const effectiveVisibilityMode = flightOwnsPresentation ? 'dim' : visibilityMode;
  const animationActive = inspectorFlightActive || Boolean(currentStory && !reduceMotion && (
    (storyPhase === 'flight' && activeStoryFlight?.flight.running)
    || storyPhase === 'arrival'
    || (storyPhase === 'hold' && storyPlaying)
  ));
  const flowPresentation = useMemo(() => relationshipFlowPolicy({
    reducedMotion: reduceMotion,
    interactionMode,
    selectedRelationIds: relationFocus.relationIds,
    storyRelationIds: storyFocus.relationIds,
    storyHoldPlaying: storyPhase === 'hold' && storyPlaying,
  }), [interactionMode, reduceMotion, relationFocus.relationIds, storyFocus.relationIds, storyPhase, storyPlaying]);
  const flowRelationIds = flowPresentation.relationIds;
  const flowActive = flowPresentation.active;
  const cinematicTransition = flightOwnsPresentation && activeStoryFlight && storyFlightSample
    ? {
        id: activeStoryFlight.id,
        positionMs: storyFlightSample.elapsedMs,
        durationMs: activeStoryFlight.flight.canonicalDurationMs,
        visualProgress: storyFlightSample.visualProgress,
        departureProgress: storyFlightSample.departureProgress,
        sourceFocusedIds: activeStoryFlight.sourceFocusedIds,
        targetFocusedIds: activeStoryFlight.targetFocusedIds,
        sourceRelationIds: activeStoryFlight.sourceRelationIds,
        targetRelationIds: activeStoryFlight.targetRelationIds,
      }
    : undefined;
  const navigationState = canonicalNavigationState({
    ...navigationIdentity,
    selectedId,
    camera,
    detail: baseDetail,
    ...(semanticLensCanonicalPathIds(semanticLensSession).length ? { lensPath: semanticLensCanonicalPathIds(semanticLensSession) } : {}),
    ...(storyStep >= 0 ? {
      story: { id: storyId, step: storyStep, positionMs: storyPositionMs },
    } : {}),
    path: navigationPathFromDraft(pathDraft),
  }, navigationDefaults);
  const navigationRef = useRef<NavigationState>(navigationState);
  useEffect(() => {
    const fixture = scanFixture;
    if (!fixture || sceneRef.current !== goldenScene) return;
    let alive = true;
    const controller = new AbortController();
    initialEnrichmentAbortRef.current = controller;
    void fixture.enrichInitialScene(controller.signal).then(enriched => {
      if (alive) setInitialDetailLoading(false);
      if (!alive || !enriched || fixture !== scanFixture || sceneRef.current !== goldenScene) return;
      const detail = semanticLensSessionDetail(semanticLensSessionRef.current);
      if (detail !== 'context' && detail !== 'container') return;
      if (!initialSceneBandsMatch(goldenScene, enriched)) return;
      setScene(enriched);
    }).catch(() => { if (alive) setInitialDetailLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [goldenScene]);
  navigationRef.current = navigationState;
  const rendererReplayState = JSON.stringify({
    timeline: {
      id: currentStory ? storyId : null,
      step: storyStep,
      positionMs: storyPositionMs,
      playbackState: storyPlaying ? 'playing' : 'paused',
      phase: storyPhase,
      canonicalPhase: storyCanonicalPhase,
      phaseElapsedMs: storyPhaseElapsedMs,
      holdElapsedMs: storyElapsedMs,
      holdDurationMs: currentStory ? storyStepDuration(story, storyStep) : 0,
      flightProgress: storyFlightSample?.progress ?? (storyCanonicalPhase === 'flight' ? initialCinematicPosition.progress ?? 0 : 1),
      flightDurationMs: activeStoryFlight?.flight.canonicalDurationMs ?? 0,
      sourceCamera: activeStoryFlight?.flight.source ?? null,
      targetCamera: activeStoryFlight?.flight.target ?? null,
      returnToStoryFrameRequired,
      interruption: storyInterruption ?? null,
      reducedMotion: reduceMotion,
    },
    lod: lodReplayRef.current ?? {
      objectId: scene.entities[0]?.id ?? null,
      current: `${scene.entities[0]?.id ?? 'scene'}:${camera.zoom >= 0.52 ? 'detail' : 'compact'}`,
      progress: 1,
      currentWeight: 1,
      previousWeight: 0,
      transitioning: false,
      durationMs: 200,
    },
    camera,
    focus: {
      selectedId: selected.id,
      objectIds: [...focusedIds].sort(),
      relationIds: [...activeRelationIds].sort(),
    },
    projection: {
      detail: activeDetail,
      rootEntityId: navigationIdentity.rootEntityId,
      entityIds: summarizeIds(activeProjectionEntityIds),
      relationIds: summarizeIds(activeProjectionRelationIds),
      lens: {
        phase: semanticLens.phase,
        targetId: semanticLens.targetId ?? null,
        progress: Math.round(semanticLens.progress * 1_000) / 1_000,
        assistBlend: Math.round(semanticLens.assistBlend * 1_000) / 1_000,
        overrideId: projectionOverride?.id ?? null,
        objectCount: projectionOverride?.objects.length ?? 0,
        pathCount: projectionOverride?.paths.length ?? 0,
      },
    },
    visibility: {
      mode: effectiveVisibilityMode,
      requestedMode: visibilityMode,
      objectIds: effectiveVisibilityMode === 'isolate' ? isolatedObjectSummary : sceneObjectSummary,
      relationIds: effectiveVisibilityMode === 'isolate' ? isolatedRelationSummary : sceneRelationSummary,
    },
    safeArea: measuredSafeArea,
    staticGeometry: {
      meshRebuilt: diagnostics.meshRebuilt ?? false,
      revision: diagnostics.staticMeshRevision ?? 0,
      uploadBytes: diagnostics.staticGeometryUploadBytes ?? diagnostics.geometryUploadBytes ?? 0,
      bufferUploads: diagnostics.staticGeometryBufferUploads ?? diagnostics.geometryBufferUploads ?? 0,
      cumulativeUploadBytes: diagnostics.cumulativeStaticGeometryUploadBytes ?? 0,
      cumulativeBufferUploads: diagnostics.cumulativeStaticGeometryBufferUploads ?? 0,
    },
    dynamicStreams: {
      indexUploadBytes: diagnostics.dynamicIndexUploadBytes ?? 0,
      cumulativeIndexUploadBytes: diagnostics.cumulativeDynamicIndexUploadBytes ?? 0,
      styleUploadBytes: diagnostics.dynamicStyleUploadBytes ?? 0,
      cumulativeStyleUploadBytes: diagnostics.cumulativeDynamicStyleUploadBytes ?? 0,
      flowUploadBytes: diagnostics.flowUploadBytes ?? 0,
      cumulativeFlowUploadBytes: diagnostics.cumulativeFlowUploadBytes ?? 0,
      uniformUploadBytes: diagnostics.uniformUploadBytes ?? 0,
      cumulativeUniformUploadBytes: diagnostics.cumulativeUniformUploadBytes ?? 0,
      lodUniformUploadBytes: diagnostics.lodUniformUploadBytes ?? 0,
      cumulativeLodUniformUploadBytes: diagnostics.cumulativeLodUniformUploadBytes ?? 0,
    },
    residency: {
      partitionTotal: diagnostics.residentPartitionTotal ?? 0,
      partitionActive: diagnostics.residentPartitionActive ?? 0,
      partitionDrawn: diagnostics.residentPartitionDrawn ?? 0,
      objectCount: diagnostics.residentObjectCount ?? 0,
      pathCount: diagnostics.residentPathCount ?? 0,
      cacheHits: diagnostics.partitionCacheHits ?? 0,
      cacheMisses: diagnostics.partitionCacheMisses ?? 0,
      cacheEvictions: diagnostics.partitionCacheEvictions ?? 0,
      drawRangeCount: diagnostics.drawRangeCount ?? 0,
    },
    scheduler: {
      rafActive: animationActive,
      frameSampleCount: diagnostics.frameSampleCount ?? 0,
      totalFrameCount: diagnostics.totalFrameCount ?? 0,
      frameWindowIncludesInitialBuild: diagnostics.frameWindowIncludesInitialBuild ?? false,
    },
  });

  function commitNavigation(next: NavigationState, mode: 'push' | 'replace') {
    const canonical = canonicalNavigationState(next, navigationDefaults);
    navigationRef.current = canonical;
    const controller = historyControllerRef.current;
    if (!controller) return;
    if (mode === 'push') controller.push(canonical);
    else controller.replace(canonical);
  }

  function installSemanticSession(session: SemanticLensSession, commitToReact = true) {
    semanticRenderPacketRef.current = undefined;
    scanContainerMorphRef.current = undefined;
    semanticLensSessionRef.current = session;
    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    if (commitToReact) setSemanticLensSession(session);
  }

  function collapseInspectorFlightSession(session: SemanticLensSession) {
    if (session.focusTransfer) {
      return {
        ...session,
        settled: session.focusTransfer.progress < .5
          ? session.focusTransfer.sourceEntries
          : session.settled,
        active: idleSemanticLens(),
        focusTransfer: undefined,
      };
    }
    return stabilizeSemanticLensSessionForPan(session);
  }

  function startInspectorCameraFlight(input: {
    targetId: string;
    targetSession: SemanticLensSession;
    targetCamera: Camera;
    navigation: NavigationState;
    historyMode: 'replace';
  }) {
    const previous = pendingInspectorCameraFlightRef.current;
    const sourceSession = collapseInspectorFlightSession(previous
      ? previous.semanticProgress < .5 ? previous.sourceSession : previous.targetSession
      : semanticLensSessionRef.current);
    inspectorCameraFlightControllerRef.current?.cancel();
    if (semanticControlTimerRef.current !== undefined) window.clearTimeout(semanticControlTimerRef.current);
    semanticControlTimerRef.current = undefined;
    if (semanticFocusTransferRafRef.current !== undefined) window.cancelAnimationFrame(semanticFocusTransferRafRef.current);
    semanticFocusTransferRafRef.current = undefined;
    const sourceCamera = inspectorFlightCameraRef.current?.begin();
    if (sourceCamera) renderedCameraRef.current = sourceCamera;
    installSemanticSession(sourceSession);
    const pending: PendingInspectorCameraFlight = {
      sourceSession,
      targetSession: input.targetSession,
      targetId: input.targetId,
      kind: semanticInspectorFlightKind(sourceSession, input.targetSession),
      semanticProgress: 0,
      navigation: canonicalNavigationState(input.navigation, navigationDefaults),
      historyMode: input.historyMode,
    };
    pendingInspectorCameraFlightRef.current = pending;
    const morphEntry = pending.kind === 'inward'
      ? pending.targetSession.settled.at(-1)
      : pending.kind === 'outward'
        ? pending.sourceSession.settled.at(-1)
        : undefined;
    const sourceBounds = morphEntry ? semanticBounds(scene, morphEntry.targetId, morphEntry.currentDetail) : undefined;
    const targetBounds = morphEntry ? semanticBounds(scene, morphEntry.targetId, morphEntry.nextDetail) : undefined;
    const morphKind = pending.kind === 'inward' || pending.kind === 'outward' ? pending.kind : undefined;
    const rawTarget = morphKind && sourceBounds && targetBounds && !reduceMotion
      ? semanticInspectorRawCameraTarget(input.targetCamera, sourceBounds, targetBounds, morphKind)
      : input.targetCamera;
    const installProgress = (easedCameraProgress: number, commitToReact = true) => {
      const semanticProgress = semanticInspectorFlightProgress(easedCameraProgress, pending.kind);
      pending.semanticProgress = semanticProgress;
      const session = semanticInspectorFlightSession(
        pending.sourceSession,
        pending.targetSession,
        pending.targetId,
        semanticProgress,
      );
      installSemanticSession(session, commitToReact);
      return session;
    };
    installProgress(0);
    setInspectorFlightActive(true);
    inspectorCameraFlightControllerRef.current?.start({
      target: rawTarget,
      viewport,
      reducedMotion: reduceMotion,
      ...(morphKind && sourceBounds && targetBounds && !reduceMotion ? { transformCamera: (sample: CameraFlightSample) => {
        const semanticProgress = semanticInspectorFlightProgress(sample.easedProgress, pending.kind);
        return compensateSemanticInspectorFlightCamera(
          sample.camera,
          sourceBounds,
          targetBounds,
          morphKind,
          semanticProgress,
        );
      } } : {}),
      onUpdate: sample => {
        if (pendingInspectorCameraFlightRef.current !== pending) return;
        const session = installProgress(sample.easedProgress, false);
        publishSemanticRenderPacket(sample.camera, sceneRef.current, session);
      },
      onComplete: () => {
        if (pendingInspectorCameraFlightRef.current !== pending) return;
        pendingInspectorCameraFlightRef.current = undefined;
        installSemanticSession(pending.targetSession);
        activeLevelRef.current = semanticDetails.indexOf(semanticLensSessionDetail(pending.targetSession));
        renderedCameraRef.current = input.targetCamera;
        updateCamera(input.targetCamera);
        setInspectorFlightActive(false);
        commitNavigation(canonicalNavigationState({
          ...pending.navigation,
          path: navigationRef.current.path,
          camera: input.targetCamera,
          detail: pending.targetSession.baseDetail,
          lensPath: semanticLensCanonicalPathIds(pending.targetSession),
        }, navigationDefaults), pending.historyMode);
      },
    });
  }

  function cancelInspectorCameraFlight(): Camera {
    const liveCamera = { ...renderedCameraRef.current };
    const pending = pendingInspectorCameraFlightRef.current;
    if (!pending) return liveCamera;
    inspectorCameraFlightControllerRef.current?.cancel();
    renderedCameraRef.current = liveCamera;
    updateCamera(liveCamera);
    pendingInspectorCameraFlightRef.current = undefined;
    installSemanticSession(pending.targetSession);
    activeLevelRef.current = semanticDetails.indexOf(semanticLensSessionDetail(pending.targetSession));
    setInspectorFlightActive(false);
    commitNavigation(canonicalNavigationState({
      ...pending.navigation,
      path: navigationRef.current.path,
      camera: liveCamera,
      detail: pending.targetSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(pending.targetSession),
    }, navigationDefaults), pending.historyMode);
    return liveCamera;
  }

  function abortInspectorCameraFlight(): Camera {
    const liveCamera = { ...renderedCameraRef.current };
    const pending = pendingInspectorCameraFlightRef.current;
    if (!pending) return liveCamera;
    const liveSession = collapseInspectorFlightSession(semanticLensSessionRef.current);
    inspectorCameraFlightControllerRef.current?.cancel();
    pendingInspectorCameraFlightRef.current = undefined;
    renderedCameraRef.current = liveCamera;
    updateCamera(liveCamera);
    installSemanticSession(liveSession);
    activeLevelRef.current = semanticDetails.indexOf(semanticLensSessionDetail(liveSession));
    setInspectorFlightActive(false);
    return liveCamera;
  }

  useEffect(() => {
    const controller = createNavigationHistoryController({
      defaults: navigationDefaults,
      urlOptions: navigationUrlOptions,
      async restore(next, source) {
        cancelGestureSceneRequests();
        cancelAskMapShow(); // back/forward supersedes an in-flight Ask "Show on map"
        abortInspectorCameraFlight();
        const restoreGeneration = navigationRestoreGenerationRef.current + 1;
        navigationRestoreGenerationRef.current = restoreGeneration;
        restoringNavigationRef.current = true;
        const restoredLevel = next.detail
          ? Math.max(0, semanticDetails.indexOf(next.detail))
          : getLevel(next.camera.zoom);
        activeLevelRef.current = restoredLevel;
        const restoredBaseDetail = semanticDetails[restoredLevel];
        const restoredScene = query.fixture === 'stress'
          || (source === 'initialize' && scanFixture && next.rootEntityId === goldenScene.rootEntityId)
          ? goldenScene
          : composeScene(next.rootEntityId, goldenScene, authoringHistoryRef.current.present);
        const validatedLensPath = validateRestoredSemanticLensPath(
          restoredScene,
          restoredBaseDetail,
          next.lensPath ?? [],
          next.camera.zoom,
        );
        const restoredSettled = validatedLensPath.entries;
        installSemanticSession({ baseDetail: restoredBaseDetail, settled: restoredSettled, active: idleSemanticLens() });
        if (validatedLensPath.truncated) {
          const corrected = canonicalNavigationState({
            ...next,
            lensPath: restoredSettled.map(entry => entry.targetId),
          }, navigationDefaults);
          navigationRef.current = corrected;
          window.queueMicrotask(() => controller.replace(corrected));
          setLiveMessage('Invalid, unrelated, or camera-incoherent semantic lens path was truncated to the deepest valid branch.');
        }
        if (!(isFramedBrowsingContext() && !isUsableAtlasViewport(viewport))) {
          initialMapFitAppliedRef.current = true;
        }
        storyOriginAvailableRef.current = source === 'popstate' && Boolean(next.story);
        setNavigationIdentity({
          repositoryId: next.repositoryId,
          snapshotId: next.snapshotId,
          viewId: next.viewId,
          rootEntityId: next.rootEntityId,
          filterId: next.filterId,
        });
        if (query.fixture !== 'stress') setScene(restoredScene);
        setInspectorHistory([]);
        setSelectedId(next.selectedId);
        restorePathDraft(next, source);
        updateCamera(next.camera);
        const restoredPlan = selectStoryPlan(storyCatalog, next.story?.id);
        const restoredKnown = Boolean(next.story && storyCatalog.some(plan => plan.id === next.story!.id));
        setActiveStoryId(restoredPlan.id);
        const restoredStep = restoredKnown ? Math.min(restoredPlan.steps.length - 1, next.story!.step) : -1;
        if (restoredStep >= 0) {
          const restoredFocusId = storyStepSelectedId(
            restoredPlan.steps[restoredStep]!.focusEntityIds,
            restoredScene.entities.map(entity => entity.id),
          );
          if (restoredFocusId) {
            inspectorSelectionRef.current = restoredFocusId;
            setSelectedId(restoredFocusId);
          }
        }
        setStoryStep(restoredStep);
        const restoredPosition = restoredKnown
          ? decodeStoryPosition(restoredPlan, restoredStep, next.story!.positionMs)
          : { phase: 'hold' as const, elapsedMs: 0 };
        const restoredElapsed = restoredPosition.phase === 'hold' ? restoredPosition.elapsedMs : 0;
        storyElapsedRef.current = restoredElapsed;
        setStoryElapsedMs(restoredElapsed);
        pausedStoryPhaseRef.current = restoredPosition.phase;
        pausedStoryPhaseElapsedRef.current = restoredPosition.elapsedMs;
        setStoryPhase(restoredStep >= 0 ? 'paused' : 'idle');
        setArrivalElapsedMs(restoredPosition.phase === 'arrival' ? restoredPosition.elapsedMs : 0);
        setReturnToStoryFrameRequired(false);
        setStorySelectionOverride(false);
        storyFlightRef.current = undefined;
        setStoryFlightSample(undefined);
        if (restoredStep >= 0 && restoredPosition.phase === 'flight') {
          const target = frameStoryStepCamera(
            restoredScene,
            restoredPlan.steps[restoredStep]!.focusEntityIds,
            restoredPlan.steps[restoredStep]!.reveal,
            viewport,
            measureCurrentStorySafeArea(),
          ) ?? next.camera;
          const sourceStep = restoredPlan.steps[(restoredStep - 1 + restoredPlan.steps.length) % restoredPlan.steps.length]!;
          const sourceSession = semanticStorySession(sourceStep);
          const targetSession = semanticStorySession(restoredPlan.steps[restoredStep]!);
          const now = performance.now();
          const canonicalDurationMs = 1_100;
          const canonicalElapsedMs = Math.round((restoredPosition.progress ?? 0) * canonicalDurationMs);
          const flight = createStoryFlight(next.camera, target, viewport, now, {
            durationMs: Math.max(1, canonicalDurationMs - canonicalElapsedMs),
            canonicalDurationMs,
            canonicalElapsedMs,
            running: false,
          });
          flight.frozenCamera = { ...next.camera };
          const restoredFlight: ActiveStoryFlight = {
            id: `restore:${restoredStep}:${canonicalElapsedMs}`,
            step: restoredStep,
            flight,
            sourceFocusedIds: [...sourceStep.focusEntityIds],
            targetFocusedIds: [...restoredPlan.steps[restoredStep]!.focusEntityIds],
            sourceRelationIds: [...sourceStep.traceRelationIds],
            targetRelationIds: [...restoredPlan.steps[restoredStep]!.traceRelationIds],
            sourceSession,
            targetSession,
            playAfterArrival: false,
          };
          storyFlightRef.current = restoredFlight;
          installStorySemanticProgress(restoredFlight, restoredPosition.progress ?? 0);
          setStoryFlightSample(sampleStoryFlight(flight, now));
          setStoryFlightEpoch(epoch => epoch + 1);
        }
        storyStartedAtRef.current = undefined;
        setStoryInterruption(undefined);
        setStoryPlaying(false);
        isolationOriginRef.current = undefined;
        setVisibilityMode('all');
        setPickedRelationId(undefined);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        if (navigationRestoreGenerationRef.current !== restoreGeneration) return;
        restoringNavigationRef.current = false;
        if (source === 'initialize' && !initialCameraExplicit) {
          if (!(isFramedBrowsingContext() && !isUsableAtlasViewport(viewport))) {
            initialMapFitAppliedRef.current = true;
          }
          // CLA-11: do not bump safeAreaEpoch; that delayed-fit after load.
        }
      },
      onCommit(commit) {
        setSettledNavigation(commit.state);
        setCameraSettledEpoch(commit.settledEpoch);
      },
    });
    historyControllerRef.current = controller;
    void controller.start();
    return () => {
      controller.dispose();
      if (historyControllerRef.current === controller) historyControllerRef.current = undefined;
    };
  }, [goldenScene, initialCameraExplicit, navigationDefaults, navigationUrlOptions, query.fixture]);

  useEffect(() => {
    if (restoringNavigationRef.current) return;
    const controller = historyControllerRef.current;
    if (!controller) return;
    const currentStoryId = controller.current().story?.id;
    const currentStoryStep = controller.current().story?.step ?? -1;
    if (currentStoryId !== navigationRef.current.story?.id || currentStoryStep !== (navigationRef.current.story?.step ?? -1)) {
      controller.replace(navigationRef.current);
    }
  }, [storyStep]);

  useEffect(() => () => {
    if (shareFeedbackTimerRef.current !== undefined) window.clearTimeout(shareFeedbackTimerRef.current);
    if (semanticControlTimerRef.current !== undefined) window.clearTimeout(semanticControlTimerRef.current);
    if (semanticFocusTransferRafRef.current !== undefined) window.cancelAnimationFrame(semanticFocusTransferRafRef.current);
  }, []);

  useEffect(() => {
    if (shareFeedback?.tone === 'error') {
      shareFallbackRef.current?.focus();
      shareFallbackRef.current?.select();
    }
  }, [shareFeedback]);

  useEffect(() => {
    if (query.fixture !== 'stress') return;
    let current = true;
    void loadStressFixture().then(stressScene => {
      if (!current) return;
      setScene(stressScene);
      const requestedId = navigationRef.current.selectedId;
      const nextSelectedId = stressScene.entities.some(entity => entity.id === requestedId)
        ? requestedId
        : stressScene.entities[0]?.id ?? 'stress-loading';
      setSelectedId(nextSelectedId);
      if (nextSelectedId !== requestedId) {
        commitNavigation(canonicalNavigationState({
          ...navigationRef.current,
          selectedId: nextSelectedId,
          rootEntityId: nextSelectedId,
        }, navigationDefaults), 'replace');
        setNavigationIdentity(current => ({ ...current, rootEntityId: nextSelectedId }));
      }
      setFixtureError(undefined);
      setLiveMessage('Deterministic 5,000 node and 15,000 relation stress fixture loaded.');
    }).catch(error => {
      if (!current) return;
      const message = error instanceof Error ? error.message : String(error);
      setFixtureError(message);
      setLiveMessage(`Stress fixture failed to load: ${message}`);
    });
    return () => { current = false; };
  }, [query.fixture]);

  function currentStoryElapsed() {
    const duration = storyStepDuration(story, storyStep);
    if (!storyPlaying || storyStartedAtRef.current === undefined) return storyElapsedRef.current;
    return Math.min(duration, Math.max(0, Math.round(storyElapsedRef.current + performance.now() - storyStartedAtRef.current)));
  }

  function publishLodState(state: RendererLodState | undefined) {
    if (!state) return;
    const canonical = {
      ...state,
      progress: Math.round(state.progress * 1_000) / 1_000,
      currentWeight: Math.round(state.currentWeight * 1_000) / 1_000,
      previousWeight: Math.round(state.previousWeight * 1_000) / 1_000,
    };
    lodReplayRef.current = canonical;
    const shell = document.querySelector<HTMLElement>('[data-testid="atlas-app"]');
    if (!shell?.dataset.rendererReplayState) return;
    try {
      const replay = JSON.parse(shell.dataset.rendererReplayState) as Record<string, unknown>;
      replay.lod = canonical;
      shell.dataset.rendererReplayState = JSON.stringify(replay);
    } catch {
      // The declarative state will repopulate the hook on the next React commit.
    }
  }

  function interruptStory(reason: string, liveCamera: Camera = camera, directManipulation = true) {
    if (storyStep < 0) return;
    const now = performance.now();
    let canonicalPhase: StoryCanonicalPhase = storyCanonicalPhase;
    let elapsed = storyPhaseElapsedMs;
    if (storyPhase === 'flight' && storyFlightRef.current) {
      const committedSample = storyFlightSample
        ?? sampleStoryFlight(storyFlightRef.current.flight, storyFlightRef.current.flight.startedAtMs);
      const pausedFlight: StoryFlight = {
        ...storyFlightRef.current.flight,
        elapsedMs: committedSample.segmentElapsedMs,
        canonicalElapsedMs: committedSample.elapsedMs,
        startedAtMs: Math.round(now),
        running: false,
        frozenCamera: { ...liveCamera },
      };
      storyFlightRef.current = { ...storyFlightRef.current, flight: pausedFlight };
      const frozenSample = { ...committedSample, camera: { ...liveCamera } };
      setStoryFlightSample(frozenSample);
      pausedStoryPhaseRef.current = 'flight';
      pausedStoryPhaseElapsedRef.current = frozenSample.elapsedMs;
      canonicalPhase = 'flight';
      elapsed = frozenSample.elapsedMs;
      updateCamera(liveCamera);
    } else if (storyPhase === 'arrival') {
      pausedStoryPhaseRef.current = 'arrival';
      pausedStoryPhaseElapsedRef.current = arrivalElapsedMs;
      canonicalPhase = 'arrival';
      elapsed = arrivalElapsedMs;
    } else if (storyPhase === 'hold' && storyPlaying) {
      elapsed = currentStoryElapsed();
      storyElapsedRef.current = elapsed;
      setStoryElapsedMs(elapsed);
      pausedStoryPhaseRef.current = 'hold';
      pausedStoryPhaseElapsedRef.current = elapsed;
      canonicalPhase = 'hold';
    }
    storyStartedAtRef.current = undefined;
    setStoryPlaying(false);
    setStoryPhase(directManipulation ? 'interrupted' : 'paused');
    setReturnToStoryFrameRequired(directManipulation && canonicalPhase === 'flight');
    setStoryInterruption(reason);
    const next = canonicalNavigationState({
      ...navigationRef.current,
      camera: liveCamera,
      story: {
        id: storyId,
        step: storyStep,
        positionMs: encodeStoryPosition(
          story,
          storyStep,
          canonicalPhase,
          elapsed,
          storyFlightRef.current?.flight.canonicalDurationMs,
        ),
      },
    }, navigationDefaults);
    navigationRef.current = next;
    historyControllerRef.current?.replace(next);
    setLiveMessage(`${reason}. Guided explanation paused at ${Math.round(elapsed / 100) / 10} seconds.`);
  }

  function toggleStoryPlayback() {
    const liveCamera = abortInspectorCameraFlight();
    if (storyPlaying || storyPhase === 'flight' || storyPhase === 'arrival') {
      interruptStory('Paused by you', liveCamera, false);
      return;
    }
    if (pausedStoryPhaseRef.current === 'flight' && storyFlightRef.current) {
      if (returnToStoryFrameRequired) {
        setLiveMessage('The map was moved. Use Return to story frame to continue this flight.');
        return;
      }
      const resumed = resumeStoryFlight(storyFlightRef.current.flight, liveCamera, viewport, performance.now());
      storyFlightRef.current = { ...storyFlightRef.current, flight: resumed };
      setStoryFlightSample(sampleStoryFlight(resumed, resumed.startedAtMs));
      setStorySelectionOverride(false);
      setStoryPhase('flight');
      setStoryInterruption(undefined);
      setStoryFlightEpoch(epoch => epoch + 1);
      setLiveMessage(`Resumed camera flight to story step ${storyStep + 1}.`);
      return;
    }
    if (pausedStoryPhaseRef.current === 'arrival') {
      arrivalStartedAtRef.current = performance.now() - pausedStoryPhaseElapsedRef.current;
      arrivalPlayAfterRef.current = true;
      setStoryPhase('arrival');
      setStorySelectionOverride(false);
      setStoryInterruption(undefined);
      return;
    }
    storyStartedAtRef.current = performance.now();
    pausedStoryPhaseRef.current = 'hold';
    setStoryInterruption(undefined);
    setStoryPlaying(true);
    setStorySelectionOverride(false);
    setStoryPhase('hold');
    setLiveMessage(`Resumed story step ${storyStep + 1} with ${Math.ceil((storyStepDuration(story, storyStep) - storyElapsedRef.current) / 1000)} seconds remaining.`);
  }

  function returnToStoryFrame() {
    const liveCamera = abortInspectorCameraFlight();
    const active = storyFlightRef.current;
    if (!active || pausedStoryPhaseRef.current !== 'flight') return;
    const resumed = resumeStoryFlight(active.flight, liveCamera, viewport, performance.now());
    storyFlightRef.current = { ...active, flight: resumed };
    setStoryFlightSample(sampleStoryFlight(resumed, resumed.startedAtMs));
    setStorySelectionOverride(false);
    setReturnToStoryFrameRequired(false);
    setStoryInterruption(undefined);
    setStoryPhase('flight');
    setStoryFlightEpoch(epoch => epoch + 1);
    setLiveMessage(`Returning to story step ${storyStep + 1}.`);
  }

  function setCamera(updater: (camera: Camera) => Camera) {
    updateCamera(updater);
  }

  function cancelSemanticLens(reason: string) {
    cancelSemanticLensAt(reason, abortInspectorCameraFlight());
  }

  function cancelSemanticLensAt(reason: string, reachedCamera: Camera) {
    const current = semanticLensSessionRef.current;
    if (current.active.phase === 'idle' && current.settled.length === 0) return;
    const idle = idleSemanticLensSession(current.baseDetail);
    semanticLensSessionRef.current = idle;    setSemanticLensSession(idle);
    updateCamera(reachedCamera);
    const next = canonicalNavigationState({
      ...navigationRef.current,
      camera: reachedCamera,
      detail: current.baseDetail,
      lensPath: undefined,
    }, navigationDefaults);
    navigationRef.current = next;
    historyControllerRef.current?.replace(next);
    setLiveMessage(`Semantic lens cancelled by ${reason}.`);
  }

  function animateSemanticFocusTransfer(targetId: string) {
    const startedAt = performance.now();
    if (semanticFocusTransferRafRef.current !== undefined) window.cancelAnimationFrame(semanticFocusTransferRafRef.current);
    const tick = (now: number) => {
      const live = semanticLensSessionRef.current;
      if (live.focusTransfer?.targetId !== targetId) {
        semanticFocusTransferRafRef.current = undefined;
        return;
      }
      const progressed = advanceSemanticLensFocusTransfer(live, (now - startedAt) / 180);
      semanticLensSessionRef.current = progressed;
      setSemanticLensSession(progressed);
      if (progressed.focusTransfer) semanticFocusTransferRafRef.current = window.requestAnimationFrame(tick);
      else semanticFocusTransferRafRef.current = undefined;
    };
    semanticFocusTransferRafRef.current = window.requestAnimationFrame(tick);
  }

  function stabilizeSemanticLensForPan(reachedCamera: Camera) {
    scanViewportInteractionRef.current = 'pan';
    if (levelScenePreparationPending(levelCompileAbortRef.current)) return;
    const current = semanticLensSessionRef.current;
    const plan = semanticPanFocusPlan(
      scene,
      current,
      selected.id,
      reachedCamera,
      viewport,
      measureCurrentMapSafeArea(),
      160,
    );
    const nextSession = plan.session;
    semanticLensSessionRef.current = nextSession;    setSemanticLensSession(nextSession);
    const lensPath = semanticLensCanonicalPathIds(nextSession);
    const next = canonicalNavigationState({
      ...navigationRef.current,
      camera: reachedCamera,
      detail: nextSession.baseDetail,
      lensPath: lensPath.length ? lensPath : undefined,
    }, navigationDefaults);
    navigationRef.current = next;
    historyControllerRef.current?.replace(next);
    if (!nextSession.focusTransfer) return;
    animateSemanticFocusTransfer(nextSession.focusTransfer.targetId);
  }

  function beginSemanticZoomBurst(reachedCamera: Camera): Camera {
    scanViewportInteractionRef.current = 'zoom';
    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    const containerMorph = scanContainerMorphRef.current;
    if (containerMorph) containerMorph.baselineProgress = containerMorph.progress;
    return reachedCamera;
  }

  /** Restore adjacent endpoints for a deep scene reached by rail, search, or a link. */
  function startScanContainerReverseMorph(camera: Camera, direction: 'inward' | 'outward' | 'none', arrivalZoom?: number) {
    if (!scanFixture || reduceMotion) return false;
    const target = sceneRef.current;
    const viewRootId = scanFixture.navigation.rootEntityId;
    const focusId = target.rootEntityId ?? viewRootId;
    const session = semanticLensSessionRef.current;
    const existing = scanContainerMorphRef.current;
    // The bridge owns both its source and target sessions. Do not rebuild it
    // while an outward gesture is still above the component boundary.
    if (existing && existing.scene === target && scanContainerMorphOwnsSession(existing, session)) return false;
    if (!shouldStartScanContainerReverseMorph({
      direction,
      currentDetail: semanticLensSessionDetail(session),
      currentRootId: focusId,
      viewRootId,
      activeTargetId: session.settled.at(-1)?.targetId,
    })) return false;
    const detail = semanticLensSessionDetail(session);
    if (detail !== 'component' && detail !== 'code') return false;
    const sourceFocusId = detail === 'code'
      ? activeSnapshot.entities.find(entity => entity.id === focusId)?.parentId
      : viewRootId;
    if (!sourceFocusId) return false;
    const source = composeScene(sourceFocusId, undefined, authoringHistoryRef.current.present);
    const bridge = createScanReverseMorph(source, target, focusId, detail, arrivalZoom);
    if (!bridge) return false;
    const frame = sampleScanContainerMorph(bridge, camera.zoom);
    scanContainerMorphRef.current = bridge;
    sceneRef.current = bridge.scene;
    setScene(bridge.scene);
    semanticLensSessionRef.current = frame.session;
    setSemanticLensSession(frame.session);
    return true;
  }

  function handleSemanticZoom(sample: Parameters<typeof handleSemanticZoomReady>[0]): Camera {
    scanZoomPointerRef.current = sample.pointer;
    renderedCameraRef.current = sample.camera;
    return runLevelSceneGesture(levelCompileAbortRef.current, sample.camera, () => handleSemanticZoomReady(sample));
  }

  function handleSemanticZoomReady(sample: {
    camera: Camera;
    pointer: LensPoint;
    direction: 'inward' | 'outward' | 'none';
    gestureSettled: boolean;
    mobile: boolean;
    renderedCamera?: Camera;
    gestureStartZoom?: number;
  }): Camera {
    if (query.fixture === 'stress' || (sample.mobile && detailsOpen)) {
      semanticRenderPacketRef.current = undefined;
      return sample.camera;
    }
    scanZoomPointerRef.current = sample.pointer;
    renderedCameraRef.current = sample.camera;
    const dormantBridge = scanContainerMorphRef.current;
    const dormantTarget = dormantBridge?.progress === 0
      ? scanZoomEntityUnderPointer(dormantBridge.scene, sample.camera, viewport, sample.pointer, dormantBridge.sourceDetail)
      : undefined;
    const sourceDetailIndex = dormantBridge ? semanticDetails.indexOf(dormantBridge.sourceDetail) : -1;
    const hasLeftSourceBand = dormantBridge && sourceDetailIndex > 0
      && getLevel(sample.camera.zoom, sourceDetailIndex) < sourceDetailIndex;
    // Preserve the dormant bridge throughout L2, including multiple wheel
    // events after the zero crossing. It is safe to release only after the
    // camera has actually crossed to L1; a different L2 card retargets now.
    if (dormantBridge?.progress === 0 && ((sample.direction === 'outward' && hasLeftSourceBand)
      || (sample.direction === 'inward' && dormantTarget && dormantTarget !== dormantBridge.focusId))) {
      scanContainerMorphRef.current = undefined;
      sceneRef.current = dormantBridge.sourceScene;
      setScene(dormantBridge.sourceScene);
      semanticLensSessionRef.current = dormantBridge.sourceSession;
      setSemanticLensSession(dormantBridge.sourceSession);
      const rootEntityId = dormantBridge.sourceScene.rootEntityId ?? scanFixture?.navigation.rootEntityId;
      if (rootEntityId) setNavigationIdentity(current => ({ ...current, rootEntityId }));
      scanZoomAdoptRawRef.current = sample.camera;
    }
    startScanContainerReverseMorph(sample.camera, sample.direction, sample.renderedCamera?.zoom ?? sample.gestureStartZoom);
    const containerMorph = scanContainerMorphRef.current;
    if (containerMorph && containerMorph.scene === sceneRef.current
      && scanContainerMorphOwnsSession(containerMorph, semanticLensSessionRef.current)) {
      const frame = sampleScanContainerMorph(containerMorph, sample.camera.zoom);
      // A completed expansion can continue into L4. Until then the same retained
      // L2/L3 representations own both zoom directions, including wheel settle.
      if (frame.progress < 1 || containerMorph.progress < 1 || sample.direction !== 'inward') {
        const next = scanContainerMorphCamera(containerMorph, frame.progress, sample.camera,
          sample.direction === 'none' ? sample.renderedCamera : undefined);
        const previousProgress = containerMorph.progress;
        containerMorph.progress = frame.progress;
        renderedCameraRef.current = next;
        semanticLensSessionRef.current = frame.session;
        setSemanticLensSession(frame.session);
        if (frame.progress === 0 && sample.direction === 'outward') {
          // Keep the stitched scene and its original zoom interval dormant.
          // Replacing it with the raw L2 source here forced the next inward
          // wheel to fetch/recreate a bridge at the current zoom, changing the
          // camera offset and briefly exposing a void. Its navigation identity
          // is still the source endpoint while the retained geometry is idle.
          const rootEntityId = containerMorph.sourceScene.rootEntityId ?? scanFixture!.navigation.rootEntityId;
          const crossedZero = previousProgress > 0;
          const dormant = { ...containerMorph.scene, rootEntityId };
          containerMorph.scene = dormant;
          sceneRef.current = dormant;
          setScene(dormant);
          setNavigationIdentity(current => ({ ...current, rootEntityId }));
          semanticLensSessionRef.current = containerMorph.sourceSession;
          setSemanticLensSession(containerMorph.sourceSession);
          if (crossedZero) {
            // Subsequent wheel samples use this rendered source endpoint as
            // raw input, so its structural compensation has been consumed.
            containerMorph.baselineProgress = 0;
            scanZoomAdoptRawRef.current = next;
          }
        } else if (frame.progress > 0 && sceneRef.current.rootEntityId !== containerMorph.focusId) {
          // Resume the same bridge rather than treating the dormant L2
          // endpoint as a new L2→L3 handoff.
          const resumed = { ...containerMorph.scene, rootEntityId: containerMorph.focusId };
          containerMorph.scene = resumed;
          sceneRef.current = resumed;
          setScene(resumed);
          setNavigationIdentity(current => ({ ...current, rootEntityId: containerMorph.focusId }));
        }
        const navigation = canonicalNavigationState({
          ...navigationRef.current,
          rootEntityId: sceneRef.current.rootEntityId,
          camera: next,
          detail: semanticLensSessionRef.current.baseDetail,
          lensPath: semanticLensCanonicalPathIds(semanticLensSessionRef.current),
        }, navigationDefaults);
        navigationRef.current = navigation;
        historyControllerRef.current?.replace(navigation);
        publishSemanticRenderPacket(next);
        return next;
      }
    } else if (containerMorph) scanContainerMorphRef.current = undefined;
    if (maybeScanZoomHandoff(sample.camera, next => {
      renderedCameraRef.current = next;
      updateCamera(next);
    }, sample.pointer)) {
      const navigation = canonicalNavigationState({
        ...navigationRef.current,
        camera: sample.camera,
        detail: semanticLensSessionRef.current.baseDetail,
        lensPath: semanticLensCanonicalPathIds(semanticLensSessionRef.current),
      }, navigationDefaults);
      navigationRef.current = navigation;
      historyControllerRef.current?.replace(navigation);
      publishSemanticRenderPacket(sample.camera);
      return sample.camera;
    }
    const current = semanticLensSessionRef.current;
    const reversingEntry = current.active.phase === 'idle' && sample.direction === 'outward'
      ? current.settled.at(-1)
      : undefined;
    const activeState = current.active.phase !== 'idle' ? current.active : reversingEntry
      ? { phase: 'settled' as const, ...reversingEntry, progress: 1, assistBlend: 0 }
      : undefined;
    if (!semanticMorphStateRef.current && activeState) {
      semanticMorphStateRef.current = activeState;
      semanticMorphBaselineRef.current = activeState.progress;
    }
    const currentDetail = activeState?.currentDetail ?? semanticLensSessionDetail(current);
    const safeArea = measureCurrentMapSafeArea();
    // Eligibility belongs to the camera produced by this input sample. The rendered
    // camera is the pre-input/structurally compensated view and can lag one wheel tick.
    const targetingCamera = sample.camera;
    const deepest = current.settled.at(-1);
    const settledTargetIds = new Set(current.settled.map(entry => entry.targetId));
    const liveScene = sceneRef.current;
    const eligibleIds = deepest
      ? new Set(semanticLensBranchEntityIds(liveScene, deepest.targetId, semanticLensSessionDetail(current))
          .filter(id => id !== deepest.targetId && !settledTargetIds.has(id)))
      : undefined;
    const candidateTarget = findSemanticLensTarget(
      liveScene,
      currentDetail,
      targetingCamera,
      viewport,
      safeArea,
      sample.pointer,
      [selected.id, navigationIdentityRef.current.rootEntityId],
      eligibleIds,
      settledTargetIds,
    );
    const activeTarget = activeState?.targetId && activeState.currentDetail
      ? measureSemanticLensTarget(liveScene, activeState.targetId, activeState.currentDetail, targetingCamera, viewport, safeArea, sample.pointer)
      : undefined;
    const nowMs = performance.now();
    const nextSession = reduceSemanticLensSession(current, {
      nowMs,
      zoom: sample.camera.zoom,
      direction: sample.direction,
      activeTarget,
      candidateTarget,
      mobile: sample.mobile,
      reducedMotion: reduceMotion,
      gestureSettled: sample.gestureSettled,
      gestureStartZoom: sample.gestureStartZoom,
    });
    semanticLensSessionRef.current = nextSession;
    setSemanticLensSession(nextSession);
    const newlySettled = nextSession.settled.length > current.settled.length
      ? nextSession.settled.at(-1)
      : undefined;
    const trackedMorph = semanticMorphStateRef.current;
    if (nextSession.active.phase !== 'idle') {
      if (trackedMorph?.targetId !== nextSession.active.targetId) semanticMorphBaselineRef.current = 0;
      semanticMorphStateRef.current = nextSession.active;
    } else if (newlySettled) {
      if (trackedMorph?.targetId !== newlySettled.targetId) semanticMorphBaselineRef.current = 0;
      semanticMorphStateRef.current = {
        phase: 'settled',
        ...newlySettled,
        progress: 1,
        assistBlend: 0,
      };
    } else if (trackedMorph?.targetId && trackedMorph.currentDetail && trackedMorph.nextDetail) {
      const remainsSettled = nextSession.settled.some(entry => entry.targetId === trackedMorph.targetId);
      semanticMorphStateRef.current = {
        ...trackedMorph,
        phase: remainsSettled ? 'settled' : 'reversing',
        progress: remainsSettled ? 1 : 0,
        assistBlend: 0,
      };
    }
    const presentation = nextSession.active.phase !== 'idle'
      ? nextSession.active
      : semanticMorphStateRef.current;
    // The morph reflow pin is the ONLY camera adjustment a zoom sample gets: it keeps
    // the branch under the pointer visually stable while its representation bounds
    // reflow between bands. Settle applies no landing at all — a zoom never moves the
    // user's anchor (direct user feedback; supersedes the task #32 settle-frame
    // containment, whose residual pull-in read as "auto pan after zooming").
    let morph: SemanticZoomMorph | undefined;
    if (presentation?.targetId && presentation.currentDetail && presentation.nextDetail) {
      const sourceBounds = semanticBounds(liveScene, presentation.targetId, presentation.currentDetail);
      const targetBounds = semanticBounds(liveScene, presentation.targetId, presentation.nextDetail);
      if (sourceBounds && targetBounds) {
        morph = { sourceBounds, targetBounds, progress: presentation.progress, baselineProgress: semanticMorphBaselineRef.current };
      }
    }
    const renderedCamera = composeSemanticZoomCamera(sample.camera, morph);    const navigation = canonicalNavigationState({
      ...navigationRef.current,
      camera: renderedCamera,
      detail: nextSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(nextSession),
    }, navigationDefaults);
    navigationRef.current = navigation;
    historyControllerRef.current?.replace(navigation);
    renderedCameraRef.current = renderedCamera;
    publishSemanticRenderPacket(renderedCamera, liveScene, nextSession);
    return renderedCamera;
  }

  function semanticZoomControl(direction: 'inward' | 'outward') {
    const safeArea = measureCurrentMapSafeArea();
    const pointer = {
      x: safeArea.left + (viewport.width - safeArea.left - safeArea.right) / 2,
      y: safeArea.top + (viewport.height - safeArea.top - safeArea.bottom) / 2,
    };
    const liveCamera = cancelInspectorCameraFlight();
    const burstCamera = beginSemanticZoomBurst(liveCamera);
    const raw = {
      ...burstCamera,
      zoom: clampAtlasCameraZoom(liveCamera.zoom * (direction === 'inward' ? 1.2 : 1 / 1.2)),
    };
    const first = handleSemanticZoom({ camera: raw, renderedCamera: liveCamera, pointer, direction, gestureSettled: false, mobile: false });
    updateCamera(first);
    if (semanticControlTimerRef.current !== undefined) window.clearTimeout(semanticControlTimerRef.current);
    semanticControlTimerRef.current = window.setTimeout(() => {
      const settled = handleSemanticZoom({ camera: raw, renderedCamera: first, pointer, direction: 'none', gestureSettled: true, mobile: false });
      updateCamera(settled);
      settleCamera(settled);
      semanticControlTimerRef.current = undefined;
    }, 100);
  }

  function settleCamera(next: Camera) {
    const base = canonicalNavigationState({
      ...navigationRef.current,
      camera: next,
      detail: baseDetail,
      lensPath: semanticLensCanonicalPathIds(semanticLensSessionRef.current),
    }, navigationDefaults);
    historyControllerRef.current?.commitSettledCamera(next, base);
    prefetchCommittedBox(semanticLensSessionRef.current.settled.at(-1)?.targetId ?? selected.id);
    if (maybeScanZoomHandoff(next, updateCamera, scanZoomPointerRef.current)) return;
    // L3 wheel motion must keep the complete component peer layout available
    // for a later L3→L4 bridge. Pan is still allowed to refresh its resident
    // window; the interaction marker is set at the actual pan callback.
    if (scanViewportInteractionRef.current === 'zoom'
      && semanticLensSessionDetail(semanticLensSessionRef.current) === 'component') return;
    refreshViewportNeighborhood(next);
  }

  function flushNavigation(next: Camera) {
    historyControllerRef.current?.flush(canonicalNavigationState({
      ...navigationRef.current,
      camera: next,
      detail: baseDetail,
      lensPath: semanticLensCanonicalPathIds(semanticLensSessionRef.current),
    }, navigationDefaults));
  }

  function navigateCamera(next: Camera, mode: 'push' | 'replace' = 'push', interruptionReason = 'Adjusted the map view') {
    semanticRenderPacketRef.current = undefined;
    scanContainerMorphRef.current = undefined;
    const liveCamera = abortInspectorCameraFlight();
    interruptStory(interruptionReason, liveCamera);
    updateCamera(next);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      camera: next,
      detail: baseDetail,
    }, navigationDefaults), mode);
  }

  function inspectorTabFor(entity: SceneEntity, intent: 'auto' | 'source' | 'details' = 'auto') {
    return inspectorTabForEntity(inspectorCanShowSource(entity), intent);
  }

  function inspectorTabButtonRef(tab: InspectorTab) {
    if (tab === 'overview') return overviewTabRef;
    if (tab === 'source') return sourceTabRef;
    return detailsTabRef;
  }

  function detailListVisible<T>(key: string, items: T[]): T[] {
    return expandedDetailLists.has(key) ? items : items.slice(0, 5);
  }

  function toggleDetailList(key: string) {
    setExpandedDetailLists(current => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function selectInspectorTab(tab: InspectorTab, focus = true) {
    setInspectorAskActive(false);
    setInspectorTab(tab);
    setSafeAreaEpoch(epoch => epoch + 1);
    if (focus) window.setTimeout(() => inspectorTabButtonRef(tab).current?.focus({ preventScroll: true }), 0);
  }

  function navigateInspectorTabs(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs: (InspectorTab | 'ask')[] = ['overview', 'source', 'details', ...(!askHidden && !getActivePortableAtlas() ? ['ask' as const] : [])];
    const current = Math.max(0, tabs.indexOf(inspectorAskActive && askOpen ? 'ask' : inspectorTab));
    const next = event.key === 'Home'
      ? tabs[0]
      : event.key === 'End'
        ? tabs[tabs.length - 1]
        : event.key === 'ArrowRight'
          ? tabs[Math.min(tabs.length - 1, current + 1)]
          : tabs[Math.max(0, current - 1)];
    if (next === 'ask') openDockedAsk();
    else if (next) selectInspectorTab(next);
  }

  function reframeEntityAfterInspectorChange(entity: SceneEntity, force = false) {
    const generation = inspectorReframeGenerationRef.current + 1;
    inspectorReframeGenerationRef.current = generation;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (generation !== inspectorReframeGenerationRef.current) return;
      const canvas = document.querySelector<HTMLElement>('[data-testid="atlas-canvas"]');
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const nextViewport = { width: Math.max(1, canvasRect.width), height: Math.max(1, canvasRect.height) };
      const detail = semanticLensSessionDetail(semanticLensSessionRef.current);
      const bounds = semanticBounds(scene, entity.id, detail) ?? entity;
      const safeArea = measureCurrentMapSafeArea();
      const currentCamera = navigationRef.current.camera;
      const reframeCamera = force && entity.detail === 'code'
        ? { ...currentCamera, zoom: levels[3]!.zoom }
        : currentCamera;
      const plan = selectedEntityReframePlan({
        camera: reframeCamera,
        bounds,
        viewport: nextViewport,
        safeArea,
        forceCenter: force && entity.detail === 'code',
      });
      if (!plan.reframed && plan.camera === currentCamera) return;
      updateCamera(plan.camera);
      commitNavigation(canonicalNavigationState({
        ...navigationRef.current,
        camera: plan.camera,
        detail: baseDetail,
      }, navigationDefaults), 'replace');
    }));
  }

  function beginInspectorResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (window.innerWidth <= 900) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = detailsWidth;
    const move = (pointer: PointerEvent) => {
      setDetailsWidth(clampInspectorWidth(startWidth + startX - pointer.clientX, window.innerWidth));
      setSafeAreaEpoch(epoch => epoch + 1);
    };
    const finish = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      reframeEntityAfterInspectorChange(selected);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  }

  function resizeInspectorWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const amount = event.shiftKey ? 64 : 16;
    setDetailsWidth(current => clampInspectorWidth(current + (event.key === 'ArrowLeft' ? amount : -amount), window.innerWidth));
    setSafeAreaEpoch(epoch => epoch + 1);
    window.setTimeout(() => reframeEntityAfterInspectorChange(selected), 0);
  }

  function currentInspectorHistorySubject(): InspectorHistorySubject {
    const currentNavigation = navigationRef.current;
    const navigation = {
      camera: { ...currentNavigation.camera },
      ...(currentNavigation.detail ? { detail: currentNavigation.detail } : {}),
      ...(currentNavigation.lensPath?.length ? { lensPath: [...currentNavigation.lensPath] } : {}),
    };
    return pickedRelationId
      ? { kind: 'relation', relationId: pickedRelationId, ownerEntityId: selected.id, tab: 'details', navigation }
      : { kind: 'entity', entityId: selected.id, tab: inspectorTab, navigation };
  }

  function updateInspectorHistoryForNavigation(origin: 'external' | 'panel' | 'history' | 'preserve') {
    if (origin === 'panel') {
      const subject = currentInspectorHistorySubject();
      setInspectorHistory(current => pushInspectorHistory(current, subject));
    } else if (origin === 'external') {
      setInspectorHistory([]);
    }
  }

  function focusEntity(
    entity: SceneEntity,
    historyMode: 'push' | 'replace' = 'replace',
    cameraIntent: 'preserve' | 'frame' = 'preserve',
    inspectorIntent: 'auto' | 'source' | 'details' = 'auto',
    inspectorNavigation: 'external' | 'panel' | 'history' | 'preserve' = 'external',
  ) {
    cancelGestureSceneRequests();
    cancelAskMapShow(); // a user selection supersedes an in-flight Ask "Show on map"
    const liveCamera = abortInspectorCameraFlight();
    setExplicitInspectorSelection(true);
    updateInspectorHistoryForNavigation(inspectorNavigation);
    if (!mainDiagramActive) activateDiagramView(MAIN_DIAGRAM_SURFACE_ID);
    interruptStory(`Selected ${entity.name}`);
    setStorySelectionOverride(storyStep >= 0);
    inspectorSelectionRef.current = entity.id;
    setSelectedId(entity.id);
    setPickedRelationId(undefined);
    setDetailsOpen(true);
    const nextInspectorTab = inspectorIntent === 'auto' ? inspectorTab : inspectorTabFor(entity, inspectorIntent);
    const currentSession = semanticLensSessionRef.current;
    const nextSession = nextInspectorTab === 'source'
      ? semanticSourceSession(scene, currentSession, entity.id)
      : currentSession;
    if (nextSession !== currentSession) {
      semanticLensSessionRef.current = nextSession;
      semanticMorphStateRef.current = undefined;
      semanticMorphBaselineRef.current = 0;
      setSemanticLensSession(nextSession);
      activeLevelRef.current = semanticDetails.indexOf('code');
    }
    setInspectorTab(nextInspectorTab);
    setSafeAreaEpoch(epoch => epoch + 1);
    if (inspectorIntent === 'source' && nextInspectorTab === 'source') {
      window.setTimeout(() => sourceTabRef.current?.focus({ preventScroll: true }), 0);
    }
    setSearchOpen(false);
    setSearch('');
    const nextCamera = cameraIntent === 'frame'
      ? semanticSessionFrameCamera(scene, entity.id, currentSession, viewport, measureCurrentMapSafeArea())
        ?? frameEntities(scene, [entity.id], viewport)
        ?? liveCamera
      : liveCamera;
    if (nextCamera !== liveCamera) {
      // The explicit frame keeps its current semantic band. Any old ordinary
      // wheel morph has consumed a different raw camera, so restart that
      // bookkeeping on the next gesture; an owned retained bridge remains
      // intact and rebases itself in beginSemanticZoomBurst.
      semanticMorphStateRef.current = undefined;
      semanticMorphBaselineRef.current = 0;
      updateCamera(nextCamera);
    }
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      selectedId: entity.id,
      camera: nextCamera,
      detail: nextSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(nextSession),
    }, navigationDefaults), historyMode);
    setLiveMessage(inspectorAcceptedSummary(entity) ? `${entity.name} selected. ${inspectorAcceptedSummary(entity)}` : `${entity.name} selected.`);
    // Selection never moves the camera, even when the card sits off-screen or
    // behind the inspector: only an explicit camera intent ("Show on map",
    // "Open source", search framing) may reframe. See
    // docs/product/interaction-semantics.md ("Spatial continuity and drill-down").
    const explicitCameraIntent = cameraIntent === 'frame' || inspectorIntent === 'source';
    if (explicitCameraIntent) reframeEntityAfterInspectorChange(entity, nextInspectorTab === 'source');
    prefetchCommittedBox(entity.id);
  }

  function navigateInspectorHierarchy(entity: SceneEntity, hierarchyScene = scene) {
    const plan = semanticInspectorHierarchyPlan(
      hierarchyScene,
      entity.id,
      viewport,
      measureCurrentMapSafeArea(),
      semanticLensSessionRef.current,
      renderedCameraRef.current,
    );
    if (!plan) {
      setLiveMessage(`${entity.name} is not available in its canonical C4 level.`);
      return;
    }
    if (!inspectorCameraFlightControllerRef.current?.isActive()) updateInspectorHistoryForNavigation('panel');
    inspectorReframeGenerationRef.current += 1;
    interruptStory(`Opened ${entity.name} at ${plan.detail} detail`, renderedCameraRef.current);
    setStorySelectionOverride(storyStep >= 0);
    inspectorSelectionRef.current = entity.id;
    setExplicitInspectorSelection(true);
    setSelectedId(entity.id);
    setPickedRelationId(undefined);
    setInspectorTab(current => current);
    setDetailsOpen(true);
    setSafeAreaEpoch(epoch => epoch + 1);
    startInspectorCameraFlight({
      targetId: entity.id,
      targetSession: plan.session,
      targetCamera: plan.camera,
      navigation: canonicalNavigationState({
      ...navigationRef.current,
      selectedId: entity.id,
      camera: plan.camera,
      detail: plan.session.baseDetail,
      lensPath: semanticLensCanonicalPathIds(plan.session),
      }, navigationDefaults),
      historyMode: plan.historyMode,
    });
    setSearchOpen(false);
    setSearch('');
    setLiveMessage(`${entity.name} opened at its ${plan.detail} level.`);
  }

  function changeVisibility(next: 'all' | 'dim' | 'isolate') {
    setAskMapFocus(undefined); // an Ask "Show on map" set never outlives an explicit visibility change
    askMapReturnRef.current = undefined;
    cancelAskMapShow();
    if (next === visibilityMode) return;
    interruptStory(`Changed context visibility to ${next}`);
    if (next === 'isolate' && visibilityMode !== 'isolate') {
      isolationOriginRef.current = {
        camera: { ...camera },
        selectedId: selected.id,
        pickedRelationId,
        visibilityMode,
      };
    } else if (visibilityMode === 'isolate') {
      isolationOriginRef.current = undefined;
    }
    setVisibilityMode(next);
    const isolatedCount = isolatedEntityIds.length;
    setLiveMessage(next === 'dim'
      ? 'Other entities dimmed. They remain available for selection and keyboard navigation.'
      : next === 'isolate'
        ? `Showing ${isolatedCount} of ${scene.entities.length} entities in the focused context.`
        : 'Full architecture context restored.');
  }

  function restoreVisibility() {
    if (visibilityMode !== 'isolate') {
      changeVisibility('all');
      window.requestAnimationFrame(() => visibilityControlRef.current?.focus({ preventScroll: true }));
      return;
    }
    abortInspectorCameraFlight();
    interruptStory('Restored the full architecture context');
    const origin = isolationOriginRef.current;
    isolationOriginRef.current = undefined;
    if (!origin) {
      setVisibilityMode('all');
      setLiveMessage('Full architecture context restored.');
      window.requestAnimationFrame(() => visibilityControlRef.current?.focus({ preventScroll: true }));
      return;
    }
    setVisibilityMode(origin.visibilityMode);
    setInspectorHistory([]);
    setSelectedId(origin.selectedId);
    setPickedRelationId(origin.pickedRelationId);
    updateCamera(origin.camera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      selectedId: origin.selectedId,
      camera: origin.camera,
      detail: baseDetail,
    }, navigationDefaults), 'replace');
    const restored = scene.entities.find(entity => entity.id === origin.selectedId);
    setLiveMessage(`Full architecture context restored. ${restored?.name ?? origin.selectedId} selected.`);
    window.requestAnimationFrame(() => visibilityControlRef.current?.focus({ preventScroll: true }));
  }

  function composeScene(
    focusEntityId: string,
    previous?: AtlasScene,
    authoring?: ArchitectureAuthoringDocument,
    cameraOverride?: Camera,
    keepEntityIds?: readonly string[],
  ): AtlasScene {
    const imported = importedAtlasRef.current;
    if (imported) {
      const matchingAuthoring = authoring?.repositoryId === imported.snapshot.repositoryId ? authoring : undefined;
      return compileImportedMermaidScene(imported, previous, focusEntityId, matchingAuthoring);
    }
    // Scan snapshots are read-only; neighborhood cache is the CLA-66 prefetch.
    // Authoring is golden-only and must not bypass the cache (callers always pass present).
    // Camera tile window is pan/zoom-only (`cameraOverride` from settleCamera).
    // Open inside / level / story / prefetch compile the new focus with the
    // CLA-67 cap alone — L3 camera space is not L4 packed layout, so inheriting
    // the previous band's camera would omit the destination's children.
    if (scanFixture) {
      const { residency, cacheKey } = scanSceneRequest(focusEntityId, cameraOverride, keepEntityIds);
      const cached = readNeighborhoodScene(neighborhoodScenesRef.current, cacheKey);
      if (cached) return cached;
      const compiled = activeCreateScene(focusEntityId, previous, undefined, residency);
      retainNeighborhoodScene(neighborhoodScenesRef.current, cacheKey, cacheableNeighborhoodScene(compiled));
      return compiled;
    }
    return activeCreateScene(focusEntityId, previous, authoring);
  }

  function cancelGestureSceneRequests() {
    gestureSceneRequestRef.current.cancel();
    viewportSceneRequestRef.current.cancel();
    viewportRequestedTileRef.current = undefined;
    zoomHandoffGenerationRef.current++;
    zoomHandoffInflightRef.current = undefined;
  }

  function scanSceneRequest(focusEntityId: string, cameraOverride?: Camera, keepEntityIds?: readonly string[]) {
    const generation = scanFixture!.getSceneGeneration();
    if (!ownsNeighborhoodSceneCache(neighborhoodSceneGenerationRef.current, scanFixture, generation)) {
      neighborhoodScenesRef.current.clear();
      neighborhoodSceneGenerationRef.current = { fixture: scanFixture, generation };
    }
    const windowCamera = scanKeepsResidentL3Landmarks(activeSnapshot, focusEntityId) ? undefined : cameraOverride;
    const retainedEntityIds = [...new Set([
      ...(inspectorSelectionRef.current ? [inspectorSelectionRef.current] : []),
      ...(keepEntityIds ?? []),
    ])];
    return {
      residency: {
        ...(windowCamera ? { worldBounds: expandRectByTileRing(cameraWorldRect(windowCamera, viewport)) } : {}),
        keepEntityIds: retainedEntityIds.length ? retainedEntityIds : undefined,
      },
      cacheKey: [generation, focusEntityId,
        viewportNeighborhoodCacheKey(focusEntityId, windowCamera, windowCamera ? viewport : undefined),
        retainedEntityIds.join(','),
      ].join(':'),
    };
  }

  async function composeScanSceneAsync(focusEntityId: string, previous: AtlasScene, signal: AbortSignal, cameraOverride?: Camera, keepEntityIds?: readonly string[]) {
    const fixture = scanFixture!;
    return compileCurrentGeneration(() => fixture.getSceneGeneration(), async () => {
      const { residency, cacheKey } = scanSceneRequest(focusEntityId, cameraOverride, keepEntityIds);
      const cached = readNeighborhoodScene(neighborhoodScenesRef.current, cacheKey);
      if (cached) return cached;
      const generation = fixture.getSceneGeneration();
      const compiled = await fixture.createSceneAsync(focusEntityId, previous, residency, signal);
      if (signal.aborted || fixture !== scanFixture) throw new DOMException('Scene request superseded', 'AbortError');
      if (generation === fixture.getSceneGeneration()) retainNeighborhoodScene(neighborhoodScenesRef.current, cacheKey, cacheableNeighborhoodScene(compiled));
      return compiled;
    }, signal, (prepared, generation) => preparedSceneGenerationsRef.current.set(prepared, generation));
  }

  /** Recompile the current C4 neighborhood for the camera tile window. Not a full-graph compile. */
  function refreshViewportNeighborhood(next: Camera) {
    // Foreground band handoffs own selected compilation until publication finishes.
    if (!scanFixture || levelScenePreparationPending(levelCompileAbortRef.current) || zoomHandoffInflightRef.current) return;
    const containerMorph = scanContainerMorphRef.current;
    // The terminal L3 frame remains an endpoint of the reversible L2↔L3
    // bridge. A camera-tile refresh here can compile only the owner shell and
    // a small local window, replacing the bridge's complete peer layout while
    // leaving its old session and bounds behind. Keep that owned endpoint
    // resident until a later L4 handoff or explicit navigation relinquishes it.
    if (containerMorph && containerMorph.scene === sceneRef.current
      && scanContainerMorphOwnsSession(containerMorph, semanticLensSessionRef.current)) return;
    const detail = semanticLensSessionDetail(semanticLensSessionRef.current);
    const viewRootId = scanFixture.navigation.rootEntityId;
    const currentFocus = sceneRef.current.rootEntityId ?? viewRootId;
    const preferredId = inspectorSelectionRef.current ?? selected.id;
    const handoff = scanZoomCompileHandoff(
      sceneRef.current,
      activeSnapshot,
      preferredId,
      viewRootId,
      detail,
      currentFocus,
    );
    const compileFocus = handoff?.compileFocus ?? currentFocus;
    const fixture = scanFixture;
    const sourceScene = sceneRef.current;
    const sourceSession = semanticLensSessionRef.current;
    const selection = inspectorSelectionRef.current;
    const tileKey = scanSceneRequest(compileFocus, next).cacheKey;
    if (viewportRequestedTileRef.current === tileKey) return;
    viewportRequestedTileRef.current = tileKey;
    const request = viewportSceneRequestRef.current.begin();
    void composeScanSceneAsync(compileFocus, sourceScene, request.signal, next).then(prepared => {
      if (!request.owns() || !ownsScenePublication(
        { fixture, scene: sourceScene, session: sourceSession, selection },
        { fixture: scanFixture, scene: sceneRef.current, session: semanticLensSessionRef.current, selection: inspectorSelectionRef.current },
      ) || containerMorph !== scanContainerMorphRef.current || viewportRequestedTileRef.current !== tileKey) return;
      let nextScene = prepared;
      if (containerMorph && compileFocus === containerMorph.focusId) {
        nextScene = retainScanDetailMorphSource(containerMorph.sourceScene, nextScene, containerMorph.sourceDetail);
      }
      if (nextScene !== sourceScene) {
        if (scanWindowedCompileDropsPeerGraph(sourceScene, nextScene, compileFocus, detail)) return;
        if (containerMorph && compileFocus === containerMorph.focusId) containerMorph.scene = nextScene;
        sceneRef.current = nextScene;
        setScene(nextScene);
      }
    }).catch(error => {
      if (request.owns() && !(error instanceof DOMException && error.name === 'AbortError')) setLiveMessage('This map view could not be prepared. Try again.');
    }).finally(() => {
      if (request.owns()) viewportRequestedTileRef.current = undefined;
    });
  }

  /**
   * CLA-104/105/117/122: swap the scan neighborhood when continuous zoom crosses a band
   * the current scene did not compile (L2→L3 into the pointer container, including
   * fat shells with resident pills; L3→L4 stays inside that opened container). Mirrors Open inside's ensureNeighborhood +
   * compile-focus + setScene, without Fit or a history push. Hang-guard stays 2000.
   * CLA-107 still pre-places L3 pills; wheel re-roots rather than staying on them.
   */
  function applyScanZoomHandoff(
    handoff: { detail: SemanticDetail; compileFocus: string },
    liveCamera: Camera,
    preferredId: string,
    nextScene: AtlasScene,
  ): Camera {
    const liveScene = sceneRef.current;
    const currentSession = semanticLensSessionRef.current;
    const previousDetail = semanticLensSessionDetail(currentSession);
    const preferredIds = [
      preferredId,
      ...currentSession.settled.map(entry => entry.targetId).reverse(),
      navigationIdentityRef.current.rootEntityId,
    ];
    if ((handoff.detail === 'component' || handoff.detail === 'code')
      && !scanDeeperBandHasPeerCards(nextScene, handoff.compileFocus, handoff.detail)) {
      return liveCamera;
    }
    const containerMorph = !reduceMotion && handoff.detail === 'component'
      && liveScene.rootEntityId === scanFixture?.navigation.rootEntityId
      ? createScanContainerMorph(liveScene, nextScene, handoff.compileFocus, liveCamera.zoom)
      : !reduceMotion && handoff.detail === 'code'
        ? createScanDetailMorph(liveScene, nextScene, handoff.compileFocus, 'component', 'code', liveCamera.zoom, currentSession)
        : undefined;
    scanContainerMorphRef.current = containerMorph;
    if (containerMorph) {
      const initial = sampleScanContainerMorph(containerMorph, liveCamera.zoom);
      semanticLensSessionRef.current = initial.session;
      semanticMorphStateRef.current = undefined;
      semanticMorphBaselineRef.current = 0;
      setSemanticLensSession(initial.session);
      scanZoomAdoptRawRef.current = liveCamera;
      sceneRef.current = containerMorph.scene;
      setScene(containerMorph.scene);
      setNavigationIdentity(current => ({ ...current, rootEntityId: handoff.compileFocus }));
      commitNavigation({
        ...navigationRef.current,
        rootEntityId: handoff.compileFocus,
        camera: liveCamera,
        detail: initial.session.baseDetail,
        lensPath: semanticLensCanonicalPathIds(initial.session),
      }, 'replace');
      publishSemanticRenderPacket(liveCamera, containerMorph.scene, initial.session);
      return liveCamera;
    }
    const nextSession = semanticLevelSession(nextScene, handoff.detail, preferredIds);
    const previousAnchorId = currentSession.settled.at(-1)?.targetId
      ?? (semanticBounds(liveScene, preferredId, previousDetail) ? preferredId : navigationIdentityRef.current.rootEntityId);
    const targetAnchorId = nextSession.settled.at(-1)?.targetId
      ?? (semanticBounds(nextScene, preferredId, handoff.detail) ? preferredId : handoff.compileFocus);
    const previousBounds = semanticBounds(liveScene, previousAnchorId, previousDetail);
    const targetBounds = semanticBounds(nextScene, targetAnchorId, handoff.detail)
      ?? semanticBounds(nextScene, handoff.compileFocus, handoff.detail);
    semanticLensSessionRef.current = nextSession;
    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    setSemanticLensSession(nextSession);
    activeLevelRef.current = semanticDetails.indexOf(handoff.detail);
    const nextCamera = scanZoomHandoffCamera(
      liveCamera,
      nextScene,
      handoff.compileFocus,
      handoff.detail,
      viewport,
      measureCurrentMapSafeArea(),
      previousBounds,
      targetBounds,
    );
    scanZoomAdoptRawRef.current = nextCamera;
    sceneRef.current = nextScene;
    setScene(nextScene);
    setNavigationIdentity(current => ({ ...current, rootEntityId: handoff.compileFocus }));
    const navigation = canonicalNavigationState({
      ...navigationRef.current,
      rootEntityId: handoff.compileFocus,
      camera: nextCamera,
      detail: nextSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(nextSession),
    }, navigationDefaults);
    navigationRef.current = navigation;
    historyControllerRef.current?.replace(navigation);
    publishSemanticRenderPacket(nextCamera, nextScene, nextSession);
    return nextCamera;
  }

  /** True when a scan zoom-band swap was started (refresh waits for that swap). */
  function maybeScanZoomHandoff(
    camera: Camera,
    applyCamera: (next: Camera) => void,
    pointer?: LensPoint,
  ): boolean {
    if (!scanFixture || levelScenePreparationPending(levelCompileAbortRef.current)) return false;
    const containerMorph = scanContainerMorphRef.current;
    if (containerMorph && containerMorph.scene === sceneRef.current && containerMorph.progress < 1) return false;
    const currentDetail = semanticLensSessionDetail(semanticLensSessionRef.current);
    const previousLevel = semanticDetails.indexOf(currentDetail);
    const active = semanticLensSessionRef.current.active;
    const enteringContainer = active.phase !== 'idle' && active.currentDetail === 'container' && active.nextDetail === 'component';
    const zoomDetail = enteringContainer ? 'component' : semanticDetails[getLevel(camera.zoom, previousLevel)] ?? 'context';
    const viewRootId = scanFixture.navigation.rootEntityId;
    const currentCompileFocus = sceneRef.current.rootEntityId ?? viewRootId;
    const preferredId = scanZoomHandoffPreferredId(
      sceneRef.current,
      activeSnapshot,
      viewRootId,
      zoomDetail,
      currentCompileFocus,
      camera,
      viewport,
      pointer,
      currentDetail,
      enteringContainer ? active.targetId! : inspectorSelectionRef.current ?? selected.id,
    );
    const handoff = scanZoomCompileHandoff(
      sceneRef.current,
      activeSnapshot,
      preferredId,
      viewRootId,
      zoomDetail,
      currentCompileFocus,
    );
    if (!handoff) {
      if (zoomHandoffInflightRef.current) {
        gestureSceneRequestRef.current.cancel();
        zoomHandoffGenerationRef.current++;
        zoomHandoffInflightRef.current = undefined;
      }
      return false;
    }
    const inflight = zoomHandoffInflightRef.current;
    if (inflight && inflight.compileFocus === handoff.compileFocus && inflight.detail === handoff.detail) {
      return true;
    }
    viewportSceneRequestRef.current.cancel();
    viewportRequestedTileRef.current = undefined;
    const request = gestureSceneRequestRef.current.begin();
    const token = ++zoomHandoffGenerationRef.current;
    const fixture = scanFixture;
    const sourceScene = sceneRef.current;
    const sourceSession = semanticLensSessionRef.current;
    const selection = inspectorSelectionRef.current;
    const owns = () => request.owns() && token === zoomHandoffGenerationRef.current && ownsScenePublication(
      { fixture, scene: sourceScene, session: sourceSession, selection },
      { fixture: scanFixture, scene: sceneRef.current, session: semanticLensSessionRef.current, selection: inspectorSelectionRef.current },
    );
    zoomHandoffInflightRef.current = handoff;
    void fixture.ensureNeighborhood(handoff.compileFocus).then(async () => {
      if (!owns()) return;
      const prepared = await composeScanSceneAsync(handoff.compileFocus, sourceScene, request.signal);
      if (!owns()) return;
      const liveCamera = renderedCameraRef.current;
      const liveLevel = semanticDetails.indexOf(semanticLensSessionDetail(semanticLensSessionRef.current));
      const liveActive = semanticLensSessionRef.current.active;
      const liveDetail = liveActive.phase !== 'idle' && liveActive.currentDetail === 'container'
        && liveActive.nextDetail === 'component' && liveActive.targetId === preferredId
        ? 'component' : semanticDetails[getLevel(liveCamera.zoom, liveLevel)] ?? 'context';
      const livePreferredId = scanZoomHandoffPreferredId(
        sourceScene, activeSnapshot, viewRootId, liveDetail, sourceScene.rootEntityId ?? viewRootId,
        liveCamera, viewport, scanZoomPointerRef.current, semanticLensSessionDetail(sourceSession),
        liveActive.phase !== 'idle' && liveActive.currentDetail === 'container' && liveActive.nextDetail === 'component'
          ? liveActive.targetId! : inspectorSelectionRef.current ?? selected.id,
      );
      const still = scanZoomCompileHandoff(sourceScene, activeSnapshot, livePreferredId, viewRootId, liveDetail, sourceScene.rootEntityId ?? viewRootId);
      if (!still || still.compileFocus !== handoff.compileFocus || still.detail !== handoff.detail) return;
      applyCamera(applyScanZoomHandoff(still, liveCamera, livePreferredId, prepared));
    }).catch(error => {
      if (owns() && !(error instanceof DOMException && error.name === 'AbortError')) setLiveMessage('This detail level could not be prepared. Try again.');
    }).finally(() => {
      if (token === zoomHandoffGenerationRef.current) zoomHandoffInflightRef.current = undefined;
    });
    return true;
  }

  /** Fetch the next-band neighborhood without compiling or changing the visible scene (CLA-11). */
  function prefetchCommittedBox(entityId: string | undefined) {
    const fixture = scanFixture;
    if (!fixture || !entityId) return;
    void fixture.ensureNeighborhood(entityId).then(async () => {
      if (fixture !== scanFixture) return;
      for (const focusId of scanPrefetchFocusIds(activeSnapshot, [entityId])) {
        await fixture.ensureNeighborhood(focusId);
        if (fixture !== scanFixture) return;
      }
    }).catch(() => { /* Fetch-only prefetch never competes for selected compile CPU. */ });
  }

  function revealOmittedEntity(entity: SceneEntity) {
    cancelGestureSceneRequests();
    inspectorSelectionRef.current = entity.id;
    if (scanFixture) {
      const compileFocus = scanCompileFocusForBand(
        activeSnapshot,
        entity.id,
        semanticLensSessionRef.current.baseDetail,
        scanFixture.navigation.rootEntityId,
      );
      setScene(composeScene(compileFocus, scene, authoringHistoryRef.current.present));
    }
    focusEntity(entity, 'replace', 'preserve', 'auto', 'panel');
  }

  function authoredScene(document: ArchitectureAuthoringDocument, currentScene: AtlasScene) {
    return composeScene(navigationIdentity.rootEntityId, currentScene, document);
  }

  function installAuthoringHistory(
    next: GestureHistory<ArchitectureAuthoringDocument>,
    message: string,
  ) {
    if (next === authoringHistoryRef.current) return;
    authoringHistoryRef.current = next;
    setAuthoringHistory(next);
    setScene(currentScene => authoredScene(next.present, currentScene));
    setLiveMessage(message);
  }

  function commitAuthoringCommands(
    commands: readonly ArchitectureAuthoringCommand[],
    message: string,
  ) {
    let document = authoringHistoryRef.current.present;
    for (const command of commands) {
      document = applyArchitectureAuthoringCommand(document, command).document;
    }
    installAuthoringHistory(commitGesture(authoringHistoryRef.current, document), message);
  }

  function changeInteractionMode(next: 'view' | 'edit') {
    setInteractionMode(next);
    if (next === 'view') setAuthoringTool('select');
    setLiveMessage(next === 'edit'
      ? 'Edit mode enabled. Relationship authoring tools are available.'
      : 'View mode enabled. Architecture inspection remains available; authoring controls are hidden.');
  }

  function createRelationship(gesture: {
    from: string;
    to: string;
    sourcePort: ConnectionPort;
    targetPort: ConnectionPort;
    routePoints: AuthoringPoint[];
  }) {
    if (!editingEnabled) return;
    const source = scene.entities.find(entity => entity.id === gesture.from);
    const target = scene.entities.find(entity => entity.id === gesture.to);
    if (!source || !target || source.id === target.id) return;
    let relationId: string;
    do {
      relationId = `relation:user:${authoredRelationSequenceRef.current++}`;
    } while (scene.relations.some(relation => relation.id === relationId));
    const scope = {
      viewId: authoringViewId,
      detail: activeDetail,
      relationId,
    };
    const override: RelationRouteOverride = {
      ...scope,
      id: relationRouteOverrideId(scope),
      intent: {
        sourcePort: gesture.sourcePort,
        targetPort: gesture.targetPort,
        waypoints: [],
      },
    };
    commitAuthoringCommands([
      {
        type: 'put-relation',
        relation: {
          id: relationId,
          from: source.id,
          to: target.id,
          kind: 'uses',
          label: 'Uses',
        },
      },
      { type: 'put-route-override', override },
    ], `Relationship created from ${source.name} to ${target.name}.`);
    setInspectorHistory([]);
    setPickedRelationId(relationId);
    setAuthoringTool('select');
  }

  function guideRelationship(gesture: {
    relationId: string;
    visualRelationId: string;
    detail: SemanticDetail;
    intent: GuidedRelationshipRouteIntent;
  }) {
    if (!editingEnabled) return;
    const document = authoringHistoryRef.current.present;
    const existing = document.routeOverrides.find(override => override.viewId === authoringViewId
      && override.detail === gesture.detail
      && override.relationId === gesture.relationId);
    const projected = scene.projection?.projectedRelationsByDetail[gesture.detail]
      .find(relation => relation.id === gesture.visualRelationId);
    const scope = existing
      ? {
          viewId: existing.viewId,
          detail: existing.detail,
          relationId: existing.relationId,
          ...(existing.visualEdgeId ? { visualEdgeId: existing.visualEdgeId } : {}),
        }
      : {
          viewId: authoringViewId,
          detail: gesture.detail,
          relationId: gesture.relationId,
          visualEdgeId: projected?.id ?? gesture.visualRelationId,
        };
    const override: RelationRouteOverride = {
      ...scope,
      id: existing?.id ?? relationRouteOverrideId(scope),
      intent: gesture.intent,
    };
    commitAuthoringCommands(
      [{ type: 'put-route-override', override }],
      'Relationship route guide applied.',
    );
  }

  function resetSelectedRelationshipRoute() {
    if (!editingEnabled || !pickedRelationId) return;
    const override = authoringHistoryRef.current.present.routeOverrides.find(candidate =>
      candidate.viewId === authoringViewId
      && candidate.detail === selectedAuthoringDetail
      && candidate.relationId === pickedRelationId);
    if (!override) return;
    commitAuthoringCommands(
      [{ type: 'reset-route-override', overrideId: override.id }],
      'Relationship route reset to automatic routing.',
    );
  }

  function deleteSelectedRelationship() {
    if (!editingEnabled || !pickedRelationId || !scene.relations.some(relation => relation.id === pickedRelationId)) return;
    const relation = scene.relations.find(candidate => candidate.id === pickedRelationId)!;
    commitAuthoringCommands(
      [{ type: 'delete-relation', relationId: pickedRelationId }],
      `Deleted ${relation.label ?? relation.kindLabel ?? 'selected'} relationship.`,
    );
    setInspectorHistory([]);
    setPickedRelationId(undefined);
  }

  function undoAuthoringGesture() {
    if (!editingEnabled) return;
    const next = undoGesture(authoringHistoryRef.current);
    if (next === authoringHistoryRef.current) return;
    if (pickedRelationId?.startsWith('relation:user:')
      && !next.present.relations.some(relation => relation.id === pickedRelationId)) {
      setPickedRelationId(undefined);
    }
    installAuthoringHistory(next, 'Undid relationship edit.');
  }

  function redoAuthoringGesture() {
    if (!editingEnabled) return;
    installAuthoringHistory(redoGesture(authoringHistoryRef.current), 'Redid relationship edit.');
  }

  /**
   * Frames a selected relationship's flow: a camera flight to a scope that contains BOTH
   * endpoints. Siblings inside the same component get a gentle local frame (may zoom in);
   * endpoints in diverging containers zoom OUT to the scope that contains both, showcasing
   * the path (direction derived from the endpoints' containment distance). Deferred past the
   * inspector panel opening so the measured safe area/viewport reflect the settled layout,
   * then driven through the shared inspector camera flight (same easing + cancel/history
   * wiring as parent-level and inspector-history navigation; an unchanged lens session makes
   * it a pure camera move). Falls back to the plain owner reframe when either endpoint has
   * no resolvable bounds.
   */
  function frameSelectedRelationFlow(relation: SceneRelation, _fallbackOwner: SceneEntity) {
    cancelGestureSceneRequests();
    const generation = inspectorReframeGenerationRef.current + 1;
    inspectorReframeGenerationRef.current = generation;
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (generation !== inspectorReframeGenerationRef.current) return;
      const canvas = document.querySelector<HTMLElement>('[data-testid="atlas-canvas"]');
      if (!canvas) return;
      const canvasRect = canvas.getBoundingClientRect();
      const nextViewport = { width: Math.max(1, canvasRect.width), height: Math.max(1, canvasRect.height) };
      const plan = resolveRelationshipReveal({
        snapshot: activeSnapshot,
        scene,
        relationId: relation.id,
        session: semanticLensSessionRef.current,
        viewport: nextViewport,
        safeArea: measureCurrentMapSafeArea(),
        compileScope: focusId => composeScene(focusId, scene, authoringHistoryRef.current.present),
      });
      if (plan.status === 'unavailable') {
        setLiveMessage(plan.reason);
        return;
      }
      setVisibilityMode('all');
      if (plan.scene !== scene) setScene(plan.scene.entities.some(entity => entity.id === selected.id) ? plan.scene : { ...plan.scene, entities: [...plan.scene.entities, selected] });
      if (plan.representation === 'aggregate') setLiveMessage('Showing the aggregate map representation that contains this relationship.');
      startInspectorCameraFlight({
        targetId: selected.id,
        targetSession: plan.session,
        targetCamera: plan.framing.camera,
        navigation: navigationRef.current,
        historyMode: 'replace',
      });
    }));
  }

  function inspectRelation(
    relation: SceneRelation,
    inspectorNavigation: 'external' | 'panel' | 'history' | 'preserve' = 'external', cameraIntent: 'preserve' | 'frame' = 'frame',
  ) {
    abortInspectorCameraFlight();
    updateInspectorHistoryForNavigation(inspectorNavigation);
    const relationName = relation.label ?? relation.kindLabel ?? 'relationship';
    const from = scene.entities.find(entity => entity.id === relation.from);
    const to = scene.entities.find(entity => entity.id === relation.to);
    const owner = selected.id === relation.from || selected.id === relation.to ? selected : from ?? to ?? selected;
    interruptStory(`Selected ${relationName}`);
    setStorySelectionOverride(storyStep >= 0);
    setPickedRelationId(relation.id);
    setInspectorTab('details');
    setDetailsOpen(true);
    setSafeAreaEpoch(epoch => epoch + 1);
    if (cameraIntent === 'frame') frameSelectedRelationFlow(relation, owner); else inspectorReframeGenerationRef.current += 1;
    const endpoints = from && to ? ` from ${from.name} to ${to.name}` : '';
    setLiveMessage(`${relationName} relationship selected${endpoints}.`);
  }

  function restoreInspectorHistoryNavigation(subject: InspectorHistorySubject) {
    inspectorReframeGenerationRef.current += 1;
    const plan = inspectorHistoryRestorePlan(navigationRef.current, subject);
    const restoredBaseDetail = plan.state.detail ?? semanticLensSessionRef.current.baseDetail;
    const restoredLens = validateRestoredSemanticLensPath(
      scene,
      restoredBaseDetail,
      plan.state.lensPath ?? [],
      plan.state.camera.zoom,
    );
    const restoredSession: SemanticLensSession = {
      baseDetail: restoredBaseDetail,
      settled: restoredLens.entries,
      active: idleSemanticLens(),
    };
    startInspectorCameraFlight({
      targetId: subject.kind === 'entity' ? subject.entityId : subject.ownerEntityId,
      targetSession: restoredSession,
      targetCamera: plan.state.camera,
      navigation: canonicalNavigationState({
        ...plan.state,
        detail: restoredSession.baseDetail,
        lensPath: semanticLensCanonicalPathIds(restoredSession),
      }, navigationDefaults),
      historyMode: plan.mode,
    });
  }

  function navigateInspectorBack() {
    const popped = popInspectorHistory(inspectorHistory);
    const subject = popped.subject;
    if (!subject) return;
    setInspectorHistory(popped.history);
    if (!popped.history.length) {
      const restoredTab = subject.kind === 'entity' ? subject.tab : 'details';
      window.setTimeout(() => inspectorTabButtonRef(restoredTab).current?.focus({ preventScroll: true }), 0);
    }
    if (subject.kind === 'entity') {
      const entity = scene.entities.find(candidate => candidate.id === subject.entityId);
      if (!entity) {
        setInspectorHistory([]);
        setLiveMessage('The previous inspector entity is no longer available.');
        return;
      }
      interruptStory(`Returned to ${entity.name}`, renderedCameraRef.current);
      setStorySelectionOverride(storyStep >= 0);
      inspectorSelectionRef.current = entity.id;
      setSelectedId(entity.id);
      setPickedRelationId(undefined);
      setInspectorTab(subject.tab);
      setDetailsOpen(true);
      setSafeAreaEpoch(epoch => epoch + 1);
      restoreInspectorHistoryNavigation(subject);
      setLiveMessage(`${entity.name} restored in the details panel.`);
      return;
    }
    const relation = scene.relations.find(candidate => candidate.id === subject.relationId);
    const owner = scene.entities.find(candidate => candidate.id === subject.ownerEntityId);
    if (!relation || !owner) {
      setInspectorHistory([]);
      setLiveMessage('The previous inspector relationship is no longer available.');
      return;
    }
    const relationName = relation.label ?? relation.kindLabel ?? 'relationship';
    interruptStory(`Returned to ${relationName}`, renderedCameraRef.current);
    setStorySelectionOverride(storyStep >= 0);
    inspectorSelectionRef.current = owner.id;
    setSelectedId(owner.id);
    setPickedRelationId(relation.id);
    setInspectorTab('details');
    setDetailsOpen(true);
    setSafeAreaEpoch(epoch => epoch + 1);
    restoreInspectorHistoryNavigation(subject);
    setLiveMessage(`${relationName} relationship restored in the details panel.`);
  }

  function handlePick(result: PickResult) {
    cancelAskMapShow();
    if (result.kind === 'entity') {
      const entity = scene.entities.find(candidate => candidate.id === result.id);
      if (entity) focusEntity(entity, 'replace', 'preserve', 'auto');
      else setLiveMessage(`The renderer returned unknown entity ${result.id}.`);
      return;
    }

    const relation = scene.relations.find(candidate => candidate.id === result.id);
    if (!relation) {
      setLiveMessage(`The renderer returned unknown relation ${result.id}.`);
      return;
    }
    inspectRelation(relation);
  }

  function closeDetails() {
    inspectorNeighborhoodRequest.current.cancel();
    // Move focus before the next render applies aria-hidden. This avoids hiding
    // the currently focused close/action control from assistive technology.
    detailsOpenerRef.current?.focus({ preventScroll: true });
    setDetailsOpen(false);
    setSafeAreaEpoch(epoch => epoch + 1);
    setLiveMessage('Inspector closed. Focus returned to the inspector button.');
  }

  function toggleDetails() {
    cancelAskMapShow(); // never close an inspector the user just toggled
    if (detailsOpen) closeDetails();
    else {
      setDetailsOpen(true);
      setInspectorTab(inspectorTabFor(selected));
      setSafeAreaEpoch(epoch => epoch + 1);
      window.setTimeout(() => reframeEntityAfterInspectorChange(selected), 0);
      setLiveMessage(`${selected.name} inspector opened.`);
    }
  }

  function selectLevel(index: number) {
    cancelGestureSceneRequests();
    levelCompileAbortRef.current?.abort();
    initialEnrichmentAbortRef.current?.abort();
    setInitialDetailLoading(false);
    const fixture = scanFixture;
    if (fixture) {
      const controller = new AbortController();
      levelCompileAbortRef.current = controller;
      controller.signal.addEventListener('abort', () => clearLevelScenePreparation(levelCompileAbortRef, controller, setLiveMessage), { once: true });
      const initialScene = sceneRef.current;
      const initialSelection = inspectorSelectionRef.current;
      setLiveMessage(LEVEL_SCENE_PREPARING);
      const detail = semanticDetails[index];
      const preferredId = selected.id;
      const initialFocus = scanCompileFocusForBand(
        activeSnapshot,
        preferredId,
        detail,
        fixture.navigation.rootEntityId,
      );
      void prepareLevelSceneWithDeadline(controller, () => prepareLoadedLevelScene({
        signal: controller.signal,
        initialFocus,
        ensure: focus => fixture.ensureNeighborhood(focus),
        recomputeFocus: () => scanCompileFocusForBand(activeSnapshot, preferredId, detail, fixture.navigation.rootEntityId),
        owns: () => fixture === scanFixture && initialScene === sceneRef.current && initialSelection === inspectorSelectionRef.current,
        compile: async () => {
          const viewRootId = fixture.navigation.rootEntityId;
          const currentFocus = initialScene.rootEntityId ?? viewRootId;
          const handoff = scanZoomCompileHandoff(initialScene, activeSnapshot, initialSelection, viewRootId, detail, currentFocus);
          const compileFocus = handoff?.compileFocus ?? currentFocus;
          return composeScanSceneAsync(compileFocus, initialScene, controller.signal, undefined, initialSelection ? [initialSelection] : undefined);
        },
        isPreparedCurrent: prepared => preparedSceneGenerationsRef.current.get(prepared) === fixture.getSceneGeneration(),
        publish: prepared => selectLevelLoaded(index, prepared),
      }), () => {
        if (levelCompileAbortRef.current === controller) setLiveMessage('Detail level preparation timed out. Choose a level to try again.');
      }).catch(() => {
        if (levelCompileAbortRef.current === controller && !controller.signal.aborted) setLiveMessage('This detail level could not be prepared. Try again.');
      }).finally(() => {
        clearLevelScenePreparation(levelCompileAbortRef, controller, setLiveMessage);
      });
      return;
    }
    selectLevelLoaded(index);
  }

  function selectLevelLoaded(index: number, preparedScene?: AtlasScene) {
    const liveCamera = abortInspectorCameraFlight();
    const level = levels[index];
    const detail = semanticDetails[index];
    const currentSession = semanticLensSessionRef.current;
    const previousDetail = semanticLensSessionDetail(currentSession);
    const preferredIds = [selected.id, ...currentSession.settled.map(entry => entry.targetId).reverse(), navigationIdentity.rootEntityId];
    const viewRootId = scanFixture?.navigation.rootEntityId ?? navigationIdentity.rootEntityId;
    const currentFocus = scene.rootEntityId ?? viewRootId;
    const handoff = scanFixture
      ? scanZoomCompileHandoff(scene, activeSnapshot, selected.id, viewRootId, detail, currentFocus)
      : undefined;
    const compileFocus = scanFixture
      ? (handoff?.compileFocus ?? currentFocus)
      : navigationIdentity.rootEntityId;
    const levelScene = preparedScene ?? (scanFixture ? composeScene(compileFocus, scene, authoringHistoryRef.current.present) : scene);
    if (levelScene !== scene) {
      setScene(levelScene);
      setNavigationIdentity(current => ({ ...current, rootEntityId: compileFocus }));
    }
    const nextSession = semanticLevelSession(levelScene, detail, preferredIds);
    const previousAnchorId = currentSession.settled.at(-1)?.targetId
      ?? (semanticBounds(scene, selected.id, previousDetail) ? selected.id : navigationIdentity.rootEntityId);
    const targetAnchorId = nextSession.settled.at(-1)?.targetId
      ?? (semanticBounds(levelScene, selected.id, detail) ? selected.id : compileFocus);
    const previousBounds = semanticBounds(scene, previousAnchorId, previousDetail);
    const targetBounds = semanticBounds(levelScene, targetAnchorId, detail)
      ?? semanticBounds(levelScene, compileFocus, detail)
      ?? selected;
    semanticLensSessionRef.current = nextSession;
    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    setSemanticLensSession(nextSession);
    activeLevelRef.current = index;
    const anchored = retargetCameraForSemanticBand(liveCamera, previousBounds, targetBounds, level.zoom, viewport);
    const mapSafeArea = measureCurrentMapSafeArea();
    const framedCamera = index === 0 && !scopeFitsSafeViewport(
      levelScene,
      compileFocus,
      detail,
      anchored,
      viewport,
      mapSafeArea,
    )
      ? frameProjectionScope(levelScene, compileFocus, detail, viewport, mapSafeArea) ?? anchored
      : anchored;
    const nextCamera = scanFixture && index === 0 ? framedCamera : containSemanticOwnerCamera(framedCamera, targetBounds, viewport, mapSafeArea);
    interruptStory(`Changed to ${level.name} detail`);
    updateCamera(nextCamera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      rootEntityId: compileFocus,
      camera: nextCamera,
      detail: nextSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(nextSession),
    }, navigationDefaults), 'replace');
    setLiveMessage(`${level.name} detail level selected.`);
  }

  function openInside(entityId = selected.id, inspectorNavigation: 'external' | 'preserve' = 'external') {
    cancelGestureSceneRequests();
    if (scanFixture) {
      void scanFixture.ensureNeighborhood(entityId).then(() => openInsideLoaded(entityId, inspectorNavigation));
      return;
    }
    openInsideLoaded(entityId, inspectorNavigation);
  }

  function openInsideLoaded(
    entityId = selected.id,
    inspectorNavigation: 'external' | 'preserve' = 'external',
    codeChildId?: string,
  ) {
    const liveCamera = abortInspectorCameraFlight();
    updateInspectorHistoryForNavigation(inspectorNavigation);
    if (query.fixture === 'stress') return;
    const target = scene.entities.find(entity => entity.id === entityId) ?? selected;
    if (target.detail === 'code') {
      focusEntity(target, 'replace', 'preserve', 'source', 'history');
      setLiveMessage(target.sourceExcerpts?.length
        ? `${target.name} source opened at its frozen evidence range.`
        : `${target.name} has no portable frozen source excerpt.`);
      return;
    }
    // Scan scoped compile (CLA-66): the current scene carries only the current
    // band + one-down prefetch, so a deeper neighborhood is absent and a lens
    // drill would dead-end. Re-enter the guarded compile seam for the target
    // scope (snapshot children, not the compiled scene). Inspector-history mode
    // was already applied above, so 'preserve' survives.
    const drillDetail = scanFixture ? scanDrillDeeperDetail(scene, target, activeSnapshot) : undefined;
    // CLA-83: Open inside a scan *system* must compile the L2 container peer map at
    // the view root. Resident CLA-81 shells already publish container bounds, so the
    // lens drill can "succeed" without a sibling package map (or skip to a child
    // neighborhood). Force the container-band compile whenever the target is a
    // context owner with children.
    const forceContainerBand = scanFixture
      && (target.detail === 'context' || target.kind === 'system')
      && scanEntityHasChildren(activeSnapshot, target.id)
      ? 'container' as const
      : undefined;
    const lensPlan = (!drillDetail && !forceContainerBand)
      ? semanticOpenNextLayer(
        scene,
        semanticLensSessionRef.current,
        target.id,
        viewport,
        measureCurrentMapSafeArea(),
        navigationIdentity.rootEntityId,
      )
      : undefined;
    // Reserved owner shells can still fail the lens on L2/L3 targets that have
    // snapshot children. Fall through to the neighborhood compile for the next band.
    const fallbackDetail = !drillDetail && !forceContainerBand && !lensPlan && scanFixture
      && scanEntityHasChildren(activeSnapshot, target.id)
      ? scanNextBand(target.detail ?? 'context')
      : undefined;
    const deeperDetail = forceContainerBand ?? drillDetail ?? fallbackDetail;
    if (deeperDetail && scanFixture) {
      // Neighborhood compile (CLA-66) then land on the deeper band. Cancelling the
      // lens first reset data-detail to context (CLA-80); the Components rail
      // recovered via semanticLevelSession. Open inside must do that landing itself.
      interruptStory(`Opened ${target.name}`);
      const currentSession = semanticLensSessionRef.current;
      const previousDetail = semanticLensSessionDetail(currentSession);
      const preferredIds = [target.id, ...currentSession.settled.map(entry => entry.targetId).reverse(), navigationIdentity.rootEntityId];
      const compileFocus = scanCompileFocusForBand(
        activeSnapshot,
        target.id,
        deeperDetail,
        scanFixture.navigation.rootEntityId,
      );
      // A code declaration can be outside the L4 page cap. Pin it before the
      // scoped compile, rather than relying on the previous inspector selection.
      const nextScene = composeScene(
        compileFocus,
        scene,
        authoringHistoryRef.current.present,
        undefined,
        codeChildId ? [codeChildId] : undefined,
      );
      const nextSession = semanticLevelSession(nextScene, deeperDetail, preferredIds);
      const previousAnchorId = currentSession.settled.at(-1)?.targetId
        ?? (semanticBounds(scene, target.id, previousDetail) ? target.id : navigationIdentity.rootEntityId);
      const targetAnchorId = nextSession.settled.at(-1)?.targetId
        ?? (semanticBounds(nextScene, target.id, deeperDetail) ? target.id : compileFocus);
      const previousBounds = semanticBounds(scene, previousAnchorId, previousDetail);
      const targetBounds = semanticBounds(nextScene, targetAnchorId, deeperDetail)
        ?? semanticBounds(nextScene, compileFocus, deeperDetail)
        ?? target;
      semanticLensSessionRef.current = nextSession;
      semanticMorphStateRef.current = undefined;
      semanticMorphBaselineRef.current = 0;
      setSemanticLensSession(nextSession);
      activeLevelRef.current = semanticDetails.indexOf(deeperDetail);
      const mapSafeArea = measureCurrentMapSafeArea();
      const anchored = retargetCameraForSemanticBand(
        liveCamera,
        previousBounds,
        targetBounds,
        levels[semanticDetails.indexOf(deeperDetail)]!.zoom,
        viewport,
      );
      const framedCamera = frameProjectionScope(nextScene, compileFocus, deeperDetail, viewport, mapSafeArea) ?? anchored;
      const nextCamera = deeperDetail === 'container' || deeperDetail === 'component' || deeperDetail === 'code' ? framedCamera : containSemanticOwnerCamera(framedCamera, targetBounds, viewport, mapSafeArea);
      const codeChild = codeChildId
        ? nextScene.entities.find(entity => entity.id === codeChildId && entity.detail === 'code')
        : undefined;
      const destination = codeChild ?? target;
      setScene({ ...nextScene, scanDrillRecompile: { targetId: target.id, deeperDetail } });
      inspectorSelectionRef.current = destination.id;
      setExplicitInspectorSelection(true);
      setPickedRelationId(undefined);
      setDetailsOpen(true);
      setSelectedId(destination.id);
      if (codeChild) {
        setInspectorTab(inspectorTabFor(codeChild, 'source'));
        setSafeAreaEpoch(epoch => epoch + 1);
        window.setTimeout(() => sourceTabRef.current?.focus({ preventScroll: true }), 0);
      }
      setNavigationIdentity(current => ({ ...current, rootEntityId: compileFocus }));
      updateCamera(nextCamera);
      commitNavigation(canonicalNavigationState({
        ...navigationRef.current,
        rootEntityId: compileFocus,
        selectedId: destination.id,
        camera: nextCamera,
        detail: nextSession.baseDetail,
        lensPath: semanticLensCanonicalPathIds(nextSession),
      }, navigationDefaults), 'push');
      setLiveMessage(`${destination.name} opened. ${levels[semanticDetails.indexOf(deeperDetail)]?.name ?? deeperDetail} detail is now in focus.`);
      return;
    }
    const plan = lensPlan;
    if (!plan) {
      setLiveMessage(target.source
        ? `Source viewer is not connected. Evidence path: ${target.source}.`
        : `${target.name} has no deeper curated scope.`);
      return;
    }
    interruptStory(`Opened ${target.name}`);
    setSelectedId(target.id);
    semanticLensSessionRef.current = plan.session;
    semanticMorphStateRef.current = undefined;
    semanticMorphBaselineRef.current = 0;
    setSemanticLensSession(plan.session);
    if (plan.session.focusTransfer) animateSemanticFocusTransfer(plan.session.focusTransfer.targetId);
    activeLevelRef.current = semanticDetails.indexOf(plan.nextDetail);
    updateCamera(plan.camera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      rootEntityId: plan.rootEntityId,
      selectedId: target.id,
      camera: plan.camera,
      detail: plan.session.baseDetail,
      lensPath: semanticLensCanonicalPathIds(plan.session),
    }, navigationDefaults), plan.historyMode);
    setLiveMessage(`${target.name} opened. ${levels[semanticDetails.indexOf(plan.nextDetail)].name} detail is now in focus.`);
  }

  function navigateRoot(entityId: string) {
    cancelGestureSceneRequests();
    if (query.fixture === 'stress' || entityId === navigationIdentity.rootEntityId) return;
    const liveCamera = abortInspectorCameraFlight();
    setInspectorHistory([]);
    cancelSemanticLensAt('breadcrumb navigation', liveCamera);
    const target = scene.entities.find(entity => entity.id === entityId);
    if (!target) return;
    interruptStory(`Returned to ${target.name}`);
    const nextScene = composeScene(target.id, scene, authoringHistoryRef.current.present);
    const nextCamera = frameProjectionScope(nextScene, target.id, baseDetail, viewport, measureCurrentMapSafeArea())
      ?? (() => {
        const bounds = semanticBounds(nextScene, target.id, baseDetail) ?? target;
        return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, zoom: levels[activeLevel].zoom };
      })();
    setScene(nextScene);
    setSelectedId(target.id);
    setNavigationIdentity(current => ({ ...current, rootEntityId: target.id }));
    updateCamera(nextCamera);
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      rootEntityId: target.id,
      selectedId: target.id,
      camera: nextCamera,
      detail: baseDetail,
    }, navigationDefaults), 'push');
    setLiveMessage(`${target.name} is now the map root.`);
  }

  function measureCurrentStorySafeArea() {
    const canvas = document.querySelector<HTMLElement>('[data-testid="atlas-canvas"]');
    if (!canvas) return storySafeArea(viewport);
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const player = rect('.story-player');
    const canvasRect = canvas.getBoundingClientRect();
    const overlays = [
      { rect: rect('.topbar'), edge: 'top' as const },
      { rect: rect('.render-status'), edge: 'bottom' as const },
      { rect: detailsOpen ? rect('.details-panel.open') : undefined, edge: 'right' as const },
      { rect: player, edge: 'bottom' as const },
      { rect: rect('.zoom-controls'), edge: 'bottom' as const },
      { rect: rect('.canvas-hint'), edge: 'bottom' as const },
      { rect: rect('.level-rail'), edge: 'left' as const },
    ].filter((overlay): overlay is { rect: DOMRect; edge: 'top' | 'right' | 'bottom' | 'left' } => overlay.rect !== undefined);
    const visual = window.visualViewport;
    const measured = measuredStorySafeArea(viewport, {
      canvas: canvasRect,
      overlays,
      ...(visual ? {
        visualViewport: {
          offsetTop: visual.offsetTop,
          offsetLeft: visual.offsetLeft,
          width: visual.width,
          height: visual.height,
        },
      } : {}),
      safeInsets: browserSafeAreaInsets(),
    });
    const safe = player ? measured : {
      ...measured,
      bottom: Math.max(measured.bottom, storySafeArea(viewport).bottom),
    };
    setMeasuredSafeArea(safe);
    return safe;
  }

  function measureCurrentMapSafeArea() {
    const canvas = document.querySelector<HTMLElement>('[data-testid="atlas-canvas"]');
    if (!canvas) return { top: 0, right: 0, bottom: 0, left: 0 };
    const rect = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const overlays = [
      { rect: rect('.topbar'), edge: 'top' as const },
      { rect: rect('.map-heading'), edge: 'top' as const },
      { rect: detailsOpen ? rect('.details-panel.open') : undefined, edge: 'right' as const },
      { rect: rect('.details-toggle'), edge: 'right' as const },
      { rect: rect('.zoom-controls'), edge: 'bottom' as const },
      { rect: rect('.story-launcher'), edge: 'bottom' as const },
      { rect: rect('.ask-popover'), edge: askPanelOverlayEdge(rect('.ask-popover'), canvasRect) },
      { rect: rect('.canvas-hint'), edge: 'bottom' as const },
      { rect: rect('.level-rail'), edge: 'left' as const },
    ].filter((overlay): overlay is { rect: DOMRect; edge: 'top' | 'right' | 'bottom' | 'left' } => overlay.rect !== undefined);
    const visual = window.visualViewport;
    const safe = measuredStorySafeArea(viewport, {
      canvas: canvasRect,
      overlays,
      overlayMargin: 0,
      ...(visual ? {
        visualViewport: {
          offsetTop: visual.offsetTop,
          offsetLeft: visual.offsetLeft,
          width: visual.width,
          height: visual.height,
        },
      } : {}),
      safeInsets: browserSafeAreaInsets(),
    });
    setMeasuredSafeArea(safe);
    return safe;
  }

  function semanticStorySession(step: AppStoryPlanStep, storyScene = scene): SemanticLensSession {
    return semanticLevelSession(storyScene, step.reveal, step.focusEntityIds);
  }

  function installStorySemanticProgress(active: ActiveStoryFlight, easedCameraProgress: number) {
    const kind = semanticInspectorFlightKind(active.sourceSession, active.targetSession);
    const progress = semanticInspectorFlightProgress(easedCameraProgress, kind);
    installSemanticSession(semanticInspectorFlightSession(
      active.sourceSession,
      active.targetSession,
      story.steps[active.step]?.focusEntityIds[0] ?? active.targetSession.settled.at(-1)?.targetId ?? 'story',
      progress,
    ));
  }

  function setStep(index: number, play = storyPlaying, historyMode: 'push' | 'replace' = 'replace', plan: AppStoryPlan = story) {
    cancelGestureSceneRequests();
    setActiveStoryId(plan.id);
    const bounded = (index + plan.steps.length) % plan.steps.length;
    const step = plan.steps[bounded];
    if (scanFixture) {
      const compileFocus = scanCompileFocusForBand(
        activeSnapshot,
        step.focusEntityIds[0] ?? scanFixture.navigation.rootEntityId,
        step.reveal,
        scanFixture.navigation.rootEntityId,
      );
      void Promise.all([
        scanFixture.ensureNeighborhood(compileFocus),
        scanFixture.ensureNeighborhood(step.focusEntityIds[0] ?? compileFocus),
      ]).then(() => setStepLoaded(index, play, historyMode, plan));
      return;
    }
    setStepLoaded(index, play, historyMode, plan);
  }

  function setStepLoaded(index: number, play = storyPlaying, historyMode: 'push' | 'replace' = 'replace', plan: AppStoryPlan = story) {
    const bounded = (index + plan.steps.length) % plan.steps.length;
    const step = plan.steps[bounded];
    const liveCamera = abortInspectorCameraFlight();
    setInspectorHistory([]);
    const compileFocus = scanFixture
      ? scanCompileFocusForBand(
          activeSnapshot,
          step.focusEntityIds[0] ?? scanFixture.navigation.rootEntityId,
          step.reveal,
          scanFixture.navigation.rootEntityId,
        )
      : navigationIdentity.rootEntityId;
    const presentIds = scanFixture
      ? activeSnapshot.entities.map(entity => entity.id)
      : scene.entities.map(entity => entity.id);
    const stepSelectedId = storyStepSelectedId(step.focusEntityIds, presentIds);
    if (stepSelectedId) inspectorSelectionRef.current = stepSelectedId;
    const stepScene = scanFixture ? composeScene(compileFocus, scene, authoringHistoryRef.current.present) : scene;
    if (stepScene !== scene) {
      setScene(stepScene);
      setNavigationIdentity(current => ({ ...current, rootEntityId: compileFocus }));
    }
    const sourceSession = collapseInspectorFlightSession(semanticLensSessionRef.current);
    const targetSession = semanticStorySession(step, stepScene);
    installSemanticSession(sourceSession);
    const existingFlight = storyFlightRef.current;
    const sourceFocusedIds = existingFlight && storyFlightSample
      ? storyFlightSample.visualProgress >= 1 - storyFlightSample.departureProgress
        ? existingFlight.targetFocusedIds
        : existingFlight.sourceFocusedIds
      : currentStory?.focusEntityIds ?? [];
    const sourceRelationIds = existingFlight && storyFlightSample
      ? storyFlightSample.visualProgress >= 1 - storyFlightSample.departureProgress
        ? existingFlight.targetRelationIds
        : existingFlight.sourceRelationIds
      : currentStory?.traceRelationIds ?? [];
    if (storyPlaying) {
      const elapsed = currentStoryElapsed();
      storyElapsedRef.current = elapsed;
      setStoryElapsedMs(elapsed);
    }
    setStoryStep(bounded);
    setStoryPlaying(false);
    storyElapsedRef.current = 0;
    setStoryElapsedMs(0);
    storyStartedAtRef.current = undefined;
    setStoryInterruption(undefined);
    setStorySelectionOverride(false);
    setReturnToStoryFrameRequired(false);
    if (stepSelectedId) {
      inspectorSelectionRef.current = stepSelectedId;
      setSelectedId(stepSelectedId);
      setPickedRelationId(undefined);
    }
    const framing = frameStoryStepCamera(stepScene, step.focusEntityIds, step.reveal, viewport, measureCurrentStorySafeArea());
    const nextCamera = framing ?? liveCamera;
    activeLevelRef.current = semanticDetails.indexOf(step.reveal);
    const now = performance.now();
    const flight = createStoryFlight(liveCamera, nextCamera, viewport, now, {
      ...(reduceMotion ? { durationMs: 0 } : {}),
    });
    const active: ActiveStoryFlight = {
      id: `step:${bounded}:${Math.round(now)}`,
      step: bounded,
      flight,
      sourceFocusedIds: [...sourceFocusedIds],
      targetFocusedIds: [...step.focusEntityIds],
      sourceRelationIds: [...sourceRelationIds],
      targetRelationIds: [...step.traceRelationIds],
      sourceSession,
      targetSession,
      playAfterArrival: play,
    };
    const initialSample = sampleStoryFlight(flight, now);
    arrivalPlayAfterRef.current = play;
    setArrivalElapsedMs(0);
    if (reduceMotion) {
      storyFlightRef.current = undefined;
      setStoryFlightSample(undefined);
      installSemanticSession(targetSession);
      updateCamera(nextCamera);
      pausedStoryPhaseRef.current = 'arrival';
      pausedStoryPhaseElapsedRef.current = 0;
      arrivalStartedAtRef.current = undefined;
      setStoryPhase('arrival');
    } else {
      storyFlightRef.current = active;
      setStoryFlightSample(initialSample);
      pausedStoryPhaseRef.current = 'flight';
      pausedStoryPhaseElapsedRef.current = 0;
      setStoryPhase('flight');
      setStoryFlightEpoch(epoch => epoch + 1);
    }
    if (historyMode === 'push' && !navigationRef.current.story) storyOriginAvailableRef.current = true;
    const canonicalSession = reduceMotion ? targetSession : sourceSession;
    commitNavigation(canonicalNavigationState({
      ...navigationRef.current,
      rootEntityId: compileFocus,
      ...(stepSelectedId ? { selectedId: stepSelectedId } : {}),
      camera: reduceMotion ? nextCamera : liveCamera,
      detail: canonicalSession.baseDetail,
      lensPath: semanticLensCanonicalPathIds(canonicalSession),
      story: {
        id: plan.id,
        step: bounded,
        positionMs: encodeStoryPosition(plan, bounded, reduceMotion ? 'arrival' : 'flight', 0, flight.canonicalDurationMs),
      },
    }, navigationDefaults), historyMode);
    const upcoming = plan.steps[(bounded + 1) % plan.steps.length];
    if (upcoming && scanFixture) {
      prefetchCommittedBox(scanCompileFocusForBand(
        activeSnapshot,
        upcoming.focusEntityIds[0] ?? scanFixture.navigation.rootEntityId,
        upcoming.reveal,
        scanFixture.navigation.rootEntityId,
      ));
    }
    setLiveMessage(reduceMotion
      ? `Story step ${bounded + 1} of ${plan.steps.length}: ${step.title}. Applying destination.`
      : `Moving to story step ${bounded + 1} of ${plan.steps.length}: ${step.title}.`);
  }

  function closeStory() {
    abortInspectorCameraFlight();
    setStoryPlaying(false);
    storyElapsedRef.current = 0;
    storyStartedAtRef.current = undefined;
    setStoryElapsedMs(0);
    setStoryInterruption(undefined);
    storyFlightRef.current = undefined;
    setStoryFlightSample(undefined);
    setStoryPhase('idle');
    setStorySelectionOverride(false);
    setReturnToStoryFrameRequired(false);
    isolationOriginRef.current = undefined;
    setVisibilityMode('all');
    if (storyOriginAvailableRef.current) {
      storyOriginAvailableRef.current = false;
      window.history.back();
      return;
    }
    setStoryStep(-1);
  }

  atlasChromeRef.current = {
    hasEntity: entityId => scene.entities.some(entity => entity.id === entityId),
    selectEntity: entityId => {
      const entity = scene.entities.find(candidate => candidate.id === entityId);
      if (entity) focusEntity(entity);
    },
    setC4Level: level => {
      const index = semanticDetails.indexOf(level);
      if (index >= 0) selectLevel(index);
    },
    isolate: active => {
      if (active) changeVisibility('isolate');
      else restoreVisibility();
    },
    startOverviewTour: () => setStep(0, true, 'push', defaultStory),
    openAsk: question => {
      if (getActivePortableAtlas() || askHidden) return;
      // Ask lives in the story launcher; a playing tour hides that chrome.
      storyOriginAvailableRef.current = false;
      if (storyStep >= 0) closeStory();
      if (!mainDiagramActive) activateDiagramView(MAIN_DIAGRAM_SURFACE_ID);
      setAskOpen(true);
      requestAskReframe();
      setQuestion(question);
      window.setTimeout(() => askInputRef.current?.focus(), 0);
    },
    askSignedIn: () => askAuth?.authenticated === true, askEnabled: () => !askHidden,
    readContext: () => ({
      atlas: atlasIdentityFromLocation(window.location.pathname, window.location.search),
      c4Level: activeDetail,
      selectedEntityId: selected?.id ?? null,
      ...(selected ? {
        selectedEntity: {
          id: selected.id,
          name: selected.name,
          kind: selected.kindLabel ?? selected.kind,
          ...(selected.detail ? { detail: selected.detail } : {}),
          ...(selectedCyclomatic ? {
            cyclomaticComplexity: selectedCyclomatic.complexity,
            cyclomaticFlagged: selectedCyclomatic.flagged,
          } : {}),
          ...(selectedCoverage ? {
            ...(selectedCoverage.fileHitRate !== undefined ? { coverageFileHitRate: selectedCoverage.fileHitRate } : {}),
            ...(selectedCoverage.fileHitPercent !== undefined ? { coverageFileHitPercent: selectedCoverage.fileHitPercent } : {}),
            ...(selectedCoverage.untestedRanges.length ? { coverageUntestedRanges: selectedCoverage.untestedRanges } : {}),
          } : {}),
          ...(selectedUntestedBehaviours.length ? { untestedBehaviours: selectedUntestedBehaviours } : {}),
          ...(selectedDuplicates.length ? { duplicates: selectedDuplicates } : {}),
        },
      } : {}),
      tourPlaying: atlasTourPlaying({ storyStep, storyPlaying, storyPhase }),
      enrichmentStatus: atlasEnrichmentStatus({
        atlasSource: importedAtlas ? 'imported-mermaid' : scanFixture ? 'scan' : query.fixture === 'stress' ? 'stress' : 'golden',
        entities: scene.entities,
      }),
      scanAvailable: false,
      askAvailable: query.fixture !== 'stress' && storyStep < 0 && !askHidden,
    }),
  };

  useEffect(() => {
    const controller = new AbortController();
    const unbind = bindAtlasChromeActions({
      hasEntity: entityId => atlasChromeRef.current.hasEntity(entityId),
      selectEntity: entityId => atlasChromeRef.current.selectEntity(entityId),
      setC4Level: level => atlasChromeRef.current.setC4Level(level),
      isolate: active => atlasChromeRef.current.isolate(active),
      startOverviewTour: () => atlasChromeRef.current.startOverviewTour(),
      openAsk: question => atlasChromeRef.current.openAsk(question),
      askSignedIn: () => atlasChromeRef.current.askSignedIn(), askEnabled: () => atlasChromeRef.current.askEnabled?.() !== false,
      readContext: () => atlasChromeRef.current.readContext(),
    });
    void registerWebMcpAtlasTools(globalThis, { signal: controller.signal });
    return () => {
      controller.abort();
      unbind();
    };
  }, []);

  useEffect(() => {
    if (query.fixture === 'stress' || storyStep >= 0 || restoringNavigationRef.current) return;
    const restoreGeneration = navigationRestoreGenerationRef.current;
    const applyInitializeFit = () => {
      if (restoringNavigationRef.current || navigationRestoreGenerationRef.current !== restoreGeneration) return;
      if (!isUsableAtlasViewport(viewport)) return;
      const safeArea = measureCurrentMapSafeArea();
      const requiresFit = !initialMapFitAppliedRef.current;
      initialMapFitAppliedRef.current = true;
      if (!requiresFit) return;
      const next = frameProjectionScope(scene, navigationIdentity.rootEntityId, activeDetail, viewport, safeArea, false, true);
      if (!next) return;
      updateCamera(next);
      commitNavigation(canonicalNavigationState({
        ...navigationRef.current,
        camera: next,
        detail: activeDetail,
      }, navigationDefaults), 'replace');
    };
    const frame = window.requestAnimationFrame(() => applyInitializeFit());
    const kick = isFramedBrowsingContext()
      ? window.setTimeout(() => applyInitializeFit(), EMBED_FRAME_IDLE_KICK_MS)
      : undefined;
    return () => {
      window.cancelAnimationFrame(frame);
      if (kick !== undefined) window.clearTimeout(kick);
    };
    // Readable framing may intentionally crop remote context. Resize/chrome/load-restore
    // must preserve that map camera; CLA-11: do not re-arm this fit after initialize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailsOpen, navigationIdentity.rootEntityId, query.fixture, safeAreaEpoch, scene, storyStep, viewport.height, viewport.width]);

  useEffect(() => {
    if (storyStep < 0) return;
    const player = document.querySelector<HTMLElement>('.story-player');
    if (!player) return;
    const invalidate = () => setSafeAreaEpoch(epoch => epoch + 1);
    const observer = new ResizeObserver(invalidate);
    observer.observe(player);
    const visual = window.visualViewport;
    visual?.addEventListener('resize', invalidate);
    visual?.addEventListener('scroll', invalidate);
    return () => {
      observer.disconnect();
      visual?.removeEventListener('resize', invalidate);
      visual?.removeEventListener('scroll', invalidate);
    };
  }, [storyStep]);

  useEffect(() => {
    if (storyStep < 0 || (storyPhase !== 'flight' && storyPhase !== 'arrival')) return;
    const step = story.steps[storyStep];
    const target = frameStoryStepCamera(scene, step.focusEntityIds, step.reveal, viewport, measureCurrentStorySafeArea());
    if (!target) return;
    const active = storyFlightRef.current;
    if (storyPhase === 'arrival' && !active) {
      updateCamera(target);
      return;
    }
    if (!active) return;
    const sample = storyFlightSample ?? sampleStoryFlight(active.flight, performance.now());
    const targetChanged = Math.hypot(target.x - active.flight.target.x, target.y - active.flight.target.y)
      * target.zoom > 0.5
      || Math.abs(target.zoom - active.flight.target.zoom) > 0.001;
    if (!targetChanged) return;
    const remainingMs = Math.max(1, active.flight.canonicalDurationMs - sample.elapsedMs);
    const retargeted = createStoryFlight(sample.camera, target, viewport, performance.now(), {
      durationMs: remainingMs,
      canonicalDurationMs: active.flight.canonicalDurationMs,
      canonicalElapsedMs: sample.elapsedMs,
    });
    storyFlightRef.current = { ...active, flight: retargeted };
    setStoryFlightSample(sampleStoryFlight(retargeted, retargeted.startedAtMs));
    setStoryFlightEpoch(epoch => epoch + 1);
  }, [detailsOpen, safeAreaEpoch, storyPhase, storyStep, viewport.height, viewport.width]);

  useEffect(() => {
    if (storyPhase !== 'flight') return;
    let frame = 0;
    let arrivalFrame = 0;
    const tick = (now: number) => {
      const active = storyFlightRef.current;
      if (!active || !active.flight.running) return;
      const sample = sampleStoryFlight(active.flight, now);
      setStoryFlightSample(sample);
      pausedStoryPhaseElapsedRef.current = sample.elapsedMs;
      installStorySemanticProgress(active, sample.easedProgress);
      updateCamera(sample.camera);
      if (!sample.arrived) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      installSemanticSession(active.targetSession);
      updateCamera(active.flight.target);
      setStoryFlightSample({ ...sample, camera: { ...active.flight.target } });
      // The exact target camera and destination focus/filter/trace state must
      // commit in a rendered frame before the 150 ms arrival barrier starts.
      arrivalFrame = window.requestAnimationFrame(arrivalNow => {
        arrivalStartedAtRef.current = arrivalNow;
        arrivalPlayAfterRef.current = active.playAfterArrival;
        pausedStoryPhaseRef.current = 'arrival';
        pausedStoryPhaseElapsedRef.current = 0;
        setArrivalElapsedMs(0);
        setStoryPhase('arrival');
        activeLevelRef.current = semanticDetails.indexOf(semanticLensSessionDetail(active.targetSession));
        const arrived = canonicalNavigationState({
          ...navigationRef.current,
          camera: active.flight.target,
          detail: active.targetSession.baseDetail,
          lensPath: semanticLensCanonicalPathIds(active.targetSession),
          story: {
            id: storyId,
            step: active.step,
            positionMs: encodeStoryPosition(story, active.step, 'arrival', 0, active.flight.canonicalDurationMs),
          },
        }, navigationDefaults);
        navigationRef.current = arrived;
        historyControllerRef.current?.replace(arrived);
      });
    };
    frame = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(arrivalFrame);
    };
  }, [storyPhase, storyFlightEpoch]);

  useEffect(() => {
    if (storyPhase !== 'arrival') return;
    let frame = 0;
    const tick = (now: number) => {
      const started = arrivalStartedAtRef.current ?? now;
      arrivalStartedAtRef.current ??= started;
      const elapsed = Math.min(STORY_ARRIVAL_SETTLE_MS, Math.max(0, Math.round(now - started)));
      setArrivalElapsedMs(elapsed);
      pausedStoryPhaseElapsedRef.current = elapsed;
      if (elapsed < STORY_ARRIVAL_SETTLE_MS) {
        frame = window.requestAnimationFrame(tick);
        return;
      }
      const play = arrivalPlayAfterRef.current;
      const active = storyFlightRef.current;
      const arrivedCamera = active?.flight.target ?? camera;
      const holdElapsedMs = storyElapsedRef.current;
      pausedStoryPhaseRef.current = 'hold';
      pausedStoryPhaseElapsedRef.current = holdElapsedMs;
      storyFlightRef.current = undefined;
      setStoryFlightSample(undefined);
      setStoryPhase(play ? 'hold' : 'paused');
      setStoryPlaying(play);
      storyStartedAtRef.current = play ? now : undefined;
      const settled = canonicalNavigationState({
        ...navigationRef.current,
        camera: arrivedCamera,
        detail: active?.targetSession.baseDetail ?? semanticLensSessionRef.current.baseDetail,
        lensPath: semanticLensCanonicalPathIds(active?.targetSession ?? semanticLensSessionRef.current),
        story: {
          id: storyId,
          step: storyStep,
          positionMs: encodeStoryPosition(
            story,
            storyStep,
            'hold',
            holdElapsedMs,
            active?.flight.canonicalDurationMs,
          ),
        },
      }, navigationDefaults);
      navigationRef.current = settled;
      historyControllerRef.current?.replace(settled);
      setLiveMessage(`Arrived at story step ${storyStep + 1}: ${story.steps[storyStep]?.title ?? 'Story step'}. ${play ? 'Playing.' : 'Paused.'}`);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [storyPhase, storyStep]);

  useEffect(() => {
    if (!storyPlaying || storyStep < 0) return;
    const delay = Math.max(0, storyStepDuration(story, storyStep) - storyElapsedRef.current);
    storyStartedAtRef.current = performance.now();
    const timeout = window.setTimeout(() => {
      storyElapsedRef.current = 0;
      setStoryElapsedMs(0);
      storyStartedAtRef.current = undefined;
      if (storyStep === story.steps.length - 1) {
        setStoryPlaying(false);
        pausedStoryPhaseRef.current = 'hold';
        pausedStoryPhaseElapsedRef.current = storyStepDuration(story, storyStep);
        setStoryPhase('paused');
      }
      else setStep(storyStep + 1, true, 'replace');
    }, delay);
    return () => { window.clearTimeout(timeout); };
  }, [storyPlaying, storyStep]);

  useEffect(() => {
    const pauseWhenHidden = () => {
      if (document.visibilityState === 'hidden') interruptStory('Story paused because the tab was hidden', camera, false);
    };
    document.addEventListener('visibilitychange', pauseWhenHidden);
    return () => document.removeEventListener('visibilitychange', pauseWhenHidden);
  }, [arrivalElapsedMs, camera, storyFlightSample, storyPhase, storyPlaying, storyStep]);

  useEffect(() => {
    function shortcut(event: KeyboardEvent) {
      const typing = keystrokeOwnedByTextEntry(event.target);
      if (!typing && editingEnabled && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoAuthoringGesture();
        else undoAuthoringGesture();
        return;
      }
      if (!typing && editingEnabled && pickedRelationId && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        deleteSelectedRelationship();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (!shouldOpenSearch(event)) return;
        setSearchOpen(true);
        window.setTimeout(() => document.getElementById('atlas-search')?.focus(), 0);
      }
      if (!typing && shouldToggleDevMode(event)) {
        event.preventDefault();
        setDevMode(value => !value);
      }
      if (!getActivePortableAtlas() && !askHidden && shouldOpenAskAtlas(event, storyStep >= 0)) {
        event.preventDefault();
        if (!mainDiagramActive) activateDiagramView(MAIN_DIAGRAM_SURFACE_ID);
        if (askDocked) openDockedAsk();
        else setAskOpen(true);
        if (!askOpen) requestAskReframe();
        window.setTimeout(() => askInputRef.current?.focus(), 0);
      }
      if (event.key === 'Escape') {
        if (searchOwnsKeystrokes(event.target)) { setSearchOpen(false); return; }
        if (askOpen || askOwnsKeystrokes(event.target)) { setAskOpen(false); window.setTimeout(() => askButtonRef.current?.focus(), 0); return; }
        const shouldCloseInspector = detailsOpen && !searchOpen && !askOpen && detailsPanelRef.current?.contains(document.activeElement);
        cancelSemanticLens('escape');
        setAuthoringTool('select');
        setSearchOpen(false); setAskOpen(false);
        if (askOpen) window.setTimeout(() => askButtonRef.current?.focus(), 0);
        if (shouldCloseInspector) closeDetails();
      }
      if (!typing && mainDiagramActive && (event.key === '+' || event.key === '=')) {
        event.preventDefault();
        semanticZoomControl('inward');
      }
      if (!typing && mainDiagramActive && (event.key === '-' || event.key === '_')) {
        event.preventDefault();
        semanticZoomControl('outward');
      }
      if (!typing && mainDiagramActive && editingEnabled && event.key.toLowerCase() === 'v') setAuthoringTool('select');
      if (!typing && mainDiagramActive && editingEnabled && event.key.toLowerCase() === 'c') setAuthoringTool('connect');
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [askHidden, askOpen, askDocked, camera, detailsOpen, editingEnabled, mainDiagramActive, navigationIdentity.rootEntityId, pickedRelationId, searchOpen, semanticLensSession, storyStep, viewport]);

  useEffect(() => {
    if (getActivePortableAtlas()) return;
    const controller = new AbortController();
    void fetchAskAuth({ signal: controller.signal }).then(auth => {
      if (!controller.signal.aborted) setAskAuth(auth);
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!askOpen || askHidden || getActivePortableAtlas()) {
      askAbortRef.current?.abort();
      askAbortRef.current = undefined;
      setAskPending(undefined);
      setAskLatestTurnId(undefined);
      setAskError(undefined);
      return;
    }
    const controller = new AbortController();
    void fetchAskAuth({ signal: controller.signal }).then(async auth => {
      if (controller.signal.aborted) return;
      setAskAuth(auth);
      setAskConnected(false);
      if (!auth.authenticated) {
        setAskConnected(false);
        setAskThread(undefined);
        return;
      }
      if (askAtlasIdentity) {
        const thread = await (auth.accountId ? readLocalAskThread(auth.accountId, askAtlasIdentity) : loadAskThread(askAtlasIdentity, { signal: controller.signal }));
        if (controller.signal.aborted) return;
        const next = keepNewerAskThread(askThreadRef.current, thread);
        askThreadRef.current = next;
        setAskThread(next);
      }
      void probeAskConnection({ signal: controller.signal, timeoutMs: ASK_PROBE_TIMEOUT_MS }).then(connected => {
        if (!controller.signal.aborted) setAskConnected(connected);
      });
    });
    return () => controller.abort();
  }, [askHidden, askOpen, askSignedIn, askAuth?.accountId, askAtlasIdentity?.owner, askAtlasIdentity?.repo, askAtlasIdentity?.commitSha]);

  // A different account must never inherit visible turns or an in-flight answer.
  useEffect(() => {
    askAbortRef.current?.abort();
    setAskThread(undefined);
    askThreadRef.current = undefined;
    setAskLatestTurnId(undefined);
    setAskPending(undefined);
    setAskWarmingUp(false);
  }, [askAuth?.accountId, askAuth?.authenticated, askAtlasIdentity?.owner, askAtlasIdentity?.repo, askAtlasIdentity?.commitSha]);

  // Opening Ask (click / shortcut / tour hand-off) and submitting a question are gestures: if the
  // panel now covers the selected card, pan it into the unobstructed area with the same safe-area
  // reframe the inspector uses. An async thread load or the panel reappearing after a story never
  // moves the camera, and closing Ask never moves it back (askPanelReframeDue).
  const askPanelLayout = askDocked || !askOpen || askHidden || portableAtlas || currentStory || query.fixture === 'stress'
    ? 'closed'
    : (askThread?.turns.length ?? 0) > 0 || askPending || askError ? 'thread' : 'empty';
  const askReframeHandledRef = useRef(0);
  useEffect(() => {
    if (!askPanelReframeDue(askPanelLayout, askReframeRequest, askReframeHandledRef.current)) return;
    askReframeHandledRef.current = askReframeRequest;
    reframeEntityAfterInspectorChange(selected);
  }, [askPanelLayout, askReframeRequest]);

  // A citation chip drills like an inspector link; once that flight settles, pan the cited entity
  // itself clear of the Ask panel / inspector (the drill frames its owner, which can leave the cited
  // declaration under the inspector). Latest-render reframe via a ref so the new scene is used.
  const askReframeRef = useRef(reframeEntityAfterInspectorChange);
  askReframeRef.current = reframeEntityAfterInspectorChange;
  function frameAskCitationWhenSettled(id: string, framesLeft = 240) {
    window.requestAnimationFrame(() => {
      if (inspectorSelectionRef.current !== id) return; // the user moved on
      if (framesLeft > 0 && inspectorCameraFlightControllerRef.current?.isActive()) { frameAskCitationWhenSettled(id, framesLeft - 1); return; }
      const entity = sceneRef.current.entities.find(candidate => candidate.id === id);
      if (entity) askReframeRef.current(entity);
    });
  }

  // "Show on map" (CLA-265): pick the level from the cited parts (askShowOnMapPlan), drill there via
  // the inspector-link path, then isolate + frame the cited cards. "Restore full view" goes back to
  // the exact pre-Show view (scene, lens, camera, selection), not just un-isolate.
  const askMapReturnRef = useRef<{
    navigation: NavigationState;
    scene: AtlasScene;
    session: SemanticLensSession;
    level: number;
    identity: typeof navigationIdentity;
    inspectorTab: InspectorTab;
    detailsOpen: boolean;
    pickedRelationId?: string;
  } | undefined>(undefined);
  const askMapApplyRef = useRef<(plan: AskMapPlan, turnId: string, generation: number, inspectorWasOpen: boolean) => void>(() => {});
  const askMapStepCurrent = (generation: number, target?: string) => askMapStepIsCurrent(
    { generation, ...(target ? { target } : {}) },
    { generation: askMapGenerationRef.current, selectionId: inspectorSelectionRef.current },
  );
  askMapApplyRef.current = (plan, turnId, generation, inspectorWasOpen) => {
    if (!askMapStepCurrent(generation, plan.focusIds[0])) return;
    askMapInFlightRef.current = false;
    const present = new Set(sceneRef.current.entities.map(entity => entity.id));
    const ids = plan.focusIds.filter(id => present.has(id));
    if (!ids.length) { setLiveMessage('The cited parts are not drawn at this level.'); return; }
    // Frame the cards as the current lens draws them (semantic bounds), inside that level's band:
    // the largest cluster (from the first citation) that fits on screen; the rest stay highlighted.
    const detail = semanticLensSessionDetail(semanticLensSessionRef.current);
    const safe = measureCurrentMapSafeArea();
    const cluster = askFramedCluster(
      ids,
      id => semanticBounds(sceneRef.current, id, detail),
      clusterIds => frameSemanticEntities(sceneRef.current, clusterIds, detail, viewport, safe),
      viewport,
      safe,
    );
    // Never leave file cards unreadably small (or undrawn) when L2 can show their container.
    if (plan.level === 'component' && plan.containerId && (!cluster.camera || cluster.smallestPx < ASK_MAP_MIN_CARD_PX)) {
      showAskPlanOnMap({ level: 'container', focusIds: [plan.containerId] }, turnId, inspectorWasOpen, generation);
      return;
    }
    const framed = cluster.camera ?? frameEntities(sceneRef.current, ids, viewport, safe);
    isolationOriginRef.current = undefined;
    setPickedRelationId(undefined);
    setAskMapFocus({ key: `ask:${turnId}:${plan.level}`, turnId, entityIds: ids, relationIds: [] });
    setVisibilityMode('isolate');
    if (framed) {
      updateCamera(framed);
      commitNavigation(canonicalNavigationState({ ...navigationRef.current, camera: framed }, navigationDefaults), 'replace');
    }
    const noun = `cited ${plan.level === 'component' ? 'file' : 'container'}${ids.length === 1 ? '' : 's'}`;
    setLiveMessage(cluster.ids.length && cluster.ids.length < ids.length
      ? `Showing ${ids.length} ${noun} from the answer; ${cluster.ids.length} in view, pan to see the rest.`
      : `Showing ${ids.length} ${noun} from the answer on the map.`);
  };
  function showAskPlanOnMap(plan: AskMapPlan, turnId: string, inspectorWasOpen: boolean, generation: number) {
    askMapInFlightRef.current = true;
    // L3 inside the container: open the first cited file (lands at its canonical L3 within the
    // container); L2: open the first container (system lens). Then isolate + frame once settled.
    const target = plan.focusIds[0]!;
    void openInspectorChild(target).then(() => {
      const settle = (framesLeft: number) => window.requestAnimationFrame(() => {
        // Bail if the user acted (generation) or the drill was dropped / superseded (selection).
        if (!askMapStepCurrent(generation, target)) return;
        if (framesLeft > 0 && inspectorCameraFlightControllerRef.current?.isActive()) { settle(framesLeft - 1); return; }
        // The drill opens the inspector; Show on map is about the map, so a closed inspector (the
        // phone sheet) stays closed. Measure the safe area only after it has closed.
        if (!inspectorWasOpen) setDetailsOpen(false);
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => askMapApplyRef.current(plan, turnId, generation, inspectorWasOpen)));
      });
      settle(240);
    }).catch(() => setLiveMessage('Unable to load this part of the map. Please try again.'));
  }
  async function showAskTurnOnMap(citedIds: string[], turnId: string) {
    // Take the generation before any await, so a user action during the load cancels this Show.
    const askIsolateActive = visibilityMode === 'isolate' && askMapFocus !== undefined;
    const showInFlight = askMapInFlightRef.current;
    cancelAskMapShow();
    const generation = askMapGenerationRef.current;
    askMapInFlightRef.current = true;
    // Scan snapshots grow lazily: load the cited neighborhoods so parentage is known.
    const fixture = scanFixture;
    if (fixture) await Promise.all(citedIds.slice(0, 24).map(id => fixture.ensureNeighborhood(id).catch(() => undefined)));
    if (!askMapStepCurrent(generation)) return;
    const byId = new Map(activeSnapshot.entities.map(entity => [entity.id, entity]));
    const plan = askShowOnMapPlan(citedIds, id => byId.get(id) ?? sceneRef.current.entities.find(entity => entity.id === id));
    if (!plan) { askMapInFlightRef.current = false; setLiveMessage('None of the cited parts can be placed on the map.'); return; }
    if (askMapShouldCaptureReturn({ hasReturn: askMapReturnRef.current !== undefined, askIsolateActive, showInFlight })) {
      askMapReturnRef.current = {
        navigation: navigationRef.current,
        scene: sceneRef.current,
        session: semanticLensSessionRef.current,
        level: activeLevelRef.current,
        identity: navigationIdentity,
        inspectorTab,
        detailsOpen,
        ...(pickedRelationId ? { pickedRelationId } : {}),
      };
    }
    showAskPlanOnMap(plan, turnId, detailsOpen, generation);
  }
  function restoreAskMapView() {
    const saved = askMapReturnRef.current;
    askMapReturnRef.current = undefined;
    cancelAskMapShow();
    setAskMapFocus(undefined);
    isolationOriginRef.current = undefined;
    setVisibilityMode('all');
    if (!saved) { setLiveMessage('Full architecture context restored.'); return; }
    abortInspectorCameraFlight();
    setScene(saved.scene);
    installSemanticSession(saved.session);
    activeLevelRef.current = saved.level;
    setNavigationIdentity(saved.identity);
    inspectorSelectionRef.current = saved.navigation.selectedId;
    setSelectedId(saved.navigation.selectedId);
    setPickedRelationId(saved.pickedRelationId);
    setInspectorTab(saved.inspectorTab);
    setDetailsOpen(saved.detailsOpen);
    setInspectorHistory([]);
    updateCamera(saved.navigation.camera);
    commitNavigation(saved.navigation, 'replace');
    setSafeAreaEpoch(epoch => epoch + 1);
    setLiveMessage('Returned to the view before Show on map.');
  }

  // Whatever takes the map out of isolate (toolbar, history, story exit, relationship reframe,
  // portable load) makes the Ask highlight and the saved pre-Show view stale.
  const askVisibilityModeRef = useRef(visibilityMode);
  useEffect(() => {
    const previous = askVisibilityModeRef.current;
    askVisibilityModeRef.current = visibilityMode;
    if (!askMapViewShouldReset(previous, visibilityMode)) return;
    cancelAskMapShow();
    askMapReturnRef.current = undefined;
    setAskMapFocus(undefined);
  }, [visibilityMode]);

  useEffect(() => () => {
    // Close (effect above) and unmount abandon an in-flight question. Selection / Isolate changes
    // do not (CLA-265): scope is only a starting point, and the server has already paid for and
    // persisted the turn, so a chip click or Show on map while asking keeps the answer.
    askAbortRef.current?.abort();
    askAbortRef.current = undefined;
  }, []);

  const askState = !askSignedIn && askAuth
    ? 'signin'
    : askPending ? 'asking' : askError ? 'error' : askLatestTurnId ? 'answered' : askConnected ? 'ready' : 'disconnected';

  function showDisconnectedAsk() {
    setAskConnected(false);
    setAskLatestTurnId(undefined);
    setAskError(undefined);
    setLiveMessage(ASK_NOT_CONNECTED_LIVE_MESSAGE);
  }

  async function submitQuestion(event: FormEvent) {
    event.preventDefault();
    const text = question.trim();
    if (!text || askPending) return;
    if (!askSignedIn) return;
    if (!askConnected) {
      showDisconnectedAsk();
      return;
    }
    requestAskReframe(); // submitting grows the panel into a thread: keep the selection clear of it
    const context = buildAskContext({
      entities: scene.entities.map(entity => ({
        id: entity.id,
        ...(entity.parentId ? { parentId: entity.parentId } : {}),
        name: entity.name,
        kind: entity.kind,
        ...(entity.responsibility ? { responsibility: entity.responsibility } : {}),
        ...(entity.source ? { source: entity.source } : {}),
        ...(typeof entity.cyclomaticComplexity === 'number' ? { cyclomaticComplexity: entity.cyclomaticComplexity } : {}),
        ...(typeof entity.coverageFileHitRate === 'number' ? { coverageFileHitRate: entity.coverageFileHitRate } : {}),
        ...(entity.coverageUntestedRanges?.length ? { coverageUntestedRanges: entity.coverageUntestedRanges } : {}),
        ...(entity.untestedBehaviours?.length ? { untestedBehaviours: entity.untestedBehaviours } : {}),
        duplicates: inspectorDuplicates(entity.id, activeSnapshot.relations, activeSnapshot.entities),
      })),
      relations: (() => {
        const seen = new Set<string>();
        const rows: Array<{ id: string; from: string; to: string; label?: string }> = [];
        const push = (relation: { id: string; from: string; to: string; label?: string }) => {
          if (seen.has(relation.id)) return;
          seen.add(relation.id);
          rows.push(relation);
        };
        for (const relation of scene.relations) {
          push({
            id: relation.id,
            from: relation.from,
            to: relation.to,
            ...(relation.label ? { label: relation.label } : {}),
          });
        }
        for (const relation of activeSnapshot.relations) {
          if (relation.kind !== 'duplicates') continue;
          push({
            id: relation.id,
            from: relation.from,
            to: relation.to,
            label: relation.label ?? 'duplicates',
          });
        }
        return rows;
      })(),
      selectedId,
      isolateActive: visibilityMode === 'isolate',
      isolatedIds: isolatedEntityIds,
    });
    askAbortRef.current?.abort();
    const controller = new AbortController();
    askAbortRef.current = controller;
    // No scope gate on commit: the answered turn lands in the thread whatever is selected now.
    const submittedAccount = askAccountRef.current;
    setAskWarmingUp(false);
    setAskPending(text);
    setAskLatestTurnId(undefined);
    setAskError(undefined);
    try {
      const result = await submitAskQuestion(text, context, {
        signal: controller.signal,
        timeoutMs: ASK_REQUEST_TIMEOUT_MS,
        onWarmingUp: warming => { if (!controller.signal.aborted) setAskWarmingUp(warming); },
        ...(askAtlasIdentity ? { atlas: askAtlasIdentity } : {}),
      });
      if (controller.signal.aborted || submittedAccount !== askAccountRef.current) return;
      // (Scope changes no longer discard the answer; only close/unmount aborts it.)
      if (isAskUnauthorized(result)) {
        setAskAuth({
          authenticated: false,
          loginPath: result.loginPath,
          logoutPath: '/api/auth/logout',
          ...(result.testLoginPath ? { testLoginPath: result.testLoginPath } : {}), ...(askAuth?.publicMode === true ? { publicMode: true } : {}),
        });
        setAskConnected(false);
        return;
      }
      if (!result.connected) {
        showDisconnectedAsk();
        return;
      }
      if ('error' in result && result.error) {
        setAskError(result.error);
        setLiveMessage(result.error);
        return;
      }
      if ('answer' in result) {
        const answered = {
          question: text,
          result,
          ...(askAtlasIdentity ? { atlas: askAtlasIdentity } : {}),
          now: Date.now(),
        };
        const thread = appendAskAnswer(askThreadRef.current, answered).thread;
        askThreadRef.current = thread;
        setAskThread(thread);
        if (submittedAccount && thread) {
          void writeLocalAskThread(submittedAccount, thread).then(saved => {
            if (!saved && !controller.signal.aborted && submittedAccount === askAccountRef.current) {
              setAskError('Your answer is available, but this browser could not save the conversation.');
            }
          });
        }
        setAskLatestTurnId(appendAskAnswer(undefined, answered).latestTurnId);
        setQuestion(current => current.trim() === text ? '' : current); // keep a follow-up typed while waiting
        setLiveMessage(result.answer);
      }
    } finally {
      if (askAbortRef.current === controller) {
        askAbortRef.current = undefined;
        setAskPending(undefined);
        setAskWarmingUp(false);
      }
    }
  }

  /** Land the live view (story sample, canvas camera, deferred URL write) in the URL; Share and Embed both read it. */
  function flushCurrentViewUrl() {
    if (storyStep >= 0) {
      let phase = storyCanonicalPhase;
      let elapsed = storyPhaseElapsedMs;
      let sampledCamera = camera;
      if (storyPhase === 'flight' && storyFlightRef.current) {
        const sample = sampleStoryFlight(storyFlightRef.current.flight, performance.now());
        setStoryFlightSample(sample);
        sampledCamera = sample.camera;
        elapsed = sample.elapsedMs;
        phase = 'flight';
      } else if (storyPlaying) {
        elapsed = currentStoryElapsed();
        storyElapsedRef.current = elapsed;
        storyStartedAtRef.current = performance.now();
        setStoryElapsedMs(elapsed);
        phase = 'hold';
      }
      const next = canonicalNavigationState({
        ...navigationRef.current,
        camera: sampledCamera,
        story: {
          id: storyId,
          step: storyStep,
          positionMs: encodeStoryPosition(
            story,
            storyStep,
            phase,
            elapsed,
            storyFlightRef.current?.flight.canonicalDurationMs,
          ),
        },
      }, navigationDefaults);
      navigationRef.current = next;
      historyControllerRef.current?.replace(next);
    }
    // Story snapshots already replaced history with the exact sampled camera
    // and canonical phase. Flushing the canvas publisher here could overwrite
    // that sample with its previous RAF camera.
    if (storyStep < 0) window.dispatchEvent(new Event('atlas:flush-navigation'));
    // Camera-only URL writes are spaced (CLA-326); land any deferred one before reading it.
    historyControllerRef.current?.flushUrl();
  }

  function readCurrentViewHref() {
    flushCurrentViewUrl();
    return window.location.href;
  }

  async function copyCurrentView() {
    const url = readCurrentViewHref();
    if (shareFeedbackTimerRef.current !== undefined) window.clearTimeout(shareFeedbackTimerRef.current);
    try {
      await copyViewLink(url, navigator.clipboard);
      const message = 'Current view link copied. Anyone with repository access can open it.';
      setShareFeedback({ tone: 'success', message, url });
      shareFeedbackTimerRef.current = window.setTimeout(() => setShareFeedback(undefined), 3200);
    } catch {
      setShareFeedback({ tone: 'error', message: 'Could not access the clipboard. Select and copy this link manually.', url });
    }
  }

  async function captureScreenshot(mode: 'copy' | 'save') {
    screenshotMenuRef.current?.removeAttribute('open');
    try {
      const blob = await captureSceneBlob({
        scene,
        camera,
        width: viewport.width,
        height: viewport.height,
        devicePixelRatio: window.devicePixelRatio,
        renderState: {
          selectedId: rendererSelectedId,
          focusedIds,
          relationFocusIds: relationFocus.endpointIds,
          activeRelationIds,
          flowRelationIds,
          reduceMotion: true,
          animate: false,
          visibilityMode: effectiveVisibilityMode,
          ...(relationFocus.projectionOverride ? { projectionOverride: relationFocus.projectionOverride } : {}),
        },
      });
      const canCopy = mode === 'copy' && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
      if (canCopy) {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        setLiveMessage('Copied a PNG of the current view to the clipboard.');
      } else {
        downloadBlob(blob, screenshotFilename(activeDiagramSurface.title, Date.now()));
        setLiveMessage(mode === 'copy'
          ? 'Clipboard image copy is unavailable in this browser; saved a PNG instead.'
          : 'Saved a PNG of the current view.');
      }
    } catch (error) {
      setLiveMessage(`Could not capture the canvas: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function dismissShareFeedback() {
    setShareFeedback(undefined);
    window.setTimeout(() => shareButtonRef.current?.focus({ preventScroll: true }), 0);
  }

  function currentDiagramSurfaceSession(): DiagramSurfaceSession {
    if (activeDiagramSurface.kind !== 'main') return activeDiagramSurface.session;
    return {
      camera: { ...renderedCameraRef.current },
      selectedId: selected.id,
      ...(pickedRelationId ? { pickedRelationId } : {}),
      inspector: {
        open: detailsOpen,
        tab: inspectorTab,
        subjectId: pickedRelationId ?? selected.id,
      },
    };
  }

  function restoreDiagramSurface(surface: DiagramSurface) {
    const liveCamera = abortInspectorCameraFlight();
    if (surface.kind !== 'source' && activeDiagramSurface.kind !== 'source') setInspectorHistory([]);
    setSearchOpen(false);
    setAskOpen(false);
    setDiagnosticsOpen(false);
    if (surface.kind !== 'main') {
      interruptStory(`Opened ${surface.title}`, liveCamera, false);
      setPickedRelationId(undefined);
      setDetailsOpen(false);
      setInspectorTab('details');
      setSafeAreaEpoch(epoch => epoch + 1);
      setLiveMessage(surface.kind === 'source' ? `${surface.title} source opened.` : `${surface.title} ${surface.kind} diagram opened.`);
      return;
    }
    const session = surface.session;
    if (session.camera) updateCamera(session.camera);
    if (session.selectedId) {
      inspectorSelectionRef.current = session.selectedId;
      setSelectedId(session.selectedId);
    }
    setPickedRelationId(session.pickedRelationId);
    setDetailsOpen(session.inspector.open);
    setInspectorTab(session.inspector.tab);
    setSafeAreaEpoch(epoch => epoch + 1);
    setLiveMessage('Main architecture diagram restored.');
  }

  function activateDiagramView(surfaceId: string) {
    if (surfaceId === diagramWorkspace.activeSurfaceId) return;
    const target = diagramWorkspace.surfaces[surfaceId];
    if (!target) return;
    abortInspectorCameraFlight();
    setDiagramWorkspace(activateDiagramSurface(diagramWorkspace, surfaceId, currentDiagramSurfaceSession()));
    restoreDiagramSurface(target);
  }

  function selectedDiagramEntityIds() {
    return [selected.id, ...selectedChildren.filter(child => child.detail === 'code').map(child => child.id)];
  }

  function applyImportedMermaid(source: string) {
    const result = importMermaidToAtlas(source);
    if (!result.ok) {
      setImportMermaidError(result.message);
      setLiveMessage(result.message);
      return;
    }
    let nextScene: AtlasScene;
    try {
      nextScene = compileImportedMermaidScene(result.atlas, scene);
    } catch (error) {
      const message = `${error instanceof Error ? error.message : 'Mermaid import failed.'} The atlas is unchanged.`;
      setImportMermaidError(message);
      setLiveMessage(message);
      return;
    }
    importedAtlasRef.current = result.atlas;
    setPathDraft(undefined);
    const importedAuthoring = createGestureHistory(createArchitectureAuthoringDocument(result.atlas.snapshot.repositoryId));
    authoringHistoryRef.current = importedAuthoring;
    setAuthoringHistory(importedAuthoring);
    setImportedAtlas(result.atlas);
    setImportMermaidError(undefined);
    setImportMermaidSource(source);
    setImportMermaidOpen(false);
    interruptStory('Imported a Mermaid diagram');
    cancelSemanticLensAt('imported mermaid', camera);
    const frameDetail = result.atlas.frameDetail;
    installSemanticSession(idleSemanticLensSession(frameDetail));
    const fitted = frameSemanticEntities(
      nextScene,
      result.atlas.frameEntityIds,
      frameDetail,
      viewport,
      measureCurrentMapSafeArea(),
    )
      ?? frameEntities(nextScene, result.atlas.frameEntityIds, viewport, measureCurrentMapSafeArea())
      ?? camera;
    const selectId = result.atlas.snapshot.entities.find(entity => entity.id !== result.atlas.rootEntityId)?.id
      ?? result.atlas.rootEntityId;
    setScene(nextScene);
    setSelectedId(selectId);
    setPickedRelationId(undefined);
    setStoryStep(-1);
    setStoryPlaying(false);
    setVisibilityMode('all');
    updateCamera(fitted);
    const identity = {
      repositoryId: result.atlas.snapshot.repositoryId,
      snapshotId: result.atlas.snapshot.id,
      viewId: `view:${result.atlas.snapshot.id}`,
      rootEntityId: result.atlas.rootEntityId,
    };
    setNavigationIdentity({ ...identity, filterId: undefined });
    setDiagramWorkspace(createDiagramWorkspace({
      camera: fitted,
      selectedId: selectId,
      inspector: { open: detailsOpen, tab: 'details', subjectId: selectId },
    }));
    commitNavigation(canonicalNavigationState({
      ...identity,
      selectedId: selectId,
      camera: fitted,
      detail: frameDetail,
      lensPath: [],
    }, {
      ...navigationDefaults,
      ...identity,
      selectedId: selectId,
      camera: fitted,
      detail: frameDetail,
      lensPath: [],
      story: undefined,
    }), 'replace');
    const kinds = result.atlas.diagramTypes.join(' and ');
    setLiveMessage(`Imported ${kinds} onto the atlas with ${result.atlas.frameEntityIds.length} nodes.`);
  }

  /** CLA-208: reveal a restored path only when it changed (or on a non-embed first load); scan links load endpoints first. */
  function restorePathDraft(next: NavigationState, source: 'initialize' | 'popstate') {
    const restored = pathDraftFromNavigation(next.path);
    const changed = JSON.stringify(navigationPathFromDraft(restored)) !== JSON.stringify(navigationPathFromDraft(pathDraftRef.current));
    setPathDraft(restored);
    if (!next.path) return;
    const embedded = isEmbedChrome({ framed: isFramedBrowsingContext(), embedQuery: isEmbedQueryFlag(window.location.search) });
    if (changed || (source === 'initialize' && !embedded)) { setInspectorTab('details'); setDetailsOpen(true); }
    const fixture = scanFixture;
    if (fixture?.boot === 'neighborhood') {
      const ids = [next.path.fromId, next.path.toId];
      void Promise.all(ids.map(id => fixture.ensureNeighborhood(id).catch(() => undefined)))
        .then(() => setPathLoadEpoch(epoch => epoch + 1));
    }
  }

  /** CLA-208: setting, swapping, or clearing endpoints is deliberate exploration (push, like a search jump); kind/option refinements replace. */
  function updatePathDraft(next: PathDraft | undefined, mode: 'push' | 'replace') {
    setPathDraft(next);
    const path = navigationPathFromDraft(next);
    if (JSON.stringify(path) !== JSON.stringify(navigationRef.current.path)) commitNavigation({ ...navigationRef.current, path }, mode);
    if (next) { setInspectorTab('details'); setDetailsOpen(true); }
  }

  function showPathHopOnMap(hop: PathHopView) {
    const relation = hop.relationId ? canonicalRelationForInspection(activeSnapshot, hop.relationId) : undefined;
    if (relation) frameSelectedRelationFlow(relation, selected);
    else setLiveMessage(hop.mapNote ?? 'This hop has no captured relation to show on the map.');
  }

  async function openPathEvidence(hop: PathHopView, evidence: PathEvidenceView) {
    let excerpt = evidence.excerpt;
    if (!excerpt && scanFixture) {
      await Promise.all([hop.from.id, hop.to.id].map(id => scanFixture?.ensureExcerpts(id).catch(() => undefined)));
      excerpt = evidenceExcerpt(activeSnapshot, { source: { path: evidence.path, commitSha: evidence.commitSha, ...(evidence.startLine !== undefined ? { startLine: evidence.startLine } : {}) } }, [hop.from.id, hop.to.id]);
    }
    if (!excerpt) {
      setLiveMessage(`A source excerpt for ${evidence.location} isn't available here.`);
      return;
    }
    // Resumes after an await: use the latest render's workspace, not this closure's.
    openPathExcerptRef.current(hop.from.id, excerpt);
  }

  openPathExcerptRef.current = (entityId: string, excerpt: SceneSourceExcerpt) => {
    const next = openDerivedDiagramSurface(diagramWorkspace, {
      id: `source:${entityId}:${excerpt.path}:${excerpt.frozenRevision}:${excerpt.highlightLine}`, kind: 'source', title: excerpt.path.split('/').at(-1) ?? excerpt.path,
      closable: true, entityIds: [entityId], excerpt,
      session: { selectedId: selected.id, inspector: { open: false, tab: 'source', subjectId: selected.id } },
    }, currentDiagramSurfaceSession());
    setDiagramWorkspace(next);
    restoreDiagramSurface(next.surfaces[next.activeSurfaceId]!);
  };

  function openSourceTab() {
    const id = `source:${selected.id}:${selectedExcerpt?.path ?? ''}:${selectedExcerpt?.frozenRevision ?? ''}`;
    const next = openDerivedDiagramSurface(diagramWorkspace, {
      id, kind: 'source', title: selectedExcerpt?.path.split('/').at(-1) ?? `${selected.name} source`,
      closable: true, entityIds: [selected.id], excerpt: selectedExcerpt,
      session: { selectedId: selected.id, inspector: { open: false, tab: 'source', subjectId: selected.id } },
    }, currentDiagramSurfaceSession());
    setDiagramWorkspace(next);
    restoreDiagramSurface(next.surfaces[next.activeSurfaceId]!);
  }

  function openDerivedDiagram(kind: DerivedDiagramKind = 'code', namedStory?: AppStoryPlan) {
    if (kind === 'code' && !hasCodeStructureDiagram) {
      setLiveMessage('No captured code structure is available for this selection.');
      return;
    }
    abortInspectorCameraFlight();
    const id = `diagram:${kind}:${selected.id}:${namedStory?.id ?? ''}`;
    const label = kind === 'flow' ? 'flow' : kind === 'dependency' ? 'dependencies' : kind === 'mermaid' ? 'Mermaid' : 'code structure';
    const surface: DerivedDiagramSurface = {
      id,
      kind,
      title: namedStory?.title ?? `${selected.name} ${label}`,
      ...(namedStory ? { storyId: namedStory.id } : {}),
      closable: true,
      entityIds: namedStory ? [...new Set([selected.id, ...namedStory.steps.flatMap(step => step.focusEntityIds)])] : kind === 'dependency' ? [...new Set([selected.id, ...scene.relations.filter(relation => relation.from === selected.id || relation.to === selected.id).flatMap(relation => [relation.from, relation.to])])].filter(id => scene.entities.some(entity => entity.id === id)) : selectedDiagramEntityIds(),
      session: {
        selectedElementId: selected.id,
        inspector: { open: false, tab: 'details', subjectId: selected.id },
      },
    };
    const next = openDerivedDiagramSurface(diagramWorkspace, surface, currentDiagramSurfaceSession());
    setDiagramWorkspace(next);
    diagramAddMenuRef.current?.removeAttribute('open');
    restoreDiagramSurface(next.surfaces[next.activeSurfaceId]!);
  }

  function closeDiagramView(surfaceId: string) {
    const next = closeDiagramSurface(diagramWorkspace, surfaceId, currentDiagramSurfaceSession());
    if (next === diagramWorkspace) return;
    const activeChanged = next.activeSurfaceId !== diagramWorkspace.activeSurfaceId;
    if (activeChanged) abortInspectorCameraFlight();
    setDiagramWorkspace(next);
    if (activeChanged) restoreDiagramSurface(next.surfaces[next.activeSurfaceId]!);
    window.requestAnimationFrame(() => document.getElementById(diagramTabDomId(next.activeSurfaceId))?.focus({ preventScroll: true }));
  }

  function updateActiveDiagramSession(session: DiagramSurfaceSession) {
    setDiagramWorkspace(current => updateDiagramSurfaceSession(current, current.activeSurfaceId, session));
  }

  function navigateDiagramTabs(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    if (!tabs.length) return;
    event.preventDefault();
    const currentIndex = Math.max(0, tabs.indexOf(document.activeElement as HTMLButtonElement));
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[nextIndex]!.focus();
    tabs[nextIndex]!.click();
  }

  const storyPlaybackStatus = storyPhase === 'flight'
    ? `Moving to ${currentStory?.title ?? 'story step'}`
    : storyPhase === 'arrival'
      ? 'Arriving…'
      : storyPlaying
        ? 'Playing'
        : storyInterruption
          ? 'Interrupted'
          : 'Paused';
  const storyControlLabel = storyPhase === 'flight'
    ? 'Pause camera flight'
    : storyPhase === 'arrival'
      ? 'Pause arrival settle'
      : returnToStoryFrameRequired
        ? 'Return to story frame to resume'
        : pausedStoryPhaseRef.current === 'flight'
          ? 'Resume camera flight'
          : storyPlaying
            ? 'Pause narration'
            : 'Resume narration';
  const storyControlActive = storyPlaying || storyPhase === 'flight' || storyPhase === 'arrival';
  const selectedLead = inspectorEntityLead({ summary: selectedSummary, honestyDetails: scanFixture?.enrichmentHonesty?.details });
  const selectedDiagramCount = inspectorDiagramCount({ hasCodeStructure: hasCodeStructureDiagram, hasDependency: hasDependencyDiagram, namedDiagramCount: namedDiagramStories.length });

  function openDockedAsk() {
    setAskDocked(true);
    setInspectorAskActive(true);
    setAskOpen(true);
    setDetailsOpen(true);
    setDetailsWidth(width => Math.max(width, clampInspectorWidth(520, window.innerWidth)));
    setSafeAreaEpoch(epoch => epoch + 1);
    window.setTimeout(() => askTabRef.current?.focus({ preventScroll: true }), 0);
  }

  const askPanelVisible = !currentStory && query.fixture !== 'stress' && !portableAtlas && !askHidden && askOpen;
  const askPanelView = (
    <AskPanel
      placement={askDocked ? 'docked' : 'floating'}
      onTogglePlacement={() => { if (askDocked) { setAskDocked(false); setInspectorAskActive(false); } else openDockedAsk(); }}
      auth={askAuth}
      citationsFor={turn => askCitationChips(turn, {
        sceneEntity: id => scene.entities.find(entity => entity.id === id),
        snapshotName: id => activeSnapshot.entities.find(entity => entity.id === id)?.name,
      })}
      connected={askConnected}
      error={askError}
      inputRef={askInputRef}
      latestTurnId={askLatestTurnId}
      mapTurnId={visibilityMode === 'isolate' ? askMapFocus?.turnId : undefined}
      onClose={() => { setAskOpen(false); window.setTimeout(() => askButtonRef.current?.focus(), 0); }}
      onFocusCitation={id => {
        // Same path as inspector Parent/Children/implementation links: load the neighborhood,
        // land on the band that draws the cited entity (declarations enter their owner's L4),
        // then frame it inside the map safe area (which accounts for this panel).
        cancelAskMapShow();
        setInspectorAskActive(false);
        void openInspectorChild(id).then(() => frameAskCitationWhenSettled(id)).catch(() => setLiveMessage('Unable to load this part of the map. Please try again.'));
      }}
      onOpenCitationSource={id => {
        cancelAskMapShow();
        // Only switch to Source if the drill actually landed on the cited part.
        void openInspectorChild(id).then(() => { if (inspectorSelectionRef.current === id) selectInspectorTab('source', false); }).catch(() => setLiveMessage('Unable to load this part of the map. Please try again.'));
      }}
      onQuestionChange={setQuestion}
      onRestoreMap={restoreAskMapView}
      onShowOnMap={(citedIds, turn) => { void showAskTurnOnMap(citedIds, turn.id); }}
      onSubmit={submitQuestion}
      pendingQuestion={askPending}
      warmingUp={askWarmingUp}
      question={question}
      returnPath={askReturnPath}
      signedIn={askSignedIn}
      state={askState}
      turns={askThread?.turns ?? []}
            />
  );

  return (
    <div className="app-shell" data-active-diagram-id={activeDiagramSurface.id} data-atlas-source={importedAtlas ? 'imported-mermaid' : scanFixture ? 'scan' : 'golden'} data-embed={isEmbedChrome({ framed: isFramedBrowsingContext(), embedQuery: isEmbedQueryFlag(window.location.search) }) ? 'true' : 'false'} data-atlas-enrichment-why={scanFixture?.enrichmentHonesty?.why ?? ''} data-authoring-history-future={authoringHistory.future.length} data-authoring-history-past={authoringHistory.past.length} data-authoring-tool={authoringTool} data-backend={query.backend} data-camera-settled-epoch={cameraSettledEpoch} data-detail={activeDetail} data-dev-mode={devMode ? 'true' : 'false'} data-fixture={query.fixture} data-interaction-mode={interactionMode} data-lens-phase={semanticLens.phase} data-lens-progress={semanticLens.progress.toFixed(3)} data-lens-target={semanticLens.targetId ?? ''} data-navigation-state={serializeNavigationState(settledNavigation)} data-projection-entity-count={activeProjectionEntityIds.length} data-projection-override-id={projectionOverride?.id ?? ''} data-projection-override-object-count={projectionOverride?.objects.length ?? 0} data-projection-override-path-count={projectionOverride?.paths.length ?? 0} data-projection-relation-count={activeProjectionRelationIds.length} data-renderer-replay-state={rendererReplayState} data-root-entity-id={navigationIdentity.rootEntityId} data-scan-boot={scanFixture?.boot ?? ''} data-seed={query.seed} data-selected-entity-id={selected.id} data-testid="atlas-app" data-visibility-mode={visibilityMode}>
      <a className="skip-link" href={mainDiagramActive ? '#entity-explorer' : '#derived-diagram-content'}>{mainDiagramActive ? 'Skip to entity explorer' : 'Skip to active diagram'}</a>
      <header className="topbar">
        <a className="brand-block" data-testid="atlas-brand-link" {...brandHomeLinkProps()}>
          <SourceForMark className="brand-mark" size={30}/>
          <div>
            <div className="brand-line"><strong>Source For</strong><span className="brand-name">Atlas</span><span className="brand-product">PREVIEW</span></div>
          </div>
        </a>

        <div className="search-zone">
          <button aria-expanded={searchOpen} className="search-trigger" onClick={() => setSearchOpen(true)} type="button">
            <SearchIcon size={16}/><span>Find a system, flow, or source file…</span><kbd>⌘ K</kbd>
          </button>
          {searchOpen && (
            <div className="search-popover" role="dialog" aria-label="Search architecture">
              <div className="search-input-row"><SearchIcon/><input autoFocus id="atlas-search" onChange={event => setSearch(event.target.value)} onKeyDown={event => { event.stopPropagation(); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); return; } if (event.key === 'Escape') { event.preventDefault(); setSearchOpen(false); } }} onKeyPress={event => event.stopPropagation()} placeholder="Search architecture and code" value={search}/><button aria-label="Close search" onClick={() => setSearchOpen(false)}><CloseIcon/></button></div>
              <p className="popover-label" role="status">{searchPending ? 'Searching…' : search.trim() ? `${searchResults.length} MATCHES` : 'ON THIS MAP'}</p>
              {devMode && <small data-search-backend={workerSearch.backend}>Search: {workerSearch.backend} · {workerSearch.status}</small>}
              <div aria-busy={searchPending} className="search-results" role="listbox">
                {searchResults.map(entity => <button aria-selected={entity.id === selectedId} key={entity.id} onClick={() => focusEntity(entity, 'push', 'frame')} role="option"><span className={`result-icon kind-${entity.kind}`}>{(entity.kindLabel ?? entity.kind).slice(0, 2).toUpperCase()}</span><span><strong>{entity.name}</strong><small>{[entity.kindLabel ?? entity.kind, entity.source ?? inspectorAcceptedSummary(entity)].filter(Boolean).join(' · ')}</small></span><span className="result-enter">↵</span></button>)}
                {!searchPending && !searchResults.length && <p className="empty-state">No architecture entities match that query.</p>}
              </div>
            </div>
          )}
        </div>

        <div className="top-actions">
          <button
            aria-haspopup="dialog"
            aria-label="Import Mermaid diagram"
            className="icon-button"
            data-testid="import-mermaid"
            onClick={() => { setImportMermaidError(undefined); setImportMermaidOpen(true); }}
            title="Import Mermaid"
            type="button"
          >
            <FileIcon/>
          </button>
          <details className="diagram-add-menu screenshot-menu" ref={screenshotMenuRef}>
            <summary aria-label="Capture screenshot" title="Capture screenshot"><ImageIcon size={16}/></summary>
            <div>
              <button onClick={() => { void captureScreenshot('copy'); }} type="button">Copy image</button>
              <button onClick={() => { void captureScreenshot('save'); }} type="button">Save PNG</button>
            </div>
          </details>
          <button
            aria-describedby={shareFeedback ? 'share-view-feedback' : undefined}
            aria-label={shareFeedback?.tone === 'success' ? 'Current view link copied' : 'Copy current view link'}
            className={`icon-button share-view-button ${shareFeedback?.tone === 'success' ? 'copied' : ''}`}
            onClick={() => { void copyCurrentView(); }}
            ref={shareButtonRef}
            title="Copy current view"
            type="button"
          >
            {shareFeedback?.tone === 'success' ? <CheckIcon/> : <ShareIcon/>}
          </button>
          {embedAtlas.visible && <EmbedAtlasControl displayNames={embedAtlas.displayNames} readPageHref={readCurrentViewHref}/>}
          {sourceRepositoryUrl && <SourceRepoLink url={sourceRepositoryUrl}/>}
          {!portableAtlas && askAuth !== undefined && askAuth.publicMode !== true && <details className="diagram-add-menu screenshot-menu account-menu"><summary aria-label={askSignedIn ? `Account menu for @${askAuth?.login}` : 'Sign in with GitHub'} className="avatar-button" data-testid="account-menu" title={askSignedIn ? `@${askAuth?.login}` : 'Sign in with GitHub'}>{accountInitials(askAuth?.login)}</summary><div>{askSignedIn ? <><p>@{askAuth?.login}</p>{askAuth?.accountPath ? <a data-testid="account-page-link" href={askAuth.accountPath}>Account</a> : null}<OperatorMenuLink signedIn={askSignedIn}/><a href={askSignInHref(askAuth?.logoutPath ?? '/api/auth/logout', askReturnPath)}>Sign out</a></> : <><a data-testid="account-signin" href={askSignInHref(askAuth?.loginPath ?? '/api/auth/github', askReturnPath)}>Sign in with GitHub</a>{askAuth?.testLoginPath ? <a data-testid="account-test-login" href={askSignInHref(askAuth.testLoginPath, askReturnPath)}>Use the local test sign-in</a> : null}</>}</div></details>}
        </div>
      </header>

      {shareFeedback && (
        <div
          aria-atomic="true"
          aria-live={shareFeedback.tone === 'error' ? 'assertive' : 'polite'}
          className={`share-feedback ${shareFeedback.tone}`}
          id="share-view-feedback"
          role={shareFeedback.tone === 'error' ? 'alert' : 'status'}
        >
          <span className="share-feedback-icon">{shareFeedback.tone === 'success' ? <CheckIcon size={15}/> : <InfoIcon size={15}/>}</span>
          <div>
            <strong>{shareFeedback.tone === 'success' ? 'View link copied' : 'Copy link manually'}</strong>
            <p>{shareFeedback.message}</p>
            {shareFeedback.tone === 'error' && (
              <label className="share-fallback-field">
                <span className="sr-only">Current view link</span>
                <input onFocus={event => event.currentTarget.select()} readOnly ref={shareFallbackRef} value={shareFeedback.url}/>
              </label>
            )}
          </div>
          <button aria-label="Dismiss copy link message" onClick={dismissShareFeedback} type="button"><CloseIcon size={14}/></button>
        </div>
      )}

      <nav aria-label="Diagram views" className="diagram-view-bar">
        <div aria-label="Open diagrams" className="diagram-tabs" onKeyDown={navigateDiagramTabs} role="tablist">
          {diagramSurfaces.map(surface => <div className={`diagram-tab-shell ${surface.id === diagramWorkspace.activeSurfaceId ? 'active' : ''}`} key={surface.id}>
            <button aria-controls="diagram-workspace-panel" aria-label={surface.kind === 'main' ? 'Main diagram, pinned' : surface.kind === 'source' ? `${surface.title} source` : `${surface.title} ${surface.kind} diagram`} aria-selected={surface.id === diagramWorkspace.activeSurfaceId} className="diagram-tab" id={diagramTabDomId(surface.id)} onClick={() => activateDiagramView(surface.id)} role="tab" tabIndex={surface.id === diagramWorkspace.activeSurfaceId ? 0 : -1} type="button">{surface.kind !== 'main' && <span aria-hidden="true" className={`diagram-kind-mark kind-${surface.kind}`}>{surface.kind === 'flow' ? 'F' : surface.kind === 'mermaid' ? 'MR' : surface.kind === 'source' ? 'S' : 'C'}</span>}<span>{surface.title}</span></button>
            {surface.closable && <button aria-label={`Close ${surface.title} ${surface.kind === 'source' ? 'source' : 'diagram'}`} className="diagram-tab-close" onClick={() => closeDiagramView(surface.id)} type="button"><CloseIcon size={12}/></button>}
          </div>)}
        </div>

        <div className="mobile-diagram-switcher">
          <label><span>Views</span><select aria-label="Active diagram view" onChange={event => activateDiagramView(event.target.value)} value={diagramWorkspace.activeSurfaceId}>{diagramSurfaces.map(surface => <option key={surface.id} value={surface.id}>{surface.title}{surface.kind === 'main' ? '' : ` · ${surface.kind}`}</option>)}</select></label>
          {activeDiagramSurface.closable && <button aria-label={`Close ${activeDiagramSurface.title} diagram`} onClick={() => closeDiagramView(activeDiagramSurface.id)} type="button"><CloseIcon size={14}/></button>}
        </div>

        {devMode && <details className="diagram-add-menu" ref={diagramAddMenuRef}>
          <summary aria-label="Create diagram" title="Create diagram"><span aria-hidden="true">+</span><em>Diagram</em></summary>
          <div>{hasCodeStructureDiagram ? <button onClick={() => openDerivedDiagram('code')} type="button"><CodeIcon size={14}/><span><strong>Code structure</strong><small>Captured code-level children</small></span></button> : <p className="detail-muted">No evidence-backed named diagram is available.</p>}</div>
        </details>}
      </nav>

      <main aria-label={`${activeDiagramSurface.title} diagram workspace`} aria-labelledby={diagramTabDomId(activeDiagramSurface.id)} className={`workspace ${mainDiagramActive && detailsOpen ? 'has-details' : ''}`} id="diagram-workspace-panel" role="tabpanel" style={{ '--details-width': `${detailsWidth}px` } as CSSProperties}>
        {activeDiagramSurface.kind === 'main' ? <>
        <section className="map-stage" aria-label="Architecture workspace">
          <CanvasViewport
            cameraPublicationGuard={cameraPublicationGuardRef.current}
            inspectorFlightCameraRef={inspectorFlightCameraRef}
            semanticRenderPacketRef={semanticRenderPacketRef}
            semanticLensSession={semanticLensSession}
            activeRelationIds={activeRelationIds}
            animationActive={animationActive}
            inspectorFlightActive={inspectorFlightActive}
            authoringDetail={activeDetail}
            authoringEnabled={editingEnabled}
            authoringEntityIds={authoringEntityIds}
            authoringTool={authoringTool}
            camera={camera}
            cinematicTransition={cinematicTransition}
            flowActive={flowActive}
            flowRelationIds={flowRelationIds}
            focusedIds={focusedIds}
            relationFocusIds={relationFocus.endpointIds}
            onCameraSettled={settleCamera}
            onCameraFlightCancel={cancelInspectorCameraFlight}
            onCreateRelationship={createRelationship}
            onDiagnostics={setDiagnostics}
            onGuideRelationship={guideRelationship}
            onInteractionStart={interruptStory}
            onLensCancel={cancelSemanticLensAt}
            onLensPan={stabilizeSemanticLensForPan}
            onLodState={publishLodState}
            onNavigationFlush={flushNavigation}
            onOpenInside={openInside}
            onPick={handlePick}
            onSemanticZoom={handleSemanticZoom}
            onSemanticZoomBurstStart={beginSemanticZoomBurst}
            scanZoomAdoptRawRef={scanZoomAdoptRawRef}
            onViewportChange={setViewport}
            projectionOverride={relationFocus.projectionOverride}
            reduceMotion={reduceMotion}
            requestedBackend={query.backend}
            scene={scene}
            selectedId={rendererSelectedId}
            selectedRelationId={pickedRelationId}
            setCamera={setCamera}
            visibilityMode={effectiveVisibilityMode}
          />

          {devMode && <div aria-label="Diagram interaction mode" className={`authoring-toolbar mode-${interactionMode}`} data-enabled={editingEnabled ? 'true' : 'false'} role="toolbar">
            <div aria-label="Interaction mode" className="diagram-mode-toggle" role="group">
              <button aria-pressed={interactionMode === 'view'} className={interactionMode === 'view' ? 'active' : ''} data-testid="interaction-mode-view" onClick={() => changeInteractionMode('view')} title="Inspect architecture without editing" type="button"><span aria-hidden="true" className="mode-indicator"/>View</button>
              <button aria-pressed={interactionMode === 'edit'} className={interactionMode === 'edit' ? 'active' : ''} data-testid="interaction-mode-edit" onClick={() => changeInteractionMode('edit')} title="Reveal relationship authoring tools" type="button"><span aria-hidden="true" className="mode-indicator"/>Edit</button>
            </div>
            {interactionMode === 'edit' && <div aria-label="Relationship authoring tools" className="authoring-edit-tools" role="group">
              <span aria-hidden="true" className="authoring-toolbar-divider"/>
              <button aria-pressed={authoringTool === 'select'} className={authoringTool === 'select' ? 'active' : ''} data-testid="authoring-tool-select" disabled={!authoringEnabled} onClick={() => setAuthoringTool('select')} title="Select relationships and route guides (V)" type="button">Select</button>
              <button aria-pressed={authoringTool === 'connect'} className={authoringTool === 'connect' ? 'active' : ''} data-testid="authoring-tool-connect" disabled={!authoringEnabled} onClick={() => setAuthoringTool('connect')} title="Connect visible nodes (C)" type="button">Connect</button>
              <span aria-hidden="true" className="authoring-toolbar-divider"/>
              <button aria-label="Undo relationship edit" data-testid="authoring-undo" disabled={!authoringEnabled || !authoringHistory.past.length} onClick={undoAuthoringGesture} title="Undo (⌘Z)" type="button">↶</button>
              <button aria-label="Redo relationship edit" data-testid="authoring-redo" disabled={!authoringEnabled || !authoringHistory.future.length} onClick={redoAuthoringGesture} title="Redo (⇧⌘Z)" type="button">↷</button>
              <button data-testid="relationship-reset-route" disabled={!authoringEnabled || !selectedRouteOverride} onClick={resetSelectedRelationshipRoute} title="Return the selected relationship to automatic routing" type="button">Auto route</button>
              <button data-testid="relationship-delete" disabled={!authoringEnabled || !pickedRelationId} onClick={deleteSelectedRelationship} title="Delete selected relationship" type="button">Delete</button>
            </div>}
          </div>}

          <div className="map-heading">
            <h1>{scene.title}</h1>
            {initialDetailLoading && <small role="status">Loading more detail…</small>}
            <nav aria-label="Architecture ancestry" className="semantic-breadcrumb">
              {breadcrumbState.chain.map((entity, index) => <span key={entity.id}>{index > 0 && <ChevronIcon size={9}/>} {entity.id === navigationIdentity.rootEntityId ? <b aria-current="page">{entity.name}</b> : <button onClick={() => navigateRoot(entity.id)}>{entity.name}</button>}</span>)}
              {breadcrumbState.descendant && <span className="selected-descendant"><ChevronIcon size={9}/><em>{breadcrumbState.descendant.name}</em></span>}
            </nav>
          </div>

          <nav aria-label="Architecture detail level" className="level-rail">
            <div className="rail-icon"><LayersIcon/></div>
            {levels.map((level, index) => <button aria-current={activeLevel === index ? 'true' : undefined} aria-label={`${level.name} level`} className={activeLevel === index ? 'active' : ''} key={level.name} onClick={() => selectLevel(index)}><span>{level.short}</span><em>{level.name}</em></button>)}
          </nav>

          <div className="zoom-controls" aria-label="Map controls">
            <button aria-label="Zoom in" onClick={() => semanticZoomControl('inward')}><ZoomInIcon/></button>
            <button aria-label="Zoom out" onClick={() => semanticZoomControl('outward')}><ZoomOutIcon/></button>
            <button aria-label="Fit architecture to view" onClick={() => {
              const next = frameVisibleProjection(scene, activeProjectionEntityIds, activeDetail, viewport, measureCurrentMapSafeArea()) ?? camera;
              navigateCamera(next, 'replace', 'Fit the current architecture scope');
            }}><FitIcon/></button>
          </div>

          <Minimap camera={camera} onPan={(next, phase) => {
            if (phase === 'move') {
              setCamera(() => next);
              return;
            }
            navigateCamera(next, 'replace', 'Panned the map overview');
            // A finished minimap pan gets the same stationary-pan lens handoff as a
            // canvas drag: the sibling now under the safe centre takes lens ownership,
            // so the node the user panned to reveals its interior.
            if (phase === 'settle') stabilizeSemanticLensForPan(next);
          }} scene={scene} viewport={viewport} projectionOverride={relationFocus.projectionOverride} reduceMotion={reduceMotion} activeDetail={activeDetail}/>

          {devMode && <button aria-expanded={diagnosticsOpen} aria-label={`Renderer backend: ${backendPresentation.title}`} className={`render-status backend-${backendPresentation.tone}`} data-active-backend={diagnostics.activeBackend} data-testid="renderer-status" onClick={() => setDiagnosticsOpen(open => !open)}>
            <span className="status-light"/><span><b>{backendPresentation.title}</b><small>{backendPresentation.detail} · {Math.round(diagnostics.lastFrameMs * 10) / 10}ms · {Math.round(camera.zoom * 100)}%</small></span><InfoIcon size={14}/>
          </button>}
          {devMode && diagnosticsOpen && <aside className="diagnostics-card" data-testid="diagnostics-panel">
            <button type="button" onClick={() => {
              if (!zoomTraceRecording) {
                zoomMotionTrace.start({
                  timeOrigin: performance.timeOrigin,
                  startedAtMs: performance.now(),
                  snapshotId: navigationIdentity.snapshotId,
                  sceneId: scene.id,
                  backend: diagnostics.activeBackend,
                });
                setZoomTraceRecording(true);
                setLiveMessage('Zoom trace recording started. Wheel inputs and rendered frames are captured locally.');
              } else {
                const trace = zoomMotionTrace.stop();
                setZoomTraceRecording(false);
                if (trace) {
                  const json = JSON.stringify(trace);
                  setLastZoomTrace(json);
                  downloadBlob(new Blob([json], { type: 'application/json' }), `okie-zoom-trace-${Date.now()}.json`);
                  setLiveMessage(`Zoom trace saved: ${trace.samples.length} samples${trace.truncated ? ', capture limit reached' : ''}.`);
                }
              }
            }}>{zoomTraceRecording ? 'Save zoom trace' : 'Start zoom trace'}</button>
            {lastZoomTrace && <details><summary>Last zoom trace JSON</summary><textarea aria-label="Last zoom trace JSON" readOnly value={lastZoomTrace}/></details>}
            <div className="diagnostics-title"><ActivityIcon/><strong>Renderer diagnostics</strong><button aria-label="Close diagnostics" onClick={() => setDiagnosticsOpen(false)}><CloseIcon size={15}/></button></div>
            <dl>
              <div><dt>Source</dt><dd>local › okie · frozen worktree fixture</dd></div>
              <div><dt>Projection</dt><dd>{activeProjectionEntityIds.length.toLocaleString()} visible entities · {activeProjectionRelationIds.length.toLocaleString()} relationships{query.fixture === 'stress' ? ' · deterministic benchmark' : ' · evidence-linked'}</dd></div>
              <div><dt>Requested</dt><dd>{diagnostics.requestedBackend}</dd></div>
              <div><dt>Active backend</dt><dd>{diagnostics.activeBackend}</dd></div>
              <div><dt>Execution</dt><dd>{diagnostics.gpuAccelerated ? 'hardware accelerated' : 'compatibility / CPU'}</dd></div>
              <div><dt>Scene</dt><dd>{diagnostics.entityCount.toLocaleString()} / {diagnostics.relationCount.toLocaleString()}</dd></div>
              {diagnostics.visibleEntities !== undefined && <div><dt>Visible</dt><dd>{diagnostics.visibleEntities.toLocaleString()} / {(diagnostics.visibleRelations ?? 0).toLocaleString()}</dd></div>}
              {diagnostics.candidateEntities !== undefined && <div><dt>Candidates</dt><dd>{diagnostics.candidateEntities.toLocaleString()} / {(diagnostics.candidateRelations ?? 0).toLocaleString()}</dd></div>}
              {diagnostics.culledEntities !== undefined && <div><dt>Culled</dt><dd>{diagnostics.culledEntities.toLocaleString()} / {(diagnostics.culledRelations ?? 0).toLocaleString()}</dd></div>}
              {diagnostics.frameP50Ms !== undefined && <div><dt>Frame p50 / p95 / p99</dt><dd>{diagnostics.frameP50Ms.toFixed(1)} / {(diagnostics.frameP95Ms ?? 0).toFixed(1)} / {(diagnostics.frameP99Ms ?? 0).toFixed(1)} ms</dd></div>}
              {diagnostics.drawCalls !== undefined && <div><dt>Draw calls</dt><dd>{diagnostics.drawCalls.toLocaleString()}</dd></div>}
              {diagnostics.meshBuildMs !== undefined && <div><dt>Mesh build</dt><dd>{diagnostics.meshBuildMs.toFixed(2)} ms{diagnostics.meshRebuilt ? ' · rebuilt' : ' · cached'}</dd></div>}
              {diagnostics.geometryUploadBytes !== undefined && <div><dt>Geometry upload</dt><dd>{diagnostics.geometryUploadBytes.toLocaleString()} B · {(diagnostics.geometryBufferUploads ?? 0).toLocaleString()} buffers</dd></div>}
              {diagnostics.staticMeshRevision !== undefined && <div><dt>Static mesh rev / cumulative</dt><dd>{diagnostics.staticMeshRevision} · {(diagnostics.cumulativeStaticGeometryUploadBytes ?? 0).toLocaleString()} B</dd></div>}
              {diagnostics.dynamicIndexUploadBytes !== undefined && <div><dt>Dynamic index / style</dt><dd>{diagnostics.dynamicIndexUploadBytes.toLocaleString()} / {(diagnostics.dynamicStyleUploadBytes ?? 0).toLocaleString()} B</dd></div>}
              {diagnostics.lodUniformUploadBytes !== undefined && <div><dt>LOD uniform / cumulative</dt><dd>{diagnostics.lodUniformUploadBytes.toLocaleString()} / {(diagnostics.cumulativeLodUniformUploadBytes ?? 0).toLocaleString()} B</dd></div>}
              {diagnostics.residentPartitionTotal !== undefined && <div><dt>Resident partitions</dt><dd>{(diagnostics.residentPartitionActive ?? 0).toLocaleString()} / {diagnostics.residentPartitionTotal.toLocaleString()} · {(diagnostics.drawRangeCount ?? 0).toLocaleString()} ranges</dd></div>}
              {diagnostics.frameSampleCount !== undefined && <div><dt>Frame samples</dt><dd>{diagnostics.frameSampleCount} / {(diagnostics.totalFrameCount ?? diagnostics.frameSampleCount).toLocaleString()} total · initial {diagnostics.frameWindowIncludesInitialBuild ? 'included' : 'excluded'}</dd></div>}
              {diagnostics.glyphQuads !== undefined && <div><dt>Glyph quads</dt><dd>{diagnostics.glyphQuads.toLocaleString()}</dd></div>}
              {(diagnostics.deferredTextPrimitives !== undefined || diagnostics.deferredIconPrimitives !== undefined) && <div><dt>Deferred text / icons</dt><dd>{(diagnostics.deferredTextPrimitives ?? 0).toLocaleString()} / {(diagnostics.deferredIconPrimitives ?? 0).toLocaleString()}</dd></div>}
              <div><dt>Fixture / seed</dt><dd>{query.fixture} / {query.seed}</dd></div>
              {scene.scopedCompile && <div><dt>Scoped compile</dt><dd>bands→{scene.scopedCompile.maxBand ?? 'code'} · {scene.scopedCompile.entityCount.toLocaleString()} entities &gt; {scene.scopedCompile.bandDepthThreshold.toLocaleString()} threshold{scene.scopedCompile.maxEdgesPerBand ? ` · ≤${scene.scopedCompile.maxEdgesPerBand} edges/band` : ''}{scene.scopedCompile.maxNodesPerBand ? ` · ≤${scene.scopedCompile.maxNodesPerBand} nodes/band` : ''}{scene.omittedNodes?.length ? ` · ${scene.omittedNodes.length} off-camera` : ''}{scene.scopedCompile.maxGridNodes ? ` · grid ${scene.scopedCompile.maxGridNodes.toLocaleString()}` : ''}{scene.scopedCompile.directFallbackCount ? ` · ${scene.scopedCompile.directFallbackCount} direct-fallback` : ''}</dd></div>}
              {scene.scanGuardRefusal && <div><dt>Scan guard</dt><dd>unscoped compile of {scene.scanGuardRefusal.requestedFocusId} refused ({scene.scanGuardRefusal.entityCount.toLocaleString()} entities · {scene.scanGuardRefusal.relationCount.toLocaleString()} relations) → fell back to {scene.scanGuardRefusal.fallbackFocusId}</dd></div>}
              {scene.scanDrillRecompile && <div><dt>Drill recompile</dt><dd>{scene.scanDrillRecompile.targetId} · deeper band {scene.scanDrillRecompile.deeperDetail} absent → recompiled via guarded seam</dd></div>}
            </dl>
            <p>{diagnostics.message}</p>
            {query.warnings.map(warning => <p className="diagnostic-warning" key={warning}>{warning}</p>)}
          </aside>}

          <button aria-controls="architecture-inspector" aria-expanded={detailsOpen} className="details-toggle" aria-label={detailsOpen ? 'Close details panel' : 'Open details panel'} onClick={toggleDetails} ref={detailsOpenerRef}><PanelIcon/></button>

          <details className="entity-explorer">
            <summary aria-label="Toggle entity list" id="entity-explorer"><LayersIcon size={15}/><span>Entity list</span></summary>
            <div className="entity-explorer-list" aria-label="Architecture entities" data-explorer-count={visibleExplorerEntities.length} data-testid="entity-explorer-list">
              <p>KEYBOARD EXPLORER · {visibleExplorerEntities.length.toLocaleString()} ENTITIES</p>
              {visibleExplorerEntities.map(entity => <button aria-current={entity.id === selectedId ? 'true' : undefined} key={entity.id} onClick={() => focusEntity(entity)}><span className={`result-icon kind-${entity.kind}`}>{(entity.kindLabel ?? entity.kind).slice(0, 2).toUpperCase()}</span><span><strong>{entity.name}</strong><small>{inspectorSecondaryCopy(entity)}</small></span></button>)}
            </div>
          </details>

          {currentStory ? (
            <section aria-label={`Guided architecture story, ${storyPlaybackStatus}`} className="story-player" data-playback-state={storyPhase === 'flight' ? 'moving' : storyPhase === 'arrival' ? 'arriving' : storyPlaying ? 'playing' : 'paused'} data-story-id={storyId} data-story-phase={storyPhase}>
              <div className="story-topline"><span><SparkIcon size={14}/> GUIDED EXPLANATION <em className="story-state">{storyPlaybackStatus}</em></span><button aria-label="Close story" onClick={closeStory}><CloseIcon size={15}/></button></div>
              <div className="story-copy"><div><small>{storyPhase === 'flight' ? 'MOVING TO ' : storyPhase === 'arrival' ? 'ARRIVING AT ' : ''}STEP {storyStep + 1} OF {story.steps.length}</small><h2>{currentStory.title}</h2><p>{currentStory.narration}</p>{currentStory.sourceRefs[0] && <p className="story-evidence">Evidence: {currentStory.sourceRefs[0].path}{currentStory.sourceRefs[0].symbol ? ` · ${currentStory.sourceRefs[0].symbol}` : ''}</p>}{storyInterruption && <p className="story-interruption">{storyInterruption}</p>}{returnToStoryFrameRequired && <button onClick={returnToStoryFrame}>Return to story frame</button>}</div><button aria-label={storyControlLabel} className="story-play" onClick={returnToStoryFrameRequired ? returnToStoryFrame : toggleStoryPlayback}>{storyControlActive ? <PauseIcon/> : <PlayIcon/>}</button></div>
              <div className="story-progress">{story.steps.map((step, index) => <button aria-label={`Go to story step ${index + 1}: ${step.title}`} className={index === storyStep ? 'active' : index < storyStep ? 'passed' : ''} key={step.id} onClick={() => setStep(index, false)}><span/></button>)}</div>
              <div className="story-context-controls" role="group" aria-label="Story context visibility">
                <button aria-pressed={visibilityMode === 'dim'} onClick={() => changeVisibility('dim')}>Dim others</button>
                <button aria-pressed={visibilityMode === 'isolate'} onClick={() => changeVisibility('isolate')} ref={visibilityControlRef}>Isolate focus</button>
                <button disabled={visibilityMode === 'all'} onClick={restoreVisibility}>Restore full view</button>
              </div>
              {effectiveVisibilityMode === 'isolate' && <div className="isolation-status" role="status">Showing {isolatedEntityIds.length} of {scene.entities.length} · <button onClick={restoreVisibility}>Restore full view</button></div>}
              <div className="story-footer"><button aria-label="Previous story step, paused" onClick={() => setStep(storyStep - 1, false)}>Previous</button><button aria-label={storyStep === story.steps.length - 1 ? 'Replay story from the beginning, paused' : 'Next story step, paused'} onClick={() => setStep(storyStep + 1, false)}>{storyStep === story.steps.length - 1 ? <><RestartIcon size={15}/> Replay</> : <>Next <ArrowIcon size={15}/></>}</button></div>
            </section>
          ) : query.fixture === 'stress' ? (
            <div className="stress-badge"><ActivityIcon size={15}/><span><b>Renderer stress fixture</b><small>{fixtureError ?? `${scene.entities.length.toLocaleString()} nodes · ${scene.relations.length.toLocaleString()} paths`}</small></span></div>
          ) : (
            <div className="story-launcher" data-story-catalog-count={storyCatalog.length}>
              <div className="ask-anchor">
              {!portableAtlas && !askHidden && <button className="ask-button" onClick={() => { if (!askOpen) requestAskReframe(); if (askDocked && (!askOpen || !inspectorAskActive || !detailsOpen)) openDockedAsk(); else setAskOpen(!askOpen); }} ref={askButtonRef}><SparkIcon/><span><b>Ask Atlas</b><small>Explain this codebase spatially</small></span><kbd>⌘ ↵</kbd></button>}
              </div>
              {storyCatalog.length === 1 ? storyCatalog.map(plan => (
                <button
                  className="saved-story"
                  data-story-id={plan.id}
                  data-testid={plan.id === defaultStory.id ? 'story-launch-overview' : 'story-launch-flow'}
                  key={plan.id}
                  onClick={() => setStep(0, true, 'push', plan)}
                  type="button"
                >
                  <PlayIcon size={14}/> {plan.title} <span>{storyDurationLabel(plan)}</span>
                </button>
              )) : (
                <details className="story-catalog-menu">
                  <summary aria-label="Guided architecture tours"><PlayIcon size={14}/> Guided tours <em>{storyCatalog.length}</em></summary>
                  <div>
                    {storyCatalog.map(plan => (
                      <button
                        className="story-catalog-item"
                        data-story-id={plan.id}
                        data-testid={plan.id === defaultStory.id ? 'story-launch-overview' : 'story-launch-flow'}
                        key={plan.id}
                        onClick={() => setStep(0, true, 'push', plan)}
                        type="button"
                      >
                        <PlayIcon size={14}/><span><strong>{plan.title}</strong><small>{storyDurationLabel(plan)}</small></span>
                      </button>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
          {askPanelVisible && !askDocked ? askPanelView : null}
          {!currentStory && visibilityMode === 'isolate' && askMapFocus && !askOpen && <div className="ask-map-status" data-ask-map-status="" role="status">Showing {askMapFocus.entityIds.length} cited part{askMapFocus.entityIds.length === 1 ? '' : 's'} from Ask · <button onClick={restoreAskMapView} type="button">Restore full view</button></div>}

          <div className="canvas-hint"><span>Pinch or wheel to zoom</span><i/>drag to pan<i/>click to inspect<i/>double-click to open inside</div>

        </section>

        <aside aria-hidden={detailsOpen ? undefined : true} aria-label={pickedRelationPresentation ? 'Selected architecture relationship inspector' : 'Selected architecture entity inspector'} className={`details-panel ${detailsOpen ? 'open' : ''} ${inspectorAskActive && askPanelVisible ? 'has-ask' : ''}`} id="architecture-inspector" inert={!detailsOpen} ref={detailsPanelRef}>
          <div aria-label="Resize inspector" aria-orientation="vertical" aria-valuemax={detailsWidthRange.max} aria-valuemin={detailsWidthRange.min} aria-valuenow={detailsWidth} className="details-resizer" onDoubleClick={() => { setDetailsWidth(defaultInspectorWidth(window.innerWidth)); setSafeAreaEpoch(epoch => epoch + 1); window.setTimeout(() => reframeEntityAfterInspectorChange(selected), 0); }} onKeyDown={resizeInspectorWithKeyboard} onPointerDown={beginInspectorResize} role="separator" tabIndex={0}/>
          <header className="details-header">
            <div className="details-header-title"><span>{inspectorAskActive && askPanelVisible ? 'ASK' : inspectorTab === 'overview' ? 'OVERVIEW' : 'DETAILS'}</span><small>{inspectorAskActive && askPanelVisible ? 'Your codebase conversation' : inspectorTab === 'overview' ? 'Architecture brief' : 'Evidence-backed'}</small></div>
            <div className="details-header-actions">
              {inspectorHistory.length > 0 && <button aria-label="Back to previous inspector selection" data-testid="inspector-back" onClick={navigateInspectorBack} title="Back within details panel" type="button"><span aria-hidden="true">←</span></button>}
              <button aria-label="Close details panel" onClick={closeDetails}><CloseIcon/></button>
            </div>
          </header>
          <div aria-label="Inspector view" className="inspector-tabs" data-inspector-tab={inspectorAskActive && askPanelVisible ? 'ask' : inspectorTab} onKeyDown={navigateInspectorTabs} role="tablist">
            <button aria-controls="overview-panel" aria-selected={!(inspectorAskActive && askPanelVisible) && inspectorTab === 'overview'} id="overview-tab" onClick={() => selectInspectorTab('overview')} ref={overviewTabRef} role="tab" tabIndex={!(inspectorAskActive && askPanelVisible) && inspectorTab === 'overview' ? 0 : -1} type="button">Overview</button>
            <button aria-controls="source-panel" aria-selected={!(inspectorAskActive && askPanelVisible) && inspectorTab === 'source'} id="source-tab" onClick={() => selectInspectorTab('source')} ref={sourceTabRef} role="tab" tabIndex={!(inspectorAskActive && askPanelVisible) && inspectorTab === 'source' ? 0 : -1} type="button">Source</button>
            <button aria-controls="details-panel" aria-selected={!(inspectorAskActive && askPanelVisible) && inspectorTab === 'details'} id="details-tab" onClick={() => selectInspectorTab('details')} ref={detailsTabRef} role="tab" tabIndex={!(inspectorAskActive && askPanelVisible) && inspectorTab === 'details' ? 0 : -1} type="button">Details</button>
            {!portableAtlas && !askHidden ? <button aria-controls="ask-panel" aria-selected={inspectorAskActive && askPanelVisible} id="ask-tab" onClick={openDockedAsk} ref={askTabRef} role="tab" tabIndex={inspectorAskActive && askPanelVisible ? 0 : -1} type="button">Ask</button> : null}
          </div>
          {inspectorAskActive && askPanelVisible ? <div aria-labelledby="ask-tab" className="inspector-ask-panel" id="ask-panel" role="tabpanel">{askPanelView}</div> : inspectorTab === 'overview' ? <div aria-labelledby="overview-tab" className="details-scroll overview-panel" data-testid="inspector-overview" id="overview-panel" role="tabpanel">
            <ContextualOverviewView key={contextualOverview?.entity.id} overview={contextualOverview} explanation={draftPreviewContext?.explanationsByEntityId.get(selected.id)} entityName={id => activeSnapshot.entities.find(entity => entity.id === id)?.name} onOpenEntity={id => { void openInspectorChild(id).catch(() => setLiveMessage('Unable to load this part of the map. Please try again.')); }}
              onOpenEvidence={evidence => { void resolveExplanationExcerpt(activeSnapshot, evidence, id => scanFixture?.ensureExcerpts(id)).then(found => { if (!found) { setLiveMessage(`A source excerpt for ${evidence.path ?? 'this evidence'} isn't available here.`); return; } openPathExcerptRef.current(found.entityId, found.excerpt); if (!found.exact) setLiveMessage(`Line ${evidence.startLine} of ${evidence.path} wasn't captured; showing the nearest captured excerpt.`); }).catch(() => setLiveMessage('Unable to open this source evidence. Please try again.')); }}/>
            {contextualOverview?.entity.id === scene.rootEntityId ? <ArchitectureBriefView
              brief={architectureBrief}
              containerAvailable={id => Boolean(scene.entities.find(candidate => candidate.id === id))}
              honestyChip={scanFixture?.enrichmentHonesty?.chip}
              onOpenContainer={id => {
                const found = scene.entities.find(candidate => candidate.id === id);
                if (found) focusEntity(found, 'replace', 'preserve', 'auto', 'panel');
              }}
            /> : null}
          </div> : inspectorTab === 'source' ? <div aria-labelledby="source-tab" className="source-panel" id="source-panel" role="tabpanel">
            {sourceAvailable && <button className="primary-detail-action" onClick={openSourceTab} type="button">Open source in a tab</button>}
            {contextualOverview?.implementationFiles ? <ComponentImplementation key={selected.id} files={contextualOverview.implementationFiles} onOpenEntity={id => { void openInspectorChild(id).catch(() => setLiveMessage('Unable to load this part of the map. Please try again.')); }}/> : sourceAvailable ? <SourceViewer sourceContext={scanFixture && askAtlasIdentity ? { scanBasePath: `/scan${(() => { const route = parseAppRoute(window.location.pathname); const slug = route.kind === 'repo' ? route.slug : query.scanRepo; return slug ? `/${encodeURIComponent(slug)}` : ''; })()}`, owner: askAtlasIdentity.owner, repo: askAtlasIdentity.repo, ...(scanFixture.publication ? { publicationVersion: scanFixture.publication.versionId } : {}) } : undefined} excerpt={selectedExcerpt} localWorkspace={localWorkspace} onFeedback={setLiveMessage}/> : <section className="detail-section" data-testid="source-unavailable"><div className="section-title"><h3>Source unavailable</h3></div><p className="detail-muted">No source evidence was captured for {selected.name}. Select another tab to inspect the available architecture evidence.</p></section>}
          </div> : <div aria-labelledby="details-tab" className="details-scroll" id="details-panel" role="tabpanel">
            {pathView && pathDraft && pathAvailable && <PathExplorer canLoadExcerpts={Boolean(scanFixture)} onClear={() => updatePathDraft(undefined, 'push')} onOpenEvidence={(hop, evidence) => { void openPathEvidence(hop, evidence); }} onShowHop={showPathHopOnMap} onSwap={() => updatePathDraft(swapPathEndpoints(pathDraft), 'push')} onToggleContainment={() => updatePathDraft(setPathOption(pathDraft, { containment: !pathDraft.containment }), 'replace')} onToggleKind={kind => updatePathDraft(togglePathKind(pathDraft, kind), 'replace')} onToggleScope={() => updatePathDraft(setPathOption(pathDraft, { scope: pathDraft.scope === 'subtree' ? 'exact' : 'subtree' }), 'replace')} view={pathView}/>}
            {pickedCanonicalRelation && <section className="detail-section" data-testid="canonical-relation-evidence"><div className="section-title"><h3>{pickedCanonicalRelation.label ?? pickedCanonicalRelation.kind}</h3><span>{pickedCanonicalRelation.evidence.length}</span></div><p>{activeSnapshot.entities.find(entity => entity.id === pickedCanonicalRelation.from)?.name ?? pickedCanonicalRelation.from} → {activeSnapshot.entities.find(entity => entity.id === pickedCanonicalRelation.to)?.name ?? pickedCanonicalRelation.to}</p>{detailListVisible('relation-evidence', pickedCanonicalRelation.evidence).map((item, index) => <p key={index}>{item.reason}<br/>{item.source.path} · line {item.source.startLine} · {item.source.commitSha}</p>)}{pickedCanonicalRelation.evidence.length > 5 && <button aria-expanded={expandedDetailLists.has('relation-evidence')} onClick={() => toggleDetailList('relation-evidence')}>{expandedDetailLists.has('relation-evidence') ? 'Show fewer' : `Show all ${pickedCanonicalRelation.evidence.length}`}</button>}{!pickedRelationPresentation && <p>The endpoints are outside this map neighborhood. Captured evidence remains available above.</p>}</section>}
            {pickedRelationPresentation ? <article aria-labelledby="inspector-relation-title" className="inspector-presentation inspector-relation-presentation" data-inspector-presentation="relation" data-inspector-relation-id={pickedRelationPresentation.id}>
              <header className="entity-hero relation-hero">
                <div className="entity-kicker"><span>{levels[activeLevel]?.short ?? 'L1'} · Relationship</span><small className="provenance-badge">Selected edge</small></div>
                <h2 id="inspector-relation-title">{pickedRelationPresentation.label}</h2>
                <p className="responsibility relation-route-copy"><strong>{pickedRelationPresentation.source.name}</strong><span aria-hidden="true">→</span><strong>{pickedRelationPresentation.target.name}</strong></p>
                <div aria-label="Relationship metadata" className="entity-metadata">
                  <span>{pickedRelationPresentation.kindLabel ?? 'Relationship'}</span>
                  {pickedRelationPresentation.protocol && <span className="signal">{pickedRelationPresentation.protocol}</span>}
                </div>
                <div aria-label="Relationship actions" className="detail-actions" role="group">
                  <button className="primary-detail-action" onClick={() => focusEntity(pickedRelationPresentation.source, 'replace', 'frame', 'details', 'panel')}>Inspect source</button>
                  <button className="secondary-detail-action" onClick={() => focusEntity(pickedRelationPresentation.target, 'replace', 'frame', 'details', 'panel')}>Inspect target</button>
                  <button className="secondary-detail-action" onClick={() => pickedRelation && frameSelectedRelationFlow(pickedRelation, selected)}><FitIcon size={15}/> Show on map</button>
                </div>
              </header>

              <section className="detail-section relation-endpoints-section">
                <div className="section-title"><h3>Endpoints</h3><span>2</span></div>
                <div className="inspector-link-list">
                  <button data-inspector-entity-id={pickedRelationPresentation.source.id} onClick={() => focusEntity(pickedRelationPresentation.source, 'replace', 'preserve', 'auto', 'panel')}><span><strong>{pickedRelationPresentation.source.name}</strong><small>Source · {pickedRelationPresentation.source.kindLabel ?? pickedRelationPresentation.source.kind}</small></span><ArrowIcon size={15}/></button>
                  <button data-inspector-entity-id={pickedRelationPresentation.target.id} onClick={() => focusEntity(pickedRelationPresentation.target, 'replace', 'preserve', 'auto', 'panel')}><span><strong>{pickedRelationPresentation.target.name}</strong><small>Target · {pickedRelationPresentation.target.kindLabel ?? pickedRelationPresentation.target.kind}</small></span><ArrowIcon size={15}/></button>
                </div>
              </section>

              <section className="detail-section relation-evidence-section">
                <div className="section-title"><h3>Evidence context</h3><span>{pickedRelationPresentation.evidence.sourceEntityRefs.length + pickedRelationPresentation.evidence.targetEntityRefs.length}</span></div>
                <dl className="relation-facts">
                  <div><dt>Semantic ID</dt><dd>{pickedRelationPresentation.evidence.relationIds.join(', ')}</dd></div>
                  <div><dt>Source anchors</dt><dd>{pickedRelationPresentation.evidence.sourceEntityRefs.length}</dd></div>
                  <div><dt>Target anchors</dt><dd>{pickedRelationPresentation.evidence.targetEntityRefs.length}</dd></div>
                  {pickedRelationPresentation.evidence.frozenRevision && <div><dt>Frozen revision</dt><dd>{pickedRelationPresentation.evidence.frozenRevision}</dd></div>}
                </dl>
                <p className="relation-evidence-note"><InfoIcon size={13}/> Endpoint evidence is shown as context; it is not asserted as direct evidence for the relationship.</p>
              </section>

              {interactionMode === 'edit' && <div aria-label="Relationship editing actions" className="detail-actions relation-edit-actions" role="group">
                <button className="secondary-detail-action" disabled={!authoringEnabled || !selectedRouteOverride} onClick={resetSelectedRelationshipRoute}>Auto route</button>
                <button className="danger-detail-action" disabled={!authoringEnabled} onClick={deleteSelectedRelationship}>Delete relationship</button>
              </div>}
            </article> : <article aria-labelledby="inspector-entity-title" className="inspector-presentation inspector-entity-presentation" data-inspector-entity-id={selected.id} data-inspector-has-owners={selectedOwners.length ? 'true' : 'false'} data-inspector-has-cyclomatic={selectedCyclomatic ? 'true' : 'false'} data-inspector-cyclomatic-flagged={selectedCyclomatic?.flagged ? 'true' : 'false'} data-inspector-has-duplicates={selectedDuplicates.length ? 'true' : 'false'} data-inspector-has-coverage={selectedCoverage ? 'true' : 'false'} data-inspector-has-untested-behaviours={selectedUntestedBehaviours.length ? 'true' : 'false'} data-inspector-has-section-summary={selectedSummary ? 'true' : 'false'} data-inspector-enrichment-honesty={scanFixture?.enrichmentHonesty?.why ?? ''} data-inspector-presentation="entity">
              <header className="entity-hero">
                <div className="entity-kicker"><span>{selectedLevelLabel}</span>{scanFixture?.enrichmentHonesty ? <small className="enrichment-honesty-chip" data-testid="inspector-enrichment-honesty">{scanFixture.enrichmentHonesty.chip}</small> : null}<small className={`provenance-badge tone-${selectedProvenance.tone}`}>{selectedProvenance.badge}</small></div>
                <h2 id="inspector-entity-title">{selected.name}</h2>
                {selectedLead.kind === 'summary' ? <p className="responsibility" data-inspector-section-summary="">{selectedLead.text}</p> : selectedLead.kind === 'enrichment-honesty' ? <p className="responsibility enrichment-honesty" data-inspector-enrichment-honesty-details="">{selectedLead.text}</p> : <p className="responsibility no-explanation" data-inspector-no-explanation="">{selectedLead.text}</p>}
                <div aria-label="Entity metadata" className="entity-metadata">
                  <span>{selected.technology ?? 'Technology not specified'}</span>
                  {selected.tags?.map(tag => <span className="signal" key={tag}>{tag}</span>)}
                </div>
                <div aria-label="Entity actions" className="detail-actions" role="group">
                  {selected.detail === 'code'
                    ? <button className="primary-detail-action" disabled={!sourceAvailable} onClick={openSourceTab}><CodeIcon size={15}/> Open source</button>
                    : <button className="primary-detail-action" disabled={!selectedHasChildren} onClick={() => openInside(selected.id, 'preserve')}>Open inside <ArrowIcon size={15}/></button>}
                  <button className="secondary-detail-action" onClick={() => focusEntity(selected, 'replace', 'frame', 'details', 'preserve')}><FitIcon size={15}/> Show on map</button>
                  {pathAvailable && <><button className="secondary-detail-action" data-testid="path-from-here" onClick={() => updatePathDraft(setPathEndpoint(pathDraft, 'from', selected.id, activeSnapshot), 'push')} type="button">Path from here</button>
                  <button className="secondary-detail-action" data-testid="path-to-here" onClick={() => updatePathDraft(setPathEndpoint(pathDraft, 'to', selected.id, activeSnapshot), 'push')} type="button">Path to here</button></>}
                </div>
              </header>

              <div aria-label={selectedProvenance.accessibleSummary} className={`provenance-strip tone-${selectedProvenance.tone}`}>
                <div><span><InfoIcon size={13}/> {selectedProvenance.heading}</span><strong>{selectedProvenance.evidenceLabel}</strong></div>
                <p>{selectedProvenance.description}</p>
              </div>

              {selectedOwners.length > 0 ? <section className="detail-section ownership-section" data-inspector-section="ownership">
                <div className="section-title"><h3>Owned by</h3><span>{selectedOwners.length}</span></div>
                <div aria-label="CODEOWNERS" className="entity-metadata" data-testid="inspector-owners">{detailListVisible('owners', selectedOwners).map(owner => <span data-inspector-owner={owner} key={owner}>{owner}</span>)}</div>{selectedOwners.length > 5 && <button aria-expanded={expandedDetailLists.has('owners')} className="empty-inspector-section relations-omitted-more" onClick={() => toggleDetailList('owners')} type="button">{expandedDetailLists.has('owners') ? 'Show fewer' : `Show all ${selectedOwners.length}`}</button>}
              </section> : null}

              {selectedCyclomatic ? <section className="detail-section cyclomatic-section" data-inspector-section="cyclomatic">
                <div className="section-title"><h3>Complexity</h3><span>{selectedCyclomatic.complexity}</span></div>
                <div aria-label="Cyclomatic complexity" className="entity-metadata" data-inspector-cyclomatic={selectedCyclomatic.complexity} data-inspector-cyclomatic-flagged={selectedCyclomatic.flagged ? 'true' : 'false'} data-testid="inspector-cyclomatic">
                  <span className={selectedCyclomatic.flagged ? 'signal' : undefined}>McCabe {selectedCyclomatic.complexity}</span>
                  {selectedCyclomatic.flagged ? <span className="signal">Over 6</span> : null}
                </div>
              </section> : null}

              {selectedDuplicates.length > 0 ? <section className="detail-section duplicates-section" data-inspector-section="duplicates">
                <div className="section-title"><h3>Duplicates</h3><span>{selectedDuplicates.length}</span></div>
                <div aria-label="Clone duplicates" className="inspector-link-list" data-testid="inspector-duplicates">{detailListVisible('duplicates', selectedDuplicates).map(counterpart => {
                  const entity = scene.entities.find(candidate => candidate.id === counterpart.id);
                  return <button data-inspector-duplicate-id={counterpart.id} disabled={!entity} key={counterpart.id} onClick={() => entity && focusEntity(entity, 'replace', 'preserve', 'auto', 'panel')} type="button"><span><strong>{counterpart.name}</strong><small>duplicates</small></span><ArrowIcon size={15}/></button>;
                })}</div>{selectedDuplicates.length > 5 && <button aria-expanded={expandedDetailLists.has('duplicates')} className="empty-inspector-section relations-omitted-more" onClick={() => toggleDetailList('duplicates')} type="button">{expandedDetailLists.has('duplicates') ? 'Show fewer' : `Show all ${selectedDuplicates.length}`}</button>}
              </section> : null}

              {selectedCoverage ? <section className="detail-section coverage-section" data-inspector-section="coverage">
                <div className="section-title"><h3>Coverage</h3>{selectedCoverage.fileHitPercent !== undefined ? <span>{selectedCoverage.fileHitPercent}%</span> : null}</div>
                <div aria-label="lcov coverage" className="entity-metadata" data-inspector-coverage-hit-percent={selectedCoverage.fileHitPercent ?? ''} data-testid="inspector-coverage">
                  {selectedCoverage.fileHitPercent !== undefined ? <span>this file {selectedCoverage.fileHitPercent}%</span> : null}
                  {detailListVisible('coverage-ranges', selectedCoverage.untestedRanges).map(range => <span data-inspector-coverage-range={`${range.startLine}-${range.endLine}`} key={`${range.startLine}-${range.endLine}`}>{formatCoverageRange(range)}</span>)}
                </div>{selectedCoverage.untestedRanges.length > 5 && <button aria-expanded={expandedDetailLists.has('coverage-ranges')} className="empty-inspector-section relations-omitted-more" onClick={() => toggleDetailList('coverage-ranges')} type="button">{expandedDetailLists.has('coverage-ranges') ? 'Show fewer' : `Show all ${selectedCoverage.untestedRanges.length}`}</button>}
                {selectedUntestedBehaviours.length > 0 ? <div aria-label="untested behaviours" className="entity-metadata" data-testid="inspector-untested-behaviours">{detailListVisible('untested', selectedUntestedBehaviours).map(item => <span data-inspector-untested-behaviour={`${item.startLine}-${item.endLine}`} key={`${item.startLine}-${item.endLine}-${item.behaviour}`}>{formatCoverageRange(item)} {item.behaviour}</span>)}</div> : null}
              </section> : selectedUntestedBehaviours.length > 0 ? <section className="detail-section coverage-section" data-inspector-section="untested-behaviours">
                <div className="section-title"><h3>Untested behaviours</h3><span>{selectedUntestedBehaviours.length}</span></div>
                <div aria-label="untested behaviours" className="entity-metadata" data-testid="inspector-untested-behaviours">{detailListVisible('untested', selectedUntestedBehaviours).map(item => <span data-inspector-untested-behaviour={`${item.startLine}-${item.endLine}`} key={`${item.startLine}-${item.endLine}-${item.behaviour}`}>{formatCoverageRange(item)} {item.behaviour}</span>)}</div>
              </section> : null}

              {selectedUntestedBehaviours.length > 5 && <button aria-expanded={expandedDetailLists.has('untested')} onClick={() => toggleDetailList('untested')} type="button">{expandedDetailLists.has('untested') ? 'Show fewer' : `Show all ${selectedUntestedBehaviours.length} untested behaviours`}</button>}
              {selectedExposure.length > 0 && <section className="detail-section"><div className="section-title"><h3>Exposure</h3><span>{selectedExposure.length}</span></div>{detailListVisible('exposure', selectedExposure).map((item, index) => <details key={`${item.kind}:${index}`}><summary>{item.kind === 'moduleExport' ? 'Exported symbol' : item.kind === 'publicApi' ? 'Public API' : 'Entry point'}</summary><p>{item.evidence.reason}</p><p>{item.evidence.source.path} · line {item.evidence.source.startLine} · {item.evidence.source.commitSha}</p></details>)}{selectedExposure.length > 5 && <button aria-expanded={expandedDetailLists.has('exposure')} onClick={() => toggleDetailList('exposure')}>{expandedDetailLists.has('exposure') ? 'Show fewer' : `Show all ${selectedExposure.length}`}</button>}</section>}
              <section className="detail-section diagrams-section">
                <div className="section-title"><h3>Diagrams</h3><span>{selectedDiagramCount}</span></div>
                {notationDetails.visible ? <div className={`notation-readiness ${notationDetails.ready ? 'ready' : 'advisory'}`} data-inspector-notation="" data-inspector-notation-errors={notationDetails.errorCount} data-inspector-notation-hidden={notationDetails.hiddenCount} data-inspector-notation-mode={devMode ? 'diagnostics' : 'user'} data-inspector-notation-total={notationDetails.total} data-testid="inspector-notation">
                  <span>{notationDetails.headline}</span>
                  <small>Title, scope, descriptions, technology, and relationship labels</small>
                  {notationDetails.rows.length > 0 ? <ul className="notation-readiness-list">{notationDetails.rows.map(row => <li data-inspector-notation-code={row.code} data-inspector-notation-tone={row.tone} key={`${row.path}:${row.code}:${row.subjectId}`}>{row.message}</li>)}</ul> : null}
                  {notationDetails.hiddenCount > 0 ? <small className="notation-readiness-more" data-inspector-notation-more="">{`+${notationDetails.hiddenCount} more completeness notes`}</small> : null}
                </div> : null}
                <div className="inspector-link-list">
                  {hasDependencyDiagram && <div className="diagram-action-row"><button data-diagram-action="open-dependency" onClick={() => openDerivedDiagram('dependency')}><span><strong>Open dependencies</strong><small>Captured incoming and outgoing relationships</small></span></button><DiagramActionHelp label="About dependencies">Opens an unordered relationship graph in its own tab. Switch to Mermaid to view the same connections.</DiagramActionHelp></div>}
                  {detailListVisible('named-diagrams', namedDiagramStories).map(story => <div className="diagram-action-row" key={story.id}><button data-diagram-action="open-flow" onClick={() => openDerivedDiagram('flow', story)}><span><strong>{story.title}</strong><small>Captured named flow</small></span></button><DiagramActionHelp label={`About ${story.title}`}>Shows the evidence-backed steps of this published story in a separate diagram tab.</DiagramActionHelp></div>)}
                  {namedDiagramStories.length > 5 && <button aria-expanded={expandedDetailLists.has('named-diagrams')} onClick={() => toggleDetailList('named-diagrams')}>{expandedDetailLists.has('named-diagrams') ? 'Show fewer' : `Show all ${namedDiagramStories.length} named diagrams`}</button>}
                  {hasCodeStructureDiagram ? <div className="diagram-action-row"><button data-diagram-action="open-code" onClick={() => openDerivedDiagram('code')} type="button"><span><strong>Open code structure</strong><small>Source-backed child structure for this component</small></span><ArrowIcon size={15}/></button><DiagramActionHelp label="What does Open code structure show?">Opens a separate tab for this component's captured code-level children. It does not infer call ordering.</DiagramActionHelp></div> : null}
                  {selectedDiagramCount === 0 && !notationDetails.visible ? <p className="empty-inspector-section" data-inspector-diagrams-empty="">No diagrams for this element yet.</p> : null}
                </div>
              </section>

              {selectedParent && <section className="detail-section parent-section">
                <div className="section-title"><h3>Parent layer</h3><span>1</span></div>
                <div className="inspector-link-list"><button data-inspector-entity-id={selectedParent.id} onClick={() => navigateInspectorHierarchy(selectedParent)}><span><strong>{selectedParent.name}</strong><small>{inspectorSecondaryCopy(selectedParent)}</small></span><ArrowIcon size={15}/></button></div>
              </section>}

              {inspectorChildren.length > 0 && <section className="detail-section children-section">
                <div className="section-title"><h3>Inside this layer</h3><span>{inspectorChildren.length}</span></div>
                <div className="inspector-link-list">{detailListVisible('children', inspectorChildren).map(child => <button data-inspector-entity-id={child.id} key={child.id} onClick={() => { const entity = scene.entities.find(candidate => candidate.id === child.id); if (entity && omittedChildNodes.some(node => node.entityId === child.id)) revealOmittedEntity(entity); else void openInspectorChild(child.id); }}><span><strong>{child.name}</strong><small>{activeProjectionEntityIds.includes(child.id) ? 'Shown on map' : 'Known, not shown at this zoom'}</small></span><ArrowIcon size={15}/></button>)}</div>
                {inspectorChildren.length > 5 && <button aria-expanded={expandedDetailLists.has('children')} onClick={() => toggleDetailList('children')} type="button">{expandedDetailLists.has('children') ? 'Show fewer' : `Show all ${inspectorChildren.length}`}</button>}
              </section>}

              <section className="detail-section relationships-section">
                <div className="section-title"><h3>Relationships</h3><span>{canonicalRelationshipGroups.reduce((total, group) => total + group.rows.length, 0)}</span></div>
                <div className="relations-list">{canonicalRelationshipGroups.length ? canonicalRelationshipGroups.map(group => {
                  const expanded = expandedRelationshipGroups.has(group.id);
                  const rows = expanded ? group.rows : group.rows.slice(0, 5);
                  return <div className="relation-group" data-inspector-relation-group={group.id} key={group.id}><div className="section-heading"><span>{group.label}</span><small>{group.rows.length}</small></div>{rows.map(row => {
                    const relation = scene.relations.find(candidate => candidate.id === row.relationId) ?? canonicalRelationForInspection(activeSnapshot, row.relationId);
                    const direction = row.direction === 'inbound' ? '←' : row.direction === 'recursive' ? '↺' : '→';
                    const mapCopy = row.mapStatus === 'shown' ? 'Shown on map' : row.mapStatus === 'aggregated' ? 'Shown on map as an aggregate' : row.mapStatus === 'hidden' ? 'Known, not shown at this zoom' : 'Known, unavailable in this map neighborhood';
                    return <div className="canonical-relation-row" data-inspector-relation-id={row.relationId} key={row.relationId}><button aria-label={`${group.label} ${row.label} ${row.counterpartName}. ${mapCopy}`} data-inspector-presentation="canonical-relation" onClick={() => { if (relation) inspectRelation(relation, 'panel', 'preserve'); else setLiveMessage(`${row.label} is captured in the architecture snapshot, but its evidence is outside this map neighborhood.`); }} type="button"><span aria-hidden="true" className="relation-direction">{direction}</span><span><strong>{row.counterpartName}</strong><small>{row.label} · {mapCopy}</small></span><ChevronIcon size={15}/></button><button aria-label={`Show ${row.label} on map`} className="secondary-detail-action" onClick={() => { if (relation) frameSelectedRelationFlow(relation, selected); else setLiveMessage(`${row.label} is known, but cannot be drawn in the current map neighborhood.`); }} type="button">Show on map</button></div>;
                  })}{group.rows.length > 5 && <button aria-expanded={expanded} className="empty-inspector-section relations-omitted-more" onClick={() => setExpandedRelationshipGroups(current => { const next = new Set(current); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })} type="button">{expanded ? 'Show fewer' : `Show all ${group.rows.length}`}</button>}</div>;
                }) : <div className="empty-inspector-section">No relationships captured.</div>}</div>
              </section>

              <section className="detail-section evidence-section">
                <div className="section-title"><h3>Source evidence</h3><span>{selected.sourceRefs?.length ?? 0}</span></div>
                <div className="source-list">{selected.sourceRefs?.length ? detailListVisible('source', selected.sourceRefs).map((source, index) => {
                  const opensSource = sourceAvailable && selectedExcerpt?.path === source.path;
                  const lineLabel = source.startLine === undefined
                    ? ''
                    : source.endLine !== undefined && source.endLine !== source.startLine
                      ? ` · lines ${source.startLine}–${source.endLine}`
                      : ` · line ${source.startLine}`;
                  const sourceContent = <><FileIcon/><span><strong>{source.path.split('/').at(-1)}{source.symbol ? <em>{source.symbol}</em> : null}</strong><small>{source.path}{lineLabel}<br/>Frozen at {source.revision.slice(0, 12)}</small></span>{opensSource ? <ArrowIcon size={15}/> : <span aria-hidden="true" className="source-static-mark">•</span>}</>;
                  return opensSource
                    ? <button className="source-card" key={`${source.path}:${source.symbol ?? ''}:${source.startLine ?? ''}:${index}`} onClick={() => focusEntity(selected, 'replace', 'preserve', 'source', 'preserve')} title="Open frozen source excerpt">{sourceContent}</button>
                    : <div className="source-card static" key={`${source.path}:${source.symbol ?? ''}:${source.startLine ?? ''}:${index}`}>{sourceContent}</div>;
                }) : <div className="empty-inspector-section">No repository source linked.</div>}</div>
                {(selected.sourceRefs?.length ?? 0) > 5 && <button aria-expanded={expandedDetailLists.has('source')} onClick={() => toggleDetailList('source')} type="button">{expandedDetailLists.has('source') ? 'Show fewer' : `Show all ${selected.sourceRefs!.length}`}</button>}
                <p><InfoIcon size={13}/> Evidence-linked summaries retain their frozen fixture source references.</p>
              </section>
            </article>}
          </div>}
        </aside>
        </> : activeDiagramSurface.kind === 'source' ? <section aria-label="Source workspace" id="derived-diagram-content" tabIndex={-1} className="map-stage derived-map-stage" style={{ overflow: 'auto', padding: 24 }}><SourceViewer sourceContext={scanFixture && askAtlasIdentity ? { scanBasePath: `/scan${(() => { const route = parseAppRoute(window.location.pathname); const slug = route.kind === 'repo' ? route.slug : query.scanRepo; return slug ? `/${encodeURIComponent(slug)}` : ''; })()}`, owner: askAtlasIdentity.owner, repo: askAtlasIdentity.repo, ...(scanFixture.publication ? { publicationVersion: scanFixture.publication.versionId } : {}) } : undefined} excerpt={activeDiagramSurface.excerpt} localWorkspace={localWorkspace} onFeedback={setLiveMessage}/></section> : <section className="map-stage derived-map-stage"><SemanticDiagramSurface flowError={activeDynamicFlowResult?.error} flowArtifact={activeDynamicFlowArtifact} mermaidSource={activeMermaidSource} devMode={devMode} notationAdvisoryCount={notationDiagnostics.length} onSessionChange={updateActiveDiagramSession} scene={scene} surface={activeDiagramSurface}/></section>}
      </main>
      <ImportMermaidDialog
        error={importMermaidError}
        onClose={() => { setImportMermaidOpen(false); setImportMermaidError(undefined); }}
        onImport={applyImportedMermaid}
        onSourceChange={next => { setImportMermaidSource(next); setImportMermaidError(undefined); }}
        open={importMermaidOpen}
        source={importMermaidSource}
      />
      <div aria-atomic="true" aria-live="polite" className="sr-only" role="status">{liveMessage}</div>
    </div>
  );
}
