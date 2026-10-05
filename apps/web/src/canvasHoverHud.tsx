import { cardSupportCopy } from '@okie/scene-compiler';
import { authoringBoundsForDetail, worldToScreen } from './editor/relationshipInteraction';
import { inspectorAcceptedSummary } from './inspector/inspectorPanel';
import { canvasCardTextLayout } from './renderer/Canvas2DRenderer';
import type { AtlasScene, Camera, PickResult, SceneEntity, SemanticDetail } from './renderer/types';

export type CanvasHoverHudModel = {
  entityId: string;
  name: string;
  path?: string;
  detail?: string;
  left: number;
  top: number;
  place: 'above' | 'below';
};

export type CanvasHoverHudQuery = {
  pick?: PickResult;
  scene: AtlasScene;
  camera: Camera;
  viewport: { width: number; height: number };
  detail: SemanticDetail;
  suppress?: boolean;
};

export function samePickResult(left?: PickResult, right?: PickResult) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return left.kind === right.kind && left.id === right.id;
}

function hoverPath(entity: SceneEntity) {
  const path = entity.source?.trim() || entity.sourceRefs?.[0]?.path?.trim();
  return path && path !== entity.name ? path : undefined;
}

function usefulSignature(entity: SceneEntity) {
  const line = entity.sourceExcerpts?.[0]?.lines.find(candidate => candidate.trim())?.trim();
  if (line && line !== entity.name) return line;
  const symbol = entity.sourceRefs?.[0]?.symbol?.trim();
  return symbol && symbol !== entity.name && !entity.name.startsWith(symbol) ? symbol : undefined;
}

function hoverDetail(entity: SceneEntity) {
  const signature = usefulSignature(entity);
  const summary = inspectorAcceptedSummary(entity);
  if (entity.detail === 'code' && signature) return signature;
  if (summary && summary !== entity.name && summary !== entity.source) return summary;
  return signature;
}

function paintedBoundary(scene: AtlasScene, entityId: string, detail: SemanticDetail) {
  const visible = new Set(
    scene.projection?.entityIdsByDetail[detail] ?? scene.entities.map(candidate => candidate.id),
  );
  return scene.entities.some(candidate => candidate.parentId === entityId && visible.has(candidate.id));
}

export function cardNeedsHoverHud(
  entity: SceneEntity,
  detail: SemanticDetail,
  boundary: boolean,
  zoom: number,
  screenWidth: number,
) {
  // Read the exact wrapped lines Canvas paints, so a description shown in full across
  // two or three lines is not reported as truncated.
  const painted = canvasCardTextLayout(entity, detail, boundary, zoom, screenWidth);
  const title = painted.lines.find(line => line.role === 'title')?.content;
  if (title !== entity.name) return true;
  const description = painted.lines.filter(line => line.role === 'description').map(line => line.content).join(' ');
  if (painted.rawDescription && description !== painted.rawDescription.trim().replace(/\s+/gu, ' ')) return true;
  return !boundary && !painted.rawDescription && !cardSupportCopy(entity.responsibility);
}

export function canvasHoverHudModel(query: CanvasHoverHudQuery): CanvasHoverHudModel | undefined {
  if (query.suppress || query.pick?.kind !== 'entity') return undefined;
  const entity = query.scene.entities.find(candidate => candidate.id === query.pick!.id);
  if (!entity) return undefined;
  const bounds = authoringBoundsForDetail(query.scene, entity.id, query.detail)
    ?? { x: entity.x, y: entity.y, width: entity.width, height: entity.height };
  const screenWidth = bounds.width * query.camera.zoom;
  const boundary = paintedBoundary(query.scene, entity.id, query.detail);
  if (!cardNeedsHoverHud(entity, query.detail, boundary, query.camera.zoom, screenWidth)) return undefined;
  const origin = worldToScreen({ x: bounds.x, y: bounds.y }, query.camera, query.viewport);
  const screenHeight = bounds.height * query.camera.zoom;
  const pad = 12;
  const left = Math.min(query.viewport.width - pad, Math.max(pad, origin.x + screenWidth / 2));
  const place: CanvasHoverHudModel['place'] = origin.y < 72 ? 'below' : 'above';
  const top = place === 'below' ? origin.y + screenHeight + 8 : origin.y - 8;
  const path = hoverPath(entity);
  const detail = hoverDetail(entity);
  return {
    entityId: entity.id,
    name: entity.name,
    ...(path ? { path } : {}),
    ...(detail ? { detail } : {}),
    left,
    top,
    place,
  };
}

export function CanvasHoverHud({ model }: { model: CanvasHoverHudModel }) {
  return (
    <div
      className={`canvas-hover-hud place-${model.place}`}
      data-entity-id={model.entityId}
      data-testid="canvas-hover-hud"
      role="tooltip"
      style={{ left: model.left, top: model.top }}
    >
      <strong>{model.name}</strong>
      {model.path ? <span className="canvas-hover-hud-path">{model.path}</span> : null}
      {model.detail ? <span className="canvas-hover-hud-detail">{model.detail}</span> : null}
    </div>
  );
}
