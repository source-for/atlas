import { createSceneCompileSession, type SceneCompileSession } from './compileSceneOffThread';
import { measureAtlasPhase, measureAtlasAsyncPhase } from '../performance/loadTimings';
import {
  assignNeighborhoodSnapshot,
  sliceArchitectureNeighborhood,
  c4BandForKind,
  isNeighborhoodPacket,
  mergeChildCounts,
  validateNeighborhoodPacket,
  validateSnapshot,
  validateStoryDocument,
  validateView,
  type ArchitectureNeighborhoodPacket,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type ContainmentEntity,
  type SourceExcerpt,
  type ValidationIssue,
} from '@okie/architecture';
import { compileAppStoryPlan, type AppStoryPlan } from './goldenC4Scene';
import { rememberPublishedChildCounts } from './lazyBandCompile';
import type { AtlasScene } from './types';
import {
  compileScanScene,
  scanScopeCompileOptions,
  type ScanModeOptions,
  type ScanScopedOptions,
  type ScanViewportResidency,
} from './scanScene';

// CLA-319: the pure compile policy moved to ./scanScene (Node-bundleable for the
// publish-time share card); re-exported so every existing import keeps working.
export {
  compileScanScene,
  guardScanCompile,
  SCAN_BAND_DEPTH_MIN_ENTITIES,
  SCAN_CONTAINER_EDGE_BUDGET,
  SCAN_CONTAINER_GRID_NODES,
  SCAN_L2_RESIDENT_PREVIEW_PILLS,
  SCAN_NEIGHBORHOOD_TARGET_ASPECT,
  SCAN_RELATION_EDGE_BUDGET,
  SCAN_RELATION_EDGE_MIN,
  SCAN_RESIDENT_NODES_PER_BAND,
  scanKeepsResidentL3Landmarks,
  scanScopeCompileOptions,
  scanScopeStats,
  type ScanGuardDecision,
  type ScanModeOptions,
  type ScanScopedOptions,
  type ScanSceneInput,
  type ScanViewportResidency,
} from './scanScene';
import {
  parsePublishedEnrichmentReport,
  parsePublishedEnrichmentStatus,
  publishedEnrichmentHonesty,
  type PublishedEnrichmentHonesty,
} from '../inspector/publishedEnrichmentHonesty';

export type ScanNavigationDefaults = {
  repositoryId: string;
  snapshotId: string;
  viewId: string;
  rootEntityId: string;
};

/** A validated, live-compiled scanned snapshot ready to drive the app shell. */
export type ScanFixture = {
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  story: AppStoryPlan;
  /** Overview first, then any published user-flow stories (CLA-77). */
  stories: AppStoryPlan[];
  /** Recompiles the scan snapshot for a new focus/root (drill-in, restore).
   *  Routed through the anti-hang guard, so no path can compile the whole graph. */
  getSceneGeneration: () => number;
  disposeSceneWorker: () => void;
  prepareInitialScene: (signal?: AbortSignal) => Promise<void>;
  enrichInitialScene: (signal?: AbortSignal) => Promise<AtlasScene | undefined>;
  createSceneAsync: (focusEntityId: string, previous?: AtlasScene, residency?: ScanViewportResidency, signal?: AbortSignal) => Promise<AtlasScene>;
  createScene: (focusEntityId: string, previous?: AtlasScene, residency?: ScanViewportResidency) => AtlasScene;
  /** Scoped-compile options for a derived (flow/Mermaid) projection of a focus, so
   *  those direct-`buildC4ProjectionBundle` bypass paths stay scoped too. */
  scopeCompileOptions: (focusEntityId: string) => ScanScopedOptions;
  /** The mode-level aspect target applied to every compile (task #30); introspectable
   *  so derived projections and diagnostics can reuse the same deterministic value. */
  targetAspect?: number;
  navigation: ScanNavigationDefaults;
  /** Published child counts, including descendants not yet fetched (CLA-73). */
  childCounts: Record<string, number>;
  /** Direct unpublished children reserved as nested footprints (CLA-81). */
  unpublishedChildren: ContainmentEntity[];
  /** How the snapshot arrived — neighborhood fetch vs the full published trio. */
  boot: 'neighborhood' | 'full';
  /** Fetch+merge a container/file subgraph. No-op when the neighborhood is already resident. */
  ensureNeighborhood: (focusEntityId: string) => Promise<void>;
  /** Fetch portable excerpts for one entity when Source opens. */
  ensureExcerpts: (entityId: string) => Promise<SourceExcerpt[] | undefined>;
  /**
   * Secret-free skip/reject copy for inspector chrome (CLA-75). Absent when
   * enrichment never ran (no report / no status sidecar).
   */
  enrichmentHonesty?: PublishedEnrichmentHonesty;
  /** Immutable publication selected by the public bootstrap packet. */
  publication?: { versionId: string; artifactRevisionId: string };
};

export type RawScanTrio = { snapshot: unknown; view: unknown; story: unknown; stories?: unknown };
export type ScanTrioLoader = (name: 'snapshot' | 'view' | 'story') => Promise<unknown>;
export type ScanNeighborhoodHost = {
  loadNeighborhood: (focusEntityId: string) => Promise<ArchitectureNeighborhoodPacket>;
  loadExcerpts: (entityId: string) => Promise<SourceExcerpt[] | undefined>;
  loadStory: () => Promise<unknown>;
  /** Optional published `stories.json` catalog. Missing/404 is undefined, never fatal. */
  loadStories?: () => Promise<unknown>;
  /** Optional published `enrichment-report.json`. Missing/404 is undefined, never fatal. */
  loadEnrichmentReport?: () => Promise<unknown>;
  /** Optional secret-free `enrichment-status.json`. Missing/404 is undefined, never fatal. */
  loadEnrichmentStatus?: () => Promise<unknown>;
  /** Identity captured from the same bootstrap neighborhood response. */
  publication?: () => { versionId: string; artifactRevisionId: string } | undefined;
};

/** Raised when the scanned trio fails validation; carries every issue found. */
export class ScanFixtureError extends Error {
  readonly issues: ValidationIssue[];
  constructor(issues: ValidationIssue[]) {
    super(`Scanned snapshot failed validation:\n${formatScanIssues(issues)}`);
    this.name = 'ScanFixtureError';
    this.issues = issues;
  }
}

export function formatScanIssues(issues: ValidationIssue[]): string {
  return issues.map(issue => `• ${issue.path ? `${issue.path} — ` : ''}${issue.message}`).join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scopedValidate(label: string, validate: () => ValidationIssue[]): ValidationIssue[] {
  try {
    return measureAtlasPhase('atlas-validate', validate).map(issue => ({ path: issue.path ? `${label}.${issue.path}` : label, message: issue.message }));
  } catch (error) {
    return [{ path: label, message: error instanceof Error ? error.message : 'is structurally invalid' }];
  }
}

function childCountsFromSnapshot(snapshot: ArchitectureSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entity of snapshot.entities) counts[entity.id] = 0;
  for (const entity of snapshot.entities) {
    if (entity.parentId === undefined) continue;
    counts[entity.parentId] = (counts[entity.parentId] ?? 0) + 1;
  }
  return counts;
}

function buildLiveScanFixture(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  story: AppStoryPlan,
  options: ScanModeOptions,
  extras: {
    boot: ScanFixture['boot'];
    childCounts: Record<string, number>;
    unpublishedChildren?: ContainmentEntity[];
    host?: ScanNeighborhoodHost;
    loadedFocusIds?: Set<string>;
    stories?: AppStoryPlan[];
    initialized?: { scene: AtlasScene; worker: SceneCompileSession };
  },
): ScanFixture {
  const childCounts = extras.childCounts;
  rememberPublishedChildCounts(snapshot, childCounts);
  const unpublishedChildren: ContainmentEntity[] = [...(extras.unpublishedChildren ?? [])];
  const loadedFocusIds = extras.loadedFocusIds ?? new Set<string>();
  const inflight = new Map<string, Promise<void>>();
  const host = extras.host;
  // CLA-94: after a nested (L3/L4) neighborhood merge, the view-root packet
  // must be fetched again before compiling L1/L2. loadedFocusIds + "already
  // resident with children" would otherwise skip it, leaving okie-only context.
  let fetchedDeeperThanRoot = false;

  const snapshotHasContextPeers = (): boolean => snapshot.entities.some(entity =>
    entity.id !== view.rootEntityId
    && entity.parentId === undefined
    && (entity.kind === 'person' || entity.kind === 'externalSystem' || entity.kind === 'softwareSystem'));

  const viewRootNeedsContextRefresh = (focus: string): boolean => {
    if (extras.boot !== 'neighborhood' || focus !== view.rootEntityId) return false;
    return fetchedDeeperThanRoot || !snapshotHasContextPeers();
  };

  let initialScene: AtlasScene | undefined = extras.initialized?.scene;
  let snapshotGeneration = 0;
  let sceneWorker: SceneCompileSession | undefined = extras.initialized?.worker;
  const workerSession = () => sceneWorker ??= createSceneCompileSession();
  // Even generations identify full graphs; the preceding odd generation is
  // reserved for a bootstrap slice. A snapshot merge advances both identities.
  const fullWorkerGeneration = () => snapshotGeneration * 2 + 2;
  const disposeSceneWorker = () => {
    sceneWorker?.dispose();
    sceneWorker = undefined;
  };
  const prepareInitialScene = async (signal?: AbortSignal) => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    if (initialScene) return;
    const generation = snapshotGeneration;
    const first = extras.boot === 'neighborhood' && snapshot.entities.length > 128
      ? measureAtlasPhase('atlas-slice', () => sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: view.rootEntityId, maxBand: 'container' }))
      : undefined;
    const input = { snapshot: first?.snapshot ?? snapshot, view: first?.view ?? view, focusEntityId: view.rootEntityId, boot: extras.boot, modeOptions: options, childCounts, unpublishedChildren: first?.unpublishedChildren ?? unpublishedChildren };
    const prepared = await measureAtlasAsyncPhase('atlas-worker-round-trip', () => workerSession().compile(input, { generation: fullWorkerGeneration() - (first ? 1 : 0), signal }));
    if (generation === snapshotGeneration) initialScene = prepared ?? measureAtlasPhase('atlas-compile', () => compileScanScene(input));
  };
  let enrichment: Promise<AtlasScene | undefined> | undefined;
  const enrichInitialScene = (signal?: AbortSignal): Promise<AtlasScene | undefined> => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
    if (enrichment) return enrichment;
    const work = (async () => {
    if (extras.boot !== 'neighborhood' || snapshot.entities.length <= 128) return undefined;
    const generation = snapshotGeneration;
    const prepared = await measureAtlasAsyncPhase('atlas-worker-round-trip', () => workerSession().compile({ snapshot, view, focusEntityId: view.rootEntityId, boot: extras.boot, modeOptions: options, childCounts, unpublishedChildren }, { generation: fullWorkerGeneration(), priority: 'speculative', signal }));
    if (generation !== snapshotGeneration) return undefined;
    if (prepared) initialScene = prepared;
    return prepared;
    })();
    enrichment = work;
    const reset = () => { if (enrichment === work) enrichment = undefined; };
    signal?.addEventListener('abort', reset, { once: true });
    void work.finally(() => signal?.removeEventListener('abort', reset)).catch(() => undefined);
    return work;
  };
  const createScene = (
    focusEntityId: string,
    previous?: AtlasScene,
    residency?: ScanViewportResidency,
  ): AtlasScene => {
    if (initialScene && focusEntityId === view.rootEntityId && !previous && !residency) return initialScene;
    return measureAtlasPhase('atlas-compile', () => compileScanScene({
      snapshot,
      view,
      focusEntityId,
      boot: extras.boot,
      modeOptions: options,
      childCounts,
      unpublishedChildren,
      ...(previous ? { previous } : {}),
      ...(residency ? { residency } : {}),
    }));
  };

  const createSceneAsync = async (focusEntityId: string, previous?: AtlasScene, residency?: ScanViewportResidency, signal?: AbortSignal): Promise<AtlasScene> => {
    const generation = snapshotGeneration;
    const prepared = await measureAtlasAsyncPhase('atlas-worker-round-trip', () => workerSession().compile({ snapshot, view, focusEntityId, boot: extras.boot, modeOptions: options, childCounts, unpublishedChildren, ...(previous ? { previous } : {}), ...(residency ? { residency } : {}) }, { generation: fullWorkerGeneration(), priority: 'selected', signal }));
    if (signal?.aborted || generation !== snapshotGeneration) throw signal?.reason ?? new DOMException('Snapshot changed', 'AbortError');
    return prepared ?? createScene(focusEntityId, previous, residency);
  };

  const ensureNeighborhood = async (focusEntityId: string): Promise<void> => {
    if (!host) return;
    const focus = focusEntityId.trim();
    if (!focus) return;
    const refreshRoot = viewRootNeedsContextRefresh(focus);
    if (loadedFocusIds.has(focus) && !refreshRoot) return;
    const resident = snapshot.entities.some(entity => entity.id === focus);
    const knownChildren = snapshot.entities.some(entity => entity.parentId === focus);
    const publishedChildren = childCounts[focus] ?? 0;
    // Resident leaves and already-expanded boxes skip the network. A deep-link
    // or tour focus that is not in the slim snapshot must still fetch — L1
    // childCounts does not list omitted L4 ids. CLA-94: the view root still
    // refetches after a nested neighborhood so L1 peers are not skipped.
    if (resident && (knownChildren || publishedChildren === 0) && !refreshRoot) {
      loadedFocusIds.add(focus);
      return;
    }
    const pending = inflight.get(focus);
    if (pending) {
      await pending;
      return;
    }
    const work = (async () => {
      const packet = await host.loadNeighborhood(focus);
      const packetIssues = measureAtlasPhase('atlas-validate', () => validateNeighborhoodPacket(packet));
      if (packetIssues.length) throw new ScanFixtureError(packetIssues);
      snapshotGeneration++;
      initialScene = undefined;
      assignNeighborhoodSnapshot(snapshot, packet.snapshot);
      for (const id of packet.view.entityIds) {
        if (!view.entityIds.includes(id)) view.entityIds.push(id);
      }
      for (const id of packet.view.relationIds) {
        if (!view.relationIds.includes(id)) view.relationIds.push(id);
      }
      Object.assign(view.layout.nodes, packet.view.layout.nodes);
      if (packet.view.layout.edges) {
        view.layout.edges = { ...(view.layout.edges ?? {}), ...packet.view.layout.edges };
      }
      Object.assign(childCounts, mergeChildCounts(childCounts, packet.childCounts));
      const residentIds = new Set(snapshot.entities.map(entity => entity.id));
      const incoming = packet.unpublishedChildren ?? [];
      const kept = unpublishedChildren.filter(child => !residentIds.has(child.id));
      unpublishedChildren.splice(0, unpublishedChildren.length, ...kept);
      for (const child of incoming) {
        if (residentIds.has(child.id) || unpublishedChildren.some(existing => existing.id === child.id)) continue;
        unpublishedChildren.push(child);
      }
      loadedFocusIds.add(focus);
      loadedFocusIds.add(packet.focusEntityId);
      const owner = snapshot.entities.find(entity => entity.id === packet.focusEntityId)
        ?? snapshot.entities.find(entity => entity.id === focus);
      if (owner && c4BandForKind(owner.kind) !== 'context') {
        fetchedDeeperThanRoot = true;
        loadedFocusIds.delete(view.rootEntityId);
      } else if (focus === view.rootEntityId || packet.focusEntityId === view.rootEntityId) {
        fetchedDeeperThanRoot = false;
      }
    })();
    inflight.set(focus, work);
    try {
      await work;
    } finally {
      inflight.delete(focus);
    }
  };

  const ensureExcerpts = async (entityId: string): Promise<SourceExcerpt[] | undefined> => {
    const existing = snapshot.entities.find(entity => entity.id === entityId);
    if (existing?.sourceExcerpts?.length) return existing.sourceExcerpts;
    if (!host) return existing?.sourceExcerpts;
    const excerpts = await host.loadExcerpts(entityId);
    if (excerpts?.length && existing) {
      existing.sourceExcerpts = excerpts;
      // Worker graphs include evidence, not only drawable geometry.
      snapshotGeneration++;
      initialScene = undefined;
    }
    return excerpts;
  };

  return {
    snapshot,
    view,
    story,
    stories: extras.stories?.length ? extras.stories : [story],
    createScene,
    getSceneGeneration: () => snapshotGeneration,
    disposeSceneWorker,
    prepareInitialScene,
    enrichInitialScene,
    createSceneAsync,
    scopeCompileOptions: (focusEntityId: string) => scanScopeCompileOptions(snapshot, focusEntityId),
    ...(options.targetAspect !== undefined ? { targetAspect: options.targetAspect } : {}),
    navigation: {
      repositoryId: snapshot.repositoryId,
      snapshotId: snapshot.id,
      viewId: view.id,
      rootEntityId: view.rootEntityId,
    },
    childCounts,
    unpublishedChildren,
    boot: extras.boot,
    ensureNeighborhood,
    ensureExcerpts,
  };
}

function parsePublishedStoryCatalog(raw: unknown): ArchitectureStory[] {
  if (!isRecord(raw) || !Array.isArray(raw.stories)) return [];
  return raw.stories.filter(item => isRecord(item) && typeof item.id === 'string') as ArchitectureStory[];
}

/** Overview first; extra catalog entries compile when valid. Invalid extras are skipped. */
function compilePublishedStories(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  overview: AppStoryPlan,
  rawCatalog: unknown,
  options: { allowMissingFocus?: boolean } = {},
): AppStoryPlan[] {
  const plans: AppStoryPlan[] = [overview];
  const seen = new Set<string>([overview.id]);
  for (const story of parsePublishedStoryCatalog(rawCatalog)) {
    if (seen.has(story.id)) continue;
    try {
      const plan = measureAtlasPhase('atlas-story', () => compileAppStoryPlan(snapshot, view, story, options));
      plans.push(plan);
      seen.add(plan.id);
    } catch {
      // Keep the overview; a broken extra story must not take down the atlas.
    }
  }
  return plans;
}

/**
 * Validates the raw scan trio and compiles it into a live ScanFixture through the
 * exact same path the demo uses (createC4Scene → buildC4ProjectionBundle →
 * compileC4Scene). Throws ScanFixtureError with every issue rather than returning
 * a partial fixture, so an invalid scan can never render silently. Pure (fetch is
 * separate), so it is exercised directly in tests with the demo fixtures as input.
 */
export function compileScanFixture(raw: RawScanTrio, options: ScanModeOptions = {}): ScanFixture {
  const shapeIssues: ValidationIssue[] = [];
  if (!isRecord(raw.snapshot)) shapeIssues.push({ path: 'snapshot', message: 'must be a JSON object' });
  if (!isRecord(raw.view)) shapeIssues.push({ path: 'view', message: 'must be a JSON object' });
  if (!isRecord(raw.story)) shapeIssues.push({ path: 'story', message: 'must be a JSON object' });
  if (shapeIssues.length) throw new ScanFixtureError(shapeIssues);

  const snapshot = raw.snapshot as ArchitectureSnapshot;
  const view = raw.view as ArchitectureView;
  const issues: ValidationIssue[] = [
    ...scopedValidate('snapshot', () => validateSnapshot(snapshot)),
    ...scopedValidate('view', () => validateView(snapshot, view)),
    ...scopedValidate('story', () => validateStoryDocument(snapshot, view, raw.story)),
  ];
  if (issues.length) throw new ScanFixtureError(issues);

  let story: AppStoryPlan;
  try {
    story = measureAtlasPhase('atlas-story', () => compileAppStoryPlan(snapshot, view, raw.story as ArchitectureStory));
  } catch (error) {
    throw new ScanFixtureError([{ path: 'story', message: error instanceof Error ? error.message : String(error) }]);
  }

  return buildLiveScanFixture(snapshot, view, story, options, {
    boot: 'full',
    childCounts: childCountsFromSnapshot(snapshot),
    stories: compilePublishedStories(snapshot, view, story, raw.stories),
  });
}

export function compileScanNeighborhoodFixture(
  packet: ArchitectureNeighborhoodPacket,
  rawStory: unknown,
  host: ScanNeighborhoodHost,
  options: ScanModeOptions = {},
  rawStories?: unknown,
): ScanFixture {
  const packetIssues = measureAtlasPhase('atlas-validate', () => validateNeighborhoodPacket(packet));
  if (packetIssues.length) throw new ScanFixtureError(packetIssues);
  return buildValidatedNeighborhoodFixture(packet, rawStory, host, options, rawStories);
}

/** Private construction seam: callers must have just completed packet validation. */
function buildValidatedNeighborhoodFixture(
  packet: ArchitectureNeighborhoodPacket,
  rawStory: unknown,
  host: ScanNeighborhoodHost,
  options: ScanModeOptions,
  rawStories?: unknown,
  initialized?: { scene: AtlasScene; worker: SceneCompileSession },
): ScanFixture {
  if (!isRecord(rawStory)) throw new ScanFixtureError([{ path: 'story', message: 'must be a JSON object' }]);
  let story: AppStoryPlan;
  try {
    story = measureAtlasPhase('atlas-story', () => compileAppStoryPlan(packet.snapshot, packet.view, rawStory as unknown as ArchitectureStory, { allowMissingFocus: true }));
  } catch (error) {
    throw new ScanFixtureError([{ path: 'story', message: error instanceof Error ? error.message : String(error) }]);
  }
  return buildLiveScanFixture(packet.snapshot, packet.view, story, options, {
    boot: 'neighborhood',
    initialized,
    childCounts: { ...packet.childCounts },
    unpublishedChildren: [...(packet.unpublishedChildren ?? [])],
    host,
    loadedFocusIds: new Set([packet.focusEntityId]),
    stories: compilePublishedStories(packet.snapshot, packet.view, story, rawStories, { allowMissingFocus: true }),
  });
}

// import.meta.glob tolerates a missing fixtures/scan/ at build time (it resolves
// to an empty map) — unlike a static import(), which would break `pnpm build`
// on a fresh checkout where the gitignored scan output has not been generated.
// The ROOT trio (fixtures/scan/{snapshot,view,story}.json) is the Okie self-scan,
// loaded by `?fixture=scan`. PER-REPO trios live one directory deeper
// (fixtures/scan/<slug>/…), loaded by `?fixture=scan:<slug>`; `*` matches a single
// path segment so the two globs never overlap.
type ScanDocGlob = Record<string, () => Promise<{ default: unknown }>>;
const rootScanLoaders: ScanDocGlob = import.meta.glob<{ default: unknown }>('../../../../fixtures/scan/{snapshot,view,story}.json');
const repoScanLoaders: ScanDocGlob = import.meta.glob<{ default: unknown }>('../../../../fixtures/scan/*/{snapshot,view,story}.json');
const rootStoryCatalogLoaders: ScanDocGlob = import.meta.glob<{ default: unknown }>('../../../../fixtures/scan/stories.json');
const repoStoryCatalogLoaders: ScanDocGlob = import.meta.glob<{ default: unknown }>('../../../../fixtures/scan/*/stories.json');

/** Sorted slugs of scanned repos present in a per-repo glob map (the loadable set). */
function slugsFromGlob(repo: ScanDocGlob): string[] {
  const slugs = new Set<string>();
  for (const path of Object.keys(repo)) {
    const match = /\/fixtures\/scan\/([^/]+)\/(?:snapshot|view|story)\.json$/.exec(path);
    if (match) slugs.add(match[1]!);
  }
  return [...slugs].sort();
}

/**
 * Sorted slugs of scanned repositories present under fixtures/scan/<slug>/ — derived
 * from what actually built (the ground truth for the fail-closed unknown-slug error),
 * not from the manifest, so a stale index.json can never claim a slug the app cannot load.
 */
export function availableScanRepoSlugs(): string[] {
  return slugsFromGlob(repoScanLoaders);
}

/**
 * Runtime-fetch trio loader (embed-hosting §1's "one required app change"): reads
 * /scan/<slug>/{snapshot,view,story}.json from the serving origin — objects a scan
 * worker published AFTER this bundle was built, which the build-time glob can never
 * see. In dev the vite proxy forwards /scan/* to the scan server; hosted, the same
 * paths come from object storage behind the CDN. Fails closed like the glob path:
 * a missing or invalid object raises ScanFixtureError, never a partial fixture.
 */
export function fetchScanTrioLoader(slug?: string, fetchImpl: typeof fetch = fetch): ScanTrioLoader {
  return async name => {
    const path = slug
      ? `/scan/${encodeURIComponent(slug)}/${name}.json`
      : `/scan/${name}.json`;
    let response: Response;
    try {
      response = await measureAtlasAsyncPhase('atlas-fetch', () => fetchImpl(path));
    } catch (error) {
      throw new ScanFixtureError([{
        path: name,
        message: `Could not reach the scan service for ${path} (${error instanceof Error ? error.message : String(error)}).`,
      }]);
    }
    if (!response.ok) {
      throw new ScanFixtureError([{
        path: name,
        message: response.status === 404
          ? `No scanned repository is published at ${path}. Paste the repository on the scan page to create it.`
          : `Failed to load ${path} (HTTP ${response.status}).`,
      }]);
    }
    try {
      const text = await measureAtlasAsyncPhase('atlas-body', () => response.text());
    return measureAtlasPhase('atlas-parse', () => JSON.parse(text)) as unknown;
    } catch {
      throw new ScanFixtureError([{ path: name, message: `${path} is not valid JSON.` }]);
    }
  };
}

/**
 * Pure resolution of which document loader serves (name, slug) from the root and
 * per-repo glob maps. No slug → the root Okie self-scan; a slug → fixtures/scan/<slug>/,
 * failing closed with a ScanFixtureError that lists the available slugs. Exported so the
 * multi-repo selection + unknown-slug paths are unit-tested with fake maps (no disk).
 */
export function resolveScanDocLoader(
  name: 'snapshot' | 'view' | 'story',
  slug: string | undefined,
  maps: { root: ScanDocGlob; repo: ScanDocGlob },
): () => Promise<{ default: unknown }> {
  if (slug) {
    const key = Object.keys(maps.repo).find(path => path.endsWith(`/fixtures/scan/${slug}/${name}.json`));
    if (!key) {
      const available = slugsFromGlob(maps.repo);
      const message = available.includes(slug)
        ? `Scanned repository “${slug}” is missing ${name}.json — re-run okie-scan for it.`
        : available.length
          ? `No scanned repository “${slug}”. Available: ${available.join(', ')}. Re-run okie-scan --source gh:owner/repo.`
          : `No scanned repository “${slug}”, and none are available. Run okie-scan --source gh:owner/repo to create one.`;
      throw new ScanFixtureError([{ path: name, message }]);
    }
    return maps.repo[key]!;
  }
  const key = Object.keys(maps.root).find(path => path.endsWith(`/${name}.json`));
  if (!key) {
    throw new ScanFixtureError([{
      path: name,
      message: `fixtures/scan/${name}.json was not found — run okie-scan to generate the snapshot trio`,
    }]);
  }
  return maps.root[key]!;
}

async function fetchScanDoc(name: 'snapshot' | 'view' | 'story', slug?: string): Promise<unknown> {
  return (await resolveScanDocLoader(name, slug, { root: rootScanLoaders, repo: repoScanLoaders })()).default;
}

async function loadOptionalStoryCatalog(slug?: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const fetched = await fetchOptionalScanJson(scanObjectPath(slug, 'stories.json'), fetchImpl);
  if (fetched !== undefined) return fetched;
  const loaders = slug ? repoStoryCatalogLoaders : rootStoryCatalogLoaders;
  const suffix = slug ? `/fixtures/scan/${slug}/stories.json` : '/stories.json';
  const key = Object.keys(loaders).find(path => path.endsWith(suffix));
  if (!key) return undefined;
  try {
    return (await loaders[key]!()).default;
  } catch {
    return undefined;
  }
}

async function fetchOptionalScanJson(path: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await measureAtlasAsyncPhase('atlas-fetch', () => fetchImpl(path));
  } catch {
    return undefined;
  }
  if (response.status === 404 || !response.ok) return undefined;
  try {
    const text = await measureAtlasAsyncPhase('atlas-body', () => response.text());
    return measureAtlasPhase('atlas-parse', () => JSON.parse(text)) as unknown;
  } catch {
    return undefined;
  }
}

export async function loadPublishedEnrichmentHonesty(
  slug: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishedEnrichmentHonesty | undefined> {
  const [reportRaw, statusRaw] = await Promise.all([
    fetchOptionalScanJson(scanObjectPath(slug, 'enrichment-report.json'), fetchImpl),
    fetchOptionalScanJson(scanObjectPath(slug, 'enrichment-status.json'), fetchImpl),
  ]);
  return publishedEnrichmentHonesty({
    report: parsePublishedEnrichmentReport(reportRaw),
    status: parsePublishedEnrichmentStatus(statusRaw),
  });
}

async function honestyFromHost(host: ScanNeighborhoodHost): Promise<PublishedEnrichmentHonesty | undefined> {
  const [reportRaw, statusRaw] = await Promise.all([
    host.loadEnrichmentReport?.() ?? Promise.resolve(undefined),
    host.loadEnrichmentStatus?.() ?? Promise.resolve(undefined),
  ]);
  return publishedEnrichmentHonesty({
    report: parsePublishedEnrichmentReport(reportRaw),
    status: parsePublishedEnrichmentStatus(statusRaw),
  });
}

function withEnrichmentHonesty(
  fixture: ScanFixture,
  honesty: PublishedEnrichmentHonesty | undefined,
): ScanFixture {
  return honesty ? { ...fixture, enrichmentHonesty: honesty } : fixture;
}

function scanObjectPath(slug: string | undefined, basename: string, query?: string): string {
  const path = slug
    ? `/scan/${encodeURIComponent(slug)}/${basename}`
    : `/scan/${basename}`;
  return query ? `${path}?${query}` : path;
}

async function fetchScanJson(path: string, fetchImpl: typeof fetch, label: string): Promise<unknown> {
  let response: Response;
  try {
    response = await measureAtlasAsyncPhase('atlas-fetch', () => fetchImpl(path));
  } catch (error) {
    throw new ScanFixtureError([{
      path: label,
      message: `Could not reach the scan service for ${path} (${error instanceof Error ? error.message : String(error)}).`,
    }]);
  }
  if (!response.ok) {
    throw new ScanFixtureError([{
      path: label,
      message: response.status === 404
        ? `No scanned repository is published at ${path}. Paste the repository on the scan page to create it.`
        : `Failed to load ${path} (HTTP ${response.status}).`,
    }]);
  }
  try {
    const text = await measureAtlasAsyncPhase('atlas-body', () => response.text());
    return measureAtlasPhase('atlas-parse', () => JSON.parse(text)) as unknown;
  } catch {
    throw new ScanFixtureError([{ path: label, message: `${path} is not valid JSON.` }]);
  }
}

/** Deep-link / Open-inside focus from the share URL. `sel` wins over lens/root. */
export function bootFocusFromSearch(search: string): string | undefined {
  const params = new URLSearchParams(search);
  const sel = params.get('sel')?.trim();
  if (sel) return sel;
  const lens = params.getAll('lens').map(id => id.trim()).filter(Boolean);
  const deepest = lens.at(-1);
  if (deepest) return deepest;
  const root = params.get('root')?.trim();
  return root || undefined;
}

/**
 * Runtime-fetch neighborhood host (CLA-73): `/scan/<slug>/neighborhood.json`
 * plus lazy `/excerpt.json`, `story.json`, optional `stories.json`, and optional enrichment honesty
 * sidecars. Does not GET snapshot.json/view.json.
 */
export function fetchScanNeighborhoodHost(slug?: string, fetchImpl: typeof fetch = fetch): ScanNeighborhoodHost {
  let publication: { versionId: string; artifactRevisionId: string } | undefined;
  const pinnedQuery = (query?: string): string | undefined => {
    if (!publication) return query;
    const params = new URLSearchParams(query);
    params.set('version', publication.versionId);
    return params.toString();
  };
  return {
    async loadNeighborhood(focusEntityId: string) {
      const focus = focusEntityId.trim();
      const query = focus ? new URLSearchParams({ focus }).toString() : undefined;
      const raw = await fetchScanJson(scanObjectPath(slug, 'neighborhood.json', pinnedQuery(query)), fetchImpl, 'neighborhood');
      if (!isNeighborhoodPacket(raw)) {
        throw new ScanFixtureError([{ path: 'neighborhood', message: 'Scan neighborhood packet is structurally invalid.' }]);
      }
      const candidate = (raw as { publication?: unknown }).publication;
      if (isRecord(candidate) && typeof candidate.versionId === 'string' && typeof candidate.artifactRevisionId === 'string') {
        if (publication && publication.versionId !== candidate.versionId) throw new ScanFixtureError([{ path: 'neighborhood', message: 'Published neighborhood changed version during this atlas session.' }]);
        publication = { versionId: candidate.versionId, artifactRevisionId: candidate.artifactRevisionId };
      }
      return raw;
    },
    async loadExcerpts(entityId: string) {
      const query = new URLSearchParams({ entity: entityId });
      const raw = await fetchScanJson(scanObjectPath(slug, 'excerpt.json', pinnedQuery(query.toString())), fetchImpl, 'excerpt');
      if (!isRecord(raw) || raw.kind !== 'excerpt' || !Array.isArray(raw.sourceExcerpts)) {
        throw new ScanFixtureError([{ path: 'excerpt', message: 'Scan excerpt packet is structurally invalid.' }]);
      }
      return raw.sourceExcerpts as SourceExcerpt[];
    },
    loadStory: () => fetchScanJson(scanObjectPath(slug, 'story.json', pinnedQuery()), fetchImpl, 'story'),
    loadStories: () => fetchOptionalScanJson(scanObjectPath(slug, 'stories.json', pinnedQuery()), fetchImpl),
    loadEnrichmentReport: () => fetchOptionalScanJson(scanObjectPath(slug, 'enrichment-report.json', pinnedQuery()), fetchImpl),
    loadEnrichmentStatus: () => fetchOptionalScanJson(scanObjectPath(slug, 'enrichment-status.json', pinnedQuery()), fetchImpl),
    publication: () => publication,
  };
}

/**
 * Fetches the scanned trio from the gitignored fixtures/scan/ path (served by the
 * dev server, like the stress fixture) and compiles it. `slug` selects a per-repo
 * scan (fixtures/scan/<slug>/); omitted, it loads the root Okie self-scan. The loader
 * is injectable so tests can drive the validate/error path without real files on disk.
 */
export async function loadScanFixture(
  load?: ScanTrioLoader,
  options: ScanModeOptions = {},
  slug?: string,
): Promise<ScanFixture> {
  const loader: ScanTrioLoader = load ?? (name => fetchScanDoc(name, slug));
  const [snapshot, view, story, catalog, honesty] = await Promise.all([
    loader('snapshot'),
    loader('view'),
    loader('story'),
    loadOptionalStoryCatalog(slug),
    load && !slug ? Promise.resolve(undefined) : loadPublishedEnrichmentHonesty(slug),
  ]);
  const fixture = withEnrichmentHonesty(compileScanFixture({ snapshot, view, story, stories: catalog }, options), honesty);
  await fixture.prepareInitialScene();
  return fixture;
}

export async function loadScanNeighborhoodFixture(
  host: ScanNeighborhoodHost,
  focusEntityId: string | undefined,
  options: ScanModeOptions = {},
  signal?: AbortSignal,
): Promise<ScanFixture> {
  const worker = createSceneCompileSession();
  let fixture: ScanFixture | undefined;
  let rejectAbort: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => {
    worker.dispose();
    fixture?.disposeSceneWorker();
    rejectAbort(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  signal?.addEventListener('abort', abort, { once: true });
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  };
  try {
    throwIfAborted();
    // The host supplies a fresh, exclusively owned parsed packet. It remains
    // unexposed and unmodified until its worker clone has passed validation.
    // Its publication pins auxiliary requests before those requests are started.
    const packet = await Promise.race([host.loadNeighborhood(focusEntityId ?? ''), aborted]);
    throwIfAborted();
    const [initialized, story, catalog, honesty] = await Promise.race([Promise.all([
      worker.initializeNeighborhood(packet, options, { generation: 2, signal }),
      Promise.resolve().then(() => host.loadStory()),
      Promise.resolve().then(() => host.loadStories?.()),
      honestyFromHost(host),
    ]), aborted]);
    throwIfAborted();
    if (initialized?.status === 'invalid') throw new ScanFixtureError(initialized.issues);
    if (initialized?.status === 'ready') {
      fixture = withEnrichmentHonesty(buildValidatedNeighborhoodFixture(packet, story, host, options, catalog, {
        scene: initialized.scene, worker,
      }), honesty);
    } else {
      // Unsupported/failed/timed-out worker: the original synchronous public
      // validator remains the only fallback. Invalid and aborted jobs never land here.
      worker.dispose();
      fixture = withEnrichmentHonesty(compileScanNeighborhoodFixture(packet, story, host, options, catalog), honesty);
      await Promise.race([fixture.prepareInitialScene(signal), aborted]);
    }
    throwIfAborted();
    const publication = host.publication?.();
    return publication ? { ...fixture, publication } : fixture;
  } catch (error) {
    worker.dispose();
    fixture?.disposeSceneWorker();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

/** Restore against the same canonical packet used by a fresh atlas entry. */
export async function loadScanNeighborhoodFixtureFromSearch(
  host: ScanNeighborhoodHost,
  search: string,
  options: ScanModeOptions = {},
  signal?: AbortSignal,
): Promise<ScanFixture> {
  const fixture = await loadScanNeighborhoodFixture(host, undefined, options, signal);
  try {
    const params = new URLSearchParams(search);
    const focuses = [...params.getAll('lens'), params.get('root'), params.get('sel')];
    for (const focus of new Set(focuses.map(id => id?.trim()).filter((id): id is string => Boolean(id)))) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      await fixture.ensureNeighborhood(focus);
    }
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    return fixture;
  } catch (error) {
    fixture.disposeSceneWorker();
    throw error;
  }
}
