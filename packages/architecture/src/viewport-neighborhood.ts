import type { EntityKind, NodeLayout, Rect, StoryDetail } from "./model.js";
import { compareText } from "./text-order.js";

/**
 * Spatial-index cell size used by the CPU renderer (`crates/atlas-engine`
 * `DEFAULT_CELL_SIZE`). Camera-resident tiles are keyed off this grid.
 */
export const VIEWPORT_TILE_WORLD_SIZE = 512;

/**
 * CLA-67 healthy sibling count for one compiled C4 band. This is a
 * **compiled-scene window** for off-screen L3/L4, not a replacement for the
 * 2000 hang-guard (`SCAN_BAND_DEPTH_MIN_ENTITIES`).
 */
export const VIEWPORT_RESIDENT_NODES_PER_BAND = 50;

export type ViewportTileKey = `${number},${number}`;

export type ResidentVisualNode = {
  kind: EntityKind;
  entity: { logicalId: string };
  parentVisualId?: string;
};

export type SelectResidentVisualNodesInput = {
  band: StoryDetail;
  visualNodeIds: readonly string[];
  packed: Readonly<Record<string, NodeLayout>>;
  visualNodeById: Readonly<Record<string, ResidentVisualNode>>;
  focusEntityId: string;
  maxNodesPerBand?: number;
  residentWorldBounds?: Rect;
  keepEntityIds?: readonly string[];
  /** When set, only these kinds consume the L3/L4 card cap (CLA-109 code-only). */
  pagedKinds?: readonly EntityKind[];
};

export type ResidentVisualNodeSelection = {
  residentIds: string[];
  omittedIds: string[];
};

function rectsOverlap(left: Rect, right: Rect): boolean {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function rectCenter(bounds: Rect): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function distanceSquared(left: { x: number; y: number }, right: { x: number; y: number }): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

/**
 * Expand a camera world rect by one spatial-index cell on every side (the
 * Google Maps neighbor ring around the viewport).
 */
export function expandRectByTileRing(
  bounds: Rect,
  cellSize = VIEWPORT_TILE_WORLD_SIZE,
): Rect {
  return {
    x: bounds.x - cellSize,
    y: bounds.y - cellSize,
    width: bounds.width + 2 * cellSize,
    height: bounds.height + 2 * cellSize,
  };
}

/** World-space rectangle covered by a camera (zoom = CSS pixels per world unit). */
export function cameraWorldRect(
  camera: { x: number; y: number; zoom: number },
  viewport: { width: number; height: number },
): Rect {
  const zoom = camera.zoom > 0 ? camera.zoom : 1;
  const width = Math.max(1, viewport.width) / zoom;
  const height = Math.max(1, viewport.height) / zoom;
  return {
    x: camera.x - width / 2,
    y: camera.y - height / 2,
    width,
    height,
  };
}

/** Deterministic tile keys covering `bounds` on the 512-world-unit grid. */
export function tileKeysForRect(
  bounds: Rect,
  cellSize = VIEWPORT_TILE_WORLD_SIZE,
): ViewportTileKey[] {
  if (!(cellSize > 0) || !(Number.isFinite(bounds.x) && Number.isFinite(bounds.y))) return [];
  const width = Math.max(0, bounds.width);
  const height = Math.max(0, bounds.height);
  const x0 = Math.floor(bounds.x / cellSize);
  const y0 = Math.floor(bounds.y / cellSize);
  const x1 = Math.floor((bounds.x + width) / cellSize);
  const y1 = Math.floor((bounds.y + height) / cellSize);
  const keys: ViewportTileKey[] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      keys.push(`${x},${y}`);
    }
  }
  return keys;
}

/**
 * Cache key for a camera-resident compile of one C4 neighborhood. Tile keys
 * change as the user pans; the focus id does not. Not a full-graph compile.
 */
export function viewportNeighborhoodCacheKey(
  focusEntityId: string,
  camera?: { x: number; y: number; zoom: number },
  viewport?: { width: number; height: number },
): string {
  if (!camera || !viewport) return `${focusEntityId}@unwindowed`;
  const windowed = expandRectByTileRing(cameraWorldRect(camera, viewport));
  return `${focusEntityId}@${tileKeysForRect(windowed).join(";")}`;
}

function pagingBounds(
  id: string,
  packed: Readonly<Record<string, NodeLayout>>,
  visualNodeById: Readonly<Record<string, ResidentVisualNode>>,
  pagedKinds?: readonly EntityKind[],
): NodeLayout | undefined {
  const node = visualNodeById[id];
  // CLA-109: L4 overlap/ranking walks to a packed ancestor. Hinted symbol
  // interiors and reserved file faces sit in a different space than compact
  // L2 tiles, so using those for the camera test pages the on-screen crate
  // to zero L4 and wheel cannot enter the code band.
  if (node && pagedKinds?.includes(node.kind)) {
    // Exact code slots are supplied for scan L4 paging. Prefer one when it is
    // available so a late symbol can be selected by its real in-file position;
    // retain the ancestor-face fallback for legacy/unhinted projections.
    const own = packed[id];
    if (own) return own;
    let currentId: string | undefined = node.parentVisualId;
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const ancestor = packed[currentId];
      if (ancestor) return ancestor;
      currentId = visualNodeById[currentId]?.parentVisualId;
    }
  }
  const own = packed[id];
  if (own) return own;
  const parentId = node?.parentVisualId;
  return parentId ? packed[parentId] : undefined;
}

function ancestorVisualIds(
  startId: string,
  visualNodeById: Readonly<Record<string, ResidentVisualNode>>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = startId;
  while (current && !seen.has(current)) {
    ids.push(current);
    seen.add(current);
    current = visualNodeById[current]?.parentVisualId;
  }
  return ids;
}

/** L3/L4 cards CLA-74 pages. Coarser shells stay resident (CLA-106). */
function isPagedBandKind(kind: EntityKind | undefined, pagedKinds?: readonly EntityKind[]): boolean {
  if (pagedKinds) return Boolean(kind && pagedKinds.includes(kind));
  return kind === "component" || kind === "code";
}

/**
 * Compiled and resident set for one C4 band (CLA-74): focused entity +
 * siblings + one band down, then the camera tile window (viewport + one
 * 512-unit ring). L1/L2 stay unpaged (a handful). Off-screen L3/L4 beyond
 * the window are omitted for inspector `+N more`.
 *
 * CLA-106: container-rank (and coarser) shells that land in an L3/L4 compile
 * stay resident so pan has adjacent territory. They do not consume the 50
 * L3/L4 card cap.
 *
 * Packing of the full neighborhood must happen first so parent bounds stay
 * stable; this helper only chooses which packed nodes remain in the compiled
 * scene. Default (no cap, no camera rect) returns every id — byte-identical.
 */
export function selectResidentVisualNodeIds(
  input: SelectResidentVisualNodesInput,
): ResidentVisualNodeSelection {
  const ordered = [...input.visualNodeIds];
  const all = () => ({ residentIds: ordered, omittedIds: [] as string[] });
  if (input.band === "context" || input.band === "container") return all();
  if (input.maxNodesPerBand === undefined && input.residentWorldBounds === undefined) return all();

  const paged = (kind: EntityKind | undefined) => isPagedBandKind(kind, input.pagedKinds);
  const byId = input.visualNodeById;
  const keepEntities = new Set([input.focusEntityId, ...(input.keepEntityIds ?? [])]);
  const always = new Set<string>();
  for (const id of ordered) {
    const node = byId[id];
    if (!node) continue;
    if (keepEntities.has(node.entity.logicalId)
      || node.kind === "person"
      || node.kind === "externalSystem"
      || !paged(node.kind)) {
      for (const ancestor of ancestorVisualIds(id, byId)) always.add(ancestor);
    }
  }

  const origin = input.residentWorldBounds
    ? rectCenter(input.residentWorldBounds)
    : (() => {
      const focusId = ordered.find(id => byId[id]?.entity.logicalId === input.focusEntityId);
      const bounds = (focusId ? pagingBounds(focusId, input.packed, byId, input.pagedKinds) : undefined)
        ?? pagingBounds(ordered[0] ?? "", input.packed, byId, input.pagedKinds);
      return bounds ? rectCenter(bounds) : { x: 0, y: 0 };
    })();

  const eligible = new Set<string>(always);
  for (const id of ordered) {
    if (always.has(id)) continue;
    const bounds = pagingBounds(id, input.packed, byId, input.pagedKinds);
    if (!bounds) continue;
    if (input.residentWorldBounds && !rectsOverlap(bounds, input.residentWorldBounds)) continue;
    eligible.add(id);
  }

  // CLA-109: L1/L2 camera tiles can miss every L4 box (compact container
  // faces vs file interiors). Never page the landmark set to zero — keep the
  // nearest cap so L3↔L4 can still morph instead of re-rooting.
  if (input.pagedKinds && input.maxNodesPerBand !== undefined) {
    const pagedEligible = [...eligible].filter(id => paged(byId[id]?.kind));
    if (pagedEligible.length === 0) {
      for (const id of ordered) {
        if (always.has(id) || !paged(byId[id]?.kind)) continue;
        if (!pagingBounds(id, input.packed, byId, input.pagedKinds)) continue;
        eligible.add(id);
      }
    }
  }

  const pagedEligibleCount = [...eligible].filter(id => paged(byId[id]?.kind)).length;
  if (input.maxNodesPerBand === undefined || pagedEligibleCount <= input.maxNodesPerBand) {
    const residentIds = ordered.filter(id => eligible.has(id));
    return {
      residentIds,
      omittedIds: ordered.filter(id => !eligible.has(id)),
    };
  }

  const ranked = [...eligible]
    .filter(id => !always.has(id) && paged(byId[id]?.kind))
    .sort((left, right) => {
      const leftBounds = pagingBounds(left, input.packed, byId, input.pagedKinds);
      const rightBounds = pagingBounds(right, input.packed, byId, input.pagedKinds);
      const leftDistance = leftBounds ? distanceSquared(rectCenter(leftBounds), origin) : Number.POSITIVE_INFINITY;
      const rightDistance = rightBounds ? distanceSquared(rectCenter(rightBounds), origin) : Number.POSITIVE_INFINITY;
      return leftDistance - rightDistance || compareText(left, right);
    });
  const kept = new Set(always);
  const alwaysPaged = [...always].filter(id => paged(byId[id]?.kind)).length;
  const remaining = Math.max(0, input.maxNodesPerBand - alwaysPaged);
  for (const id of ranked.slice(0, remaining)) kept.add(id);
  const residentIds = ordered.filter(id => kept.has(id));
  return {
    residentIds,
    omittedIds: ordered.filter(id => !kept.has(id)),
  };
}
