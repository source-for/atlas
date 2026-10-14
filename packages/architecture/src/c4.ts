import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  EdgeLayout,
  EntityKind,
  NodeLayout,
  Rect,
  RelationId,
  RelationKind,
  StoryDetail,
} from './model.js';
import { selectResidentVisualNodeIds } from './viewport-neighborhood.js';
import type { RelationRouteOverride } from './authoring.js';
import {
  expandRoutingRect,
  routeOrthogonal,
  routeOrthogonalWithIntent,
  simplifyOrthogonalPoints,
  type GuidedOrthogonalRouteReason,
  type OrthogonalRouteDiagnostic,
} from './orthogonal-router.js';
import { compareText } from './text-order.js';

export type C4Band = StoryDetail;

export const C4_BANDS: readonly C4Band[] = ['context', 'container', 'component', 'code'];

export type LineageEntityRef = {
  snapshotEntityId: string;
  logicalId: string;
  lineageId: string;
};

export type LineageRelationRef = {
  snapshotRelationId: string;
  logicalId: string;
  lineageId: string;
};

export type ViewFamily = {
  id: string;
  snapshotId: string;
  rootEntity: LineageEntityRef;
  focusEntity: LineageEntityRef;
  zoomPolicyId: string;
  projectionIds: Record<C4Band, string>;
};

export type BandProjection = {
  id: string;
  familyId: string;
  snapshotId: string;
  band: C4Band;
  rootEntity: LineageEntityRef;
  focusEntity: LineageEntityRef;
  visualNodeIds: string[];
  visualEdgeIds: string[];
  contextNodeIds: string[];
  /** Present only under an edge budget: visual edges kept out of routing but still
   *  enumerable via the bundle index (the "+N more" set). */
  omittedEdgeIds?: string[];
  /** Present only under an L3/L4 resident window: packed nodes kept out of the
   *  compiled scene but still enumerable via inspector `+N more`. */
  omittedNodeIds?: string[];
  layoutId: string;
};

export type VisualNode = {
  id: string;
  entity: LineageEntityRef;
  kind: EntityKind;
  name: string;
  responsibility?: string;
  technology: string[];
  parentVisualId?: string;
};

export type VisualEdgeAggregate = {
  count: number;
  kinds: RelationKind[];
  labels: string[];
  technologies: string[];
  optionalCount: number;
};

export type VisualEdge = {
  id: string;
  projectionId: string;
  fromVisualId: string;
  toVisualId: string;
  kind: RelationKind;
  label: string;
  relations: LineageRelationRef[];
  aggregate: VisualEdgeAggregate;
};

export type BandLayout = {
  id: string;
  projectionId: string;
  policy: {
    id: string;
    fontMetricsId: string;
    labelPaddingScreenPx: number;
  };
  nodes: Record<string, NodeLayout>;
  edges: Record<string, EdgeLayout>;
  /**
   * CLA-81 reserved shells: packed bounds for omitted / unpublished children
   * that stay out of `visualNodeIds` (details stay lazy). Keys are visual node
   * ids. Absent on the golden/default path.
   */
  reservedShells?: Record<string, NodeLayout>;
  /**
   * CLA-120: `+N more` remainder chip inside an L2 container that capped
   * resident preview pills. Keys are parent visual node ids. Absent when
   * every child is resident (golden / unbounded / L3 Open inside).
   */
  remainderBadges?: Record<string, { count: number; bounds: NodeLayout }>;
};

export type ProjectionIndex = {
  entityIdByVisualNodeId: Record<string, string>;
  visualNodeIdsByEntityId: Record<string, string[]>;
  relationIdsByVisualEdgeId: Record<string, string[]>;
  visualEdgeIdsByRelationId: Record<string, string[]>;
  boundsByEntityIdAndBand: Record<string, Partial<Record<C4Band, NodeLayout>>>;
};

/**
 * Normalized semantic-zoom artifact. Rows are keyed independently so the same
 * visual node can retain identity while different band projections reference it.
 */
export type C4ProjectionBundle = {
  schemaVersion: 1;
  /** Internal compile policy: L4 residents use canonical full-sibling slots. */
  pageCodeLandmarks?: boolean;
  family: ViewFamily;
  projectionById: Record<string, BandProjection>;
  visualNodeById: Record<string, VisualNode>;
  visualEdgeById: Record<string, VisualEdge>;
  bandLayoutById: Record<string, BandLayout>;
  index: ProjectionIndex;
};

export type MaterializedBandProjection = {
  schemaVersion: 1;
  familyId: string;
  snapshotId: string;
  band: C4Band;
  rootEntity: LineageEntityRef;
  focusEntity: LineageEntityRef;
  nodes: Array<VisualNode & { bounds: NodeLayout; context: boolean }>;
  edges: Array<VisualEdge & { route: EdgeLayout }>;
};

export type BuildC4ProjectionOptions = {
  rootEntityId: string;
  focusEntityId?: string;
  familyId?: string;
  zoomPolicyId?: string;
  /** User-owned relations may connect any two nodes already visible in-band. */
  authoredRelationIds?: readonly RelationId[];
  /**
   * Deepest band to populate (opt-in scoped compile). Bands deeper than this are
   * left empty so a large-repo top scene compiles without routing every component/code
   * edge; the app re-compiles a deeper focus on drill-in. Default: all bands.
   */
  maxBand?: C4Band;
  /**
   * Routed-edge budget per band (opt-in). When a band has more visual edges than this,
   * only the top-N are routed: focus-first, then aggregate count desc, then on the
   * code band clone `duplicates` ahead of same-count `uses` (CLA-68), then id asc.
   * The remainder are recorded on `BandProjection.omittedEdgeIds` (their VisualEdge
   * records — and thus relation ids/evidence — stay in the bundle index for
   * `+N more` enumeration). Default: unbounded (byte-identical).
   */
  maxEdgesPerBand?: number;
  /**
   * Routing grid-node budget (opt-in). Lower values make dense bands route faster and
   * degrade gracefully to a direct edge when a tight grid can't find an obstacle-safe
   * route (instead of hanging). Default: 20000 (byte-identical).
   */
  maxGridNodes?: number;
  /**
   * Aspect-aware packing target (opt-in, task #30). Forwarded to every owner grid so
   * a dense owner packs toward this width/height ratio instead of a fixed 3-column
   * column that grows unboundedly tall. Absent → historical packing (byte-identical).
   * See {@link ASPECT_PRESET_TARGET} for the discrete client-chosen presets.
   */
  targetAspect?: number;
  /**
   * Compiled-scene node window for L3/L4 (opt-in, CLA-74). Packs the full
   * neighborhood so parent bounds stay stable, then keeps focused entity +
   * siblings + one band down inside the camera tile window. Remainder goes to
   * `omittedNodeIds` for inspector `+N more`. Default: unbounded (byte-identical).
   */
  maxNodesPerBand?: number;
  /**
   * Camera-resident world window (opt-in), typically the viewport plus one
   * 512-world-unit tile ring. L3/L4 nodes whose packed bounds miss this rect
   * are omitted from the compiled scene. Default: no camera paging.
   */
  residentWorldBounds?: Rect;
  /** Entity ids that must stay resident even when off-camera (selection). */
  keepEntityIds?: readonly string[];
  /**
   * CLA-109: page only L4 `code` cards (keep L3 file shells). Default pages
   * both component and code (CLA-74). Additive; omitted → byte-identical.
   */
  pageCodeLandmarks?: boolean;
  /**
   * CLA-120: at L2 (context-rank focus), keep this many landmark component
   * pills per container and record the rest on `omittedNodeIds` (`+N more`).
   * Does not apply at L3 Open inside / container focus. Default: unbounded
   * (byte-identical). Independent of CLA-119 √N footprints.
   */
  maxL2PreviewPillsPerOwner?: number;
  /**
   * World-space entity bounds for L4 paging (previous compiled scene). When
   * set, `pageCodeLandmarks` selects L4 in that camera space instead of
   * stage-1 leaf packing, and does not re-pack parents after the window.
   * Omit on first compile so parent file shells (packed with L3) provide the
   * overlap test — containment layout is a different space from L1/L2 tiles.
   */
  entityLayoutHints?: Readonly<Record<string, NodeLayout>>;
};

/**
 * World-space L1 card face for a software system (stage-1 leaf). Scan Fit / boot
 * frame this readable face instead of the CLA-81 reserved interior footprint.
 */
export const C4_CONTEXT_CARD_FACE = { width: 480, height: 250 } as const;

/**
 * World-space L2 card face for a container (stage-1 leaf). Scan Open inside
 * frames this readable face instead of a CLA-81 reserved interior footprint.
 */
export const C4_CONTAINER_CARD_FACE = { width: 420, height: 180 } as const;

/**
 * World-space L3 card face for a file-component (stage-1 leaf). Scan Open inside
 * a container frames this readable face instead of a CLA-81 reserved interior.
 */
export const C4_COMPONENT_CARD_FACE = { width: 300, height: 150 } as const;

/**
 * Screen-space geometry contract used when a semantic owner reveals its
 * children. The scene compiler converts these values to world units at the
 * focus zoom of the incoming band.
 */
export const C4_INTRINSIC_LAYOUT = {
  maxColumns: 3,
  leaf: {
    code: { width: 224, height: 112 },
  },
  gap: 16,
  sidePadding: 20,
  bottomPadding: 20,
  header: {
    system: 72,
    container: 72,
    component: 96,
  },
} as const;

/**
 * Screen-space routing clearance (CSS px at band focus). Matches the
 * `8 / focusZoom` world clearance compiled in `@okie/scene-compiler`.
 */
export const C4_ROUTING_CLEARANCE_PX = 8;

/**
 * Scan-mode extra L4 sibling gap (CSS px at code focus zoom). Packed code
 * cards otherwise sit two routing clearances apart, so a duplicates U is
 * shorter than the renderer’s 6px corner rounding and collapses into a
 * facing hop. Modest L4 packing bump (CLA-68); golden/demo (no
 * targetAspect) stay byte-identical. A 20-leaf landscape file (okie’s
 * icons.tsx public surface) reflows 4→5 columns at +32px — enough for a
 * ~20px U at code-enter zoom, not a packing rewrite.
 */
export const C4_SCAN_CODE_GAP_EXTRA_PX = 32;

/**
 * Focus-zoom contract the intrinsic owner grid uses (CLA-81). Must match
 * `C4_ZOOM_BANDS[].focusZoom` in `@okie/scene-compiler` so containment
 * precompute and band compile paint into the same world shells.
 */
export const C4_BAND_FOCUS_ZOOM: Readonly<Record<C4Band, number>> = Object.freeze({
  context: 0.75,
  container: 1.99,
  component: 5.27,
  code: 13.96,
});

/** Next-band child kind a C4 owner packs. Undefined for leaves / context peers. */
export function c4ExpectedChildKind(kind: EntityKind): EntityKind | undefined {
  if (kind === 'component') return 'code';
  if (kind === 'container' || kind === 'dataStore' || kind === 'queue') return 'component';
  if (kind === 'softwareSystem') return 'container';
  return undefined;
}

/**
 * World-space grid metrics for an owner's direct children (CLA-81 / intrinsic
 * grow). Component owners pack at code focus zoom; containers at component;
 * systems at container. Absent kind → undefined (persons / externals / code).
 */
export function c4IntrinsicOwnerMetrics(kind: EntityKind, targetAspect?: number): C4GridMetrics | undefined {
  const contract = C4_INTRINSIC_LAYOUT;
  const focusZoom = kind === 'component'
    ? C4_BAND_FOCUS_ZOOM.code
    : kind === 'container' || kind === 'dataStore' || kind === 'queue'
      ? C4_BAND_FOCUS_ZOOM.component
      : kind === 'softwareSystem'
        ? C4_BAND_FOCUS_ZOOM.container
        : undefined;
  if (!focusZoom) return undefined;
  const header = kind === 'component'
    ? contract.header.component
    : kind === 'softwareSystem'
      ? contract.header.system
      : contract.header.container;
  return {
    gap: (contract.gap + (targetAspect !== undefined && kind === 'component' ? C4_SCAN_CODE_GAP_EXTRA_PX : 0)) / focusZoom,
    paddingLeft: contract.sidePadding / focusZoom,
    paddingRight: contract.sidePadding / focusZoom,
    paddingTop: header / focusZoom,
    paddingBottom: contract.bottomPadding / focusZoom,
    maxColumns: contract.maxColumns,
    ...(targetAspect !== undefined ? { targetAspect } : {}),
  };
}

/**
 * Stable L4 grid slots for a component's complete direct-code order. Paging
 * uses these lightweight bounds to choose residents; the scene compiler uses
 * the same calculation when it materializes only those residents. Keeping the
 * full order here prevents a pinned or late symbol from re-packing its file.
 */
export function c4CodeChildSlots(
  parent: NodeLayout,
  childIds: readonly string[],
): Record<string, NodeLayout> {
  const ordered = [...childIds].sort(compareText);
  if (!ordered.length) return {};
  const focusZoom = C4_BAND_FOCUS_ZOOM.code;
  const padX = C4_INTRINSIC_LAYOUT.sidePadding / focusZoom;
  const padTop = C4_INTRINSIC_LAYOUT.header.component / focusZoom;
  const padBottom = C4_INTRINSIC_LAYOUT.bottomPadding / focusZoom;
  const gap = C4_ROUTING_CLEARANCE_PX / focusZoom;
  let innerX = parent.x + padX;
  let innerY = parent.y + padTop;
  let innerW = parent.width - padX * 2;
  let innerH = parent.height - padTop - padBottom;
  if (innerW < 4) {
    innerX = parent.x + Math.min(padX, parent.width * 0.04);
    innerW = Math.max(1, parent.width - (innerX - parent.x) * 2);
  }
  if (innerH < 4) {
    innerY = parent.y + Math.min(padTop, parent.height * 0.12);
    const bottom = Math.min(padBottom, parent.height * 0.04);
    innerH = Math.max(1, parent.y + parent.height - bottom - innerY);
  }
  const maxX = parent.x + parent.width;
  const maxY = parent.y + parent.height;
  innerX = Math.min(Math.max(parent.x, innerX), maxX);
  innerY = Math.min(Math.max(parent.y, innerY), maxY);
  innerW = Math.max(1, Math.min(innerW, maxX - innerX));
  innerH = Math.max(1, Math.min(innerH, maxY - innerY));
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
  const rows = Math.ceil(ordered.length / columns);
  const cellW = innerW / columns;
  const cellH = innerH / rows;
  const inset = Math.min(gap, cellW / 4, cellH / 4);
  const slots: Record<string, NodeLayout> = {};
  ordered.forEach((id, index) => {
    const x = innerX + (index % columns) * cellW + inset;
    const y = innerY + Math.floor(index / columns) * cellH + inset;
    slots[id] = {
      x,
      y,
      width: Math.max(1, Math.min(cellW - inset * 2, maxX - x)),
      height: Math.max(1, Math.min(cellH - inset * 2, maxY - y)),
    };
  });
  return slots;
}

/** World-space floor for one unpublished / childless occupant of `kind`. */
export function c4ContainmentLeafSize(kind: EntityKind, targetAspect?: number): { width: number; height: number } {
  const code = {
    width: C4_INTRINSIC_LAYOUT.leaf.code.width / C4_BAND_FOCUS_ZOOM.code,
    height: C4_INTRINSIC_LAYOUT.leaf.code.height / C4_BAND_FOCUS_ZOOM.code,
  };
  if (kind === 'code') return code;
  const ownBand: C4Band | undefined = kind === 'component'
    ? 'component'
    : kind === 'container' || kind === 'dataStore' || kind === 'queue'
      ? 'container'
      : kind === 'softwareSystem'
        ? 'context'
        : undefined;
  if (targetAspect !== undefined && ownBand && ownBand !== 'context') {
    const zoom = C4_BAND_FOCUS_ZOOM[ownBand];
    return {
      width: C4_INTRINSIC_LAYOUT.leaf.code.width / zoom * 2,
      height: C4_INTRINSIC_LAYOUT.leaf.code.height / zoom * 2,
    };
  }
  return code;
}

/**
 * Scan L3 file-component card face (CLA-121). Compact leaf at component
 * focus — kicker + title (+ optional summary). Not the CLA-81 reserved L4
 * interior used when nested symbols are painted.
 */
export function c4ScanComponentCardFace(targetAspect: number): { width: number; height: number } {
  return c4ContainmentLeafSize('component', targetAspect);
}

/**
 * Child count that still fits Canvas2D titles on the compact L2 peer tile.
 * `ceil(sqrt(N))` packing into the 224×112 leaf is a ~3×3 grid at N=9, matching
 * `C4_INTRINSIC_LAYOUT.maxColumns`. CLA-119 scales the leaf by √(N / comfort)
 * so fat packages expand while N≤comfort stays compact. Edge ∝ √N; that is a
 * nested shell, not a full-bleed squarified treemap of the L2 map.
 */
export const C4_SCAN_L2_PEER_TILE_CHILD_COMFORT = 9;

/**
 * Landmark file-pill cap inside one L2 container shell (CLA-120). Fat
 * packages like `@okie/web` keep this many resident preview pills plus a
 * `+N more` remainder; Open inside / L2→L3 still compiles the full
 * neighborhood. Midpoint of the 8–12 product window; independent of the
 * hang-guard (2000) and of CLA-119 √N footprints.
 */
export const C4_SCAN_L2_RESIDENT_PREVIEW_PILLS = 10;

export type L2PreviewVisualNode = {
  kind: EntityKind;
  entity: { logicalId: string };
  parentVisualId?: string;
};

/**
 * Per-owner L2 preview window: keep {@link C4_SCAN_L2_RESIDENT_PREVIEW_PILLS}
 * landmark `component` pills (heavier code children first, then id), omit
 * the rest for `+N more`. Coarser shells always stay resident. Default
 * (no cap) is not used — callers pass the constant explicitly so golden
 * stays byte-identical.
 */
export function selectL2ResidentPreviewPills(input: {
  visualNodeIds: readonly string[];
  visualNodeById: Readonly<Record<string, L2PreviewVisualNode>>;
  maxPillsPerOwner: number;
}): { residentIds: string[]; omittedIds: string[] } {
  const ordered = [...input.visualNodeIds];
  const byId = input.visualNodeById;
  const cap = Math.max(0, input.maxPillsPerOwner);
  const codeWeight = new Map<string, number>();
  for (const node of Object.values(byId)) {
    if (node.kind !== 'code' || !node.parentVisualId) continue;
    codeWeight.set(node.parentVisualId, (codeWeight.get(node.parentVisualId) ?? 0) + 1);
  }
  const byParent = new Map<string, string[]>();
  const always = new Set<string>();
  for (const id of ordered) {
    const node = byId[id];
    if (!node || node.kind !== 'component') {
      always.add(id);
      continue;
    }
    const parent = node.parentVisualId ?? '';
    const list = byParent.get(parent) ?? [];
    list.push(id);
    byParent.set(parent, list);
  }
  const kept = new Set(always);
  for (const kids of byParent.values()) {
    const ranked = [...kids].sort((left, right) => {
      const leftWeight = codeWeight.get(left) ?? 0;
      const rightWeight = codeWeight.get(right) ?? 0;
      return rightWeight - leftWeight || compareText(left, right);
    });
    for (const id of ranked.slice(0, cap)) kept.add(id);
  }
  return {
    residentIds: ordered.filter(id => kept.has(id)),
    omittedIds: ordered.filter(id => !kept.has(id)),
  };
}

/** Compact (N≤comfort) scan L2 package tile — one intrinsic leaf at container focus. */
export function c4ScanContainerPeerTileBase(): { width: number; height: number } {
  const zoom = C4_BAND_FOCUS_ZOOM.container;
  return {
    width: C4_INTRINSIC_LAYOUT.leaf.code.width / zoom,
    height: C4_INTRINSIC_LAYOUT.leaf.code.height / zoom,
  };
}

/**
 * CLA-119: scan L2 container peer tile. Soft √N — edge scales with
 * √(childCount / comfort) so `@okie/web`-scale packages breathe and thin
 * packages stay at the compact leaf. Independent per-container shells packed
 * as a padded grid, not a treemap fill of the system.
 */
export function c4ScanContainerPeerTile(childCount: number): { width: number; height: number } {
  const base = c4ScanContainerPeerTileBase();
  const n = Number.isFinite(childCount) ? Math.max(0, childCount) : 0;
  const scale = Math.max(1, Math.sqrt(n / C4_SCAN_L2_PEER_TILE_CHILD_COMFORT));
  return {
    width: base.width * scale,
    height: base.height * scale,
  };
}

/** World-space packed-gutter ceiling for a tight L4 duplicates loop. */
function packedDuplicatesGutter(clearance: number): number {
  return clearance * 2 + clearance * (C4_SCAN_CODE_GAP_EXTRA_PX / C4_ROUTING_CLEARANCE_PX);
}

/**
 * Discrete, compile-time aspect targets for grid packing. The CLIENT picks one at
 * compile-request time (e.g. from device orientation at bootstrap) and it travels
 * with the compiled scene as a deterministic parameter — the live viewport never
 * feeds layout, so a shared or restored scene reproduces byte-for-byte. `landscape`
 * is ~16:10, `portrait` its inverse, `square` = 1.
 */
export type AspectPreset = 'landscape' | 'portrait' | 'square';

export const ASPECT_PRESET_TARGET: Readonly<Record<AspectPreset, number>> = Object.freeze({
  landscape: 1.6,
  portrait: 0.625,
  square: 1,
});

export type C4GridItem = {
  id: string;
  width: number;
  height: number;
};

export type C4GridMetrics = {
  gap: number;
  paddingLeft: number;
  paddingRight: number;
  paddingTop: number;
  paddingBottom: number;
  maxColumns?: number;
  /**
   * Opt-in aspect-aware packing (task #30). When set (> 0), the column count is
   * chosen so the measured grid box lands closest to this width/height ratio,
   * overriding the fixed `maxColumns` cap — this is what stops a dense owner (50+
   * children) from stacking into one very tall column. Absent → the historical
   * `min(maxColumns, ceil(sqrt(n)))` formula runs unchanged (byte-identical).
   */
  targetAspect?: number;
};

export type C4GridMeasurement = {
  columns: number;
  rows: number;
  columnWidths: number[];
  rowHeights: number[];
  contentWidth: number;
  contentHeight: number;
  width: number;
  height: number;
};

/**
 * O2 owner-aspect safety clamp (task #37): the most extreme width/height ratio a single owner may
 * pack to under an aspect target, in EITHER orientation (an owner is kept within [1/cap, cap]).
 * A sparse owner (few children → coarse achievable ratios) could otherwise pack pathologically
 * wide/tall and over-widen the world. Chosen just beyond the 1.6 landscape / 0.625 portrait
 * presets so it is a BACKSTOP, not the primary shaper — context-peer hugging (O1) does the bulk
 * of the world-aspect work; on Okie's own scan this cap changes a single owner. Only consulted on
 * the targetAspect path, so the default/golden packing is byte-identical.
 */
export const MAX_OWNER_ASPECT = 2.2;

/**
 * Deterministic column count for a compact grid. Default (no `targetAspect`) is the
 * historical `min(maxColumns, ceil(sqrt(n)))`. With a `targetAspect`, seeds the
 * closed-form column count that hits the target width/height ratio, then refines ±1
 * against the exactly-measured box (which accounts for gap/padding/header) and keeps
 * the log-closest to the target — landscape and portrait are treated symmetrically,
 * ties break to the smaller column count. Order-independent: the representative cell
 * uses the max item width/height, mirroring how `measureC4Grid` sizes columns/rows.
 * Finally, {@link MAX_OWNER_ASPECT} clamps the result so no owner packs more extreme than
 * the cap when a within-cap column count exists (a scan-mode backstop; golden never reaches it).
 */
export function chooseColumns(items: readonly C4GridItem[], metrics: C4GridMetrics): number {
  const n = items.length;
  if (n <= 1) return n;
  const target = metrics.targetAspect;
  if (target === undefined || !(target > 0)) {
    const maximumColumns = Math.max(1, metrics.maxColumns ?? C4_INTRINSIC_LAYOUT.maxColumns);
    return Math.min(maximumColumns, Math.max(1, Math.ceil(Math.sqrt(n))));
  }
  // Representative cell = max width/height over the items (loop, not spread, so a very
  // dense owner cannot overflow the call-argument limit). Mirrors how measureC4Grid
  // sizes columns/rows by their max, so the choice is order-independent.
  let cellWidth = 1;
  let cellHeight = 1;
  for (const item of items) {
    if (item.width > cellWidth) cellWidth = item.width;
    if (item.height > cellHeight) cellHeight = item.height;
  }
  const paddingX = metrics.paddingLeft + metrics.paddingRight;
  const paddingY = metrics.paddingTop + metrics.paddingBottom;
  const aspectFor = (columns: number): number => {
    const rows = Math.ceil(n / columns);
    const width = columns * cellWidth + metrics.gap * (columns - 1) + paddingX;
    const height = rows * cellHeight + metrics.gap * (rows - 1) + paddingY;
    return width / height;
  };
  // Closed-form seed C ≈ sqrt(target · n · cellH / cellW), then an exact ±1 refine.
  const seed = Math.round(Math.sqrt((target * n * cellHeight) / cellWidth));
  const clampedSeed = Math.min(n, Math.max(1, seed));
  const candidates = [clampedSeed - 1, clampedSeed, clampedSeed + 1].filter(value => value >= 1 && value <= n);
  let best = candidates[0]!;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const columns of candidates) {
    const score = Math.abs(Math.log(aspectFor(columns)) - Math.log(target));
    if (score < bestScore) {
      best = columns;
      bestScore = score;
    }
  }
  // O2 backstop (task #37): if the target-closest choice still lands outside [1/cap, cap]
  // (coarse achievable ratios for a small owner), fall back to the within-cap column count
  // closest to the target. Full 1..n scan only on this rare path; the common in-cap case
  // returns `best` unchanged, so the pinned column counts (c4-aspect.test) are untouched.
  const withinCap = (columns: number): boolean => {
    const aspect = aspectFor(columns);
    return aspect <= MAX_OWNER_ASPECT && aspect >= 1 / MAX_OWNER_ASPECT;
  };
  if (!withinCap(best)) {
    let capped: number | undefined;
    let cappedScore = Number.POSITIVE_INFINITY;
    for (let columns = 1; columns <= n; columns += 1) {
      if (!withinCap(columns)) continue;
      const score = Math.abs(Math.log(aspectFor(columns)) - Math.log(target));
      if (score < cappedScore) {
        capped = columns;
        cappedScore = score;
      }
    }
    if (capped !== undefined) return capped;
  }
  return best;
}

/** Deterministically measures a compact row-major hierarchy grid. */
export function measureC4Grid(
  items: readonly C4GridItem[],
  metrics: C4GridMetrics,
): C4GridMeasurement {
  const ordered = [...items].sort((left, right) => compareText(left.id, right.id));
  const columns = chooseColumns(ordered, metrics);
  const rows = columns === 0 ? 0 : Math.ceil(ordered.length / columns);
  const columnWidths = Array.from({ length: columns }, (_, column) => Math.max(
    0,
    ...ordered.filter((_, index) => index % columns === column).map(value => value.width),
  ));
  const rowHeights = Array.from({ length: rows }, (_, row) => Math.max(
    0,
    ...ordered.slice(row * columns, (row + 1) * columns).map(value => value.height),
  ));
  const contentWidth = columnWidths.reduce((sum, value) => sum + value, 0)
    + metrics.gap * Math.max(0, columns - 1);
  const contentHeight = rowHeights.reduce((sum, value) => sum + value, 0)
    + metrics.gap * Math.max(0, rows - 1);
  return {
    columns,
    rows,
    columnWidths,
    rowHeights,
    contentWidth,
    contentHeight,
    width: metrics.paddingLeft + contentWidth + metrics.paddingRight,
    height: metrics.paddingTop + contentHeight + metrics.paddingBottom,
  };
}

const bandRank: Record<C4Band, number> = {
  context: 0,
  container: 1,
  component: 2,
  code: 3,
};

function entityRank(kind: EntityKind): number {
  switch (kind) {
    case 'person':
    case 'softwareSystem':
    case 'externalSystem':
      return 0;
    case 'container':
    case 'dataStore':
    case 'queue':
      return 1;
    case 'component':
      return 2;
    case 'code':
      return 3;
    case 'boundary':
      return 0;
  }
}

/** True for L2 container-rank kinds (not their L3/L4 descendants). */
function isContainerRankKind(kind: EntityKind): boolean {
  return entityRank(kind) === bandRank.container;
}

/**
 * CLA-106: same-parent container-rank peers of a focused container, still
 * under `rootId`. Does not walk descendants (CLA-107 stays a separate slice).
 */
function containerRankSiblings(
  focus: ArchitectureEntity,
  rootId: string,
  entityById: ReadonlyMap<string, ArchitectureEntity>,
  snapshot: ArchitectureSnapshot,
): ArchitectureEntity[] {
  if (!isContainerRankKind(focus.kind) || !focus.parentId) return [];
  const siblings: ArchitectureEntity[] = [];
  for (const entity of snapshot.entities) {
    if (entity.id === focus.id) continue;
    if (entity.parentId !== focus.parentId) continue;
    if (!isContainerRankKind(entity.kind)) continue;
    if (!isDescendantOrSelf(entity.id, rootId, entityById)) continue;
    siblings.push(entity);
  }
  return siblings;
}

function entityRef(snapshot: ArchitectureSnapshot, entity: ArchitectureEntity): LineageEntityRef {
  return {
    snapshotEntityId: `${snapshot.id}::${entity.id}`,
    logicalId: entity.id,
    lineageId: entity.lineageId ?? entity.id,
  };
}

function relationRef(snapshot: ArchitectureSnapshot, relation: ArchitectureRelation): LineageRelationRef {
  return {
    snapshotRelationId: `${snapshot.id}::${relation.id}`,
    logicalId: relation.id,
    lineageId: relation.lineageId ?? relation.id,
  };
}

function visualNodeId(_familyId: string, entity: ArchitectureEntity): string {
  return `visual-node:${entity.lineageId ?? entity.id}`;
}

function visualEdgeId(
  band: C4Band,
  fromVisualId: string,
  toVisualId: string,
  relation: ArchitectureRelation,
): string {
  return `visual-edge:${band}:${encodeURIComponent(fromVisualId)}>${encodeURIComponent(toVisualId)}:${relation.kind}`;
}

function isDescendantOrSelf(
  entityId: string,
  ancestorId: string,
  entityById: ReadonlyMap<string, ArchitectureEntity>,
): boolean {
  let current = entityById.get(entityId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (current.id === ancestorId) return true;
    visited.add(current.id);
    current = current.parentId ? entityById.get(current.parentId) : undefined;
  }
  return false;
}

function nearestRepresentative(
  entityId: string,
  rank: number,
  entityById: ReadonlyMap<string, ArchitectureEntity>,
): ArchitectureEntity | undefined {
  let current = entityById.get(entityId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    if (entityRank(current.kind) <= rank && current.kind !== 'boundary') return current;
    visited.add(current.id);
    current = current.parentId ? entityById.get(current.parentId) : undefined;
  }
  return current;
}

function ancestors(entityId: string, entityById: ReadonlyMap<string, ArchitectureEntity>): ArchitectureEntity[] {
  const result: ArchitectureEntity[] = [];
  let current = entityById.get(entityId);
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    result.unshift(current);
    visited.add(current.id);
    current = current.parentId ? entityById.get(current.parentId) : undefined;
  }
  return result;
}

function leafSize(kind: EntityKind): { width: number; height: number } {
  switch (kind) {
    case 'person':
    case 'externalSystem':
      return { width: 480, height: 190 };
    case 'softwareSystem':
      return { ...C4_CONTEXT_CARD_FACE };
    case 'container':
    case 'dataStore':
    case 'queue':
      return { ...C4_CONTAINER_CARD_FACE };
    case 'component':
      return { ...C4_COMPONENT_CARD_FACE };
    case 'code':
      return { width: 270, height: 110 };
    case 'boundary':
      return { width: 420, height: 240 };
  }
}

type LocalTreeLayout = {
  width: number;
  height: number;
  nodes: Record<string, NodeLayout>;
};

function shiftNodes(nodes: Record<string, NodeLayout>, x: number, y: number): Record<string, NodeLayout> {
  return Object.fromEntries(Object.entries(nodes).map(([id, bounds]) => [id, {
    ...bounds,
    x: bounds.x + x,
    y: bounds.y + y,
  }]));
}

function layoutTree(
  nodeId: string,
  childrenByVisualId: ReadonlyMap<string, readonly string[]>,
  nodeById: Readonly<Record<string, VisualNode>>,
  targetAspect?: number,
): LocalTreeLayout {
  const node = nodeById[nodeId];
  if (!node) throw new Error(`Missing visual node ${nodeId}`);
  const children = [...(childrenByVisualId.get(nodeId) ?? [])].sort();
  const minimum = leafSize(node.kind);
  if (!children.length) {
    return {
      width: minimum.width,
      height: minimum.height,
      nodes: { [nodeId]: { x: 0, y: 0, width: minimum.width, height: minimum.height } },
    };
  }

  const childLayouts = children.map(childId => ({ id: childId, layout: layoutTree(childId, childrenByVisualId, nodeById, targetAspect) }));
  const gap = 44;
  const paddingX = 48;
  const paddingTop = 86;
  const paddingBottom = 48;
  const measurement = measureC4Grid(childLayouts.map(({ id, layout }) => ({
    id,
    width: layout.width,
    height: layout.height,
  })), {
    gap,
    paddingLeft: paddingX,
    paddingRight: paddingX,
    paddingTop,
    paddingBottom,
    ...(targetAspect !== undefined ? { targetAspect } : {}),
  });
  const { columns, columnWidths, rowHeights } = measurement;
  const width = Math.max(minimum.width, measurement.width);
  const height = Math.max(minimum.height, measurement.height);
  const nodes: Record<string, NodeLayout> = { [nodeId]: { x: 0, y: 0, width, height } };

  childLayouts.forEach(({ layout }, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = paddingX + columnWidths.slice(0, column).reduce((sum, value) => sum + value, 0) + gap * column;
    const y = paddingTop + rowHeights.slice(0, row).reduce((sum, value) => sum + value, 0) + gap * row;
    Object.assign(nodes, shiftNodes(layout.nodes, x, y));
  });
  return { width, height, nodes };
}

export type RouteC4BandEdgesOptions = {
  clearance: number;
  laneSpacing: number;
  maxPoints?: number;
  maxGridNodes?: number;
  routeOverrides?: readonly RelationRouteOverride[];
};

export type C4RouteOverrideDiagnostic = {
  overrideId: string;
  detail: C4Band;
  status: 'applied' | 'fallback' | 'stale';
  visualEdgeId?: string;
  reason?: GuidedOrthogonalRouteReason | 'edge-not-visible' | 'superseded';
  routerDiagnostic?: OrthogonalRouteDiagnostic;
};

export type RouteC4BandEdgesResult = {
  edges: Record<string, EdgeLayout>;
  diagnostics: C4RouteOverrideDiagnostic[];
};

function visibleAncestorChain(
  visualId: string,
  visible: ReadonlySet<string>,
  visualNodeById: Readonly<Record<string, VisualNode>>,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = visualId;
  while (current && visible.has(current) && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = visualNodeById[current]?.parentVisualId;
  }
  return result;
}

/**
 * Routes a complete band after its node geometry is final. The shared helper is
 * used by both authored layouts and compiler-normalized layouts so obstacle and
 * tie-breaking behavior cannot diverge between those stages.
 */
export function routeC4BandEdges(
  projection: BandProjection,
  visualNodeById: Readonly<Record<string, VisualNode>>,
  visualEdgeById: Readonly<Record<string, VisualEdge>>,
  nodes: Readonly<Record<string, NodeLayout>>,
  options: RouteC4BandEdgesOptions,
): Record<string, EdgeLayout> {
  return routeC4BandEdgesDetailed(projection, visualNodeById, visualEdgeById, nodes, options).edges;
}

const ROUTING_EPSILON = 1e-9;

function facingGap(source: NodeLayout, target: NodeLayout): { axis: 'x' | 'y'; gap: number } {
  const dx = target.x + target.width / 2 - (source.x + source.width / 2);
  const dy = target.y + target.height / 2 - (source.y + source.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    const gap = dx >= 0
      ? target.x - (source.x + source.width)
      : source.x - (target.x + target.width);
    return { axis: 'x', gap };
  }
  const gap = dy >= 0
    ? target.y - (source.y + source.height)
    : source.y - (target.y + target.height);
  return { axis: 'y', gap };
}

function duplicatesShareLane(
  source: NodeLayout,
  target: NodeLayout,
  axis: 'x' | 'y',
): boolean {
  if (axis === 'x') {
    return source.y < target.y + target.height - ROUTING_EPSILON
      && target.y < source.y + source.height - ROUTING_EPSILON;
  }
  return source.x < target.x + target.width - ROUTING_EPSILON
    && target.x < source.x + source.width - ROUTING_EPSILON;
}

function duplicatesLoopSide(axis: 'x' | 'y', flipped: boolean) {
  if (axis === 'x') return flipped ? 'top' as const : 'bottom' as const;
  return flipped ? 'left' as const : 'right' as const;
}

function duplicatesDomainRoom(
  source: NodeLayout,
  target: NodeLayout,
  clearance: number,
  domain: NodeLayout | undefined,
  side: 'top' | 'right' | 'bottom' | 'left',
): number {
  if (!domain) return Number.POSITIVE_INFINITY;
  const pad = Math.max(clearance, ROUTING_EPSILON);
  if (side === 'bottom' || side === 'top') {
    const outer = side === 'bottom'
      ? Math.max(source.y + source.height, target.y + target.height)
      : Math.min(source.y, target.y);
    return side === 'bottom'
      ? domain.y + domain.height - pad - outer
      : outer - (domain.y + pad);
  }
  const outer = side === 'right'
    ? Math.max(source.x + source.width, target.x + target.width)
    : Math.min(source.x, target.x);
  return side === 'right'
    ? domain.x + domain.width - pad - outer
    : outer - (domain.x + pad);
}

function duplicatesLoopOffset(
  source: NodeLayout,
  target: NodeLayout,
  clearance: number,
  domain: NodeLayout | undefined,
  side: 'top' | 'right' | 'bottom' | 'left',
): number {
  const pad = Math.max(clearance, ROUTING_EPSILON);
  const packingGap = facingGap(source, target).gap;
  const card = side === 'bottom' || side === 'top'
    ? Math.min(source.height, target.height)
    : Math.min(source.width, target.width);
  const desired = Math.max(pad * 4, card * 0.4);
  const gutterRoom = packingGap > pad ? packingGap - pad - ROUTING_EPSILON : pad;
  let offset = Math.min(desired, Math.max(pad, gutterRoom));
  const domainRoom = duplicatesDomainRoom(source, target, clearance, domain, side);
  if (Number.isFinite(domainRoom) && domainRoom > ROUTING_EPSILON) {
    offset = Math.min(offset, domainRoom);
  }
  return Math.max(pad, offset);
}

/**
 * CLA-68: packed L4 siblings sit about two routing clearances apart, so the
 * default side-to-side orthogonal hop occupies the inter-card gutter. Emit a
 * U in the packing gutter next to the pair (bottom/right, then the opposite
 * side when the owner has more room there) so the stroke stays in the same
 * viewport as the two cards. The grid router is not used: waypoints in that
 * gutter sit on expanded-obstacle boundaries and would fall back to the hop.
 * Far-apart clones keep auto routing. Not a packing or router rewrite.
 */
function tightDuplicatesLoopPoints(
  source: NodeLayout,
  target: NodeLayout,
  clearance: number,
  domain: NodeLayout | undefined,
): { x: number; y: number }[] | undefined {
  const facing = facingGap(source, target);
  if (facing.gap < -ROUTING_EPSILON || facing.gap > packedDuplicatesGutter(clearance) + ROUTING_EPSILON) {
    return undefined;
  }
  if (!duplicatesShareLane(source, target, facing.axis)) return undefined;
  const primary = duplicatesLoopSide(facing.axis, false);
  const flipped = duplicatesLoopSide(facing.axis, true);
  const primaryRoom = duplicatesDomainRoom(source, target, clearance, domain, primary);
  const flippedRoom = duplicatesDomainRoom(source, target, clearance, domain, flipped);
  const side = (Number.isFinite(primaryRoom) && primaryRoom < clearance && flippedRoom > primaryRoom)
    ? flipped
    : primary;
  const offset = duplicatesLoopOffset(source, target, clearance, domain, side);
  if (side === 'bottom' || side === 'top') {
    const x0 = source.x + source.width / 2;
    const x1 = target.x + target.width / 2;
    const y0 = side === 'bottom' ? source.y + source.height : source.y;
    const y1 = side === 'bottom' ? target.y + target.height : target.y;
    const y = side === 'bottom'
      ? Math.max(source.y + source.height, target.y + target.height) + offset
      : Math.min(source.y, target.y) - offset;
    return simplifyOrthogonalPoints([
      { x: x0, y: y0 },
      { x: x0, y },
      { x: x1, y },
      { x: x1, y: y1 },
    ]);
  }
  const y0 = source.y + source.height / 2;
  const y1 = target.y + target.height / 2;
  const x0 = side === 'right' ? source.x + source.width : source.x;
  const x1 = side === 'right' ? target.x + target.width : target.x;
  const x = side === 'right'
    ? Math.max(source.x + source.width, target.x + target.width) + offset
    : Math.min(source.x, target.x) - offset;
  return simplifyOrthogonalPoints([
    { x: x0, y: y0 },
    { x, y: y0 },
    { x, y: y1 },
    { x: x1, y: y1 },
  ]);
}

export function routeC4BandEdgesDetailed(
  projection: BandProjection,
  visualNodeById: Readonly<Record<string, VisualNode>>,
  visualEdgeById: Readonly<Record<string, VisualEdge>>,
  nodes: Readonly<Record<string, NodeLayout>>,
  options: RouteC4BandEdgesOptions,
): RouteC4BandEdgesResult {
  const visible = new Set(projection.visualNodeIds.filter(id => Boolean(nodes[id])));
  const ancestorChains = new Map([...visible].map(id => [
    id,
    visibleAncestorChain(id, visible, visualNodeById),
  ]));
  const isAncestor = (ancestorId: string, visualId: string) => (
    ancestorChains.get(visualId)?.includes(ancestorId) ?? false
  );
  const pairKey = (edge: VisualEdge) => [edge.fromVisualId, edge.toVisualId].sort().join('\u0000');
  const parallelByPair = new Map<string, string[]>();
  for (const edgeId of [...projection.visualEdgeIds].sort()) {
    const edge = visualEdgeById[edgeId];
    if (!edge || !visible.has(edge.fromVisualId) || !visible.has(edge.toVisualId)) continue;
    const key = pairKey(edge);
    const ids = parallelByPair.get(key) ?? [];
    ids.push(edgeId);
    parallelByPair.set(key, ids);
  }
  for (const ids of parallelByPair.values()) ids.sort();

  const relevantOverrides = (options.routeOverrides ?? [])
    .filter(value => value.viewId === projection.familyId && value.detail === projection.band)
    .sort((left, right) => compareText(left.id, right.id));
  const consumedOverrides = new Set<string>();
  const diagnostics: C4RouteOverrideDiagnostic[] = [];
  const edges: Record<string, EdgeLayout> = {};
  for (const edgeId of [...projection.visualEdgeIds].sort()) {
    const edge = visualEdgeById[edgeId];
    if (!edge) continue;
    const source = nodes[edge.fromVisualId];
    const target = nodes[edge.toVisualId];
    if (!source || !target) continue;
    const sourceAncestors = ancestorChains.get(edge.fromVisualId) ?? [];
    const targetAncestorSet = new Set(ancestorChains.get(edge.toVisualId) ?? []);
    const lcaId = sourceAncestors.find(id => targetAncestorSet.has(id));
    const candidateIds = [...visible].filter(id => (
      id !== edge.fromVisualId
      && id !== edge.toVisualId
      && !isAncestor(id, edge.fromVisualId)
      && !isAncestor(id, edge.toVisualId)
    ));
    const candidateSet = new Set(candidateIds);
    const obstacles = candidateIds.filter(id => {
      let parentId = visualNodeById[id]?.parentVisualId;
      const seen = new Set<string>();
      while (parentId && !seen.has(parentId)) {
        if (candidateSet.has(parentId)) return false;
        seen.add(parentId);
        parentId = visualNodeById[parentId]?.parentVisualId;
      }
      return true;
    }).sort().map(id => ({ id, bounds: nodes[id]! }));
    const parallel = parallelByPair.get(pairKey(edge)) ?? [edgeId];
    const laneIndex = parallel.indexOf(edgeId);
    const laneOffset = (laneIndex - (parallel.length - 1) / 2) * options.laneSpacing;
    const lcaBounds = lcaId ? nodes[lcaId] : undefined;
    const matchingOverrides = relevantOverrides.filter(value => value.visualEdgeId !== undefined
      ? value.visualEdgeId === edgeId
      : edge.relations.some(relation => relation.logicalId === value.relationId))
      .sort((left, right) => Number(right.visualEdgeId !== undefined) - Number(left.visualEdgeId !== undefined)
        || compareText(left.id, right.id));
    const selectedOverride = matchingOverrides[0];
    for (const superseded of matchingOverrides.slice(1)) {
      consumedOverrides.add(superseded.id);
      diagnostics.push({
        overrideId: superseded.id,
        detail: projection.band,
        status: 'stale',
        visualEdgeId: edgeId,
        reason: 'superseded',
      });
    }
    if (selectedOverride) consumedOverrides.add(selectedOverride.id);
    const domain = lcaBounds ? expandRoutingRect(lcaBounds, options.clearance * 2 + 1) : undefined;
    const routeOptions = {
      source,
      target,
      obstacles,
      ...(domain ? { domain } : {}),
      clearance: options.clearance,
      laneOffset,
      maxPoints: options.maxPoints ?? 16,
      maxGridNodes: options.maxGridNodes ?? 20_000,
    };
    if (selectedOverride) {
      const guided = routeOrthogonalWithIntent(routeOptions, selectedOverride.intent);
      edges[edgeId] = { points: guided.points };
      diagnostics.push({
        overrideId: selectedOverride.id,
        detail: projection.band,
        status: guided.status === 'applied' ? 'applied' : 'fallback',
        visualEdgeId: edgeId,
        ...(guided.reason ? { reason: guided.reason } : {}),
        routerDiagnostic: guided.diagnostic,
      });
    } else if (edge.kind === 'duplicates') {
      const loop = tightDuplicatesLoopPoints(source, target, options.clearance, lcaBounds);
      edges[edgeId] = {
        points: loop ?? routeOrthogonal(routeOptions).points,
      };
    } else {
      edges[edgeId] = { points: routeOrthogonal(routeOptions).points };
    }
  }
  for (const override of relevantOverrides) {
    if (consumedOverrides.has(override.id)) continue;
    diagnostics.push({
      overrideId: override.id,
      detail: projection.band,
      status: 'stale',
      reason: 'edge-not-visible',
    });
  }
  diagnostics.sort((left, right) => compareText(left.overrideId, right.overrideId));
  return { edges, diagnostics };
}

function packedFromEntityHints(
  visualNodeIds: readonly string[],
  visualNodeById: Readonly<Record<string, VisualNode>>,
  hints: Readonly<Record<string, NodeLayout>>,
): Record<string, NodeLayout> {
  const packed: Record<string, NodeLayout> = {};
  for (const id of visualNodeIds) {
    const entityId = visualNodeById[id]?.entity.logicalId;
    const hint = entityId ? hints[entityId] : undefined;
    if (hint) packed[id] = { ...hint };
  }
  return packed;
}

function packVisualNodes(
  nodeIds: readonly string[],
  visualNodeById: Readonly<Record<string, VisualNode>>,
  targetAspect?: number,
): Record<string, NodeLayout> {
  const visible = new Set(nodeIds);
  const childrenByVisualId = new Map<string, string[]>();
  const roots: string[] = [];
  for (const nodeId of nodeIds) {
    const parentId = visualNodeById[nodeId]?.parentVisualId;
    if (parentId && visible.has(parentId)) {
      const values = childrenByVisualId.get(parentId) ?? [];
      values.push(nodeId);
      childrenByVisualId.set(parentId, values);
    } else {
      roots.push(nodeId);
    }
  }
  for (const values of childrenByVisualId.values()) values.sort();

  const hierarchyRoots = roots.filter(id => {
    const kind = visualNodeById[id]?.kind;
    return kind !== 'person' && kind !== 'externalSystem';
  }).sort();
  const contextRoots = roots.filter(id => !hierarchyRoots.includes(id)).sort();
  const nodes: Record<string, NodeLayout> = {};
  const leftContextRight = contextRoots.reduce((right, rootId, index) => {
    if (index % 2 !== 0) return right;
    return Math.max(right, 80 + leafSize(visualNodeById[rootId]!.kind).width);
  }, 0);
  // Keep enough room for the relation label between the left context column
  // and the hierarchy without making the overview wider than a laptop map.
  const contextRouteCorridor = 260;
  let hierarchyX = Math.max(520, leftContextRight + contextRouteCorridor);
  for (const rootId of hierarchyRoots) {
    const tree = layoutTree(rootId, childrenByVisualId, visualNodeById, targetAspect);
    Object.assign(nodes, shiftNodes(tree.nodes, hierarchyX, 120));
    hierarchyX += tree.width + 100;
  }
  contextRoots.forEach((rootId, index) => {
    const size = leafSize(visualNodeById[rootId]!.kind);
    const leftSide = index % 2 === 0;
    const column = Math.floor(index / 2);
    nodes[rootId] = {
      x: leftSide ? 80 : hierarchyX + contextRouteCorridor,
      y: 180 + column * (size.height + 70),
      width: size.width,
      height: size.height,
    };
  });
  if (!hierarchyRoots.length) {
    contextRoots.forEach((rootId, index) => {
      const size = leafSize(visualNodeById[rootId]!.kind);
      nodes[rootId] = { x: 180 + index * (size.width + 90), y: 180, width: size.width, height: size.height };
    });
  }
  return nodes;
}

function bandLayout(
  projection: BandProjection,
  visualNodeById: Readonly<Record<string, VisualNode>>,
  visualEdgeById: Readonly<Record<string, VisualEdge>>,
  nodes: Record<string, NodeLayout>,
  maxGridNodes = 20_000,
): BandLayout {
  const edges = routeC4BandEdges(projection, visualNodeById, visualEdgeById, nodes, {
    clearance: 12,
    laneSpacing: 12,
    maxGridNodes,
  });
  return {
    id: projection.layoutId,
    projectionId: projection.id,
    policy: {
      id: 'collision-safe-orthogonal-v2',
      fontMetricsId: 'okie-ibm-plex-static-v1',
      labelPaddingScreenPx: 8,
    },
    nodes,
    edges,
  };
}

function layoutProjection(
  projection: BandProjection,
  visualNodeById: Readonly<Record<string, VisualNode>>,
  visualEdgeById: Readonly<Record<string, VisualEdge>>,
  maxGridNodes = 20_000,
  targetAspect?: number,
): BandLayout {
  return bandLayout(
    projection,
    visualNodeById,
    visualEdgeById,
    packVisualNodes(projection.visualNodeIds, visualNodeById, targetAspect),
    maxGridNodes,
  );
}

function aggregateLabel(relations: readonly ArchitectureRelation[], kind: RelationKind): string {
  const labels = [...new Set(relations.map(relation => relation.label?.trim()).filter((label): label is string => Boolean(label)))].sort();
  if (labels.length === 1 && relations.every(relation => relation.label?.trim() === labels[0])) return labels[0]!;
  if (relations.length === 1) return labels[0] ?? kind;
  const plural: Record<RelationKind, string> = {
    uses: 'uses',
    calls: 'calls',
    reads: 'reads',
    writes: 'writes',
    publishes: 'publications',
    subscribes: 'subscriptions',
    contains: 'containment relationships',
    dependsOn: 'dependencies',
    returns: 'returns',
    duplicates: 'duplicates',
  };
  return `${relations.length} ${plural[kind]}`;
}

export function buildC4ProjectionBundle(
  snapshot: ArchitectureSnapshot,
  options: BuildC4ProjectionOptions,
): C4ProjectionBundle {
  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const root = entityById.get(options.rootEntityId);
  if (!root) throw new Error(`Unknown C4 root entity ${options.rootEntityId}`);
  const focus = entityById.get(options.focusEntityId ?? root.id);
  if (!focus) throw new Error(`Unknown C4 focus entity ${options.focusEntityId}`);
  if (!isDescendantOrSelf(focus.id, root.id, entityById)) {
    throw new Error(`C4 focus ${focus.id} is outside root ${root.id}`);
  }
  const familyId = options.familyId ?? `view-family:${snapshot.repositoryId}:${root.lineageId ?? root.id}:${focus.lineageId ?? focus.id}`;
  const projectionIds = Object.fromEntries(C4_BANDS.map(band => [band, `band-projection:${familyId}:${band}`])) as Record<C4Band, string>;
  const family: ViewFamily = {
    id: familyId,
    snapshotId: snapshot.id,
    rootEntity: entityRef(snapshot, root),
    focusEntity: entityRef(snapshot, focus),
    zoomPolicyId: options.zoomPolicyId ?? 'zoom-policy:c4-default',
    projectionIds,
  };
  const projectionById: Record<string, BandProjection> = {};
  const visualNodeById: Record<string, VisualNode> = {};
  const visualEdgeById: Record<string, VisualEdge> = {};
  const bandLayoutById: Record<string, BandLayout> = {};
  const authoredRelationIds = new Set(options.authoredRelationIds ?? []);
  const l2PreviewOmittedComponentIds = new Set<string>();

  for (const band of C4_BANDS) {
    const rank = bandRank[band];
    const projectionId = projectionIds[band];
    if (options.maxBand !== undefined && bandRank[band] > bandRank[options.maxBand]) {
      // Scoped compile: leave deeper bands empty so the top scene never routes them.
      const emptyLayoutId = `band-layout:${projectionId}:v2-font-metrics-label-policy`;
      const emptyProjection: BandProjection = {
        id: projectionId, familyId, snapshotId: snapshot.id, band,
        rootEntity: entityRef(snapshot, root), focusEntity: entityRef(snapshot, focus),
        visualNodeIds: [], visualEdgeIds: [], contextNodeIds: [], layoutId: emptyLayoutId,
      };
      projectionById[projectionId] = emptyProjection;
      bandLayoutById[emptyLayoutId] = layoutProjection(emptyProjection, visualNodeById, visualEdgeById, options.maxGridNodes, options.targetAspect);
      continue;
    }
    const includedEntities = new Map<string, ArchitectureEntity>();
    const focusAncestors = new Set(ancestors(focus.id, entityById).map(entity => entity.id));
    for (const entity of snapshot.entities) {
      if (entity.kind === 'boundary') continue;
      if (isDescendantOrSelf(entity.id, focus.id, entityById) && entityRank(entity.kind) <= rank) {
        includedEntities.set(entity.id, entity);
      }
      if (entity.kind === 'person' || entity.kind === 'externalSystem') {
        includedEntities.set(entity.id, entity);
      }
    }
    for (const ancestor of ancestors(focus.id, entityById)) {
      // Focusing a file must not insert that file into its L1/L2 projections:
      // doing so changes the context layout and shifts every deeper anchor.
      if (entityRank(ancestor.kind) <= rank) includedEntities.set(ancestor.id, ancestor);
    }
    // CLA-106: keep peer containers in the focused L3 neighborhood so pan
    // has adjacent territory. Soft focus — siblings only, not their children.
    for (const sibling of containerRankSiblings(focus, root.id, entityById, snapshot)) {
      if (entityRank(sibling.kind) <= rank) includedEntities.set(sibling.id, sibling);
    }

    type EdgeGroup = { from: ArchitectureEntity; to: ArchitectureEntity; relations: ArchitectureRelation[] };
    const groups = new Map<string, EdgeGroup>();
    for (const relation of [...snapshot.relations].sort((left, right) => compareText(left.id, right.id))) {
      const fromEntity = entityById.get(relation.from);
      const toEntity = entityById.get(relation.to);
      if (!fromEntity || !toEntity) continue;
      // Coarser authored summaries belong only to their native band. Finer
      // evidence is projected upward and collapsed, preventing duplicate L1/L2
      // arrows while retaining real implementation relationships.
      if (Math.max(entityRank(fromEntity.kind), entityRank(toEntity.kind)) < rank) continue;
      // Clone pairs are L4 facts: do not lift `duplicates` into L1–L3 arrows.
      if (relation.kind === 'duplicates' && band !== 'code') continue;
      const touchesFocus = isDescendantOrSelf(relation.from, focus.id, entityById)
        || isDescendantOrSelf(relation.to, focus.id, entityById);
      // A relation authored between two nodes already visible as surrounding
      // context must remain visible even when neither endpoint is inside the
      // focus subtree. This is what makes connect-by-drag on context peers a
      // first-class semantic edit instead of a fact that vanishes on compile.
      const connectsVisibleContext = authoredRelationIds.has(relation.id)
        && includedEntities.has(fromEntity.id)
        && includedEntities.has(toEntity.id);
      if (!touchesFocus && !connectsVisibleContext) continue;
      const from = nearestRepresentative(relation.from, rank, entityById);
      const to = nearestRepresentative(relation.to, rank, entityById);
      if (!from || !to || from.id === to.id) continue;
      includedEntities.set(from.id, from);
      includedEntities.set(to.id, to);
      const fromVisualId = visualNodeId(familyId, from);
      const toVisualId = visualNodeId(familyId, to);
      const id = visualEdgeId(band, fromVisualId, toVisualId, relation);
      const group = groups.get(id) ?? { from, to, relations: [] };
      group.relations.push(relation);
      groups.set(id, group);
    }

    // Every nested visual object keeps its nearest visible parent so boundaries
    // remain stable and containment never needs a second set of arrows.
    for (const entity of [...includedEntities.values()]) {
      let parentId = entity.parentId;
      while (parentId) {
        const parent = entityById.get(parentId);
        if (!parent) break;
        if (entityRank(parent.kind) <= rank || focusAncestors.has(parent.id)) includedEntities.set(parent.id, parent);
        parentId = parent.parentId;
      }
    }

    let visualNodeIds = [...includedEntities.values()]
      .sort((left, right) => compareText(left.id, right.id))
      .map(entity => {
        const id = visualNodeId(familyId, entity);
        const parent = entity.parentId ? includedEntities.get(entity.parentId) : undefined;
        visualNodeById[id] ??= {
          id,
          entity: entityRef(snapshot, entity),
          kind: entity.kind,
          name: entity.name,
          technology: [...(entity.technology ?? [])].sort(),
          ...(entity.responsibility ? { responsibility: entity.responsibility } : {}),
          ...(parent ? { parentVisualId: visualNodeId(familyId, parent) } : {}),
        };
        return id;
      });

    const visualEdgeIds = [...groups.entries()].sort(([left], [right]) => compareText(left, right)).map(([id, group]) => {
      const relations = [...new Map(group.relations.map(relation => [relation.id, relation])).values()]
        .sort((left, right) => compareText(left.id, right.id));
      const first = relations[0]!;
      const labels = [...new Set(relations.map(relation => relation.label?.trim()).filter((label): label is string => Boolean(label)))].sort();
      visualEdgeById[id] = {
        id,
        projectionId,
        fromVisualId: visualNodeId(familyId, group.from),
        toVisualId: visualNodeId(familyId, group.to),
        kind: first.kind,
        label: aggregateLabel(relations, first.kind),
        relations: relations.map(relation => relationRef(snapshot, relation)),
        aggregate: {
          count: relations.length,
          kinds: [...new Set(relations.map(relation => relation.kind))].sort(),
          labels,
          technologies: [...new Set(relations.flatMap(relation => relation.technology ? [relation.technology] : []))].sort(),
          optionalCount: relations.filter(relation => relation.optional).length,
        },
      };
      return id;
    });
    // CLA-74: pack the full L3/L4 neighborhood first so parent bounds stay
    // stable, then keep only the camera-resident window in the compiled scene.
    // CLA-109 `pageCodeLandmarks`: keep L3 shells, select L4 against packed
    // parent faces (and previous-scene hints when present). Do not re-pack
    // parents after the window. Default (no cap, no camera rect) skips this
    // so golden stays byte-identical.
    const pageOffscreen = (options.pageCodeLandmarks ? band === 'code' : (band === 'component' || band === 'code'))
      && (options.maxNodesPerBand !== undefined || options.residentWorldBounds !== undefined);
    let omittedNodeIds: string[] = [];
    let packedNodes: Record<string, NodeLayout> | undefined;
    let candidateEdgeIds = visualEdgeIds;
    if (pageOffscreen) {
      const hinted = options.pageCodeLandmarks && options.entityLayoutHints
        ? packedFromEntityHints(visualNodeIds, visualNodeById, options.entityLayoutHints)
        : undefined;
      const packedForSelect = options.pageCodeLandmarks
        ? {
          ...packVisualNodes(
            visualNodeIds.filter(id => {
              const kind = visualNodeById[id]?.kind;
              return kind !== 'code' && kind !== 'component';
            }),
            visualNodeById,
            options.targetAspect,
          ),
          ...(hinted ?? {}),
        }
        : packVisualNodes(visualNodeIds, visualNodeById, options.targetAspect);
      const selection = selectResidentVisualNodeIds({
        band,
        visualNodeIds,
        packed: packedForSelect,
        visualNodeById,
        focusEntityId: focus.id,
        ...(options.maxNodesPerBand !== undefined ? { maxNodesPerBand: options.maxNodesPerBand } : {}),
        ...(options.residentWorldBounds ? { residentWorldBounds: options.residentWorldBounds } : {}),
        ...(options.keepEntityIds ? { keepEntityIds: options.keepEntityIds } : {}),
        ...(options.pageCodeLandmarks ? { pagedKinds: ['code'] as const } : {}),
      });
      omittedNodeIds = selection.omittedIds;
      const resident = new Set(selection.residentIds);
      visualNodeIds = selection.residentIds;
      packedNodes = options.pageCodeLandmarks
        ? packedFromEntityHints(
          visualNodeIds,
          visualNodeById,
          options.entityLayoutHints ?? {},
        )
        : packedForSelect;
      if (options.pageCodeLandmarks) {
        for (const id of visualNodeIds) {
          if (!packedNodes[id] && packedForSelect[id]) packedNodes[id] = packedForSelect[id];
        }
        const missingShells = visualNodeIds.filter(id =>
          !packedNodes![id] && visualNodeById[id]?.kind !== 'code');
        if (missingShells.length) {
          const shells = packVisualNodes(
            visualNodeIds.filter(id => visualNodeById[id]?.kind !== 'code'),
            visualNodeById,
            options.targetAspect,
          );
          for (const id of missingShells) {
            if (shells[id]) packedNodes[id] = shells[id];
          }
        }
      }
      candidateEdgeIds = visualEdgeIds.filter(id => {
        const edge = visualEdgeById[id]!;
        return resident.has(edge.fromVisualId) && resident.has(edge.toVisualId);
      });
    }
    // CLA-120: L2 (context-rank focus) keeps a landmark handful of file pills
    // per container. Open inside / container focus does not take this path.
    if (
      options.maxL2PreviewPillsPerOwner !== undefined
      && band === 'component'
      && entityRank(focus.kind) === 0
    ) {
      const selection = selectL2ResidentPreviewPills({
        visualNodeIds,
        visualNodeById,
        maxPillsPerOwner: options.maxL2PreviewPillsPerOwner,
      });
      omittedNodeIds = [...new Set([...omittedNodeIds, ...selection.omittedIds])];
      visualNodeIds = selection.residentIds;
      for (const id of selection.omittedIds) {
        const logicalId = visualNodeById[id]?.entity.logicalId;
        if (logicalId) l2PreviewOmittedComponentIds.add(logicalId);
      }
      const resident = new Set(visualNodeIds);
      candidateEdgeIds = candidateEdgeIds.filter(id => {
        const edge = visualEdgeById[id]!;
        return resident.has(edge.fromVisualId) && resident.has(edge.toVisualId);
      });
    }
    if (l2PreviewOmittedComponentIds.size && band === 'code') {
      const extra = visualNodeIds.filter(id => {
        const node = visualNodeById[id];
        if (node?.kind !== 'code') return false;
        let current = node.parentVisualId;
        const seen = new Set<string>();
        while (current && !seen.has(current)) {
          seen.add(current);
          const parent = visualNodeById[current];
          if (parent && l2PreviewOmittedComponentIds.has(parent.entity.logicalId)) return true;
          current = parent?.parentVisualId;
        }
        return false;
      });
      if (extra.length) {
        omittedNodeIds = [...new Set([...omittedNodeIds, ...extra])];
        const drop = new Set(extra);
        visualNodeIds = visualNodeIds.filter(id => !drop.has(id));
        const resident = new Set(visualNodeIds);
        candidateEdgeIds = candidateEdgeIds.filter(id => {
          const edge = visualEdgeById[id]!;
          return resident.has(edge.fromVisualId) && resident.has(edge.toVisualId);
        });
      }
    }
    // Edge budget (opt-in): route only the top-N edges, focus-first — an edge touching
    // the focus subtree outranks every global heavy-hitter, so a drilled scope always
    // shows ITS OWN wiring before the repo's loudest edges. Within each tier, rank by
    // aggregate count desc; on the code band, clone `duplicates` beat same-count
    // `uses` so packed L4 sibling strokes are not dropped by the scan relation-gate
    // budget (CLA-68); then id asc. Heavier `uses` still outrank a count-1 clone
    // pair. The rest stay enumerable via omittedEdgeIds + the bundle index ("+N more").
    let routedEdgeIds = candidateEdgeIds;
    let omittedEdgeIds = visualEdgeIds.filter(id => !candidateEdgeIds.includes(id));
    if (options.maxEdgesPerBand !== undefined && candidateEdgeIds.length > options.maxEdgesPerBand) {
      const touchesFocus = (id: string): number => {
        const edge = visualEdgeById[id]!;
        const fromEntityId = visualNodeById[edge.fromVisualId]!.entity.logicalId;
        const toEntityId = visualNodeById[edge.toVisualId]!.entity.logicalId;
        return isDescendantOrSelf(fromEntityId, focus.id, entityById)
          || isDescendantOrSelf(toEntityId, focus.id, entityById) ? 1 : 0;
      };
      const kindRank = (id: string): number => (
        band === 'code' && visualEdgeById[id]?.kind === 'duplicates' ? 1 : 0
      );
      const ranked = [...candidateEdgeIds].sort((left, right) =>
        touchesFocus(right) - touchesFocus(left)
        || visualEdgeById[right]!.aggregate.count - visualEdgeById[left]!.aggregate.count
        || kindRank(right) - kindRank(left)
        || compareText(left, right));
      const kept = new Set(ranked.slice(0, options.maxEdgesPerBand));
      routedEdgeIds = candidateEdgeIds.filter(id => kept.has(id));
      omittedEdgeIds = visualEdgeIds.filter(id => !kept.has(id));
    }
    const layoutId = `band-layout:${projectionId}:v2-font-metrics-label-policy`;
    const projection: BandProjection = {
      id: projectionId,
      familyId,
      snapshotId: snapshot.id,
      band,
      rootEntity: entityRef(snapshot, root),
      focusEntity: entityRef(snapshot, focus),
      visualNodeIds,
      visualEdgeIds: routedEdgeIds,
      contextNodeIds: visualNodeIds.filter(id => {
        const entityId = visualNodeById[id]!.entity.logicalId;
        return !isDescendantOrSelf(entityId, focus.id, entityById) && !focusAncestors.has(entityId);
      }),
      ...(omittedEdgeIds.length ? { omittedEdgeIds } : {}),
      ...(omittedNodeIds.length ? { omittedNodeIds } : {}),
      layoutId,
    };
    projectionById[projectionId] = projection;
    if (packedNodes && omittedNodeIds.length) {
      // CLA-81: keep packed bounds for omitted children so band compile can
      // paint reserved shells. Routing still uses resident-only visualEdgeIds.
      bandLayoutById[layoutId] = bandLayout(
        projection,
        visualNodeById,
        visualEdgeById,
        packedNodes,
        options.maxGridNodes,
      );
    } else {
      bandLayoutById[layoutId] = layoutProjection(projection, visualNodeById, visualEdgeById, options.maxGridNodes, options.targetAspect);
    }
  }

  const index: ProjectionIndex = {
    entityIdByVisualNodeId: {},
    visualNodeIdsByEntityId: {},
    relationIdsByVisualEdgeId: {},
    visualEdgeIdsByRelationId: {},
    boundsByEntityIdAndBand: {},
  };
  for (const node of Object.values(visualNodeById).sort((left, right) => compareText(left.id, right.id))) {
    index.entityIdByVisualNodeId[node.id] = node.entity.logicalId;
    index.visualNodeIdsByEntityId[node.entity.logicalId] = [node.id];
  }
  for (const edge of Object.values(visualEdgeById).sort((left, right) => compareText(left.id, right.id))) {
    const relationIds = edge.relations.map(relation => relation.logicalId).sort();
    index.relationIdsByVisualEdgeId[edge.id] = relationIds;
    for (const relationId of relationIds) {
      const values = index.visualEdgeIdsByRelationId[relationId] ?? [];
      values.push(edge.id);
      index.visualEdgeIdsByRelationId[relationId] = values;
    }
  }
  for (const values of Object.values(index.visualEdgeIdsByRelationId)) values.sort();
  for (const band of C4_BANDS) {
    const projection = projectionById[projectionIds[band]]!;
    const layout = bandLayoutById[projection.layoutId]!;
    for (const [nodeId, bounds] of Object.entries(layout.nodes)) {
      const entityId = visualNodeById[nodeId]!.entity.logicalId;
      index.boundsByEntityIdAndBand[entityId] ??= {};
      index.boundsByEntityIdAndBand[entityId]![band] = { ...bounds };
    }
  }

  return {
    schemaVersion: 1,
    ...(options.pageCodeLandmarks ? { pageCodeLandmarks: true } : {}),
    family,
    projectionById,
    visualNodeById,
    visualEdgeById,
    bandLayoutById,
    index,
  };
}

/** Canonical semantic projection consumed by Mermaid, embeds and static export. */
export function selectC4BandProjection(
  bundle: C4ProjectionBundle,
  band: C4Band,
): MaterializedBandProjection {
  const projection = bundle.projectionById[bundle.family.projectionIds[band]];
  if (!projection) throw new Error(`Missing ${band} projection for ${bundle.family.id}`);
  const layout = bundle.bandLayoutById[projection.layoutId];
  if (!layout) throw new Error(`Missing layout ${projection.layoutId}`);
  const context = new Set(projection.contextNodeIds);
  return {
    schemaVersion: 1,
    familyId: bundle.family.id,
    snapshotId: bundle.family.snapshotId,
    band,
    rootEntity: { ...projection.rootEntity },
    focusEntity: { ...projection.focusEntity },
    nodes: projection.visualNodeIds.map(id => ({
      ...bundle.visualNodeById[id]!,
      entity: { ...bundle.visualNodeById[id]!.entity },
      technology: [...bundle.visualNodeById[id]!.technology],
      bounds: { ...layout.nodes[id]! },
      context: context.has(id),
    })),
    edges: projection.visualEdgeIds.map(id => ({
      ...bundle.visualEdgeById[id]!,
      relations: bundle.visualEdgeById[id]!.relations.map(value => ({ ...value })),
      aggregate: {
        ...bundle.visualEdgeById[id]!.aggregate,
        kinds: [...bundle.visualEdgeById[id]!.aggregate.kinds],
        labels: [...bundle.visualEdgeById[id]!.aggregate.labels],
        technologies: [...bundle.visualEdgeById[id]!.aggregate.technologies],
      },
      route: { points: layout.edges[id]!.points.map(point => ({ ...point })) },
    })),
  };
}
