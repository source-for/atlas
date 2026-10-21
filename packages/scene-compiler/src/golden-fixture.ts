import type {
  ArchitectureEntity,
  ArchitectureRelation,
  ArchitectureSnapshot,
  ArchitectureStory,
  ArchitectureView,
  EntityKind,
  RelationKind,
  SourceExcerpt,
  SourceRef,
} from '@okie/architecture';
import { GOLDEN_SOURCE_EXCERPTS } from './golden-source-excerpts.js';
import { compareText } from '@okie/architecture';

export const GOLDEN_WORKTREE_REVISION = 'golden-worktree-okie-2026-07-14-v1';

const source = (path: string, symbol?: string, startLine?: number, endLine?: number): SourceRef => ({
  path,
  commitSha: GOLDEN_WORKTREE_REVISION,
  ...(symbol ? { symbol } : {}),
  ...(startLine !== undefined ? { startLine } : {}),
  ...(endLine !== undefined ? { endLine } : {}),
});

function entity(
  id: string,
  kind: EntityKind,
  name: string,
  responsibility: string,
  sourceRefs: SourceRef[],
  options: { parentId?: string; technology?: string[]; sourceExcerpts?: SourceExcerpt[] } = {},
): ArchitectureEntity {
  return {
    id,
    lineageId: `lineage:${id}`,
    fingerprint: `golden:${id}:v1`,
    kind,
    name,
    responsibility,
    sourceRefs,
    ...(options.sourceExcerpts?.length ? { sourceExcerpts: options.sourceExcerpts } : {}),
    ...(options.parentId ? { parentId: options.parentId } : {}),
    ...(options.technology ? { technology: options.technology } : {}),
  };
}

function relation(
  id: string,
  from: string,
  to: string,
  kind: RelationKind,
  label: string,
  evidence: SourceRef[],
  technology?: string,
): ArchitectureRelation {
  return {
    id,
    lineageId: `lineage:${id}`,
    fingerprint: `golden:${id}:v1`,
    from,
    to,
    kind,
    label,
    evidence: evidence.map(item => ({ source: item })),
    ...(technology ? { technology } : {}),
  };
}

const contextEntities: ArchitectureEntity[] = [
  entity(
    'actor:developer',
    'person',
    'Developer / maintainer',
    'Explores an unfamiliar codebase from system context to source evidence.',
    [source('README.md', 'Okie', 1, 5), source('apps/web/src/App.tsx', 'App')],
  ),
  entity(
    'system:okie',
    'softwareSystem',
    'Okie',
    'Evidence-backed architecture atlas with semantic zoom and deterministic guided stories.',
    [source('README.md', 'Okie', 1, 5), source('docs/architecture/renderer.md', 'Product boundary')],
    { technology: ['TypeScript', 'Rust', 'WebAssembly', 'wgpu'] },
  ),
  entity(
    'external:source-repository',
    'externalSystem',
    'Source repository',
    'Supplies source references used to support architecture claims.',
    [source('packages/architecture/src/model.ts', 'SourceRef'), source('packages/architecture/src/model.ts', 'Evidence')],
  ),
  entity(
    'external:browser-graphics',
    'externalSystem',
    'Browser graphics platform',
    'Provides the canvas, WebAssembly runtime, and WebGPU or WebGL2 surface used to render the atlas.',
    [source('crates/atlas-wasm/src/browser.rs', 'create_atlas_renderer'), source('apps/web/src/renderer/createRenderer.ts', 'createRenderer')],
  ),
];

const containerEntities: ArchitectureEntity[] = [
  entity(
    'container:web-app', 'container', 'Atlas web app',
    'Owns the browser shell, navigation, inspection, search, camera controls, and guided-story experience.',
    [source('apps/web/src/App.tsx', 'App'), source('apps/web/src/App.tsx', 'CanvasViewport')],
    { parentId: 'system:okie', technology: ['React', 'TypeScript'] },
  ),
  entity(
    'container:architecture-model', 'container', 'Architecture model',
    'Defines versioned architecture claims, evidence, views, hierarchy, zoom policy, and story state.',
    [source('packages/architecture/src/model.ts'), source('packages/architecture/src/normalized.ts')],
    { parentId: 'system:okie', technology: ['TypeScript'] },
  ),
  entity(
    'container:scene-compiler', 'container', 'Scene compiler',
    'Deterministically converts semantic architecture and stories into renderer scenes, patches, and timelines.',
    [source('packages/scene-compiler/src/compile-scene.ts', 'compileScene'), source('packages/scene-compiler/src/compile-story.ts', 'compileStory')],
    { parentId: 'system:okie', technology: ['TypeScript'] },
  ),
  entity(
    'container:rust-renderer', 'container', 'Rust / WASM renderer',
    'Validates, culls, hit-tests, animates, and draws scene-protocol objects through GPU-backed browser rendering.',
    [source('crates/atlas-engine/src/protocol_runtime.rs', 'ProtocolEngine'), source('crates/atlas-gpu/src/surface.rs', 'GpuRenderer')],
    { parentId: 'system:okie', technology: ['Rust', 'WebAssembly', 'wgpu'] },
  ),
  entity(
    'container:tooling', 'container', 'Build and fixture tooling',
    'Builds the WASM package and generates deterministic demo and stress fixtures.',
    [source('scripts/build-wasm.mjs'), source('scripts/generate-stress.mjs'), source('packages/scene-compiler/src/generate-fixtures.ts')],
    { parentId: 'system:okie', technology: ['Node.js', 'wasm-pack'] },
  ),
];

type ComponentDefinition = readonly [
  id: string,
  parentId: string,
  name: string,
  responsibility: string,
  sourceRefs: readonly SourceRef[],
];

const componentDefinitions: readonly ComponentDefinition[] = [
  ['component:web-shell', 'container:web-app', 'Application shell', 'Composes the canvas, level rail, search, inspector, diagnostics, and story controls.', [source('apps/web/src/App.tsx', 'App')]],
  ['component:web-navigation', 'container:web-app', 'Navigation and history', 'Canonicalizes shareable URL state and separates pushed navigation from replaced selection and camera state.', [source('apps/web/src/navigation/navigationState.ts'), source('apps/web/src/navigation/historyController.ts')]],
  ['component:web-renderer-host', 'container:web-app', 'Renderer host', 'Creates GPU or Canvas2D backends and forwards scene, camera, input, and visibility state.', [source('apps/web/src/renderer/createRenderer.ts'), source('apps/web/src/renderer/WasmRendererAdapter.ts')]],
  ['component:web-stories', 'container:web-app', 'Guided story player', 'Frames story entities, interpolates camera flights, and presents deterministic focus and flow state.', [source('apps/web/src/storyPlayback.ts'), source('apps/web/src/storyFraming.ts')]],
  ['component:web-provenance', 'container:web-app', 'Evidence presentation', 'Distinguishes observed facts, deterministic inference, and AI-authored explanation.', [source('apps/web/src/provenance/presentation.ts', 'presentClaimProvenance')]],

  ['component:model-schema', 'container:architecture-model', 'Semantic schema', 'Defines entities, relations, evidence, snapshots, views, stories, and user overrides.', [source('packages/architecture/src/model.ts')]],
  ['component:model-normalized', 'container:architecture-model', 'Normalized state', 'Stores qualified identities and indexed rows for snapshots, hierarchy, layouts, zoom bands, and stories.', [source('packages/architecture/src/normalized.ts', 'NormalizedArchitecture')]],
  ['component:model-scoping', 'container:architecture-model', 'Hierarchy selectors', 'Reconstructs snapshots and selects a view scoped to a root entity.', [source('packages/architecture/src/normalized.ts', 'selectScopedView')]],
  ['component:model-validation', 'container:architecture-model', 'Architecture validation', 'Rejects invalid snapshots, views, stories, geometry, evidence, and overrides before compilation.', [source('packages/architecture/src/validation.ts', 'validateSnapshot')]],

  ['component:compiler-scene', 'container:scene-compiler', 'Scene compilation', 'Maps visible semantic entities and relations to bounded renderer objects and paths.', [source('packages/scene-compiler/src/compile-scene.ts', 'compileScene')]],
  ['component:compiler-story', 'container:scene-compiler', 'Story compilation', 'Converts narrated focus steps into deterministic camera and emphasis keyframes.', [source('packages/scene-compiler/src/compile-story.ts', 'compileStory')]],
  ['component:compiler-normalized', 'container:scene-compiler', 'Scoped scene and patch compilation', 'Selects a root-scoped view and diffs retained scenes into revisioned patches.', [source('packages/scene-compiler/src/compile-normalized.ts', 'compileNormalizedScene')]],
  ['component:compiler-protocol', 'container:scene-compiler', 'TypeScript protocol mirror', 'Defines the TypeScript scene, patch, primitive, LOD, and timeline payloads sent to Rust.', [source('packages/scene-compiler/src/protocol.ts', 'SceneSnapshot')]],

  ['component:renderer-protocol', 'container:rust-renderer', 'Versioned renderer protocol', 'Validates scene objects, representations, paths, patches, and timelines at the Rust boundary.', [source('crates/atlas-protocol/src/scene.rs'), source('crates/atlas-protocol/src/patch.rs')]],
  ['component:renderer-engine', 'container:rust-renderer', 'Scene engine', 'Owns retained scene state, semantic LOD, visibility, camera, culling, hit testing, patches, and timeline sampling.', [source('crates/atlas-engine/src/protocol_runtime.rs', 'ProtocolEngine')]],
  ['component:renderer-gpu', 'container:rust-renderer', 'GPU renderer', 'Builds mesh and glyph data, initializes WebGPU/WebGL2, and submits visible frame geometry.', [source('crates/atlas-gpu/src/surface.rs', 'GpuRenderer')]],
  ['component:renderer-wasm', 'container:rust-renderer', 'Browser WASM bridge', 'Deserializes host payloads and exposes scene, patch, camera, visibility, picking, and timeline controls to JavaScript.', [source('crates/atlas-wasm/src/browser.rs', 'WasmAtlasRenderer')]],

  ['component:tooling-wasm', 'container:tooling', 'WASM build driver', 'Selects release, profiling, or debug wasm-pack builds and reports missing prerequisites.', [source('scripts/build-wasm.mjs')]],
  ['component:tooling-fixtures', 'container:tooling', 'Fixture generator', 'Compiles the checked semantic fixture into renderer scene and timeline JSON.', [source('packages/scene-compiler/src/generate-fixtures.ts')]],
  ['component:tooling-stress', 'container:tooling', 'Stress scene generator', 'Generates seeded large scenes for renderer profiling.', [source('scripts/generate-stress.mjs')]],
];

const componentEntities = componentDefinitions.map(([id, parentId, name, responsibility, refs]) => entity(
  id,
  'component',
  name,
  responsibility,
  [...refs],
  {
    parentId,
    technology: parentId === 'container:rust-renderer'
      ? ['Rust']
      : parentId === 'container:web-app'
        ? ['React', 'TypeScript']
        : parentId === 'container:tooling'
          ? ['Node.js', 'JavaScript']
          : ['TypeScript'],
  },
));

type AnchorDefinition = readonly [id: string, parentId: string, name: string, path: string, symbol?: string];

const anchorDefinitions: readonly AnchorDefinition[] = [
  ['code:web-shell:app', 'component:web-shell', 'App', 'apps/web/src/App.tsx', 'App'],
  ['code:web-shell:canvas-viewport', 'component:web-shell', 'CanvasViewport', 'apps/web/src/App.tsx', 'CanvasViewport'],
  ['code:web-navigation:navigation-state', 'component:web-navigation', 'NavigationState', 'apps/web/src/navigation/navigationState.ts', 'NavigationState'],
  ['code:web-navigation:canonical-url', 'component:web-navigation', 'canonicalNavigationUrl()', 'apps/web/src/navigation/navigationState.ts', 'canonicalNavigationUrl'],
  ['code:web-navigation:history-controller', 'component:web-navigation', 'createNavigationHistoryController()', 'apps/web/src/navigation/historyController.ts', 'createNavigationHistoryController'],
  ['code:web-renderer-host:create-renderer', 'component:web-renderer-host', 'createRenderer()', 'apps/web/src/renderer/createRenderer.ts', 'createRenderer'],
  ['code:web-renderer-host:wasm-adapter', 'component:web-renderer-host', 'WasmRendererAdapter', 'apps/web/src/renderer/WasmRendererAdapter.ts', 'WasmRendererAdapter'],
  ['code:web-renderer-host:canvas-renderer', 'component:web-renderer-host', 'Canvas2DRenderer', 'apps/web/src/renderer/Canvas2DRenderer.ts', 'Canvas2DRenderer'],
  ['code:web-stories:create-flight', 'component:web-stories', 'createStoryFlight()', 'apps/web/src/storyPlayback.ts', 'createStoryFlight'],
  ['code:web-stories:frame-entities', 'component:web-stories', 'frameEntities()', 'apps/web/src/storyFraming.ts', 'frameEntities'],
  ['code:web-stories:focus-presentation', 'component:web-stories', 'storyFocusPresentation()', 'apps/web/src/storyFocus.ts', 'storyFocusPresentation'],
  ['code:web-provenance:present-claim', 'component:web-provenance', 'presentClaimProvenance()', 'apps/web/src/provenance/presentation.ts', 'presentClaimProvenance'],
  ['code:model-schema:snapshot', 'component:model-schema', 'ArchitectureSnapshot', 'packages/architecture/src/model.ts', 'ArchitectureSnapshot'],
  ['code:model-schema:entity', 'component:model-schema', 'ArchitectureEntity', 'packages/architecture/src/model.ts', 'ArchitectureEntity'],
  ['code:model-schema:story', 'component:model-schema', 'ArchitectureStory', 'packages/architecture/src/model.ts', 'ArchitectureStory'],
  ['code:model-normalized:normalize', 'component:model-normalized', 'normalizeArchitecture()', 'packages/architecture/src/normalized.ts', 'normalizeArchitecture'],
  ['code:model-normalized:state', 'component:model-normalized', 'NormalizedArchitecture', 'packages/architecture/src/normalized.ts', 'NormalizedArchitecture'],
  ['code:model-scoping:select-scoped-view', 'component:model-scoping', 'selectScopedView()', 'packages/architecture/src/normalized.ts', 'selectScopedView'],
  ['code:model-scoping:select-snapshot', 'component:model-scoping', 'selectArchitectureSnapshot()', 'packages/architecture/src/normalized.ts', 'selectArchitectureSnapshot'],
  ['code:model-validation:snapshot', 'component:model-validation', 'validateSnapshot()', 'packages/architecture/src/validation.ts', 'validateSnapshot'],
  ['code:model-validation:view', 'component:model-validation', 'validateView()', 'packages/architecture/src/validation.ts', 'validateView'],
  ['code:model-validation:story', 'component:model-validation', 'validateStory()', 'packages/architecture/src/validation.ts', 'validateStory'],
  ['code:compiler-scene:compile', 'component:compiler-scene', 'compileScene()', 'packages/scene-compiler/src/compile-scene.ts', 'compileScene'],
  ['code:compiler-story:compile', 'component:compiler-story', 'compileStory()', 'packages/scene-compiler/src/compile-story.ts', 'compileStory'],
  ['code:compiler-normalized:compile-scene', 'component:compiler-normalized', 'compileNormalizedScene()', 'packages/scene-compiler/src/compile-normalized.ts', 'compileNormalizedScene'],
  ['code:compiler-normalized:diff', 'component:compiler-normalized', 'diffSceneSnapshots()', 'packages/scene-compiler/src/compile-normalized.ts', 'diffSceneSnapshots'],
  ['code:compiler-protocol:snapshot', 'component:compiler-protocol', 'SceneSnapshot', 'packages/scene-compiler/src/protocol.ts', 'SceneSnapshot'],
  ['code:compiler-protocol:timeline', 'component:compiler-protocol', 'Timeline', 'packages/scene-compiler/src/protocol.ts', 'Timeline'],
  ['code:renderer-protocol:validate-scene', 'component:renderer-protocol', 'SceneSnapshot::validate()', 'crates/atlas-protocol/src/scene.rs', 'SceneSnapshot::validate'],
  ['code:renderer-protocol:validate-patch', 'component:renderer-protocol', 'ScenePatch::validate_against()', 'crates/atlas-protocol/src/patch.rs', 'ScenePatch::validate_against'],
  ['code:renderer-engine:protocol-engine', 'component:renderer-engine', 'ProtocolEngine', 'crates/atlas-engine/src/protocol_runtime.rs', 'ProtocolEngine'],
  ['code:renderer-engine:lod-controller', 'component:renderer-engine', 'LodController', 'crates/atlas-engine/src/lod.rs', 'LodController'],
  ['code:renderer-engine:hit-test', 'component:renderer-engine', 'hit_test()', 'crates/atlas-engine/src/hit_test.rs', 'hit_test'],
  ['code:renderer-gpu:renderer', 'component:renderer-gpu', 'GpuRenderer', 'crates/atlas-gpu/src/surface.rs', 'GpuRenderer'],
  ['code:renderer-gpu:build-mesh', 'component:renderer-gpu', 'build_mesh()', 'crates/atlas-gpu/src/mesh.rs', 'build_mesh'],
  ['code:renderer-gpu:glyph-atlas', 'component:renderer-gpu', 'GlyphAtlas', 'crates/atlas-gpu/src/glyph.rs', 'GlyphAtlas'],
  ['code:renderer-wasm:atlas-renderer', 'component:renderer-wasm', 'WasmAtlasRenderer', 'crates/atlas-wasm/src/browser.rs', 'WasmAtlasRenderer'],
  ['code:renderer-wasm:create-renderer', 'component:renderer-wasm', 'createAtlasRenderer()', 'crates/atlas-wasm/src/browser.rs', 'create_atlas_renderer'],
  ['code:tooling-wasm:build-script', 'component:tooling-wasm', 'scripts/build-wasm.mjs', 'scripts/build-wasm.mjs'],
  ['code:tooling-fixtures:generator', 'component:tooling-fixtures', 'packages/scene-compiler/src/generate-fixtures.ts', 'packages/scene-compiler/src/generate-fixtures.ts'],
  ['code:tooling-stress:generator', 'component:tooling-stress', 'scripts/generate-stress.mjs', 'scripts/generate-stress.mjs'],
];

function frozenExcerpt(id: string, path: string, symbol?: string): SourceExcerpt {
  const excerpts: Readonly<Record<string, SourceExcerpt>> = GOLDEN_SOURCE_EXCERPTS;
  const excerpt = excerpts[id];
  if (!excerpt) throw new Error(`Missing frozen source excerpt for ${id}`);
  if (excerpt.path !== path || (excerpt.symbol ?? '') !== (symbol ?? '')) {
    throw new Error(`Frozen source excerpt does not match ${id}'s curated anchor`);
  }
  if (excerpt.frozenRevision !== GOLDEN_WORKTREE_REVISION) {
    throw new Error(`Frozen source excerpt for ${id} has the wrong revision`);
  }
  return { ...excerpt, lines: [...excerpt.lines] };
}

const codeEntities = anchorDefinitions.map(([id, parentId, name, path, symbol]) => {
  const excerpt = frozenExcerpt(id, path, symbol);
  return entity(
    id,
    'code',
    name,
    `Curated implementation entry point for ${componentEntities.find(component => component.id === parentId)?.name ?? parentId}.`,
    [source(path, symbol, excerpt.startLine, excerpt.endLine)],
    {
      parentId,
      sourceExcerpts: [excerpt],
      technology: path.endsWith('.rs')
        ? ['Rust']
        : path.endsWith('.tsx')
          ? ['React', 'TypeScript']
          : path.endsWith('.mjs')
            ? ['Node.js', 'JavaScript']
            : ['TypeScript'],
    },
  );
});

const contextRelations: ArchitectureRelation[] = [
  relation('relation:developer-explores-okie', 'actor:developer', 'system:okie', 'uses', 'explores architecture and source', [source('README.md', 'Okie', 1, 5)]),
  relation('relation:okie-source-evidence', 'system:okie', 'external:source-repository', 'dependsOn', 'links claims to source evidence', [source('packages/architecture/src/model.ts', 'SourceRef')]),
  relation('relation:okie-renders-browser', 'system:okie', 'external:browser-graphics', 'uses', 'renders through WASM and WebGPU/WebGL2', [source('apps/web/src/renderer/createRenderer.ts', 'createRenderer')]),
];

const containerRelations: ArchitectureRelation[] = [
  relation('relation:model-to-compiler', 'container:architecture-model', 'container:scene-compiler', 'dependsOn', 'provides snapshots, views, and stories', [source('packages/scene-compiler/src/compile-scene.ts', 'compileScene')]),
  relation('relation:compiler-to-renderer', 'container:scene-compiler', 'container:rust-renderer', 'dependsOn', 'emits protocol scenes, patches, and timelines', [source('packages/scene-compiler/src/protocol.ts')]),
  relation('relation:web-controls-renderer', 'container:web-app', 'container:rust-renderer', 'calls', 'sends scenes, camera input, visibility, and playback time', [source('apps/web/src/renderer/WasmRendererAdapter.ts', 'WasmRendererAdapter')]),
  relation('relation:tooling-builds-renderer', 'container:tooling', 'container:rust-renderer', 'dependsOn', 'builds browser WASM', [source('scripts/build-wasm.mjs')]),
  relation('relation:tooling-generates-scenes', 'container:tooling', 'container:scene-compiler', 'calls', 'generates checked deterministic fixtures', [source('packages/scene-compiler/src/generate-fixtures.ts')]),
];

const componentRelations: ArchitectureRelation[] = [
  relation('relation:web-shell-navigation', 'component:web-shell', 'component:web-navigation', 'uses', 'uses canonical navigation state', [source('apps/web/src/App.tsx', 'App')]),
  relation('relation:web-shell-renderer-host', 'component:web-shell', 'component:web-renderer-host', 'uses', 'hosts the atlas renderer', [source('apps/web/src/App.tsx', 'CanvasViewport')]),
  relation('relation:web-shell-stories', 'component:web-shell', 'component:web-stories', 'uses', 'presents guided stories', [source('apps/web/src/App.tsx', 'App')]),
  relation('relation:web-shell-provenance', 'component:web-shell', 'component:web-provenance', 'uses', 'presents source provenance', [source('apps/web/src/App.tsx', 'App')]),
  relation('relation:model-schema-normalized', 'component:model-normalized', 'component:model-schema', 'dependsOn', 'uses semantic schema types', [source('packages/architecture/src/normalized.ts', 'NormalizedArchitecture')]),
  relation('relation:model-normalized-scoping', 'component:model-scoping', 'component:model-normalized', 'uses', 'queries indexed hierarchy', [source('packages/architecture/src/normalized.ts', 'selectScopedView')]),
  relation('relation:model-validation-schema', 'component:model-validation', 'component:model-schema', 'dependsOn', 'validates semantic records', [source('packages/architecture/src/validation.ts', 'validateSnapshot')]),
  relation('relation:compiler-normalized-scene', 'component:compiler-normalized', 'component:compiler-scene', 'calls', 'compiles selected views', [source('packages/scene-compiler/src/compile-normalized.ts', 'compileNormalizedScene')]),
  relation('relation:compiler-normalized-story', 'component:compiler-normalized', 'component:compiler-story', 'calls', 'compiles selected stories', [source('packages/scene-compiler/src/compile-normalized.ts', 'compileNormalizedTimeline')]),
  relation('relation:compiler-scene-protocol', 'component:compiler-scene', 'component:compiler-protocol', 'dependsOn', 'emits scene protocol', [source('packages/scene-compiler/src/compile-scene.ts', 'compileScene')]),
  relation('relation:renderer-engine-protocol', 'component:renderer-engine', 'component:renderer-protocol', 'dependsOn', 'validates retained protocol state', [source('crates/atlas-engine/src/protocol_runtime.rs', 'ProtocolEngine')]),
  relation('relation:renderer-gpu-engine', 'component:renderer-gpu', 'component:renderer-engine', 'reads', 'draws prepared frames', [source('crates/atlas-gpu/src/surface.rs', 'GpuRenderer')]),
  relation('relation:renderer-wasm-engine', 'component:renderer-wasm', 'component:renderer-engine', 'calls', 'forwards browser commands', [source('crates/atlas-wasm/src/browser.rs', 'WasmAtlasRenderer')]),
  relation('relation:renderer-wasm-gpu', 'component:renderer-wasm', 'component:renderer-gpu', 'calls', 'submits browser frames', [source('crates/atlas-wasm/src/browser.rs', 'WasmAtlasRenderer')]),
];

const codeRelations: ArchitectureRelation[] = [
  relation('relation:code-app-navigation-url', 'code:web-shell:app', 'code:web-navigation:history-controller', 'calls', 'commits navigation through history', [source('apps/web/src/App.tsx', 'commitNavigation')]),
  relation('relation:code-app-create-renderer', 'code:web-shell:canvas-viewport', 'code:web-renderer-host:create-renderer', 'calls', 'creates the renderer', [source('apps/web/src/App.tsx', 'CanvasViewport')]),
  relation('relation:code-flight-frame', 'code:web-shell:app', 'code:web-stories:create-flight', 'calls', 'starts a deterministic camera flight', [source('apps/web/src/App.tsx', 'setStep')]),
  relation('relation:code-normalize-select-scoped', 'code:model-scoping:select-scoped-view', 'code:model-normalized:state', 'dependsOn', 'queries normalized state', [source('packages/architecture/src/normalized.ts', 'selectScopedView')]),
  relation('relation:code-select-scoped-snapshot', 'code:model-scoping:select-scoped-view', 'code:model-scoping:select-snapshot', 'calls', 'reconstructs the snapshot', [source('packages/architecture/src/normalized.ts', 'selectScopedView')]),
  relation('relation:code-validation-view-snapshot', 'code:model-validation:view', 'code:model-schema:snapshot', 'reads', 'validates snapshot references', [source('packages/architecture/src/validation.ts', 'validateView')]),
  relation('relation:code-compile-normalized-scene', 'code:compiler-normalized:compile-scene', 'code:compiler-scene:compile', 'calls', 'compiles a scoped scene', [source('packages/scene-compiler/src/compile-normalized.ts', 'compileNormalizedScene')]),
  relation('relation:code-diff-scene', 'code:compiler-normalized:diff', 'code:compiler-protocol:snapshot', 'reads', 'diffs renderer snapshots', [source('packages/scene-compiler/src/compile-normalized.ts', 'diffSceneSnapshots')]),
  relation('relation:code-engine-scene-validation', 'code:renderer-engine:protocol-engine', 'code:renderer-protocol:validate-scene', 'calls', 'validates scene input', [source('crates/atlas-engine/src/protocol_runtime.rs', 'ProtocolEngine')]),
  relation('relation:code-gpu-build-mesh', 'code:renderer-gpu:renderer', 'code:renderer-gpu:build-mesh', 'calls', 'builds retained geometry', [source('crates/atlas-gpu/src/surface.rs', 'GpuRenderer')]),
  relation('relation:code-wasm-engine', 'code:renderer-wasm:atlas-renderer', 'code:renderer-engine:protocol-engine', 'uses', 'owns the scene engine', [source('crates/atlas-wasm/src/browser.rs', 'WasmAtlasRenderer')]),
  relation('relation:code-tooling-fixture-generator', 'code:tooling-fixtures:generator', 'code:compiler-scene:compile', 'calls', 'generates checked scenes', [source('packages/scene-compiler/src/generate-fixtures.ts')]),
];

export const goldenSnapshot: ArchitectureSnapshot = {
  schemaVersion: 1,
  id: 'snapshot:okie-golden-worktree-v1',
  repositoryId: 'repo:okie-golden',
  commitSha: GOLDEN_WORKTREE_REVISION,
  generatedAt: '2026-07-14T00:00:00.000Z',
  entities: [...contextEntities, ...containerEntities, ...componentEntities, ...codeEntities],
  relations: [...contextRelations, ...containerRelations, ...componentRelations, ...codeRelations],
};

function legacyLayout(entities: readonly ArchitectureEntity[]) {
  const nodes = Object.fromEntries([...entities].sort((left, right) => compareText(left.id, right.id)).map((item, index) => [
    item.id,
    { x: 120 + index % 8 * 330, y: 120 + Math.floor(index / 8) * 210, width: 280, height: 140 },
  ]));
  return { nodes };
}

export const goldenView: ArchitectureView = {
  schemaVersion: 1,
  id: 'view:okie-golden-hierarchy',
  snapshotId: goldenSnapshot.id,
  name: 'Okie golden hierarchy',
  rootEntityId: 'system:okie',
  entityIds: goldenSnapshot.entities.map(item => item.id),
  relationIds: goldenSnapshot.relations.map(item => item.id),
  layout: legacyLayout(goldenSnapshot.entities),
};

export const goldenStory: ArchitectureStory = {
  schemaVersion: 1,
  id: 'story:okie-context-to-code',
  snapshotId: goldenSnapshot.id,
  viewId: goldenView.id,
  title: 'From Okie to selectScopedView()',
  steps: [
    {
      id: 'step:context',
      title: 'Start with Okie',
      focusEntityIds: ['system:okie'],
      traceRelationIds: ['relation:developer-explores-okie'],
      reveal: 'context',
      narration: 'Okie helps a developer move from a system overview to source evidence.',
      durationMs: 1_600,
    },
    {
      id: 'step:containers',
      title: 'Find the architecture model',
      focusEntityIds: ['container:architecture-model'],
      traceRelationIds: ['relation:model-to-compiler'],
      reveal: 'container',
      narration: 'The architecture model owns the semantic hierarchy, evidence, views, and zoom policy.',
      durationMs: 1_800,
    },
    {
      id: 'step:components',
      title: 'Open model scoping',
      focusEntityIds: ['component:model-scoping'],
      traceRelationIds: ['relation:model-normalized-scoping'],
      reveal: 'component',
      narration: 'Hierarchy selectors reconstruct immutable snapshots and select a focused subgraph.',
      durationMs: 1_800,
    },
    {
      id: 'step:code',
      title: 'Read selectScopedView()',
      focusEntityIds: ['code:model-scoping:select-scoped-view'],
      traceRelationIds: ['relation:code-select-scoped-snapshot'],
      reveal: 'code',
      narration: 'selectScopedView is the curated source entry point for drilling into one architecture scope.',
      sourceRefs: [source('packages/architecture/src/normalized.ts', 'selectScopedView')],
      durationMs: 2_000,
    },
  ],
};

export const goldenFixtureCounts = {
  entities: goldenSnapshot.entities.length,
  relations: goldenSnapshot.relations.length,
  context: contextEntities.length,
  containers: containerEntities.length,
  components: componentEntities.length,
  code: codeEntities.length,
} as const;
