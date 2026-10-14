import { readFileSync } from "node:fs";
import {
  adaptArchitectureExtraction,
  ASPECT_PRESET_TARGET,
  buildC4ProjectionBundle,
  sanitizeControlCharacters,
  validateSnapshot,
  validateStory,
  validateView,
  type ArchitectureExtraction,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type ArchitectureExtractionSnapshotMetadata,
  type NodeLayout,
} from "@okie/architecture";
import { compileC4Scene, compileC4Timeline, type CompiledC4Scene, type SceneSnapshot, type Timeline } from "@okie/scene-compiler";
import { attachPathOwners, readCodeOwners } from "./codeowners.js";
import { attachCoverage, coverageByCodeIdFromEntities, parseLcov, readLcov, type LcovSidecar } from "./lcov.js";
import { attachPortableSourceExcerpts } from "./excerpt.js";
import { buildOverviewStory } from "./overview-story.js";
import { buildUserFlowStories, publishedStoryCatalog, type PublishedStoryCatalog } from "./flow-story.js";
import { discoverExtractedTree, TOOLING_UNIT_KEY, type Discovery, type DiscoverySummary } from "./discover.js";
import { membershipDiagnostics, membershipReport, type MembershipReport } from "./container-membership.js";
import {
  attachCyclomaticComplexity,
  attachDuplicateRelations,
  clonePairsFromEntities,
  collectExtractedArchitecture,
  cyclomaticByIdFromEntities,
  type ClonePair,
  type ExtractInput,
  type UnresolvedRelativeImport,
} from "./extract.js";
import { mergeEnrichment, type EnrichmentReport } from "./enrich.js";
import { applyComponentMembership, type ComponentMapInput, type ComponentMapReport } from './component-map.js';
import { buildEnrichmentPackets, type EmittedPackets } from "./packet.js";
import { acquireCommittedTree, type AcquiredCommittedTree, type RepositoryPin } from "./pin.js";
import { skippedEntryLimitations, type SkippedTreeEntries } from "./source-tree.js";
import {
  acquireGithubTree,
  createDefaultGithubClient,
  resolveGithubCommit,
  type GithubClient,
  type GithubSourceRef,
} from "./github.js";
import { slug, typedId } from "./ids.js";
import type { PortableAtlas } from '@okie/architecture';
import type { LanguageAnalysis } from './language-analysis.js';
import { analyzeTypeScript } from './analyze-typescript.js';
import { analyzeRust } from './analyze-rust.js';
import { buildDependencyFacts, collectDependencyInputs } from './dependency-facts.js';

export interface ScanOptions {
  analysisMode?: 'full' | 'quick';
  includeSource?: boolean;
  systemName?: string;
  repositorySlug?: string;
  /** Scan fixture/example/playground/e2e workspace members too (default: skip them). */
  includeAllMembers?: boolean;
  /** container id -> enrichment document or remainder-packet array; accepted docs merge into that scope. */
  enrichmentDocs?: ReadonlyMap<string, unknown>;
  /** Optional explicit, pinned architectural component interpretation. */
  componentMap?: ComponentMapInput;
  /** L4 code surface: 'all' (default, every top-level declaration) or 'public' (export surface only). */
  codeSurface?: "all" | "public";
  /**
   * Optional lcov.info bytes. When set, wins over conventional sidecar lookup.
   * Missing / empty → omit coverage (do not invent 0%).
   */
  lcovText?: string;
  /** Local Git revision to scan (HEAD by default). */
  revision?: string;
  /**
   * CLA-271: content-addressed rust-analyzer SCIP index cache directory. Off by default (every full scan runs
   * rust-analyzer). The same Rust inputs, analyzer version and invocation reuse an index across checkouts.
   */
  rustIndexCacheDir?: string;
}

export interface GithubScanOptions extends ScanOptions {
  /** Transport for GitHub reads (default: anonymous HTTPS + `gh` fallback). Injected in tests. */
  client?: GithubClient;
  /** Cap on the downloaded tarball; a clearer error fires above it. */
  maxTarballBytes?: number;
  /**
   * Live enrichment adapter (M3): called with the bounded packets while the ephemeral
   * checkout is still on disk; returns container-id-keyed docs to merge through the
   * gate. Remainder packets for one container must be an array (same shape as
   * `--enrich-from`); last-write-wins would drop the first chunk. Used only when no
   * pre-recorded `enrichmentDocs` were supplied. The adapter owns its own resilience
   * — per-scope failures simply omit that scope's doc, and the deterministic base
   * always publishes (an empty map means no enrichment).
   */
  enrichWithPackets?: (packets: EmittedPackets) => Promise<ReadonlyMap<string, unknown>>;
}

export interface ScanArtifacts {
  analysis: PortableAtlas['analysis'];
  sources?: PortableAtlas['sources'];
  /** Dependency consumer facts (CLA-212): bundle-only, never graph input. */
  dependencies: NonNullable<PortableAtlas['dependencies']>;
  pin: RepositoryPin;
  /** The deterministic (pre-enrichment) extraction — the source for enrichment packets. */
  baseExtraction: ArchitectureExtraction;
  extraction: ArchitectureExtraction;
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  story: ArchitectureStory;
  /** Overview first, then any deterministic user-flow stories (CLA-77). */
  stories: ArchitectureStory[];
  catalog: PublishedStoryCatalog;
  scene: SceneSnapshot;
  timeline: Timeline;
  discoverySummary: DiscoverySummary;
  /** CLA-263: folded re-export shims + container-membership warnings (always present; persisted). */
  membership: MembershipReport;
  enrichmentReport?: EnrichmentReport;
  componentMapReport?: ComponentMapReport;
}

function rootPackageName(sourceRoot: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(`${sourceRoot}/package.json`, "utf8")) as { name?: string };
    return typeof pkg.name === "string" && pkg.name.trim() ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/** Deterministic legacy grid: the C4 renderer lays out intrinsically, so these
 *  node rects exist ONLY to satisfy validateView and carry story membership. */
function syntheticLayout(snapshot: ArchitectureSnapshot): Record<string, NodeLayout> {
  return Object.fromEntries([...snapshot.entities]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((entity, index) => [entity.id, {
      x: 120 + (index % 8) * 330,
      y: 120 + Math.floor(index / 8) * 210,
      width: 280,
      height: 140,
    }]));
}

function buildView(snapshot: ArchitectureSnapshot, systemId: string, repositorySlug: string, systemName: string): ArchitectureView {
  return {
    schemaVersion: 1,
    id: typedId("view", repositorySlug, "hierarchy"),
    snapshotId: snapshot.id,
    name: `${systemName} scan`,
    rootEntityId: systemId,
    entityIds: snapshot.entities.map(entity => entity.id),
    relationIds: snapshot.relations.map(relation => relation.id),
    layout: { nodes: syntheticLayout(snapshot) },
  };
}

/** Keep timeline compilation aligned with the (possibly band-capped) debug scene. */
function storyStepsVisibleInScene(
  compiled: CompiledC4Scene,
  story: ArchitectureStory,
): ArchitectureStory["steps"] {
  const sceneObjectIds = new Set(compiled.scene.objects.map(object => object.id));
  return story.steps.filter(step => {
    const band = step.reveal ?? "context";
    const projection = compiled.projections.projectionById[compiled.projections.family.projectionIds[band]];
    if (!projection) return false;
    const layout = compiled.projections.bandLayoutById[projection.layoutId];
    if (!layout) return false;
    return step.focusEntityIds.some(entityId =>
      (compiled.projections.index.visualNodeIdsByEntityId[entityId] ?? [])
        .some(id => sceneObjectIds.has(id) && layout.nodes[id]));
  });
}

/** Full portable source is limited to known regular files, never container anchors. */
function portableSourcePaths(snapshot: ArchitectureSnapshot, discovery: Discovery): string[] {
  const knownFiles = new Set(discovery.sourceFiles);
  const isManifest = (path: string): boolean => path === "README.md" || path === "package.json" || path === "Cargo.toml"
    || path === "pnpm-workspace.yaml" || path.endsWith("/package.json") || path.endsWith("/Cargo.toml");
  const references = [
    ...snapshot.entities.flatMap(entity => [
      ...entity.sourceRefs,
      ...(entity.exposure ?? []).map(exposure => exposure.evidence.source),
    ]),
    ...snapshot.relations.flatMap(relation => relation.evidence.map(evidence => evidence.source)),
  ];
  return [...new Set(references.map(ref => ref.path).filter(path => knownFiles.has(path) || isManifest(path)))].sort();
}

export interface BuildScanArtifactsParams {
  languageAnalysis?: LanguageAnalysis;
  analysisMode?: 'full' | 'quick';
  includeSource?: boolean;
  discovery: Discovery;
  pin: RepositoryPin;
  readFile: (repoRelativePath: string) => string;
  repositorySlug: string;
  systemName: string;
  enrichmentDocs?: ReadonlyMap<string, unknown>;
  componentMap?: ComponentMapInput;
  codeSurface?: "all" | "public";
  /**
   * A base extraction already computed over the SAME inputs (used by the live-enrichment
   * path to avoid extracting twice while the checkout is alive). Must be byte-equal to
   * what extractArchitecture would produce here; callers never mutate it.
   */
  baseExtraction?: ArchitectureExtraction;
  /** McCabe map from the same extract as `baseExtraction`. Recomputed from source when omitted. */
  cyclomaticById?: ReadonlyMap<string, number>;
  /** Clone pairs from the same extract as `baseExtraction`. Recomputed from source when omitted. */
  clonePairs?: readonly ClonePair[];
  /** Unresolved relative imports from the same extract as `baseExtraction`. Recomputed from source when omitted. */
  unresolvedRelativeImports?: readonly UnresolvedRelativeImport[];
  /** Optional lcov.info bytes. Conventional `coverage/lcov.info` is read when omitted. */
  lcovText?: string;
  /**
   * Committed manifests/lockfiles captured before any analyzer ran (collectDependencyInputs).
   * When omitted they are read through `readFile` (safe only when no analyzer touched the tree).
   */
  dependencyInputs?: ReadonlyMap<string, string>;
}

/** Pure pipeline over an already-collected discovery + pin (drives the determinism gate). */
export function buildScanArtifacts(params: BuildScanArtifactsParams): ScanArtifacts {
  const { discovery, pin, readFile, repositorySlug, systemName } = params;
  const systemSlug = slug(systemName);

  const extractInput: ExtractInput = {
    discovery,
    readFile,
    systemName,
    systemSlug,
    ...(params.languageAnalysis ? { languageAnalysis: params.languageAnalysis } : {}),
    ...(params.codeSurface ? { codeSurface: params.codeSurface } : {}),
  };
  const collected = params.baseExtraction
    ? {
      extraction: params.baseExtraction,
      cyclomaticById: params.cyclomaticById
        ?? cyclomaticByIdFromEntities(params.baseExtraction.entities, readFile),
      clonePairs: params.clonePairs
        ?? clonePairsFromEntities(params.baseExtraction.entities, readFile),
      unresolvedRelativeImports: params.unresolvedRelativeImports
        ?? collectExtractedArchitecture(extractInput).unresolvedRelativeImports,
    }
    : collectExtractedArchitecture(extractInput);
  const baseExtraction = collected.extraction;
  const sidecar = loadLcovSidecar(readFile, params.lcovText);
  const coverageByCodeId = coverageByCodeIdFromEntities(baseExtraction.entities, sidecar);
  let extraction = baseExtraction;
  let componentMapReport: ComponentMapReport | undefined;
  if (params.componentMap) {
    const outcome = applyComponentMembership(baseExtraction, params.componentMap);
    extraction = outcome.extraction;
    componentMapReport = outcome.report;
  }
  let enrichmentReport: EnrichmentReport | undefined;
  if (params.enrichmentDocs && params.enrichmentDocs.size > 0) {
    const outcome = mergeEnrichment(extraction, params.enrichmentDocs, { coverageByCodeId });
    extraction = outcome.extraction;
    enrichmentReport = outcome.report;
  }

  // CLA-263: container membership should be exclusive — a file cited from two
  // containers (or a shim re-exporting another container's file) double-counts
  // components/enrichment and yields duplicate operator scopes. Warnings only:
  // persisted in the report + bundle, never fatal to a scan or operator run.
  const nonMemberPaths = new Set(discovery.sourceFiles.filter(path => discovery.unitByFile.get(path) === TOOLING_UNIT_KEY));
  const membership = membershipReport(discovery.summary.reexportAliases, membershipDiagnostics(extraction, readFile, nonMemberPaths));
  const hasMembershipFacts = membership.reexportAliases.length > 0 || membership.diagnostics.length > 0;
  const scanLimitations = [
    ...discoveryLimitations(discovery.summary),
    ...unresolvedImportLimitations(collected.unresolvedRelativeImports),
  ];

  const metadata: ArchitectureExtractionSnapshotMetadata = {
    snapshotId: typedId("snapshot", repositorySlug, pin.commitSha.slice(0, 12)),
    repositoryId: typedId("repo", repositorySlug),
    commitSha: pin.commitSha,
    generatedAt: pin.generatedAt,
  };
  const snapshot = attachCoverage(
    attachDuplicateRelations(
      attachCyclomaticComplexity(
        attachPathOwners(
          attachPortableSourceExcerpts(
            adaptArchitectureExtraction(extraction, metadata),
            readFile,
          ),
          readCodeOwners(readFile)?.rules ?? [],
        ),
        collected.cyclomaticById,
      ),
        collected.clonePairs,
      ),
      sidecar,
    );
  const snapshotIssues = validateSnapshot(snapshot);
  if (snapshotIssues.length) {
    throw new Error(`Scanned snapshot failed validation:\n${snapshotIssues.map(i => `${i.path}: ${i.message}`).join("\n")}`);
  }

  const system = snapshot.entities.find(entity => entity.kind === "softwareSystem");
  if (!system) throw new Error("Scanned snapshot has no softwareSystem root");

  const view = buildView(snapshot, system.id, repositorySlug, systemName);
  const viewIssues = validateView(snapshot, view);
  if (viewIssues.length) {
    throw new Error(`Scanned view failed validation:\n${viewIssues.map(i => `${i.path}: ${i.message}`).join("\n")}`);
  }

  const story = buildOverviewStory(snapshot, view, system.id, repositorySlug, systemName);
  const storyIssues = validateStory(snapshot, view, story);
  if (storyIssues.length) {
    throw new Error(`Scanned story failed validation:\n${storyIssues.map(i => `${i.path}: ${i.message}`).join("\n")}`);
  }
  const flowStories = buildUserFlowStories(snapshot, view, repositorySlug, systemName);
  for (const flow of flowStories) {
    const flowIssues = validateStory(snapshot, view, flow);
    if (flowIssues.length) {
      throw new Error(`Scanned flow story ${flow.id} failed validation:\n${flowIssues.map(i => `${i.path}: ${i.message}`).join("\n")}`);
    }
  }
  const stories = [story, ...flowStories];
  const catalog = publishedStoryCatalog(stories);

  // scene.json is a debug artifact — the app compiles per-focus live. A big snapshot's
  // full-graph compile would not terminate (edge routing is superlinear in edges), so
  // above a deterministic relation threshold we bound it to the container-band top scene
  // with an edge budget. Okie (well below the threshold) stays a full, byte-identical scene.
  const SCENE_RELATION_BUDGET = 400;
  const familyId = typedId("view-family", repositorySlug, "system-root");
  // CLA-96: published scan scene.json must use the same landscape ~1.6 the
  // browser neighborhood compile uses. Golden/demo omit targetAspect.
  const targetAspect = ASPECT_PRESET_TARGET.landscape;
  const focus = {
    rootEntityId: system.id,
    focusEntityId: system.id,
    familyId,
    targetAspect,
  };
  const bundle = snapshot.relations.length > SCENE_RELATION_BUDGET
    ? buildC4ProjectionBundle(snapshot, { ...focus, maxBand: "container", maxEdgesPerBand: 64 })
    : buildC4ProjectionBundle(snapshot, focus);
  const compiled = compileC4Scene(snapshot, bundle, { targetAspect });
  const visibleSteps = storyStepsVisibleInScene(compiled, story);
  if (!visibleSteps.length) {
    throw new Error("Scanned overview story has no steps visible in the compiled scene");
  }
  const timeline = compileC4Timeline(snapshot, { ...story, steps: visibleSteps }, compiled);

  return {
    pin,
    baseExtraction,
    extraction,
    snapshot,
    view,
    story,
    stories,
    catalog,
    scene: compiled.scene,
    timeline,
    discoverySummary: discovery.summary,
    membership,
    analysis: {
      mode: params.analysisMode ?? 'quick',
      adapters: params.languageAnalysis?.coverage.map(({ indexedFiles: _files, ...coverage }) => coverage) ??
        [...new Set(discovery.sourceFiles.map(path => path.endsWith('.rs') ? 'rust' : 'typescript/javascript'))].map(language => ({ language, tool: language === 'rust' ? 'tree-sitter-rust' : 'typescript', version: 'syntax-v1', coverage: 'syntax' as const, limitations: ['Quick scan: project-wide semantic resolution was not requested.'] })),
      ...(hasMembershipFacts ? { membership } : {}),
      ...(scanLimitations.length > 0 ? { limitations: scanLimitations } : {}),
    },
    dependencies: buildDependencyFacts({
      commitSha: pin.commitSha,
      sourceFiles: discovery.sourceFiles,
      readFile,
      analysisMode: params.analysisMode ?? 'quick',
      ...(params.languageAnalysis ? { languageAnalysis: params.languageAnalysis } : {}),
      ...(params.dependencyInputs ? { manifestInputs: params.dependencyInputs } : {}),
      // Every non-root unit with its own package.json is a JS workspace member (incl. a same-dir crate).
      workspaceDirectories: discovery.units.filter(unit => unit.kind !== 'root' && unit.packageManifest).map(unit => unit.dir),
    }),
    ...(params.includeSource ? { sources: portableSourcePaths(snapshot, discovery).map(path => ({ path, text: readFile(path) })) } : {}),
    ...(enrichmentReport ? { enrichmentReport } : {}),
    ...(componentMapReport ? { componentMapReport } : {}),
  };
}

/**
 * Scan-level (not per-analyzer) limitations from source acquisition and discovery:
 * skipped symlinks/submodules and built-in test-data exclusions. Deterministic and
 * empty unless something was actually left out, so a repo without such entries keeps
 * a byte-identical bundle.
 */
export function discoveryLimitations(summary: DiscoverySummary): string[] {
  return [
    ...skippedEntryLimitations(summary.skippedEntries),
    ...(summary.excludedTestDataFiles ? [`${summary.excludedTestDataFiles} source file(s) under testdata/ directories were excluded as test data.`] : []),
    ...skippedJsLimitations(summary),
  ];
}

/** Longest repository-controlled text (a specifier, a path) shown in a limitation line. */
export const LIMITATION_TEXT_MAX_CHARS = 200;

/**
 * Repository-controlled text made safe for analysis.limitations and the terminal:
 * control characters (ANSI escapes) neutralized, bidi embedding/override/isolate
 * characters (U+202A–202E, U+2066–2069) removed so a specifier cannot reorder the
 * line around it, then capped by code point (never splitting a surrogate pair) with
 * an ellipsis so one huge specifier cannot blow up the artifact.
 */
export function displayText(text: string): string {
  const codePoints = Array.from(sanitizeControlCharacters(text).replace(/[\u202A-\u202E\u2066-\u2069]/g, ""));
  return codePoints.length > LIMITATION_TEXT_MAX_CHARS ? `${codePoints.slice(0, LIMITATION_TEXT_MAX_CHARS).join("")}…` : codePoints.join("");
}

/** At most this many unresolved imports are itemized; the rest are counted. */
export const UNRESOLVED_IMPORTS_SHOWN = 20;

/**
 * Relative imports that recorded no relation and name no file in the repository
 * listing — their dependency edge is missing from the atlas: a header line, then one
 * `path:line: 'specifier'` line each (already sorted and deduplicated), capped at
 * {@link UNRESOLVED_IMPORTS_SHOWN} with a "+N more" line so a broken repo stays
 * bounded. Scan-level (not per-adapter) because extraction — not an analyzer —
 * drops the edge, in quick and full mode alike. Empty when every import resolved.
 */
export function unresolvedImportLimitations(imports: readonly UnresolvedRelativeImport[]): string[] {
  if (imports.length === 0) return [];
  const shown = imports.slice(0, UNRESOLVED_IMPORTS_SHOWN).map(item =>
    `Unresolved relative import ${displayText(item.path)}:${item.line}: '${displayText(item.specifier)}'`);
  const hidden = imports.length - shown.length;
  return [
    `${imports.length} relative import(s) name no file in the repository; no relation was recorded for them.`,
    ...shown,
    ...(hidden > 0 ? [`+${hidden} more unresolved relative import(s) not itemized.`] : []),
  ];
}

/** The TypeScript-repo `.js` exclusions, by reason (empty when none were skipped). */
function skippedJsLimitations(summary: DiscoverySummary): string[] {
  const byReason = summary.skippedJsByReason;
  if (!summary.skippedJsFiles || !byReason) return [];
  const parts = [
    byReason.testOrVendorDirectory ? `${byReason.testOrVendorDirectory} under a test/fixture/vendor directory` : "",
    byReason.minified ? `${byReason.minified} minified (*.min.js)` : "",
    byReason.compiledSibling ? `${byReason.compiledSibling} compiled output beside a .ts/.tsx source` : "",
  ].filter(Boolean);
  return [`${summary.skippedJsFiles} .js file(s) in this TypeScript repository were not scanned: ${parts.join("; ")}.`];
}

/** Runs the local scan pipeline against an already-acquired committed tree. */
function analyzeLanguages(root: string, discovery: Discovery, mode: ScanOptions['analysisMode'], installationRoot?: string, rustIndexCacheDir?: string): LanguageAnalysis | undefined {
  if (mode !== 'full') return undefined;
  const analyses = [analyzeTypeScript(root, discovery.sourceFiles, installationRoot), analyzeRust(root, discovery.sourceFiles, rustIndexCacheDir ? { indexCacheDir: rustIndexCacheDir } : {})];
  return { schemaVersion: 1, definitions: analyses.flatMap(item => item.definitions), references: analyses.flatMap(item => item.references), modules: analyses.flatMap(item => item.modules), externalReferences: analyses.flatMap(item => item.externalReferences ?? []), coverage: analyses.flatMap(item => item.coverage) };
}

export function scanAcquiredRepository(acquired: Pick<AcquiredCommittedTree, "root" | "pin" | "sourceName" | "installationRoot"> & { skipped?: SkippedTreeEntries }, options: ScanOptions = {}): ScanArtifacts {
  const sourceRoot = acquired.root;
  const packageName = rootPackageName(sourceRoot);
  const fallbackName = acquired.sourceName;
  const repositorySlug = options.repositorySlug ?? slug(packageName ?? fallbackName);
  const systemName = options.systemName ?? packageName ?? (fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1));
  const discovery = discoverExtractedTree(sourceRoot, {
    ...(options.includeAllMembers ? { includeAllMembers: true } : {}),
    ...(acquired.skipped ? { skippedEntries: acquired.skipped } : {}),
  });
  const readFile = (repoRelativePath: string): string => readFileSync(`${sourceRoot}/${repoRelativePath}`, "utf8");
  // Read manifests/lockfiles BEFORE analyzers run: cargo/rust-analyzer may write a
  // Cargo.lock into the acquired tree, which must never be cited as committed evidence.
  const dependencyInputs = collectDependencyInputs(discovery.sourceFiles, readFile);
  const languageAnalysis = analyzeLanguages(sourceRoot, discovery, options.analysisMode, acquired.installationRoot, options.rustIndexCacheDir);
  return buildScanArtifacts({
    dependencyInputs,
    discovery,
    pin: acquired.pin,
    readFile,
    repositorySlug,
    systemName,
    ...(languageAnalysis ? { languageAnalysis } : {}),
    ...(options.analysisMode ? { analysisMode: options.analysisMode } : {}),
    ...(options.includeSource ? { includeSource: true } : {}),
    ...(options.enrichmentDocs ? { enrichmentDocs: options.enrichmentDocs } : {}),
    ...(options.componentMap ? { componentMap: options.componentMap } : {}),
    ...(options.codeSurface ? { codeSurface: options.codeSurface } : {}),
    ...(options.lcovText ? { lcovText: options.lcovText } : {}),
  });
}

/** Scans an immutable local Git revision into the full artifact set (HEAD by default). */
export function scanRepository(sourceRoot: string, options: ScanOptions = {}): ScanArtifacts {
  const acquired = acquireCommittedTree(sourceRoot, options.revision);
  try {
    return scanAcquiredRepository(acquired, options);
  } finally {
    acquired.cleanup();
  }
}

export interface GithubScanResult {
  source: GithubSourceRef;
  commitSha: string;
  artifacts: ScanArtifacts;
}

/**
 * Scans a GitHub repository by `gh:owner/repo[@ref]`: resolves the ref to an immutable
 * commit (SHA + committer date + tree SHA), fetches the codeload tarball at that SHA
 * into a temp dir, walks the extracted tree, and runs the SAME deterministic pipeline
 * as a local scan — then discards the checkout. `generatedAt` is the commit's committer
 * date (never wall-clock), so two scans of the same source at the same SHA are
 * byte-identical. Defaults `repositorySlug`/`systemName` from the repo identity; the
 * extracted `package.json` name refines the display name when present.
 */
export async function scanGithubRepository(source: GithubSourceRef, options: GithubScanOptions = {}): Promise<GithubScanResult> {
  const client = options.client ?? createDefaultGithubClient();
  const commit = await resolveGithubCommit(source, client);
  const acquired = await acquireGithubTree(source, commit.sha, client, options.maxTarballBytes);
  try {
    const readFile = (repoRelativePath: string): string => readFileSync(`${acquired.root}/${repoRelativePath}`, "utf8");
    const packageName = rootPackageName(acquired.root);
    const repositorySlug = options.repositorySlug ?? slug(`${source.owner}-${source.repo}`);
    const systemName = options.systemName ?? packageName ?? source.repo;
    const pin: RepositoryPin = { commitSha: commit.sha, treeHash: commit.treeSha, generatedAt: commit.generatedAt };
    const discovery = discoverExtractedTree(acquired.root, {
      ...(options.includeAllMembers ? { includeAllMembers: true } : {}),
      skippedEntries: acquired.skipped,
    });
    const dependencyInputs = collectDependencyInputs(discovery.sourceFiles, readFile);
    const languageAnalysis = analyzeLanguages(acquired.root, discovery, options.analysisMode, undefined, options.rustIndexCacheDir);
    if (discovery.sourceFiles.length === 0) {
      throw new Error(
        `No scannable source files in ${source.owner}/${source.repo} at ${commit.sha.slice(0, 12)}. ` +
        "The scanner extracts .ts/.tsx/.mts/.cts/.js/.mjs/.cjs/.jsx/.rs (in a TypeScript repo, test/vendor, minified and compiled .js are left out); " +
        "this looks like a repository with no TypeScript, JavaScript, or Rust sources.",
      );
    }
    // Live enrichment (M3) must run inside this window: packets read source bytes from
    // the ephemeral checkout, which the finally below discards.
    let baseExtraction: ArchitectureExtraction | undefined;
    let cyclomaticById: ReadonlyMap<string, number> | undefined;
    let clonePairs: readonly ClonePair[] | undefined;
    let unresolvedRelativeImports: readonly UnresolvedRelativeImport[] | undefined;
    let enrichmentDocs = options.enrichmentDocs;
    if ((!enrichmentDocs || enrichmentDocs.size === 0) && options.enrichWithPackets) {
      const collected = collectExtractedArchitecture({
        discovery,
        readFile,
        systemName,
        systemSlug: slug(systemName),
        ...(languageAnalysis ? { languageAnalysis } : {}),
        ...(options.codeSurface ? { codeSurface: options.codeSurface } : {}),
      });
      baseExtraction = collected.extraction;
      cyclomaticById = collected.cyclomaticById;
      clonePairs = collected.clonePairs;
      unresolvedRelativeImports = collected.unresolvedRelativeImports;
      const sidecar = loadLcovSidecar(readFile, options.lcovText);
      const coverageByCodeId = coverageByCodeIdFromEntities(baseExtraction.entities, sidecar);
      // The live provider must see the same accepted component interpretation
      // that the later merge targets. applyComponentMembership fails closed by
      // returning the immutable base extraction for an invalid map.
      const packetExtraction = options.componentMap
        ? applyComponentMembership(baseExtraction, options.componentMap).extraction
        : baseExtraction;
      const packets = buildEnrichmentPackets(packetExtraction, readFile, { coverageByCodeId });
      const generated = await options.enrichWithPackets(packets);
      enrichmentDocs = generated.size > 0 ? generated : undefined;
    }
    const artifacts = buildScanArtifacts({
      dependencyInputs,
      discovery,
      pin,
      readFile,
      repositorySlug,
      systemName,
      ...(languageAnalysis ? { languageAnalysis } : {}),
      ...(options.analysisMode ? { analysisMode: options.analysisMode } : {}),
      ...(options.includeSource ? { includeSource: true } : {}),
      ...(enrichmentDocs ? { enrichmentDocs } : {}),
      ...(options.componentMap ? { componentMap: options.componentMap } : {}),
      ...(options.codeSurface ? { codeSurface: options.codeSurface } : {}),
      ...(baseExtraction ? { baseExtraction } : {}),
      ...(cyclomaticById ? { cyclomaticById } : {}),
      ...(clonePairs && clonePairs.length ? { clonePairs } : {}),
      ...(unresolvedRelativeImports ? { unresolvedRelativeImports } : {}),
      ...(options.lcovText ? { lcovText: options.lcovText } : {}),
    });
    return { source, commitSha: commit.sha, artifacts };
  } finally {
    acquired.cleanup();
  }
}

function loadLcovSidecar(
  readFile: (repoRelativePath: string) => string,
  lcovText?: string,
): LcovSidecar | undefined {
  if (lcovText !== undefined) {
    const files = parseLcov(lcovText);
    return files.size ? { path: "--lcov", files } : undefined;
  }
  return readLcov(readFile);
}

/** Canonical, byte-stable JSON serialization (trailing newline, 2-space indent). */
export function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
