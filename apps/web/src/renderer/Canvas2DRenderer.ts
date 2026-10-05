import type { AtlasRenderer, AtlasScene, Camera, PickResult, RenderState, RendererDiagnostics, RendererLodState, SceneEntity, SceneRelation, SemanticDetail } from './types';
import { C4_BOUNDARY_STROKE_ALPHA, C4_LABEL_MIN_TITLE_PX, C4_PRESENTATION_AT_FOCUS, C4_ZOOM_BANDS, c4TitleFitFloor, cardContentLayout, cardDescriptionStep, cardSupportCopy, cardTitleStep, codeCardCopy } from '@okie/scene-compiler';
import { roundedOrthogonalRoute, routeArrowHead, routeArrowHeads, routeShaft, type RouteArrowHead, type RoutePoint } from './routeGeometry';

const palette = {
  person: { fill: '#151b1c', stroke: '#81918b', accent: '#b5c2bd' },
  system: { fill: '#17151b', stroke: '#8e7ab8', accent: '#b9a1ff' },
  container: { fill: '#11191a', stroke: '#417b75', accent: '#79dfd4' },
  component: { fill: '#11171d', stroke: '#476487', accent: '#7ca9ff' },
  store: { fill: '#181712', stroke: '#8d784a', accent: '#f2cb78' },
  queue: { fill: '#191511', stroke: '#93623f', accent: '#ffae70' },
};

const flowParticleColor = '#d9ff70';
const flowParticleRadiusPx = 3.5;

function roundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
}

function diagramFont(role: 'sans' | 'mono') {
  if (typeof getComputedStyle !== 'function' || typeof document === 'undefined') {
    return role === 'sans' ? 'sans-serif' : 'monospace';
  }
  const variable = role === 'sans' ? '--atlas-font-diagram-sans' : '--atlas-font-diagram-mono';
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim()
    || (role === 'sans' ? 'sans-serif' : 'monospace');
}

const focusZoomByDetail: Readonly<Record<SemanticDetail, number>> = Object.fromEntries(
  C4_ZOOM_BANDS.map(band => [band.detail, band.focusZoom]),
) as Record<SemanticDetail, number>;

/**
 * Converts the compiler's band-normalized world-space presentation values to
 * Canvas CSS pixels. Keeping this conversion in one place prevents camera zoom
 * from being applied to raw (already screen-targeted) font sizes.
 */
export function canvasEntityPresentationMetrics(detail: SemanticDetail, boundary: boolean, zoom: number) {
  const focusZoom = focusZoomByDetail[detail];
  const screenScale = C4_PRESENTATION_AT_FOCUS[detail].geometryScale / focusZoom * zoom;
  const presentation = C4_PRESENTATION_AT_FOCUS[detail];
  const fontScale = zoom / focusZoom;
  const kickerFontSize = presentation.kickerFontSize * fontScale;
  // L1/L2 titles hold a CSS-pixel readability floor while geometry shrinks with zoom.
  const titleFontSize = Math.max(detail === 'context' || detail === 'container' ? C4_LABEL_MIN_TITLE_PX : 0,
    presentation.titleFontSize
    * (boundary && (detail === 'context' || detail === 'container') ? 0.78 : 1) * fontScale);
  const descriptionFontSize = presentation.descriptionFontSize * fontScale;
  const top = 12 * screenScale;
  const gap = 4 * screenScale;
  // Same rule as cardContentLayout, which paints the face: the title sits below the
  // kicker's descenders even when its floor outgrows the scaled geometry.
  const kickerClearance = kickerFontSize * .25 + 2;
  const kickerBaseline = top + kickerFontSize;
  const titleBaseline = kickerBaseline + cardTitleStep(gap, kickerClearance, titleFontSize);
  return {
    screenScale,
    leftInset: (boundary ? 22 : 18) * screenScale,
    horizontalInsets: 2 * (boundary ? 22 : 18) * screenScale,
    top,
    gap,
    bottom: 10 * screenScale,
    kickerClearance,
    kickerBaseline,
    titleBaseline,
    descriptionBaseline: titleBaseline + cardDescriptionStep(gap, descriptionFontSize),
    kickerFontSize,
    titleFontSize,
    descriptionFontSize,
    radius: (boundary ? 20 : detail === 'code' ? 7 : 14) * screenScale,
    strokeWidth: (boundary ? 1.5 : 2) * screenScale,
  };
}

/**
 * Select the authored representation that is actually present. A scoped scan
 * scene can retain an outgoing shell without an incoming counterpart; falling
 * back to the session detail at the half-way point made that shell's type jump
 * bands while its geometry was still fading out.
 */
export function projectionRepresentationDetail(
  sourceRepresentationId: string | undefined,
  targetRepresentationId: string | undefined,
  progress: number,
  activeDetail: SemanticDetail,
): SemanticDetail {
  const detailFromRepresentation = (id: string | undefined): SemanticDetail | undefined => {
    const suffix = id?.split(':').at(-1);
    return suffix === 'context' || suffix === 'container' || suffix === 'component' || suffix === 'code' ? suffix : undefined;
  };
  const source = detailFromRepresentation(sourceRepresentationId);
  const target = detailFromRepresentation(targetRepresentationId);
  return (progress >= .5 ? target ?? source : source ?? target) ?? activeDetail;
}

export function pointAlongPolyline(points: readonly RoutePoint[], phase: number): RoutePoint | undefined {
  if (!points.length) return undefined;
  const lengths = points.slice(1).map((point, index) => Math.hypot(
    point.x - points[index]!.x,
    point.y - points[index]!.y,
  ));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (total <= Number.EPSILON) return { ...points[0]! };
  let remaining = total * Math.max(0, Math.min(1, phase));
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (remaining <= length) {
      const start = points[index]!;
      const end = points[index + 1]!;
      const amount = length <= Number.EPSILON ? 0 : remaining / length;
      return { x: start.x + (end.x - start.x) * amount, y: start.y + (end.y - start.y) * amount };
    }
    remaining -= length;
  }
  return { ...points.at(-1)! };
}

export function distanceToPolyline(point: RoutePoint, points: readonly RoutePoint[]): number {
  let closest = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < points.length; index += 1) {
    const start = points[index]!;
    const end = points[index + 1]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    const amount = lengthSquared <= Number.EPSILON ? 0 : Math.max(0, Math.min(1,
      ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared,
    ));
    closest = Math.min(closest, Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount)));
  }
  return closest;
}

export const arrowHeadForPolyline = routeArrowHead;

type CanvasCardTextLayout = ReturnType<typeof cardContentLayout> & { rawDescription: string | undefined };
const cardTextLayoutCache = new WeakMap<SceneEntity, Map<string, CanvasCardTextLayout>>();
const CARD_TEXT_LAYOUT_CACHE_LIMIT = 64;

/** The exact lines Canvas paints on a card face (also read by the hover HUD). Wrapping
 * measures every word, so still frames reuse the layout. Scene entities are replaced,
 * never mutated, when their copy changes, so the entity object is the cache identity. */
export function canvasCardTextLayout(entity: SceneEntity, detail: SemanticDetail, boundary: boolean, zoom: number, width: number): CanvasCardTextLayout {
  let byInput = cardTextLayoutCache.get(entity);
  if (!byInput) { byInput = new Map(); cardTextLayoutCache.set(entity, byInput); }
  const key = `${detail}|${boundary ? 1 : 0}|${zoom}|${width}`;
  const cached = byInput.get(key);
  if (cached) return cached;
  const layout = uncachedCanvasCardTextLayout(entity, detail, boundary, zoom, width);
  if (byInput.size >= CARD_TEXT_LAYOUT_CACHE_LIMIT) byInput.clear();
  byInput.set(key, layout);
  return layout;
}

function uncachedCanvasCardTextLayout(entity: SceneEntity, detail: SemanticDetail, boundary: boolean, zoom: number, width: number): CanvasCardTextLayout {
  const metrics = canvasEntityPresentationMetrics(detail, boundary, zoom);
  const codeCopy = entity.detail === 'code' ? codeCardCopy(entity) : undefined;
  const rawDescription = codeCopy ? codeCopy.description : cardSupportCopy(entity.responsibility);
  const layout = cardContentLayout({
    width, inset: metrics.leftInset, top: metrics.top,
    bottom: metrics.bottom, gap: metrics.gap, kickerClearance: metrics.kickerClearance,
    kicker: codeCopy?.kicker ?? (entity.kindLabel ?? entity.kind).toUpperCase(),
    title: entity.name, description: boundary ? undefined : rawDescription,
    descriptionLines: detail === 'component' || detail === 'code' ? 2 : 3,
    kickerSize: metrics.kickerFontSize, titleSize: metrics.titleFontSize,
    titleFloor: c4TitleFitFloor(detail, metrics.titleFontSize, C4_LABEL_MIN_TITLE_PX),
    titleFitStep: .25 * zoom / focusZoomByDetail[detail],
    descriptionSize: metrics.descriptionFontSize, mono: detail === 'code',
  });
  return { ...layout, rawDescription: boundary ? undefined : rawDescription };
}

export class Canvas2DRenderer implements AtlasRenderer {
  readonly kind = 'canvas2d-preview';
  private context: CanvasRenderingContext2D;
  private scene?: AtlasScene;
  private camera: Camera = { x: 0, y: 0, zoom: 0.72 };
  private state: RenderState = { focusedIds: new Set(), activeRelationIds: new Set(), flowRelationIds: new Set(), reduceMotion: false, animate: false, visibilityMode: 'all' };
  private width = 1;
  private height = 1;
  private dpr = 1;
  private lastFrameMs = 0;
  private lastVisibleEntities = 0;
  private lastVisibleRelations = 0;
  private lod = {
    current: 'detail' as 'compact' | 'detail',
    previous: undefined as 'compact' | 'detail' | undefined,
    progress: 1,
    currentWeight: 1,
    previousWeight: 0,
    startedMs: 0,
    awaitingFirstFrame: false,
  };
  private semanticDetail: SemanticDetail = 'context';

  private projectionProgress() {
    const progress = Math.max(0, Math.min(1, this.state.projectionOverride?.progress ?? 0));
    return this.state.reduceMotion ? Number(progress >= .5) : progress;
  }

  private detailFromRepresentation(id: string | undefined): SemanticDetail | undefined {
    const suffix = id?.split(':').at(-1);
    return suffix === 'context' || suffix === 'container' || suffix === 'component' || suffix === 'code' ? suffix : undefined;
  }

  private semanticObjectId(visualId: string) {
    return this.scene?.projection?.visualToSemanticEntityId[visualId] ?? visualId;
  }

  private projectionObject(entityId: string) {
    return this.state.projectionOverride?.objects.find(object => this.semanticObjectId(object.objectId) === entityId);
  }

  private projectionObjectOpacity(entityId: string) {
    const object = this.projectionObject(entityId);
    if (!object) return 1;
    const progress = this.projectionProgress();
    const source = object.sourceOpacity ?? (object.sourceRepresentationId ? 1 : 0);
    const target = object.targetOpacity ?? (object.targetRepresentationId ? 1 : 0);
    return source + (target - source) * progress;
  }

  private projectionObjectContentOpacity(entityId: string) {
    const object = this.projectionObject(entityId);
    if (!object) return 1;
    const progress = this.projectionProgress();
    const sourceObjectOpacity = object.sourceOpacity ?? (object.sourceRepresentationId ? 1 : 0);
    const targetObjectOpacity = object.targetOpacity ?? (object.targetRepresentationId ? 1 : 0);
    const source = object.sourceContentOpacity ?? sourceObjectOpacity;
    const target = object.targetContentOpacity ?? targetObjectOpacity;
    return source + (target - source) * progress;
  }

  private projectionObjectOwned(entityId: string) {
    const object = this.projectionObject(entityId);
    if (!object) return true;
    const representation = this.projectionProgress() >= .5 ? object.targetRepresentationId : object.sourceRepresentationId;
    return Boolean(representation) && this.projectionObjectOpacity(entityId) > .001;
  }

  private projectionObjectPickable(entityId: string) {
    const object = this.projectionObject(entityId);
    if (!object) return true;
    const authored = this.projectionProgress() >= .5
      ? object.targetPickable ?? Boolean(object.targetRepresentationId)
      : object.sourcePickable ?? Boolean(object.sourceRepresentationId);
    return authored && this.projectionObjectOpacity(entityId) >= .12;
  }

  private projectionObjectPickPriority(entityId: string) {
    const object = this.projectionObject(entityId);
    if (!object) return 0;
    return this.projectionProgress() >= .5
      ? object.targetPickPriority ?? 0
      : object.sourcePickPriority ?? 0;
  }

  private projectionPathOpacity(pathId: string) {
    const path = this.state.projectionOverride?.paths.find(candidate => candidate.pathId === pathId);
    if (!path) return 1;
    const progress = this.projectionProgress();
    return path.sourceOpacity + (path.targetOpacity - path.sourceOpacity) * progress;
  }

  private projectionMorphBounds() {
    const projection = this.state.projectionOverride;
    const morph = projection?.morph;
    if (!projection || !morph || !this.scene?.projection) return undefined;
    const boundary = projection.objects.find(object => object.objectId === morph.boundaryObjectId);
    if (!boundary) return undefined;
    const entityId = this.semanticObjectId(boundary.objectId);
    const sourceDetail = this.detailFromRepresentation(boundary.sourceRepresentationId);
    const targetDetail = this.detailFromRepresentation(boundary.targetRepresentationId);
    const source = sourceDetail ? this.scene.projection.boundsByEntityIdAndDetail[entityId]?.[sourceDetail] : undefined;
    const target = targetDetail ? this.scene.projection.boundsByEntityIdAndDetail[entityId]?.[targetDetail] : undefined;
    if (!source || !target) return undefined;
    const progress = this.projectionProgress();
    return {
      source,
      target,
      current: {
        x: source.x + (target.x - source.x) * progress,
        y: source.y + (target.y - source.y) * progress,
        width: source.width + (target.width - source.width) * progress,
        height: source.height + (target.height - source.height) * progress,
      },
    };
  }

  private projectionClipBounds(entityId: string) {
    const projection = this.state.projectionOverride;
    const morph = projection?.morph;
    if (!morph || this.semanticObjectId(morph.boundaryObjectId) === entityId) return undefined;
    const visualId = projection.objects.find(object => this.semanticObjectId(object.objectId) === entityId)?.objectId;
    return visualId && morph.objectIds.includes(visualId) ? this.projectionMorphBounds()?.current : undefined;
  }

  private projectionPathClipBounds(pathId: string) {
    const morph = this.state.projectionOverride?.morph;
    return morph?.pathIds.includes(pathId) ? this.projectionMorphBounds()?.current : undefined;
  }

  private affineRect(
    rect: { x: number; y: number; width: number; height: number },
    from: { x: number; y: number; width: number; height: number },
    to: { x: number; y: number; width: number; height: number },
  ) {
    const scaleX = from.width ? to.width / from.width : 1;
    const scaleY = from.height ? to.height / from.height : 1;
    return {
      x: to.x + (rect.x - from.x) * scaleX,
      y: to.y + (rect.y - from.y) * scaleY,
      width: rect.width * scaleX,
      height: rect.height * scaleY,
    };
  }

  private affinePoint(point: RoutePoint, from: { x: number; y: number; width: number; height: number }, to: { x: number; y: number; width: number; height: number }) {
    const scaleX = from.width ? to.width / from.width : 1;
    const scaleY = from.height ? to.height / from.height : 1;
    return {
      x: to.x + (point.x - from.x) * scaleX,
      y: to.y + (point.y - from.y) * scaleY,
    };
  }

  private relationScreenRoute(relation: SceneRelation, fromEntity: SceneEntity, toEntity: SceneEntity): RoutePoint[] {
    if (relation.routePoints && relation.routePoints.length >= 2) {
      const morph = this.state.projectionOverride?.morph;
      const morphBounds = morph?.pathIds.includes(relation.id) ? this.projectionMorphBounds() : undefined;
      const pathOverride = this.state.projectionOverride?.paths.find(path => path.pathId === relation.id);
      const basis = morphBounds && pathOverride
        ? pathOverride.targetOpacity > pathOverride.sourceOpacity ? morphBounds.target : morphBounds.source
        : undefined;
      const worldPoints = basis && morphBounds
        ? relation.routePoints.map(point => this.affinePoint(point, basis, morphBounds.current))
        : relation.routePoints;
      return roundedOrthogonalRoute(worldPoints.map(point => this.screenPoint(point)));
    }

    // Non-compiled stress/legacy scenes retain their prior smooth route as a
    // sampled polyline so drawing, picking and animation still share geometry.
    const from = this.screenPoint({ x: fromEntity.x + fromEntity.width, y: fromEntity.y + fromEntity.height / 2 });
    const to = this.screenPoint({ x: toEntity.x, y: toEntity.y + toEntity.height / 2 });
    const bend = Math.max(38, Math.abs(to.x - from.x) * .4);
    return roundedOrthogonalRoute(Array.from({ length: 21 }, (_, index) => {
      const phase = index / 20;
      const inverse = 1 - phase;
      return {
        x: inverse ** 3 * from.x + 3 * inverse ** 2 * phase * (from.x + bend) + 3 * inverse * phase ** 2 * (to.x - bend) + phase ** 3 * to.x,
        y: inverse ** 3 * from.y + 3 * inverse ** 2 * phase * from.y + 3 * inverse * phase ** 2 * to.y + phase ** 3 * to.y,
      };
    }));
  }

  private entityIsAncestorOf(ancestorId: string, descendantId: string) {
    const entities = new Map(this.scene?.entities.map(entity => [entity.id, entity]) ?? []);
    const visited = new Set<string>();
    let current = entities.get(descendantId);
    while (current?.parentId && !visited.has(current.parentId)) {
      if (current.parentId === ancestorId) return true;
      visited.add(current.parentId);
      current = entities.get(current.parentId);
    }
    return false;
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly requestedBackend: string,
    private readonly fallbackMessage?: string,
  ) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas 2D is unavailable in this browser.');
    this.context = context;
  }

  setScene(scene: AtlasScene) { this.scene = scene; }
  setCamera(camera: Camera) {
    this.camera = camera;
    const order: SemanticDetail[] = ['context', 'container', 'component', 'code'];
    const bands = this.scene?.projection?.zoomPolicy?.bands;
    const handoffs = order.slice(1).map(detail =>
      bands?.find(band => band.detail === detail)?.enterZoom ?? C4_ZOOM_BANDS.find(band => band.detail === detail)!.enterZoom);
    const hysteresis = order.slice(1).map(detail =>
      bands?.find(band => band.detail === detail)?.hysteresis ?? C4_ZOOM_BANDS.find(band => band.detail === detail)!.hysteresis);
    let detailIndex = order.indexOf(this.semanticDetail);
    while (detailIndex < 3 && camera.zoom >= handoffs[detailIndex]! + hysteresis[detailIndex]!) detailIndex += 1;
    while (detailIndex > 0 && camera.zoom < handoffs[detailIndex - 1]! - hysteresis[detailIndex - 1]!) detailIndex -= 1;
    this.semanticDetail = order[detailIndex]!;
    const target = this.lod.current === 'detail'
      ? camera.zoom < 0.48 ? 'compact' : 'detail'
      : camera.zoom >= 0.56 ? 'detail' : 'compact';
    if (target !== this.lod.current) {
      const visible = this.lod.previous && this.lod.progress < 0.5 ? this.lod.previous : this.lod.current;
      this.lod = {
        current: target,
        previous: visible,
        progress: 0,
        currentWeight: 0,
        previousWeight: 1,
        startedMs: 0,
        awaitingFirstFrame: true,
      };
    }
  }
  setRenderState(state: RenderState) {
    this.state = state;
    if (state.reduceMotion && this.lod.previous) {
      this.lod.previous = undefined;
      this.lod.progress = 1;
      this.lod.currentWeight = 1;
      this.lod.previousWeight = 0;
      this.lod.awaitingFirstFrame = false;
    }
  }

  resize(width: number, height: number, devicePixelRatio: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.dpr = Math.min(Math.max(1, devicePixelRatio), 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
  }

  private screenPoint(entity: Pick<SceneEntity, 'x' | 'y'>) {
    return {
      x: this.width / 2 + (entity.x - this.camera.x) * this.camera.zoom,
      y: this.height / 2 + (entity.y - this.camera.y) * this.camera.zoom,
    };
  }

  render(timeMs: number) {
    this.updateLod(timeMs);
    const started = performance.now();
    const { context: ctx, width, height, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#070a0b';
    ctx.fillRect(0, 0, width, height);
    this.drawGrid();
    if (!this.scene) return;
    this.drawRegions();
    const activeEntities = this.activeEntities();
    const activeRelations = this.activeRelations();
    const visibleEntityIds = new Set(activeEntities.filter(entity => this.inVisibilityFilter(entity.id) && this.isVisible(entity, 220)).map(entity => entity.id));
    this.lastVisibleEntities = visibleEntityIds.size;
    this.lastVisibleRelations = this.drawRelations(timeMs, visibleEntityIds, activeEntities, activeRelations);
    const boundaryIds = new Set(activeEntities.flatMap(entity => entity.parentId ? [entity.parentId] : []));
    for (const entity of activeEntities) if (visibleEntityIds.has(entity.id)) this.drawEntity(entity, boundaryIds.has(entity.id));
    this.lastFrameMs = performance.now() - started;
  }

  private drawGrid() {
    const ctx = this.context;
    const minor = Math.max(16, 40 * this.camera.zoom);
    const offsetX = ((this.width / 2 - this.camera.x * this.camera.zoom) % minor + minor) % minor;
    const offsetY = ((this.height / 2 - this.camera.y * this.camera.zoom) % minor + minor) % minor;
    ctx.strokeStyle = 'rgba(215, 235, 226, 0.032)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = offsetX; x < this.width; x += minor) { ctx.moveTo(x, 0); ctx.lineTo(x, this.height); }
    for (let y = offsetY; y < this.height; y += minor) { ctx.moveTo(0, y); ctx.lineTo(this.width, y); }
    ctx.stroke();
  }

  private drawRegions() {
    const ctx = this.context;
    for (const region of this.scene!.regions) {
      const topLeft = this.screenPoint(region);
      const w = region.width * this.camera.zoom;
      const h = region.height * this.camera.zoom;
      ctx.fillStyle = 'rgba(147, 180, 166, 0.018)';
      ctx.strokeStyle = 'rgba(176, 207, 194, 0.28)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 7]);
      roundedRect(ctx, topLeft.x, topLeft.y, w, h, 18);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      if (region.id !== 'boundary-commerce' && region.showLabel !== false && this.camera.zoom > 0.45) {
        ctx.font = `600 ${Math.min(14, Math.max(9, 10 * this.camera.zoom))}px ${diagramFont('sans')}`;
        ctx.fillStyle = 'rgba(174, 194, 186, 0.38)';
        ctx.fillText(region.name, topLeft.x + 18, topLeft.y + 24);
      }
    }
  }

  private isVisible(entity: SceneEntity, margin = 0) {
    const origin = this.screenPoint(entity);
    const width = entity.width * this.camera.zoom;
    const height = entity.height * this.camera.zoom;
    return origin.x + width >= -margin && origin.x <= this.width + margin && origin.y + height >= -margin && origin.y <= this.height + margin;
  }

  private drawRelations(timeMs: number, visibleEntityIds: Set<string>, activeEntities: SceneEntity[], activeRelations: SceneRelation[]) {
    const ctx = this.context;
    const entities = new Map(activeEntities.map(entity => [entity.id, entity]));
    let visibleRelations = 0;
    for (const relation of activeRelations) {
      const projectionOpacity = this.projectionPathOpacity(relation.id);
      if (projectionOpacity <= .001) continue;
      const fromEntity = entities.get(relation.from);
      const toEntity = entities.get(relation.to);
      if (!fromEntity || !toEntity) continue;
      if (!this.inVisibilityFilter(fromEntity.id) || !this.inVisibilityFilter(toEntity.id)) continue;
      if (!visibleEntityIds.has(fromEntity.id) && !visibleEntityIds.has(toEntity.id)) continue;
      visibleRelations += 1;
      ctx.save();
      ctx.globalAlpha = projectionOpacity;
      const pathClipBounds = this.projectionPathClipBounds(relation.id);
      if (pathClipBounds) {
        const clipOrigin = this.screenPoint(pathClipBounds);
        ctx.beginPath();
        ctx.rect(clipOrigin.x, clipOrigin.y, pathClipBounds.width * this.camera.zoom, pathClipBounds.height * this.camera.zoom);
        ctx.clip();
      }
      const route = this.relationScreenRoute(relation, fromEntity, toEntity);
      if (route.length < 2) {
        ctx.restore();
        continue;
      }
      const activeWeight = this.relationFocusWeight(relation);
      const active = activeWeight > 0.001;
      const focusFiltered = this.state.selectedId !== undefined
        || this.state.focusedIds.size > 0
        || Boolean(this.state.relationFocusIds?.size);
      const contextFocused = this.isFocused(fromEntity.id) && this.isFocused(toEntity.id);
      const dimmed = this.state.visibilityMode === 'dim' && focusFiltered && !contextFocused;
      ctx.strokeStyle = active
        ? `rgba(217, 255, 112, ${0.27 + activeWeight * 0.59})`
        : dimmed ? 'rgba(117, 137, 130, 0.06)' : 'rgba(117, 137, 130, 0.27)';
      ctx.lineWidth = 1 + activeWeight;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const arrowMode = relation.arrow ?? 'end';
      const { source: sourceArrow, target: targetArrow } = routeArrowHeads(route, arrowMode);
      const shaft = routeShaft(route, sourceArrow, targetArrow);
      ctx.beginPath();
      ctx.moveTo(shaft[0]!.x, shaft[0]!.y);
      for (const point of shaft.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();

      const drawArrow = (arrow: RouteArrowHead | undefined) => {
        if (!arrow) return;
        ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath();
        ctx.moveTo(arrow.tip.x, arrow.tip.y);
        ctx.lineTo(arrow.left.x, arrow.left.y);
        ctx.lineTo(arrow.right.x, arrow.right.y);
        ctx.closePath();
        ctx.fill();
      };
      drawArrow(targetArrow);
      drawArrow(sourceArrow);

      const relationIds = relation.semanticIds ?? [relation.id];
      const flowing = relationIds.some(id => this.state.flowRelationIds.has(id));
      if (flowing && projectionOpacity >= .5 && this.state.animate && !this.state.reduceMotion) {
        const phase = (timeMs % 1800) / 1800;
        const particle = pointAlongPolyline(shaft, phase);
        if (particle) {
          ctx.shadowColor = flowParticleColor;
          ctx.shadowBlur = 14;
          ctx.fillStyle = flowParticleColor;
          ctx.beginPath();
          ctx.arc(particle.x, particle.y, flowParticleRadiusPx, 0, Math.PI * 2);
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      }
      ctx.restore();
    }
    return visibleRelations;
  }

  private drawEntity(entity: SceneEntity, boundary: boolean) {
    const ctx = this.context;
    ctx.save();
    const projectionClip = this.projectionClipBounds(entity.id);
    if (projectionClip) {
      const clipOrigin = this.screenPoint(projectionClip);
      ctx.beginPath();
      ctx.rect(clipOrigin.x, clipOrigin.y, projectionClip.width * this.camera.zoom, projectionClip.height * this.camera.zoom);
      ctx.clip();
    }
    const origin = this.screenPoint(entity);
    const width = entity.width * this.camera.zoom;
    const height = entity.height * this.camera.zoom;
    const colors = palette[entity.kind];
    const selected = this.state.selectedId === entity.id;
    const focusWeight = this.entityFocusWeight(entity.id);
    const focused = focusWeight > 0.001;
    const focusFiltered = this.state.selectedId !== undefined
      || this.state.focusedIds.size > 0
      || Boolean(this.state.relationFocusIds?.size);
    const dimmed = this.state.visibilityMode === 'dim' && focusFiltered && !focused && !selected;
    const detail = this.activeDetail();
    const objectOverride = this.projectionObject(entity.id);
    const renderedDetail = projectionRepresentationDetail(
      objectOverride?.sourceRepresentationId,
      objectOverride?.targetRepresentationId,
      this.projectionProgress(),
      detail,
    );
    const metrics = canvasEntityPresentationMetrics(renderedDetail, boundary, this.camera.zoom);

    const projectionOpacity = this.projectionObjectOpacity(entity.id);
    const projectionContentOpacity = this.projectionObjectContentOpacity(entity.id);
    const chromeVisibility = dimmed ? 0.23 : Math.max(0.23, focusWeight || 1);
    const labelVisibility = dimmed ? 0.23 : 1;
    ctx.globalAlpha = projectionOpacity * chromeVisibility * (boundary ? .14 : 1);
    if (selected || focused) {
      ctx.shadowColor = selected ? 'rgba(217, 255, 112, 0.28)' : 'rgba(121, 223, 212, 0.2)';
      ctx.shadowBlur = 28;
    }
    ctx.fillStyle = colors.fill;
    ctx.strokeStyle = selected ? '#d9ff70' : focused ? '#79dfd4' : colors.stroke;
    ctx.lineWidth = Math.max(selected ? 1.7 : 1, metrics.strokeWidth);
    roundedRect(ctx, origin.x, origin.y, width, height, metrics.radius);
    ctx.fill();
    ctx.globalAlpha = projectionOpacity * chromeVisibility * (boundary ? C4_BOUNDARY_STROKE_ALPHA : 1);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Text clipping is deliberately local to the node. Projection morph clips
    // constrain the branch, while this clip guarantees a label cannot obscure
    // adjacent cards or routes even during an intermediate camera scale.
    ctx.beginPath();
    ctx.rect(origin.x, origin.y, width, height);
    ctx.clip();
    const textLayout = canvasCardTextLayout(entity, renderedDetail, boundary, this.camera.zoom, width);
    ctx.globalAlpha = projectionContentOpacity * labelVisibility;
    for (const line of textLayout.lines) {
      ctx.fillStyle = line.role === 'kicker' ? colors.accent : line.role === 'title' ? '#ffffff' : '#9aa8b4';
      ctx.font = `${line.role === 'description' ? 400 : 600} ${line.size}px ${diagramFont(line.metrics.startsWith('mono') ? 'mono' : 'sans')}`;
      ctx.fillText(line.content, origin.x + metrics.leftInset, origin.y + line.baseline);
    }
    ctx.restore();
  }

  pick(screenX: number, screenY: number): PickResult | undefined {
    if (!this.scene) return undefined;
    const activeEntities = this.activeEntities();
    const candidates = activeEntities.filter(candidate => {
      if (!this.inVisibilityFilter(candidate.id)
        || !this.projectionObjectOwned(candidate.id)
        || !this.projectionObjectPickable(candidate.id)) return false;
      const origin = this.screenPoint(candidate);
      return screenX >= origin.x && screenX <= origin.x + candidate.width * this.camera.zoom
        && screenY >= origin.y && screenY <= origin.y + candidate.height * this.camera.zoom;
    });
    const entity = this.state.projectionOverride
      ? candidates.sort((left, right) => this.projectionObjectPickPriority(right.id) - this.projectionObjectPickPriority(left.id)
        || left.width * left.height - right.width * right.height
        || left.id.localeCompare(right.id))[0]
      : candidates.at(-1);

    const entities = new Map(activeEntities.map(candidate => [candidate.id, candidate]));
    const relation = this.activeRelations().filter(candidate => this.projectionPathOpacity(candidate.id) >= .5 && this.inVisibilityFilter(candidate.from) && this.inVisibilityFilter(candidate.to)).find(candidate => {
      const fromEntity = entities.get(candidate.from);
      const toEntity = entities.get(candidate.to);
      if (!fromEntity || !toEntity) return false;
      const clip = this.projectionPathClipBounds(candidate.id);
      if (clip) {
        const origin = this.screenPoint(clip);
        if (screenX < origin.x || screenX > origin.x + clip.width * this.camera.zoom
          || screenY < origin.y || screenY > origin.y + clip.height * this.camera.zoom) return false;
      }
      return distanceToPolyline({ x: screenX, y: screenY }, this.relationScreenRoute(candidate, fromEntity, toEntity)) <= 7;
    });

    if (relation && (!entity || (
      entity.id !== relation.from
      && entity.id !== relation.to
      && (this.entityIsAncestorOf(entity.id, relation.from) || this.entityIsAncestorOf(entity.id, relation.to))
    ))) {
      return { kind: 'relation', id: relation.semanticIds?.[0] ?? relation.id };
    }
    if (entity) return { kind: 'entity', id: entity.id };
    return relation ? { kind: 'relation', id: relation.semanticIds?.[0] ?? relation.id } : undefined;
  }

  visibleScene() {
    if (!this.scene) return { objectIds: [], relationIds: [] };
    const objectIds = this.activeEntities().filter(entity => this.inVisibilityFilter(entity.id) && this.projectionObjectOwned(entity.id)).map(entity => entity.id);
    const visible = new Set(objectIds);
    const relationIds = this.activeRelations()
      .filter(relation => this.projectionPathOpacity(relation.id) >= .5 && visible.has(relation.from) && visible.has(relation.to))
      .map(relation => relation.id);
    return { objectIds, relationIds };
  }

  lodState(): RendererLodState | undefined {
    const objectId = this.scene?.entities[0]?.id;
    if (!objectId) return undefined;
    return {
      objectId,
      current: `${objectId}:${this.lod.current}`,
      ...(this.lod.previous ? { previous: `${objectId}:${this.lod.previous}` } : {}),
      progress: this.lod.progress,
      currentWeight: this.lod.currentWeight,
      previousWeight: this.lod.previousWeight,
      transitioning: this.lod.previous !== undefined,
      durationMs: 200,
    };
  }

  private updateLod(timeMs: number) {
    if (!this.lod.previous) return;
    if (this.lod.awaitingFirstFrame) {
      this.lod.startedMs = timeMs;
      this.lod.awaitingFirstFrame = false;
    }
    const progress = Math.max(0, Math.min(1, (timeMs - this.lod.startedMs) / 200));
    const eased = progress < 0.5
      ? 4 * progress ** 3
      : 1 - (-2 * progress + 2) ** 3 / 2;
    this.lod.progress = progress;
    this.lod.currentWeight = eased;
    this.lod.previousWeight = 1 - eased;
    if (progress >= 1) {
      this.lod.previous = undefined;
      this.lod.currentWeight = 1;
      this.lod.previousWeight = 0;
    }
  }

  private inVisibilityFilter(id: string) {
    return this.state.visibilityMode !== 'isolate' || this.isFocused(id);
  }

  private isFocused(id: string) {
    return this.state.selectedId === id || this.entityFocusWeight(id) > 0.5;
  }

  private entityFocusWeight(id: string) {
    const relationFocus = this.state.relationFocusIds?.has(id) ? 1 : 0;
    const transition = this.state.cinematicTransition;
    if (!transition) return Math.max(relationFocus, this.state.focusedIds.has(id) ? 1 : 0);
    const progress = Math.max(0, Math.min(1, transition.visualProgress));
    const source = transition.sourceFocusedIds.includes(id) ? 1 - transition.departureProgress : 0;
    const target = transition.targetFocusedIds.includes(id) ? progress : 0;
    return Math.max(relationFocus, source, target);
  }

  private relationFocusWeight(relation: SceneRelation) {
    const ids = relation.semanticIds ?? [relation.id];
    const transition = this.state.cinematicTransition;
    if (!transition) return ids.some(id => this.state.activeRelationIds.has(id)) ? 1 : 0;
    const progress = Math.max(0, Math.min(1, transition.visualProgress));
    const source = ids.some(id => transition.sourceRelationIds.includes(id)) ? 1 - transition.departureProgress : 0;
    const target = ids.some(id => transition.targetRelationIds.includes(id)) ? progress : 0;
    return Math.max(source, target);
  }

  private activeDetail(): SemanticDetail {
    return this.semanticDetail;
  }

  private activeEntities(): SceneEntity[] {
    if (!this.scene?.projection) return this.scene?.entities ?? [];
    const detail = this.activeDetail();
    const visibleIds = new Set(this.scene.projection.entityIdsByDetail[detail]);
    const base = this.scene.entities.flatMap(entity => {
      const bounds = this.scene!.projection!.boundsByEntityIdAndDetail[entity.id]?.[detail];
      return visibleIds.has(entity.id) && bounds ? [{ ...entity, ...bounds }] : [];
    });
    const projection = this.state.projectionOverride;
    if (!projection) return base;
    const overridden = new Set(projection.objects.map(object => this.semanticObjectId(object.objectId)));
    const progress = this.projectionProgress();
    const projected = projection.objects.flatMap(object => {
      const entityId = this.semanticObjectId(object.objectId);
      const entity = this.scene!.entities.find(candidate => candidate.id === entityId);
      if (!entity) return [];
      const sourceDetail = this.detailFromRepresentation(object.sourceRepresentationId);
      const targetDetail = this.detailFromRepresentation(object.targetRepresentationId);
      const source = sourceDetail ? this.scene!.projection!.boundsByEntityIdAndDetail[entityId]?.[sourceDetail] : undefined;
      const target = targetDetail ? this.scene!.projection!.boundsByEntityIdAndDetail[entityId]?.[targetDetail] : undefined;
      if (!source && !target) return [];
      let from = source ?? target!;
      let to = target ?? source!;
      const morph = projection.morph;
      const morphBounds = this.projectionMorphBounds();
      if (morph && morphBounds && morph.objectIds.includes(object.objectId) && object.objectId !== morph.boundaryObjectId) {
        const basis = target ? morphBounds.target : morphBounds.source;
        const transformed = this.affineRect(target ?? source!, basis, morphBounds.current);
        from = transformed;
        to = transformed;
      }
      const opacity = this.projectionObjectOpacity(entityId);
      if (opacity <= .001) return [];
      return [{
        ...entity,
        x: from.x + (to.x - from.x) * progress,
        y: from.y + (to.y - from.y) * progress,
        width: from.width + (to.width - from.width) * progress,
        height: from.height + (to.height - from.height) * progress,
      }];
    });
    return [...base.filter(entity => !overridden.has(entity.id)), ...projected];
  }

  private activeRelations(): SceneRelation[] {
    if (!this.scene?.projection) return this.scene?.relations ?? [];
    const base = this.scene.projection.projectedRelationsByDetail[this.activeDetail()];
    const projection = this.state.projectionOverride;
    if (!projection) return base;
    const overridden = new Set(projection.paths.map(path => path.pathId));
    const all = Object.values(this.scene.projection.projectedRelationsByDetail).flat();
    const byId = new Map(all.map(relation => [relation.id, relation]));
    return [
      ...base.filter(relation => !overridden.has(relation.id)),
      ...projection.paths.flatMap(path => byId.get(path.pathId) ? [byId.get(path.pathId)!] : []),
    ];
  }

  diagnostics(): RendererDiagnostics {
    const activeEntityCount = this.activeEntities().length;
    const activeRelationCount = this.activeRelations().length;
    return {
      requestedBackend: this.requestedBackend,
      activeBackend: this.kind,
      gpuAccelerated: false,
      entityCount: activeEntityCount,
      relationCount: activeRelationCount,
      lastFrameMs: this.lastFrameMs,
      message: this.fallbackMessage ?? (this.requestedBackend === 'canvas2d'
        ? 'Canvas 2D preview selected explicitly.'
        : 'GPU initialization was unavailable; using the Canvas 2D preview adapter.'),
      visibleEntities: this.lastVisibleEntities,
      visibleRelations: this.lastVisibleRelations,
      candidateEntities: activeEntityCount,
      candidateRelations: activeRelationCount,
      culledEntities: activeEntityCount - this.lastVisibleEntities,
      culledRelations: activeRelationCount - this.lastVisibleRelations,
      drawCalls: this.scene ? 3 : 0,
      meshRebuilt: false,
      meshBuildMs: 0,
      geometryUploadBytes: 0,
      geometryBufferUploads: 0,
      glyphQuads: 0,
      deferredTextPrimitives: 0,
      deferredIconPrimitives: 0,
    };
  }

  dispose() {
    this.scene = undefined;
  }
}
