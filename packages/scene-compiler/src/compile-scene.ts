import {
  type ArchitectureEntity,
  type ArchitectureSnapshot,
  type ArchitectureView,
  type NodeLayout,
  validateSnapshot,
  validateView,
  compareText,
} from "@okie/architecture";
import type { LodRange, Point, Rect, Representation, SceneObject, ScenePath, SceneSnapshot } from "./protocol.js";
import { RENDERER_PROTOCOL_VERSION } from "./protocol.js";
import { defaultTheme, type SceneTheme } from "./theme.js";

export interface CompileSceneOptions {
  sceneId?: string;
  revision?: number;
  worldPadding?: number;
  theme?: SceneTheme;
}

function assertColor(color: readonly number[], name: string): void {
  if (color.length !== 4 || color.some((component) => !Number.isFinite(component) || component < 0 || component > 1)) {
    throw new Error(`${name} must be finite RGBA in the range 0..1`);
  }
}

function validateOptions(options: CompileSceneOptions, theme: SceneTheme): void {
  const revision = options.revision ?? 1;
  const padding = options.worldPadding ?? 120;
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("revision must be a finite positive integer");
  if (!Number.isFinite(padding) || padding < 0) throw new Error("worldPadding must be finite and non-negative");
  if (options.sceneId !== undefined && !options.sceneId) throw new Error("sceneId must not be empty");
  assertColor(theme.background, "theme.background");
  assertColor(theme.text, "theme.text");
  assertColor(theme.mutedText, "theme.mutedText");
  assertColor(theme.edge, "theme.edge");
  assertColor(theme.edgeLabel, "theme.edgeLabel");
  assertColor(theme.optionalEdge, "theme.optionalEdge");
  assertColor(theme.selection, "theme.selection");
  for (const [kind, color] of Object.entries(theme.entityFill)) assertColor(color, `theme.entityFill.${kind}`);
}

const overviewLod: LodRange = { minZoom: 0, maxZoom: 2.1, fadeWidth: 0.3, hysteresis: 0.06 };
const detailLod: LodRange = { minZoom: 1.8, maxZoom: null, fadeWidth: 0.3, hysteresis: 0.06 };

function objectRepresentations(entity: ArchitectureEntity, bounds: NodeLayout, theme: SceneTheme): Representation[] {
  const fill = theme.entityFill[entity.kind];
  const titlePosition = { x: bounds.x + 18, y: bounds.y + 35 };
  const overview: Representation = {
    id: `${entity.id}:overview`,
    lod: overviewLod,
    primitives: [
      {
        kind: "roundedRect",
        rect: bounds,
        radius: Math.max(0, Math.min(entity.kind === "code" ? 6 : 14, bounds.width / 2, bounds.height / 2)),
        fill,
        stroke: {
          color: [Math.min(1, fill[0] + 0.16), Math.min(1, fill[1] + 0.16), Math.min(1, fill[2] + 0.16), 0.9],
          width: 1.5,
        },
      },
      {
        kind: "text",
        position: titlePosition,
        maxWidth: bounds.width - 36,
        content: entity.name,
        fontFamily: "IBM Plex Sans SemiBold",
        fontSize: 17,
        color: theme.text,
        align: "start",
      },
    ],
  };

  const detail: Representation = {
    id: `${entity.id}:detail`,
    lod: detailLod,
    primitives: [
      {
        kind: "roundedRect",
        rect: bounds,
        radius: Math.max(0, Math.min(entity.kind === "code" ? 6 : 14, bounds.width / 2, bounds.height / 2)),
        fill,
        stroke: {
          color: [Math.min(1, fill[0] + 0.18), Math.min(1, fill[1] + 0.18), Math.min(1, fill[2] + 0.18), 1],
          width: 2,
        },
      },
      {
        kind: "text",
        position: { x: bounds.x + 18, y: bounds.y + 26 },
        maxWidth: bounds.width - 36,
        content: entity.kind,
        fontFamily: "IBM Plex Sans SemiBold",
        fontSize: 9,
        color: theme.mutedText,
        align: "start",
      },
      {
        kind: "text",
        position: { x: bounds.x + 18, y: bounds.y + 50 },
        maxWidth: bounds.width - 36,
        content: entity.name,
        fontFamily: entity.kind === "code" ? "IBM Plex Mono SemiBold" : "IBM Plex Sans SemiBold",
        fontSize: 17,
        color: theme.text,
        align: "start",
      },
      ...(entity.responsibility
        ? ([
            {
              kind: "text",
              position: { x: bounds.x + 18, y: bounds.y + 75 },
              maxWidth: bounds.width - 36,
              content: entity.responsibility,
              fontFamily: "IBM Plex Sans",
              fontSize: 11,
              color: theme.mutedText,
              align: "start",
            },
          ] satisfies Representation["primitives"])
        : []),
    ],
  };
  return [overview, detail];
}

function unionBounds(rects: readonly Rect[], padding: number): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  return {
    x: left - padding,
    y: top - padding,
    width: right - left + padding * 2,
    height: bottom - top + padding * 2,
  };
}

function center(layout: NodeLayout): Point {
  return { x: layout.x + layout.width / 2, y: layout.y + layout.height / 2 };
}

function pathMidpoint(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0]! };
  const segments = points.slice(1).map((point, index) => {
    const previous = points[index]!;
    return { from: previous, to: point, length: Math.hypot(point.x - previous.x, point.y - previous.y) };
  });
  const totalLength = segments.reduce((total, segment) => total + segment.length, 0);
  if (totalLength === 0) return { ...points[0]! };
  const target = totalLength / 2;
  let traversed = 0;
  for (const segment of segments) {
    if (traversed + segment.length >= target) {
      const progress = (target - traversed) / segment.length;
      return {
        x: segment.from.x + (segment.to.x - segment.from.x) * progress,
        y: segment.from.y + (segment.to.y - segment.from.y) * progress,
      };
    }
    traversed += segment.length;
  }
  return { ...points.at(-1)! };
}

export function compileScene(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  options: CompileSceneOptions = {},
): SceneSnapshot {
  const issues = [...validateSnapshot(snapshot), ...validateView(snapshot, view)];
  if (issues.length) throw new Error(`Cannot compile invalid architecture: ${issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`);

  const theme = options.theme ?? defaultTheme;
  validateOptions(options, theme);
  const visibleEntityIds = new Set(view.entityIds);
  const visibleRelationIds = new Set(view.relationIds);
  const entityObjects: SceneObject[] = snapshot.entities
    .filter((entity) => visibleEntityIds.has(entity.id))
    .sort((a, b) => compareText(a.id, b.id))
    .map((entity) => {
      const bounds = view.layout.nodes[entity.id];
      if (!bounds) throw new Error(`Missing layout for ${entity.id}`);
      return {
        id: entity.id,
        ...(entity.parentId && visibleEntityIds.has(entity.parentId) ? { parentId: entity.parentId } : {}),
        zIndex: entity.kind === "boundary" ? -2 : entity.kind === "softwareSystem" ? -1 : 1,
        bounds,
        pickable: entity.kind !== "boundary",
        representations: objectRepresentations(entity, bounds, theme),
      };
    });

  const visibleRelations = snapshot.relations
    .filter((relation) => visibleRelationIds.has(relation.id))
    .sort((a, b) => compareText(a.id, b.id));
  const paths: ScenePath[] = visibleRelations.map((relation) => {
      const from = view.layout.nodes[relation.from];
      const to = view.layout.nodes[relation.to];
      if (!from || !to) throw new Error(`Relation ${relation.id} has an endpoint without layout`);
      return {
        id: relation.id,
        fromObjectId: relation.from,
        toObjectId: relation.to,
        points: view.layout.edges?.[relation.id]?.points ?? [center(from), center(to)],
        stroke: relation.optional ? theme.optionalEdge : theme.edge,
        width: 2,
        arrow: "end",
        optional: relation.optional ?? false,
        pickable: true,
        lod: { minZoom: 0, maxZoom: null, fadeWidth: 0.1, hysteresis: 0.04 },
      };
    });
  const pathById = new Map(paths.map((path) => [path.id, path]));
  const labelObjects: SceneObject[] = visibleRelations.flatMap((relation) => {
    if (!relation.label?.trim()) return [];
    const path = pathById.get(relation.id);
    if (!path) return [];
    const midpoint = pathMidpoint(path.points);
    const fontSize = 11;
    const maxWidth = 160;
    const textWidth = Math.min(maxWidth, [...relation.label].length * fontSize * 0.625);
    const baselineY = midpoint.y - 6;
    const objectId = `relation-label:${relation.id}`;
    return [{
      id: objectId,
      zIndex: 30,
      bounds: { x: midpoint.x - textWidth / 2, y: baselineY - fontSize, width: textWidth, height: fontSize },
      pickable: false,
      representations: [{
        id: `${objectId}:default`,
        lod: { ...path.lod },
        primitives: [{
          kind: "text",
          position: { x: midpoint.x, y: baselineY },
          maxWidth,
          content: relation.label,
          fontFamily: "IBM Plex Sans Medium",
          fontSize,
          color: theme.edgeLabel,
          align: "center",
        }],
      }],
    }];
  });
  const objects = [...entityObjects, ...labelObjects];

  return {
    protocolVersion: RENDERER_PROTOCOL_VERSION,
    sceneId: options.sceneId ?? `scene:${view.id}`,
    revision: options.revision ?? 1,
    worldBounds: unionBounds(objects.map((object) => object.bounds), options.worldPadding ?? 120),
    objects,
    paths,
  };
}
