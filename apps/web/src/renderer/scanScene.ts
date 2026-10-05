/**
 * Pure scan-mode compile policy (CLA-66/67/74/107/109/118/120) and the one scan
 * scene compile both the live app ({@link ./scanFixture}) and the publish-time
 * share card (CLA-319, apps/web/src/atlasStructureCard.ts) go through. No DOM,
 * no Vite (`import.meta.glob` stays in scanFixture.ts), no fetch: it bundles for
 * plain Node.
 */
import {
  ASPECT_PRESET_TARGET,
  c4BandForKind,
  C4_SCAN_L2_RESIDENT_PREVIEW_PILLS,
  neighborhoodSliceOptionsForFocus,
  sliceArchitectureNeighborhood,
  snapshotPreplacesL3InL2,
  VIEWPORT_RESIDENT_NODES_PER_BAND,
  type ArchitectureSnapshot,
  type ArchitectureView,
  type C4Band,
  type ContainmentEntity,
  type EntityKind,
  type Rect,
} from '@okie/architecture';
import { createC4Scene } from './goldenC4Scene';
import type { AtlasScene, ScanGuardRefusal } from './types';

// Hang-guard only (CLA-66 / CLA-67): unbounded full-graph compiles above this
// entity count are refused. Band scoping is the DEFAULT scan path at every
// size — do not raise this number as a product fix, and do not treat a bigger
// dump as the slice. CLA-67 measured the per-band curve in
// docs/architecture/band-cost-curve.md; the hang-guard stays 2000 until a
// replacement is taken from that table (tests lock the number).
export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;
export const SCAN_CONTAINER_EDGE_BUDGET = 24;     // routed edges per band at a container drill-in
export const SCAN_CONTAINER_GRID_NODES = 1500;    // router grid-node cap at a container drill-in
/** Compiled L3/L4 window (CLA-74 / CLA-67 healthy 50). Not the 2000 hang-guard. */
export const SCAN_RESIDENT_NODES_PER_BAND = VIEWPORT_RESIDENT_NODES_PER_BAND;
/** L2 landmark file-pill cap per container (CLA-120). Not the 50 L3/L4 window. */
export const SCAN_L2_RESIDENT_PREVIEW_PILLS = C4_SCAN_L2_RESIDENT_PREVIEW_PILLS;

// Relation-pressure gate: the symbol-level `uses` graph makes edge ROUTING the
// dominant cost even when the entity count sits far under the hang-guard
// (okie's own public scan: 850 entities but ~1.7k relations → a two-minute
// unbounded compile). Above this relation count every compile takes an edge
// budget; dropped edges stay enumerable via omittedEdgeIds ("+N more").
// Per-kind maxBand still applies (current band + one-down prefetch) — the
// relation gate never compiles the whole tree.
export const SCAN_RELATION_EDGE_MIN = 600;   // relation gate — above this, budget the routed edges
export const SCAN_RELATION_EDGE_BUDGET = 64; // routed edges per band under the relation gate

export type ScanScopedOptions = {
  maxBand?: C4Band;
  maxEdgesPerBand?: number;
  maxGridNodes?: number;
  maxNodesPerBand?: number;
  pageCodeLandmarks?: boolean;
  /**
   * CLA-120: L2 landmark file-pill cap per container. Unset at L3 Open inside
   * so the full neighborhood still compiles.
   */
  maxL2PreviewPillsPerOwner?: number;
  /**
   * CLA-118: container-focus / large component neighborhoods pack toward
   * landscape ~1.6 so ~79 children become ~6–8 columns, not a 3-col skyscraper.
   * System/L1 still takes this from {@link ScanModeOptions} (CLA-96 bootstrap).
   */
  targetAspect?: number;
};

/** Camera-resident compile window (CLA-74). Does not change CLA-73 fetch. */
export type ScanViewportResidency = {
  /** Safe map width in CSS pixels, frozen for scan code reveal preparation. */
  scanCodeSafeWidth?: number;
  worldBounds?: Rect;
  keepEntityIds?: readonly string[];
};

/**
 * Mode-level compile options for scan mode (task #30). Independent of per-kind
 * maxBand: they apply to every scan compile at any repo size, because the
 * tall-container problem (a system packing into one narrow column) shows up on
 * small scans too (e.g. Okie's own scan). `targetAspect` is landscape ~1.6 for
 * published scan / neighborhood (CLA-96) and is a deterministic compile input,
 * never the live viewport. Golden/demo omit it. Container-focus / large
 * component neighborhoods also apply this via {@link scanScopeCompileOptions}
 * (CLA-118) so a missing mode option cannot fall back to the 3-column cap.
 */
export type ScanModeOptions = { targetAspect?: number };

/** Landscape ~1.6 for container-focus / large component neighborhood compiles (CLA-118). */
export const SCAN_NEIGHBORHOOD_TARGET_ASPECT = ASPECT_PRESET_TARGET.landscape;

// Per-focus-kind scoped options — the default scan compile path (CLA-66).
// Current C4 band + one band down: system→container; container→component;
// component→code. Open inside / zoom-target compile uses this mapping, not
// a panic at SCAN_BAND_DEPTH_MIN_ENTITIES.
const SCAN_SCOPED_OPTIONS_BY_KIND: Partial<Record<EntityKind, ScanScopedOptions>> = {
  person: { maxBand: 'container' },
  softwareSystem: { maxBand: 'container' },
  externalSystem: { maxBand: 'container' },
  boundary: { maxBand: 'container' },
  container: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES, maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND, targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT },
  dataStore: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES, maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND, targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT },
  queue: { maxBand: 'component', maxEdgesPerBand: SCAN_CONTAINER_EDGE_BUDGET, maxGridNodes: SCAN_CONTAINER_GRID_NODES, maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND, targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT },
  // Component focus is the actual L4 paging entry point. It needs the same
  // code-only landmarks as the root overlay so a cold file URL and a live
  // file drill select symbols in the aligned code grid rather than the L3
  // component face.
  component: { maxBand: 'code', maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND, pageCodeLandmarks: true, targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT },
  code: { maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND, targetAspect: SCAN_NEIGHBORHOOD_TARGET_ASPECT },
};

/**
 * Deterministic scoped-compile options for a scan-mode focus. Band scoping is
 * the default path at every repo size (CLA-66): system→container band;
 * container drill-in→component band + edge budget + router grid cap;
 * component→code band. CLA-107/109 overlays `maxBand: code` on the system
 * compile when the snapshot is a small repo (≤12 containers, ≤2000 components)
 * so L2–L4 are not hollow shells. Total entity count is not the switch — THISS/okie
 * is ~3k entities mostly L4 code. A second, independent relation gate
 * (> SCAN_RELATION_EDGE_MIN) adds a per-band routed-edge budget plus a router
 * grid cap wherever the options don't already carry one. SCAN_BAND_DEPTH_MIN_ENTITIES
 * is not a compile-strategy switch — it remains the hang-guard in
 * {@link guardScanCompile} only.
 */
export function scanScopeCompileOptions(snapshot: ArchitectureSnapshot, focusEntityId: string): ScanScopedOptions {
  const aboveRelationGate = snapshot.relations.length > SCAN_RELATION_EDGE_MIN;
  const focus = snapshot.entities.find(entity => entity.id === focusEntityId);
  const scoped = focus ? SCAN_SCOPED_OPTIONS_BY_KIND[focus.kind] : undefined;
  const options: ScanScopedOptions = scoped ? { ...scoped } : {};
  // CLA-107/109: small-repo L2 compiles through code (component + symbol
  // landmarks in global coordinates) so L2↔L3↔L4 morph like L1↔L2. 13+
  // containers stay CLA-66 `maxBand: container`. CLA-120 caps resident L3
  // preview pills per container (~10 + `+N more`); Open inside still uses
  // the CLA-74 window. Only L4 cards use `pageCodeLandmarks` so THISS/okie
  // (~3k symbols) cannot freeze the system scene. Renderer culling still skips
  // drawing.
  if (
    snapshotPreplacesL3InL2(snapshot)
    && (options.maxBand === 'container' || (focus && c4BandForKind(focus.kind) === 'context' && options.maxBand === undefined))
  ) {
    options.maxBand = 'code';
    options.maxEdgesPerBand ??= SCAN_RELATION_EDGE_BUDGET;
    options.maxGridNodes ??= SCAN_CONTAINER_GRID_NODES;
    options.maxNodesPerBand ??= SCAN_RESIDENT_NODES_PER_BAND;
    options.pageCodeLandmarks = true;
    options.maxL2PreviewPillsPerOwner = SCAN_L2_RESIDENT_PREVIEW_PILLS;
  }
  if (aboveRelationGate) {
    options.maxEdgesPerBand ??= SCAN_RELATION_EDGE_BUDGET;
    options.maxGridNodes ??= SCAN_CONTAINER_GRID_NODES;
  }
  return options;
}

/**
 * CLA-107 kept L3 by skipping the camera window. CLA-109 still keeps those
 * file shells, but via `pageCodeLandmarks` (code-band-only paging) so the
 * shell can pass the camera tile window and L4 can morph without compiling
 * every symbol. Always false: skipping residency would freeze ~3k L4 meshes
 * on THISS/okie. Open-inside and large-repo compiles stay CLA-74 windowed.
 */
export function scanKeepsResidentL3Landmarks(
  _snapshot: ArchitectureSnapshot,
  _focusEntityId: string,
): boolean {
  return false;
}

/**
 * True when these options bound the routed node set for ANY repo size — so the
 * compile can never route the whole graph. A router-grid cap bounds the layout
 * outright; without one, only the shallow bands (context/container) hold a
 * bounded node set (deeper component/code bands can pull in the entire tree, so
 * they must carry a grid cap). This is the property the guard requires above the
 * gate; it is intentionally independent of the compile respecting the options, so
 * a stale (pre-scoping) package build cannot make it lie.
 */
function optionsBoundRouting(options: ScanScopedOptions): boolean {
  if (options.maxGridNodes !== undefined) return true;
  return options.maxBand === 'context' || options.maxBand === 'container';
}

/**
 * Cheap, deterministic size of a focus scope WITHOUT compiling: the entities that
 * are descendant-or-self of the focus (the set a full-depth `code`-band compile
 * routes), plus the relations that touch them. O(entities + relations). Used by
 * the guard to decide whether an unbounded compile is safe. Returns zeros for an
 * unknown focus (the compile itself will reject it — never a hang).
 */
export function scanScopeStats(
  snapshot: ArchitectureSnapshot,
  focusEntityId: string,
): { entityCount: number; relationCount: number } {
  if (!snapshot.entities.some(entity => entity.id === focusEntityId)) {
    return { entityCount: 0, relationCount: 0 };
  }
  const childrenByParent = new Map<string, string[]>();
  for (const entity of snapshot.entities) {
    if (entity.parentId === undefined) continue;
    const siblings = childrenByParent.get(entity.parentId);
    if (siblings) siblings.push(entity.id);
    else childrenByParent.set(entity.parentId, [entity.id]);
  }
  const inScope = new Set<string>();
  const stack = [focusEntityId];
  while (stack.length) {
    const id = stack.pop()!;
    if (inScope.has(id)) continue;
    inScope.add(id);
    for (const child of childrenByParent.get(id) ?? []) stack.push(child);
  }
  let relationCount = 0;
  for (const relation of snapshot.relations) {
    if (inScope.has(relation.from) || inScope.has(relation.to)) relationCount += 1;
  }
  return { entityCount: inScope.size, relationCount };
}

export type ScanGuardDecision = {
  /** The focus that will actually be compiled — the fallback when refused. */
  focusEntityId: string;
  /** Scoped-compile options for `focusEntityId` (always bounded when refused). */
  options: ScanScopedOptions;
  /** Present only when the requested focus was refused. */
  refusal?: ScanGuardRefusal;
};

/**
 * The hard anti-hang guard for scan-mode compiles, and the single choke point all
 * scan compiles pass through. Derives scoped options for the requested focus
 * (per-kind maxBand at every size — CLA-66) and, ABOVE the hang-guard entity
 * count, refuses any focus whose scope exceeds that count when no option bounds
 * the routing (an unbounded full-graph compile — the deep-link hang vector).
 * On refusal it substitutes the scoped fallback focus (the view root), forcing a
 * guaranteed-bounded band if even the fallback derives no constraint, so the app
 * renders a safe scene instead of freezing.
 *
 * Below the hang-guard the refusal walk is skipped; per-kind maxBand still
 * applies so Open inside is the default scoped path, not a panic at 2000.
 * Pure — counts entities/relations, never compiles.
 */
export function guardScanCompile(
  snapshot: ArchitectureSnapshot,
  requestedFocusId: string,
  fallbackFocusId: string,
): ScanGuardDecision {
  const options = scanScopeCompileOptions(snapshot, requestedFocusId);
  if (snapshot.entities.length <= SCAN_BAND_DEPTH_MIN_ENTITIES) {
    return { focusEntityId: requestedFocusId, options };
  }
  if (optionsBoundRouting(options)) {
    return { focusEntityId: requestedFocusId, options };
  }
  const stats = scanScopeStats(snapshot, requestedFocusId);
  if (stats.entityCount <= SCAN_BAND_DEPTH_MIN_ENTITIES) {
    // Unbounded options, but a genuinely small scope (e.g. a `code` leaf) never
    // explodes — compile it as requested.
    return { focusEntityId: requestedFocusId, options };
  }
  const fallbackOptions = scanScopeCompileOptions(snapshot, fallbackFocusId);
  return {
    focusEntityId: fallbackFocusId,
    options: optionsBoundRouting(fallbackOptions) ? fallbackOptions : { maxBand: 'context' },
    refusal: {
      requestedFocusId,
      entityCount: stats.entityCount,
      relationCount: stats.relationCount,
      fallbackFocusId,
    },
  };
}


export type ScanSceneInput = {
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  focusEntityId: string;
  /** How the snapshot arrived: a neighborhood boot re-slices the view-root packet before compiling L1/L2. */
  boot: 'neighborhood' | 'full';
  modeOptions: ScanModeOptions;
  childCounts: Record<string, number>;
  /** Direct unpublished children reserved as nested footprints (CLA-81). */
  unpublishedChildren: readonly ContainmentEntity[];
  previous?: AtlasScene;
  residency?: ScanViewportResidency;
};

/**
 * One scan-mode scene compile, routed through the anti-hang guard (see
 * {@link guardScanCompile}). The live fixture's `createScene` and the CLA-319
 * publish-time share card both call this, so the card shows exactly the scene
 * the app compiles for the same focus.
 */
export function compileScanScene(input: ScanSceneInput, onPhase?: (phase: 'root-slice' | 'projection' | 'layout' | 'adapter') => void): AtlasScene {
  const { snapshot, view, previous, residency, childCounts, modeOptions: options } = input;
  const decision = guardScanCompile(snapshot, input.focusEntityId, view.rootEntityId);
  const scoped = decision.options;
  // Neighborhood boot: compile the view-root L1/L2 *entities*, not the union of
  // every opened L3/L4 subgraph. Keep live published childCounts + CLA-81
  // unpublished stubs — a re-slice of an already-slim L1 packet would zero
  // container counts and collapse reserved shells.
  onPhase?.('root-slice');
  const rootPacket = input.boot === 'neighborhood' && decision.focusEntityId === view.rootEntityId
    ? sliceArchitectureNeighborhood(snapshot, view, {
      focusEntityId: decision.focusEntityId,
      ...neighborhoodSliceOptionsForFocus(snapshot, decision.focusEntityId),
    })
    : undefined;
  const compileSnapshot = rootPacket?.snapshot ?? snapshot;
  const compileIds = new Set(compileSnapshot.entities.map(entity => entity.id));
  const compileUnpublished = input.unpublishedChildren.filter(child =>
    !rootPacket
    || (Boolean(child.parentId) && compileIds.has(child.parentId!) && !compileIds.has(child.id)));
  const keepResidentL3 = scanKeepsResidentL3Landmarks(snapshot, decision.focusEntityId);
  const scene = createC4Scene({
    onPhase,
    baseSnapshot: compileSnapshot,
    rootEntityId: view.rootEntityId,
    focusEntityId: decision.focusEntityId,
    familyId: `view-family:${snapshot.repositoryId}:${decision.focusEntityId}`,
    sceneId: `scan:${snapshot.repositoryId}:c4`,
    title: view.name,
    subtitle: `scanned snapshot · ${snapshot.commitSha.slice(0, 12)}`,
    frozenRevision: snapshot.commitSha,
    previous,
    ...scoped,
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
    ...(scoped.maxBand !== undefined ? { bandDepthThreshold: SCAN_BAND_DEPTH_MIN_ENTITIES } : {}),
    ...(residency?.worldBounds && !keepResidentL3 ? { residentWorldBounds: residency.worldBounds } : {}),
    ...(residency?.keepEntityIds ? { keepEntityIds: residency.keepEntityIds } : {}),
    ...(residency?.scanCodeSafeWidth !== undefined ? { scanCodeSafeWidth: residency.scanCodeSafeWidth } : {}),
    childCounts,
    ...(compileUnpublished.length ? { unpublishedChildren: compileUnpublished } : {}),
  });
  return decision.refusal ? { ...scene, scanGuardRefusal: decision.refusal } : scene;
}
