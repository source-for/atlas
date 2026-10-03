import initWasm, { createAtlasRenderer } from '../../../../crates/atlas-wasm/pkg/atlas_wasm.js';
import { toProtocolScene } from './protocolScene';
import { measureAtlasAsyncPhase, measureAtlasPhase } from '../performance/loadTimings';
import type { AtlasRenderer, AtlasScene, Camera, PickResult, RenderState, RendererDiagnostics, RendererLodState, VisibleSceneState } from './types';

type NativeRenderer = Awaited<ReturnType<typeof createAtlasRenderer>>;
type ExtendedNativeRenderer = NativeRenderer & {
  applyPatch(value: unknown): void;
  setVisibility(value: unknown): void;
  visibleScene(): unknown;
  lodState(): unknown;
  setReducedMotion(value: boolean): void;
  setProjectionOverride(value: unknown): void;
  setProjectionProgress(id: string, progress: number): void;
};

let initialization: Promise<unknown> | undefined;

function initializeWasm() {
  initialization ??= measureAtlasAsyncPhase('renderer-wasm-init', initWasm);
  return initialization;
}

function validPick(value: unknown): PickResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as { kind?: unknown; id?: unknown };
  if ((candidate.kind === 'entity' || candidate.kind === 'relation') && typeof candidate.id === 'string') {
    return { kind: candidate.kind, id: candidate.id };
  }
  return undefined;
}

export class WasmRendererAdapter implements AtlasRenderer {
  private scene?: AtlasScene;
  private protocolSceneId = '';
  private camera?: Camera;
  private renderStateKey = '';
  private transitionPositionMs = -1;
  private timelinePlaying = false;
  private projectionOverrideKey = '';
  private projectionOverrideProgress = -1;

  private constructor(private readonly native: ExtendedNativeRenderer, private readonly requestedBackend: string) {}

  static async create(canvas: HTMLCanvasElement, backendAttempt: string, reportedRequestedBackend = backendAttempt) {
    await initializeWasm();
    const native = await measureAtlasAsyncPhase('renderer-gpu-init', () => createAtlasRenderer(canvas, backendAttempt), 'renderer-gpu-init-failed');
    return new WasmRendererAdapter(native as ExtendedNativeRenderer, reportedRequestedBackend);
  }

  get kind() { return this.native.kind; }

  setScene(scene: AtlasScene) {
    if (scene === this.scene) return;
    const protocolScene = measureAtlasPhase('renderer-protocol', () => toProtocolScene(scene)) as { sceneId?: unknown };
    if (this.scene && scene.protocolPatch) {
      measureAtlasPhase('renderer-native-patch', () => this.native.applyPatch(scene.protocolPatch));
    } else {
      measureAtlasPhase('renderer-native-scene', () => this.native.setScene(protocolScene));
    }
    this.protocolSceneId = typeof protocolScene.sceneId === 'string' ? protocolScene.sceneId : `scene:${scene.id}`;
    this.scene = scene;
    this.camera = undefined;
    this.renderStateKey = '';
    this.transitionPositionMs = -1;
    this.timelinePlaying = false;
    this.projectionOverrideKey = '';
    this.projectionOverrideProgress = -1;
  }

  setCamera(camera: Camera) {
    if (this.camera && this.camera.x === camera.x && this.camera.y === camera.y && this.camera.zoom === camera.zoom) return;
    this.native.setCamera(camera.x, camera.y, camera.zoom);
    this.camera = { ...camera };
  }

  setRenderState(state: RenderState) {
    if (!this.scene) return;
    const transition = state.cinematicTransition;
    // The App assigns a new stable ID whenever topology/target changes. The
    // wheel hot path therefore compares O(1) identity and sends one float.
    const projectionOverrideKey = state.projectionOverride?.id ?? 'none';
    if (projectionOverrideKey !== this.projectionOverrideKey) {
      this.native.setProjectionOverride(state.projectionOverride ?? null);
      this.projectionOverrideKey = projectionOverrideKey;
      this.projectionOverrideProgress = state.projectionOverride?.progress ?? -1;
    } else if (state.projectionOverride && state.projectionOverride.progress !== this.projectionOverrideProgress) {
      this.native.setProjectionProgress(state.projectionOverride.id, state.projectionOverride.progress);
      this.projectionOverrideProgress = state.projectionOverride.progress;
    }
    const semanticObjectIds = [...new Set([
      ...(state.selectedId ? [state.selectedId] : []),
      ...state.focusedIds,
      ...(state.relationFocusIds ?? []),
      ...(transition?.sourceFocusedIds ?? []),
      ...(transition?.targetFocusedIds ?? []),
    ])].sort();
    const semanticPathIds = [...new Set([
      ...state.activeRelationIds,
      ...(transition?.sourceRelationIds ?? []),
      ...(transition?.targetRelationIds ?? []),
    ])].sort();
    const objectIds = this.visualObjectIds(semanticObjectIds);
    const pathIds = this.visualPathIds(semanticPathIds);
    const flowPathIds = this.visualPathIds([...state.flowRelationIds].sort());
    const animate = state.animate && !state.reduceMotion && flowPathIds.length > 0;
    const key = transition
      ? `flight:${transition.id}|${transition.durationMs}|${transition.sourceFocusedIds.join(',')}|${transition.targetFocusedIds.join(',')}|${transition.sourceRelationIds.join(',')}|${transition.targetRelationIds.join(',')}|${state.visibilityMode}|${state.reduceMotion}`
      : `${objectIds.join(',')}|${pathIds.join(',')}|flow:${flowPathIds.join(',')}|${state.visibilityMode}|${state.reduceMotion}|${animate}`;
    if (key !== this.renderStateKey) {
      this.native.setVisibility({
        mode: state.visibilityMode,
        object_ids: objectIds,
        dim_opacity: 0.18,
      });
      this.native.setReducedMotion(state.reduceMotion);
      if (transition) {
        const sourceObjects = this.visualObjectIds(transition.sourceFocusedIds);
        const targetObjects = this.visualObjectIds(transition.targetFocusedIds);
        const sourcePaths = this.visualPathIds(transition.sourceRelationIds);
        const targetPaths = this.visualPathIds(transition.targetRelationIds);
        const focusStartMs = Math.max(0, transition.durationMs - 200);
        const departureEndMs = Math.min(120, focusStartMs);
        const sourceState = {
          objectStates: sourceObjects.length ? [{ objectIds: sourceObjects, opacity: 1, emphasis: 1 }] : [],
          pathStates: sourcePaths.length ? [{ pathIds: sourcePaths, opacity: 1, color: [0.851, 1, 0.439, 1], flowSpeed: 0, emphasis: 1 }] : [],
        };
        const keyframes = [{ id: 'flight-source', atMs: 0, easing: 'linear', ...sourceState }];
        const neutralState = { objectStates: [], pathStates: [] };
        if (departureEndMs > 0) keyframes.push({ id: 'flight-source-faded', atMs: departureEndMs, easing: 'easeOut', ...neutralState });
        if (focusStartMs > departureEndMs) keyframes.push({ id: 'flight-focus-start', atMs: focusStartMs, easing: 'linear', ...neutralState });
        keyframes.push({
          id: 'flight-target',
          atMs: transition.durationMs,
          easing: 'easeInOut',
          objectStates: targetObjects.length ? [{ objectIds: targetObjects, opacity: 1, emphasis: 1 }] : [],
          pathStates: targetPaths.length ? [{ pathIds: targetPaths, opacity: 1, color: [0.851, 1, 0.439, 1], flowSpeed: 0, emphasis: 1 }] : [],
        });
        this.native.setTimeline({
          protocolVersion: 1,
          timelineVersion: 2,
          id: `timeline:cinematic:${this.scene.id}:${transition.id}`,
          sceneId: this.protocolSceneId,
          durationMs: transition.durationMs,
          looped: false,
          keyframes,
        });
      } else {
        const emphasized = new Set(pathIds);
        const flowing = new Set(flowPathIds);
        const emphasisOnlyPathIds = pathIds.filter(id => !flowing.has(id));
        const emphasizedFlowPathIds = pathIds.filter(id => flowing.has(id));
        const flowOnlyPathIds = flowPathIds.filter(id => !emphasized.has(id));
        this.native.setTimeline({
          protocolVersion: 1,
          timelineVersion: 2,
          id: `timeline:react-state:${this.scene.id}`,
          sceneId: this.protocolSceneId,
          durationMs: 60_000,
          looped: true,
          keyframes: [{
            id: 'react-state',
            atMs: 0,
            easing: 'linear',
            objectStates: objectIds.length ? [{ objectIds, opacity: 1, emphasis: 1 }] : [],
            pathStates: [
              ...(emphasisOnlyPathIds.length ? [{ pathIds: emphasisOnlyPathIds, opacity: 1, color: [0.851, 1, 0.439, 1], flowSpeed: 0, emphasis: 1 }] : []),
              ...(emphasizedFlowPathIds.length ? [{ pathIds: emphasizedFlowPathIds, opacity: 1, color: [0.851, 1, 0.439, 1], flowSpeed: state.reduceMotion ? 0 : 1, emphasis: 1 }] : []),
              ...(flowOnlyPathIds.length ? [{ pathIds: flowOnlyPathIds, opacity: 1, flowSpeed: state.reduceMotion ? 0 : 1, emphasis: 0 }] : []),
            ],
          }],
        });
      }
      // Installing a timeline creates a fresh paused native player at position 0.
      this.timelinePlaying = false;
      this.renderStateKey = key;
      this.transitionPositionMs = -1;
    }
    if (transition) {
      const positionMs = Math.max(0, Math.min(transition.durationMs, Math.round(transition.positionMs)));
      if (positionMs !== this.transitionPositionMs) {
        this.native.seekTimeline(positionMs);
        this.transitionPositionMs = positionMs;
      }
      if (this.timelinePlaying) {
        this.native.pauseTimeline();
        this.timelinePlaying = false;
      }
    } else {
      if (animate !== this.timelinePlaying) {
        if (animate) this.native.playTimeline();
        else this.native.pauseTimeline();
        this.timelinePlaying = animate;
      }
    }
  }

  resize(width: number, height: number, devicePixelRatio: number) {
    this.native.resize(width, height, Math.min(Math.max(devicePixelRatio, 1), 2));
  }

  render(timeMs: number) { this.native.render(timeMs); }

  pick(screenX: number, screenY: number) {
    const picked = validPick(this.native.pick(screenX, screenY));
    if (!picked || !this.scene?.projection) return picked;
    if (picked.kind === 'entity') {
      const semanticId = this.scene.projection.visualToSemanticEntityId[picked.id];
      return semanticId ? { kind: 'entity' as const, id: semanticId } : undefined;
    }
    const semanticId = this.scene.projection.visualToSemanticRelationIds[picked.id]?.[0];
    return semanticId ? { kind: 'relation' as const, id: semanticId } : undefined;
  }

  visibleScene(): VisibleSceneState {
    const value = this.native.visibleScene() as { objects?: Array<{ id?: unknown }>; paths?: Array<{ id?: unknown }> };
    const objectIds = (value.objects ?? []).flatMap(object => typeof object.id === 'string' ? [object.id] : []);
    const relationIds = (value.paths ?? []).flatMap(path => typeof path.id === 'string' ? [path.id] : []);
    const projection = this.scene?.projection;
    if (!projection) return { objectIds, relationIds };
    return {
      objectIds: [...new Set(objectIds.flatMap(id => projection.visualToSemanticEntityId[id] ? [projection.visualToSemanticEntityId[id]!] : []))].sort(),
      relationIds: [...new Set(relationIds)].sort(),
    };
  }

  lodState(): RendererLodState | undefined {
    const value = this.native.lodState() as {
      objectId?: unknown;
      currentRepresentationId?: unknown;
      previousRepresentationId?: unknown;
      transitionProgress?: unknown;
      currentWeight?: unknown;
      previousWeight?: unknown;
      transitioning?: unknown;
    } | undefined;
    if (!value || typeof value.objectId !== 'string' || typeof value.currentRepresentationId !== 'string') return undefined;
    return {
      objectId: this.scene?.projection?.visualToSemanticEntityId[value.objectId] ?? value.objectId,
      current: value.currentRepresentationId,
      ...(typeof value.previousRepresentationId === 'string' ? { previous: value.previousRepresentationId } : {}),
      progress: typeof value.transitionProgress === 'number' ? value.transitionProgress : 1,
      currentWeight: typeof value.currentWeight === 'number' ? value.currentWeight : 1,
      previousWeight: typeof value.previousWeight === 'number' ? value.previousWeight : 0,
      transitioning: value.transitioning === true,
      durationMs: 200,
    };
  }

  diagnostics(): RendererDiagnostics {
    const diagnostics = this.native.diagnostics() as RendererDiagnostics;
    return {
      ...diagnostics,
      requestedBackend: this.requestedBackend,
      activeBackend: diagnostics.activeBackend || this.kind,
      gpuAccelerated: diagnostics.gpuAccelerated ?? true,
    };
  }

  dispose() {
    this.native.dispose();
    this.native.free();
    this.scene = undefined;
    this.timelinePlaying = false;
  }

  private visualObjectIds(ids: Iterable<string>): string[] {
    const projection = this.scene?.projection;
    return [...new Set([...ids].flatMap(id => {
      if (!projection) return [id];
      const visualId = projection.semanticToVisualEntityId[id];
      return visualId ? [visualId] : [];
    }))].sort();
  }

  private visualPathIds(ids: Iterable<string>): string[] {
    const projection = this.scene?.projection;
    return [...new Set([...ids].flatMap(id => projection?.semanticToVisualRelationIds[id] ?? [id]))].sort();
  }
}
