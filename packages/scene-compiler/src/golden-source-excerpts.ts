import type { SourceExcerpt } from "@okie/architecture";

/** Checked source content; regenerate deliberately when the frozen revision changes. */
export const GOLDEN_SOURCE_EXCERPTS = {
  "code:compiler-normalized:compile-scene": {
    "path": "packages/scene-compiler/src/compile-normalized.ts",
    "symbol": "compileNormalizedScene",
    "language": "typescript",
    "startLine": 34,
    "endLine": 39,
    "highlightLine": 34,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function compileNormalizedScene(",
      "  state: NormalizedArchitecture,",
      "  viewId: string,",
      "  options: CompileNormalizedSceneOptions = {},",
      "): SceneSnapshot {",
      "  const view = options.rootEntityId"
    ],
    "text": "export function compileNormalizedScene(\n  state: NormalizedArchitecture,\n  viewId: string,\n  options: CompileNormalizedSceneOptions = {},\n): SceneSnapshot {\n  const view = options.rootEntityId"
  },
  "code:compiler-normalized:diff": {
    "path": "packages/scene-compiler/src/compile-normalized.ts",
    "symbol": "diffSceneSnapshots",
    "language": "typescript",
    "startLine": 59,
    "endLine": 64,
    "highlightLine": 59,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function diffSceneSnapshots(",
      "  current: SceneSnapshot,",
      "  target: SceneSnapshot,",
      "  transition?: { durationMs: number; easing: Easing },",
      "): ScenePatch {",
      "  if (current.sceneId !== target.sceneId) throw new Error('Cannot diff snapshots from different scenes');"
    ],
    "text": "export function diffSceneSnapshots(\n  current: SceneSnapshot,\n  target: SceneSnapshot,\n  transition?: { durationMs: number; easing: Easing },\n): ScenePatch {\n  if (current.sceneId !== target.sceneId) throw new Error('Cannot diff snapshots from different scenes');"
  },
  "code:compiler-protocol:snapshot": {
    "path": "packages/scene-compiler/src/protocol.ts",
    "symbol": "SceneSnapshot",
    "language": "typescript",
    "startLine": 72,
    "endLine": 77,
    "highlightLine": 72,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export interface SceneSnapshot {",
      "  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;",
      "  sceneId: string;",
      "  revision: number;",
      "  worldBounds: Rect;",
      "  objects: SceneObject[];"
    ],
    "text": "export interface SceneSnapshot {\n  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;\n  sceneId: string;\n  revision: number;\n  worldBounds: Rect;\n  objects: SceneObject[];"
  },
  "code:compiler-protocol:timeline": {
    "path": "packages/scene-compiler/src/protocol.ts",
    "symbol": "Timeline",
    "language": "typescript",
    "startLine": 119,
    "endLine": 124,
    "highlightLine": 119,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export interface Timeline {",
      "  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;",
      "  timelineVersion: 2;",
      "  id: string;",
      "  sceneId: string;",
      "  durationMs: number;"
    ],
    "text": "export interface Timeline {\n  protocolVersion: typeof RENDERER_PROTOCOL_VERSION;\n  timelineVersion: 2;\n  id: string;\n  sceneId: string;\n  durationMs: number;"
  },
  "code:compiler-scene:compile": {
    "path": "packages/scene-compiler/src/compile-scene.ts",
    "symbol": "compileScene",
    "language": "typescript",
    "startLine": 169,
    "endLine": 174,
    "highlightLine": 169,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function compileScene(",
      "  snapshot: ArchitectureSnapshot,",
      "  view: ArchitectureView,",
      "  options: CompileSceneOptions = {},",
      "): SceneSnapshot {",
      "  const issues = [...validateSnapshot(snapshot), ...validateView(snapshot, view)];"
    ],
    "text": "export function compileScene(\n  snapshot: ArchitectureSnapshot,\n  view: ArchitectureView,\n  options: CompileSceneOptions = {},\n): SceneSnapshot {\n  const issues = [...validateSnapshot(snapshot), ...validateView(snapshot, view)];"
  },
  "code:compiler-story:compile": {
    "path": "packages/scene-compiler/src/compile-story.ts",
    "symbol": "compileStory",
    "language": "typescript",
    "startLine": 80,
    "endLine": 85,
    "highlightLine": 80,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function compileStory(",
      "  snapshot: ArchitectureSnapshot,",
      "  view: ArchitectureView,",
      "  story: ArchitectureStory,",
      "  scene: SceneSnapshot,",
      "  options: CompileStoryOptions = {},"
    ],
    "text": "export function compileStory(\n  snapshot: ArchitectureSnapshot,\n  view: ArchitectureView,\n  story: ArchitectureStory,\n  scene: SceneSnapshot,\n  options: CompileStoryOptions = {},"
  },
  "code:model-normalized:normalize": {
    "path": "packages/architecture/src/normalized.ts",
    "symbol": "normalizeArchitecture",
    "language": "typescript",
    "startLine": 219,
    "endLine": 224,
    "highlightLine": 219,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function normalizeArchitecture({ snapshot, views = [], stories = [] }: NormalizeArchitectureInput): NormalizedArchitecture {",
      "  const repositoryById: Record<string, NormalizedRepository> = {",
      "    [snapshot.repositoryId]: {",
      "      id: snapshot.repositoryId,",
      "      latestSnapshot: ident('snapshot', snapshot.id),",
      "    },"
    ],
    "text": "export function normalizeArchitecture({ snapshot, views = [], stories = [] }: NormalizeArchitectureInput): NormalizedArchitecture {\n  const repositoryById: Record<string, NormalizedRepository> = {\n    [snapshot.repositoryId]: {\n      id: snapshot.repositoryId,\n      latestSnapshot: ident('snapshot', snapshot.id),\n    },"
  },
  "code:model-normalized:state": {
    "path": "packages/architecture/src/normalized.ts",
    "symbol": "NormalizedArchitecture",
    "language": "typescript",
    "startLine": 148,
    "endLine": 153,
    "highlightLine": 148,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export type NormalizedArchitecture = {",
      "  schemaVersion: typeof NORMALIZED_ARCHITECTURE_VERSION;",
      "  repositoryById: Record<string, NormalizedRepository>;",
      "  snapshotById: Record<string, NormalizedSnapshot>;",
      "  entityById: Record<string, NormalizedEntity>;",
      "  relationById: Record<string, NormalizedRelation>;"
    ],
    "text": "export type NormalizedArchitecture = {\n  schemaVersion: typeof NORMALIZED_ARCHITECTURE_VERSION;\n  repositoryById: Record<string, NormalizedRepository>;\n  snapshotById: Record<string, NormalizedSnapshot>;\n  entityById: Record<string, NormalizedEntity>;\n  relationById: Record<string, NormalizedRelation>;"
  },
  "code:model-schema:entity": {
    "path": "packages/architecture/src/model.ts",
    "symbol": "ArchitectureEntity",
    "language": "typescript",
    "startLine": 106,
    "endLine": 111,
    "highlightLine": 106,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export interface ArchitectureEntity {",
      "  id: EntityId;",
      "  /** Stable semantic identity used to reconcile this entity across immutable snapshots. */",
      "  lineageId?: string;",
      "  kind: EntityKind;",
      "  parentId?: EntityId;"
    ],
    "text": "export interface ArchitectureEntity {\n  id: EntityId;\n  /** Stable semantic identity used to reconcile this entity across immutable snapshots. */\n  lineageId?: string;\n  kind: EntityKind;\n  parentId?: EntityId;"
  },
  "code:model-schema:snapshot": {
    "path": "packages/architecture/src/model.ts",
    "symbol": "ArchitectureSnapshot",
    "language": "typescript",
    "startLine": 168,
    "endLine": 173,
    "highlightLine": 168,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export interface ArchitectureSnapshot {",
      "  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;",
      "  id: SnapshotId;",
      "  repositoryId: string;",
      "  commitSha: string;",
      "  generatedAt: string;"
    ],
    "text": "export interface ArchitectureSnapshot {\n  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;\n  id: SnapshotId;\n  repositoryId: string;\n  commitSha: string;\n  generatedAt: string;"
  },
  "code:model-schema:story": {
    "path": "packages/architecture/src/model.ts",
    "symbol": "ArchitectureStory",
    "language": "typescript",
    "startLine": 237,
    "endLine": 242,
    "highlightLine": 237,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export interface ArchitectureStory {",
      "  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;",
      "  id: StoryId;",
      "  snapshotId: SnapshotId;",
      "  viewId: ViewId;",
      "  title: string;"
    ],
    "text": "export interface ArchitectureStory {\n  schemaVersion: typeof ARCHITECTURE_SCHEMA_VERSION;\n  id: StoryId;\n  snapshotId: SnapshotId;\n  viewId: ViewId;\n  title: string;"
  },
  "code:model-scoping:select-scoped-view": {
    "path": "packages/architecture/src/normalized.ts",
    "symbol": "selectScopedView",
    "language": "typescript",
    "startLine": 600,
    "endLine": 605,
    "highlightLine": 600,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function selectScopedView(state: NormalizedArchitecture, viewId: string, rootEntityId: string): ArchitectureView {",
      "  const view = selectArchitectureView(state, viewId);",
      "  const snapshot = selectArchitectureSnapshot(state, view.snapshotId);",
      "  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));",
      "  if (!view.entityIds.includes(rootEntityId)) throw new Error(`Root ${rootEntityId} is outside normalized view ${viewId}`);",
      "  const included = new Set<string>([rootEntityId]);"
    ],
    "text": "export function selectScopedView(state: NormalizedArchitecture, viewId: string, rootEntityId: string): ArchitectureView {\n  const view = selectArchitectureView(state, viewId);\n  const snapshot = selectArchitectureSnapshot(state, view.snapshotId);\n  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));\n  if (!view.entityIds.includes(rootEntityId)) throw new Error(`Root ${rootEntityId} is outside normalized view ${viewId}`);\n  const included = new Set<string>([rootEntityId]);"
  },
  "code:model-scoping:select-snapshot": {
    "path": "packages/architecture/src/normalized.ts",
    "symbol": "selectArchitectureSnapshot",
    "language": "typescript",
    "startLine": 471,
    "endLine": 476,
    "highlightLine": 471,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function selectArchitectureSnapshot(state: NormalizedArchitecture, snapshotId: string): ArchitectureSnapshot {",
      "  const snapshot = state.snapshotById[snapshotId];",
      "  if (!snapshot) throw new Error(`Unknown normalized snapshot ${snapshotId}`);",
      "  const entities: ArchitectureEntity[] = snapshot.entities.map(([, id]) => {",
      "    const entity = state.entityById[id];",
      "    if (!entity) throw new Error(`Missing normalized entity ${id}`);"
    ],
    "text": "export function selectArchitectureSnapshot(state: NormalizedArchitecture, snapshotId: string): ArchitectureSnapshot {\n  const snapshot = state.snapshotById[snapshotId];\n  if (!snapshot) throw new Error(`Unknown normalized snapshot ${snapshotId}`);\n  const entities: ArchitectureEntity[] = snapshot.entities.map(([, id]) => {\n    const entity = state.entityById[id];\n    if (!entity) throw new Error(`Missing normalized entity ${id}`);"
  },
  "code:model-validation:snapshot": {
    "path": "packages/architecture/src/validation.ts",
    "symbol": "validateSnapshot",
    "language": "typescript",
    "startLine": 180,
    "endLine": 185,
    "highlightLine": 180,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function validateSnapshot(snapshot: ArchitectureSnapshot): ValidationIssue[] {",
      "  const issues: ValidationIssue[] = [];",
      "  if (snapshot.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) {",
      "    issues.push({ path: \"schemaVersion\", message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });",
      "  }",
      ""
    ],
    "text": "export function validateSnapshot(snapshot: ArchitectureSnapshot): ValidationIssue[] {\n  const issues: ValidationIssue[] = [];\n  if (snapshot.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) {\n    issues.push({ path: \"schemaVersion\", message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });\n  }\n"
  },
  "code:model-validation:story": {
    "path": "packages/architecture/src/validation.ts",
    "symbol": "validateStory",
    "language": "typescript",
    "startLine": 633,
    "endLine": 638,
    "highlightLine": 633,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function validateStory(snapshot: ArchitectureSnapshot, view: ArchitectureView, story: ArchitectureStory): ValidationIssue[] {",
      "  return validateStoryDocument(snapshot, view, story);",
      "}",
      "",
      "export function validateOverrides(overrides: ArchitectureOverrides): ValidationIssue[] {",
      "  const issues: ValidationIssue[] = [];"
    ],
    "text": "export function validateStory(snapshot: ArchitectureSnapshot, view: ArchitectureView, story: ArchitectureStory): ValidationIssue[] {\n  return validateStoryDocument(snapshot, view, story);\n}\n\nexport function validateOverrides(overrides: ArchitectureOverrides): ValidationIssue[] {\n  const issues: ValidationIssue[] = [];"
  },
  "code:model-validation:view": {
    "path": "packages/architecture/src/validation.ts",
    "symbol": "validateView",
    "language": "typescript",
    "startLine": 357,
    "endLine": 362,
    "highlightLine": 357,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function validateView(snapshot: ArchitectureSnapshot, view: ArchitectureView): ValidationIssue[] {",
      "  const issues: ValidationIssue[] = [];",
      "  if (view.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) issues.push({ path: \"schemaVersion\", message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });",
      "  if (view.snapshotId !== snapshot.id) issues.push({ path: \"snapshotId\", message: \"does not match snapshot\" });",
      "  const entityIds = new Set(snapshot.entities.map((entity) => entity.id));",
      "  const relationById = new Map<string, ArchitectureSnapshot[\"relations\"][number]>();"
    ],
    "text": "export function validateView(snapshot: ArchitectureSnapshot, view: ArchitectureView): ValidationIssue[] {\n  const issues: ValidationIssue[] = [];\n  if (view.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) issues.push({ path: \"schemaVersion\", message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });\n  if (view.snapshotId !== snapshot.id) issues.push({ path: \"snapshotId\", message: \"does not match snapshot\" });\n  const entityIds = new Set(snapshot.entities.map((entity) => entity.id));\n  const relationById = new Map<string, ArchitectureSnapshot[\"relations\"][number]>();"
  },
  "code:renderer-engine:hit-test": {
    "path": "crates/atlas-engine/src/hit_test.rs",
    "symbol": "hit_test",
    "language": "rust",
    "startLine": 22,
    "endLine": 27,
    "highlightLine": 22,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "pub fn hit_test(",
      "    scene: &Scene,",
      "    camera: &Camera,",
      "    level: SemanticLevel,",
      "    screen_point: Vec2,",
      "    tolerance_px: f64,"
    ],
    "text": "pub fn hit_test(\n    scene: &Scene,\n    camera: &Camera,\n    level: SemanticLevel,\n    screen_point: Vec2,\n    tolerance_px: f64,"
  },
  "code:renderer-engine:lod-controller": {
    "path": "crates/atlas-engine/src/lod.rs",
    "symbol": "LodController",
    "language": "rust",
    "startLine": 91,
    "endLine": 96,
    "highlightLine": 91,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "pub struct LodController {",
      "    thresholds: LodThresholds,",
      "    current: SemanticLevel,",
      "    previous: Option<SemanticLevel>,",
      "    transition_started_ms: f64,",
      "}"
    ],
    "text": "pub struct LodController {\n    thresholds: LodThresholds,\n    current: SemanticLevel,\n    previous: Option<SemanticLevel>,\n    transition_started_ms: f64,\n}"
  },
  "code:renderer-engine:protocol-engine": {
    "path": "crates/atlas-engine/src/protocol_runtime.rs",
    "symbol": "ProtocolEngine",
    "language": "rust",
    "startLine": 747,
    "endLine": 752,
    "highlightLine": 747,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "pub struct ProtocolEngine {",
      "    snapshot: SceneSnapshot,",
      "    camera: Camera,",
      "    lod: ProtocolLodState,",
      "    selected: Option<HitTarget>,",
      "    timeline: Option<ProtocolTimelinePlayer>,"
    ],
    "text": "pub struct ProtocolEngine {\n    snapshot: SceneSnapshot,\n    camera: Camera,\n    lod: ProtocolLodState,\n    selected: Option<HitTarget>,\n    timeline: Option<ProtocolTimelinePlayer>,"
  },
  "code:renderer-gpu:build-mesh": {
    "path": "crates/atlas-gpu/src/mesh.rs",
    "symbol": "build_mesh",
    "language": "rust",
    "startLine": 150,
    "endLine": 155,
    "highlightLine": 150,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "pub fn build_mesh(snapshot: &SceneSnapshot, glyph_atlas: &GlyphAtlas) -> GpuMesh {",
      "    let mut builder = MeshBuilder::with_capacity(",
      "        snapshot.paths.len().saturating_mul(12) + snapshot.objects.len().saturating_mul(192),",
      "    );",
      "    let mut style_spans = Vec::with_capacity(snapshot.paths.len() + snapshot.objects.len() * 4);",
      "    let mut path_style_spans = vec![Vec::new(); snapshot.paths.len()];"
    ],
    "text": "pub fn build_mesh(snapshot: &SceneSnapshot, glyph_atlas: &GlyphAtlas) -> GpuMesh {\n    let mut builder = MeshBuilder::with_capacity(\n        snapshot.paths.len().saturating_mul(12) + snapshot.objects.len().saturating_mul(192),\n    );\n    let mut style_spans = Vec::with_capacity(snapshot.paths.len() + snapshot.objects.len() * 4);\n    let mut path_style_spans = vec![Vec::new(); snapshot.paths.len()];"
  },
  "code:renderer-gpu:glyph-atlas": {
    "path": "crates/atlas-gpu/src/glyph.rs",
    "symbol": "GlyphAtlas",
    "language": "rust",
    "startLine": 157,
    "endLine": 162,
    "highlightLine": 157,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "pub struct GlyphAtlas {",
      "    width: u32,",
      "    height: u32,",
      "    pixels: Vec<u8>,",
      "    metrics: Vec<GlyphMetric>,",
      "}"
    ],
    "text": "pub struct GlyphAtlas {\n    width: u32,\n    height: u32,\n    pixels: Vec<u8>,\n    metrics: Vec<GlyphMetric>,\n}"
  },
  "code:renderer-gpu:renderer": {
    "path": "crates/atlas-gpu/src/surface.rs",
    "symbol": "GpuRenderer",
    "language": "rust",
    "startLine": 230,
    "endLine": 235,
    "highlightLine": 230,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "pub struct GpuRenderer {",
      "    _instance: wgpu::Instance,",
      "    surface: wgpu::Surface<'static>,",
      "    adapter_info: wgpu::AdapterInfo,",
      "    device: wgpu::Device,",
      "    queue: wgpu::Queue,"
    ],
    "text": "pub struct GpuRenderer {\n    _instance: wgpu::Instance,\n    surface: wgpu::Surface<'static>,\n    adapter_info: wgpu::AdapterInfo,\n    device: wgpu::Device,\n    queue: wgpu::Queue,"
  },
  "code:renderer-protocol:validate-patch": {
    "path": "crates/atlas-protocol/src/patch.rs",
    "symbol": "ScenePatch::validate_against",
    "language": "rust",
    "startLine": 44,
    "endLine": 49,
    "highlightLine": 44,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "    pub fn validate_against(&self, scene: &SceneSnapshot) -> Result<(), ProtocolError> {",
      "        if self.protocol_version != PROTOCOL_VERSION {",
      "            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));",
      "        }",
      "        if self.scene_id != scene.scene_id {",
      "            return Err(ProtocolError::SceneMismatch {"
    ],
    "text": "    pub fn validate_against(&self, scene: &SceneSnapshot) -> Result<(), ProtocolError> {\n        if self.protocol_version != PROTOCOL_VERSION {\n            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));\n        }\n        if self.scene_id != scene.scene_id {\n            return Err(ProtocolError::SceneMismatch {"
  },
  "code:renderer-protocol:validate-scene": {
    "path": "crates/atlas-protocol/src/scene.rs",
    "symbol": "SceneSnapshot::validate",
    "language": "rust",
    "startLine": 237,
    "endLine": 242,
    "highlightLine": 237,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "    pub fn validate(&self) -> Result<(), ProtocolError> {",
      "        if self.protocol_version != PROTOCOL_VERSION {",
      "            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));",
      "        }",
      "        if !self.world_bounds.is_valid() {",
      "            return Err(ProtocolError::InvalidBounds(\"worldBounds\".into()));"
    ],
    "text": "    pub fn validate(&self) -> Result<(), ProtocolError> {\n        if self.protocol_version != PROTOCOL_VERSION {\n            return Err(ProtocolError::UnsupportedVersion(self.protocol_version));\n        }\n        if !self.world_bounds.is_valid() {\n            return Err(ProtocolError::InvalidBounds(\"worldBounds\".into()));"
  },
  "code:renderer-wasm:atlas-renderer": {
    "path": "crates/atlas-wasm/src/browser.rs",
    "symbol": "WasmAtlasRenderer",
    "language": "rust",
    "startLine": 13,
    "endLine": 18,
    "highlightLine": 13,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "pub struct WasmAtlasRenderer {",
      "    canvas: HtmlCanvasElement,",
      "    gpu: Option<GpuRenderer>,",
      "    engine: Option<ProtocolEngine>,",
      "    requested_backend: String,",
      "    viewport: Viewport,"
    ],
    "text": "pub struct WasmAtlasRenderer {\n    canvas: HtmlCanvasElement,\n    gpu: Option<GpuRenderer>,\n    engine: Option<ProtocolEngine>,\n    requested_backend: String,\n    viewport: Viewport,"
  },
  "code:renderer-wasm:create-renderer": {
    "path": "crates/atlas-wasm/src/browser.rs",
    "symbol": "create_atlas_renderer",
    "language": "rust",
    "startLine": 46,
    "endLine": 51,
    "highlightLine": 46,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "pub async fn create_atlas_renderer(",
      "    canvas: HtmlCanvasElement,",
      "    requested_backend: String,",
      ") -> Result<WasmAtlasRenderer, JsValue> {",
      "    console_error_panic_hook::set_once();",
      "    let preference = BackendPreference::from_query(Some(&requested_backend));"
    ],
    "text": "pub async fn create_atlas_renderer(\n    canvas: HtmlCanvasElement,\n    requested_backend: String,\n) -> Result<WasmAtlasRenderer, JsValue> {\n    console_error_panic_hook::set_once();\n    let preference = BackendPreference::from_query(Some(&requested_backend));"
  },
  "code:tooling-fixtures:generator": {
    "path": "packages/scene-compiler/src/generate-fixtures.ts",
    "language": "typescript",
    "startLine": 1,
    "endLine": 6,
    "highlightLine": 1,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "import { readFile, writeFile } from 'node:fs/promises';",
      "import { fileURLToPath } from 'node:url';",
      "import { buildC4ProjectionBundle, validateSnapshot } from '@okie/architecture';",
      "import { compileC4Scene, compileC4Timeline } from './compile-c4.js';",
      "import { goldenSnapshot, goldenStory, goldenView } from './golden-fixture.js';",
      ""
    ],
    "text": "import { readFile, writeFile } from 'node:fs/promises';\nimport { fileURLToPath } from 'node:url';\nimport { buildC4ProjectionBundle, validateSnapshot } from '@okie/architecture';\nimport { compileC4Scene, compileC4Timeline } from './compile-c4.js';\nimport { goldenSnapshot, goldenStory, goldenView } from './golden-fixture.js';\n"
  },
  "code:tooling-stress:generator": {
    "path": "scripts/generate-stress.mjs",
    "language": "javascript",
    "startLine": 1,
    "endLine": 6,
    "highlightLine": 1,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "#!/usr/bin/env node",
      "import { mkdir, writeFile } from \"node:fs/promises\";",
      "import { dirname, resolve } from \"node:path\";",
      "",
      "function readInteger(name, fallback) {",
      "  const index = process.argv.indexOf(`--${name}`);"
    ],
    "text": "#!/usr/bin/env node\nimport { mkdir, writeFile } from \"node:fs/promises\";\nimport { dirname, resolve } from \"node:path\";\n\nfunction readInteger(name, fallback) {\n  const index = process.argv.indexOf(`--${name}`);"
  },
  "code:tooling-wasm:build-script": {
    "path": "scripts/build-wasm.mjs",
    "language": "javascript",
    "startLine": 1,
    "endLine": 6,
    "highlightLine": 1,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "#!/usr/bin/env node",
      "import { spawnSync } from \"node:child_process\";",
      "",
      "const release = process.argv.includes(\"--release\");",
      "const debug = process.argv.includes(\"--debug\");",
      "if (release && debug) {"
    ],
    "text": "#!/usr/bin/env node\nimport { spawnSync } from \"node:child_process\";\n\nconst release = process.argv.includes(\"--release\");\nconst debug = process.argv.includes(\"--debug\");\nif (release && debug) {"
  },
  "code:web-navigation:canonical-url": {
    "path": "apps/web/src/navigation/navigationState.ts",
    "symbol": "canonicalNavigationUrl",
    "language": "typescript",
    "startLine": 187,
    "endLine": 192,
    "highlightLine": 187,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function canonicalNavigationUrl(",
      "  value: NavigationState,",
      "  baseUrl: string | URL = window.location.href,",
      "  options: NavigationUrlOptions = {},",
      ") {",
      "  assertWritableId(value.repositoryId, 'repository ID');"
    ],
    "text": "export function canonicalNavigationUrl(\n  value: NavigationState,\n  baseUrl: string | URL = window.location.href,\n  options: NavigationUrlOptions = {},\n) {\n  assertWritableId(value.repositoryId, 'repository ID');"
  },
  "code:web-navigation:history-controller": {
    "path": "apps/web/src/navigation/historyController.ts",
    "symbol": "createNavigationHistoryController",
    "language": "typescript",
    "startLine": 93,
    "endLine": 98,
    "highlightLine": 93,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function createNavigationHistoryController(options: NavigationHistoryOptions): NavigationHistoryController {",
      "  const adapter = options.adapter ?? browserAdapter();",
      "  void options.cameraCoalesceMs;",
      "  let state = canonicalNavigationState({}, options.defaults);",
      "  let settledEpoch = 0;",
      "  let restoreGeneration = 0;"
    ],
    "text": "export function createNavigationHistoryController(options: NavigationHistoryOptions): NavigationHistoryController {\n  const adapter = options.adapter ?? browserAdapter();\n  void options.cameraCoalesceMs;\n  let state = canonicalNavigationState({}, options.defaults);\n  let settledEpoch = 0;\n  let restoreGeneration = 0;"
  },
  "code:web-navigation:navigation-state": {
    "path": "apps/web/src/navigation/navigationState.ts",
    "symbol": "NavigationState",
    "language": "typescript",
    "startLine": 26,
    "endLine": 31,
    "highlightLine": 26,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export type NavigationState = {",
      "  version: typeof NAVIGATION_URL_VERSION;",
      "  repositoryId: string;",
      "  snapshotId: string;",
      "  viewId: string;",
      "  rootEntityId: string;"
    ],
    "text": "export type NavigationState = {\n  version: typeof NAVIGATION_URL_VERSION;\n  repositoryId: string;\n  snapshotId: string;\n  viewId: string;\n  rootEntityId: string;"
  },
  "code:web-provenance:present-claim": {
    "path": "apps/web/src/provenance/presentation.ts",
    "symbol": "presentClaimProvenance",
    "language": "typescript",
    "startLine": 40,
    "endLine": 45,
    "highlightLine": 40,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function presentClaimProvenance(value: ClaimProvenance): ClaimProvenancePresentation {",
      "  const count = normalizedEvidenceCount(value.evidenceCount);",
      "  const evidence = evidenceLabel(count);",
      "",
      "  if (value.origin === 'observed') {",
      "    const description = value.commitPinned"
    ],
    "text": "export function presentClaimProvenance(value: ClaimProvenance): ClaimProvenancePresentation {\n  const count = normalizedEvidenceCount(value.evidenceCount);\n  const evidence = evidenceLabel(count);\n\n  if (value.origin === 'observed') {\n    const description = value.commitPinned"
  },
  "code:web-renderer-host:canvas-renderer": {
    "path": "apps/web/src/renderer/Canvas2DRenderer.ts",
    "symbol": "Canvas2DRenderer",
    "language": "typescript",
    "startLine": 144,
    "endLine": 149,
    "highlightLine": 144,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export class Canvas2DRenderer implements AtlasRenderer {",
      "  readonly kind = 'canvas2d-preview';",
      "  private context: CanvasRenderingContext2D;",
      "  private scene?: AtlasScene;",
      "  private camera: Camera = { x: 0, y: 0, zoom: 0.72 };",
      "  private state: RenderState = { focusedIds: new Set(), activeRelationIds: new Set(), flowRelationIds: new Set(), reduceMotion: false, animate: false, visibilityMode: 'all' };"
    ],
    "text": "export class Canvas2DRenderer implements AtlasRenderer {\n  readonly kind = 'canvas2d-preview';\n  private context: CanvasRenderingContext2D;\n  private scene?: AtlasScene;\n  private camera: Camera = { x: 0, y: 0, zoom: 0.72 };\n  private state: RenderState = { focusedIds: new Set(), activeRelationIds: new Set(), flowRelationIds: new Set(), reduceMotion: false, animate: false, visibilityMode: 'all' };"
  },
  "code:web-renderer-host:create-renderer": {
    "path": "apps/web/src/renderer/createRenderer.ts",
    "symbol": "createRenderer",
    "language": "typescript",
    "startLine": 27,
    "endLine": 32,
    "highlightLine": 27,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export async function createRenderer(host: HTMLElement, requestedBackend: string, signal?: AbortSignal): Promise<RendererSession> {",
      "  if (requestedBackend === 'canvas2d') return createCanvasFallback(host, requestedBackend);",
      "",
      "  const attemptGpu = async (backend: 'webgpu' | 'webgl2') => {",
      "    // Context choice is permanent for a canvas. Every GPU attempt receives a",
      "    // node that has never been passed to another backend."
    ],
    "text": "export async function createRenderer(host: HTMLElement, requestedBackend: string, signal?: AbortSignal): Promise<RendererSession> {\n  if (requestedBackend === 'canvas2d') return createCanvasFallback(host, requestedBackend);\n\n  const attemptGpu = async (backend: 'webgpu' | 'webgl2') => {\n    // Context choice is permanent for a canvas. Every GPU attempt receives a\n    // node that has never been passed to another backend."
  },
  "code:web-renderer-host:wasm-adapter": {
    "path": "apps/web/src/renderer/WasmRendererAdapter.ts",
    "symbol": "WasmRendererAdapter",
    "language": "typescript",
    "startLine": 32,
    "endLine": 37,
    "highlightLine": 32,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export class WasmRendererAdapter implements AtlasRenderer {",
      "  private scene?: AtlasScene;",
      "  private protocolSceneId = '';",
      "  private camera?: Camera;",
      "  private renderStateKey = '';",
      "  private transitionPositionMs = -1;"
    ],
    "text": "export class WasmRendererAdapter implements AtlasRenderer {\n  private scene?: AtlasScene;\n  private protocolSceneId = '';\n  private camera?: Camera;\n  private renderStateKey = '';\n  private transitionPositionMs = -1;"
  },
  "code:web-shell:app": {
    "path": "apps/web/src/App.tsx",
    "symbol": "App",
    "language": "tsx",
    "startLine": 1438,
    "endLine": 1443,
    "highlightLine": 1438,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function App() {",
      "  const query = useMemo(() => readDemoQuery(window.location.search), []);",
      "  const draftPreviewContext = getDraftPreviewContext();",
      "  const initialCameraExplicit = useMemo(() => {",
      "    const params = new URLSearchParams(window.location.search);",
      "    return params.has('cx') || params.has('cy') || params.has('z');"
    ],
    "text": "export function App() {\n  const query = useMemo(() => readDemoQuery(window.location.search), []);\n  const draftPreviewContext = getDraftPreviewContext();\n  const initialCameraExplicit = useMemo(() => {\n    const params = new URLSearchParams(window.location.search);\n    return params.has('cx') || params.has('cy') || params.has('z');"
  },
  "code:web-shell:canvas-viewport": {
    "path": "apps/web/src/App.tsx",
    "symbol": "CanvasViewport",
    "language": "tsx",
    "startLine": 5966,
    "endLine": 5971,
    "highlightLine": 5966,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "          <CanvasViewport",
      "            cameraPublicationGuard={cameraPublicationGuardRef.current}",
      "            inspectorFlightCameraRef={inspectorFlightCameraRef}",
      "            semanticRenderPacketRef={semanticRenderPacketRef}",
      "            semanticLensSession={semanticLensSession}",
      "            activeRelationIds={activeRelationIds}"
    ],
    "text": "          <CanvasViewport\n            cameraPublicationGuard={cameraPublicationGuardRef.current}\n            inspectorFlightCameraRef={inspectorFlightCameraRef}\n            semanticRenderPacketRef={semanticRenderPacketRef}\n            semanticLensSession={semanticLensSession}\n            activeRelationIds={activeRelationIds}"
  },
  "code:web-stories:create-flight": {
    "path": "apps/web/src/storyPlayback.ts",
    "symbol": "createStoryFlight",
    "language": "typescript",
    "startLine": 141,
    "endLine": 146,
    "highlightLine": 141,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function createStoryFlight(",
      "  source: Camera,",
      "  target: Camera,",
      "  viewport: StoryViewport,",
      "  nowMs: number,",
      "  options: {"
    ],
    "text": "export function createStoryFlight(\n  source: Camera,\n  target: Camera,\n  viewport: StoryViewport,\n  nowMs: number,\n  options: {"
  },
  "code:web-stories:focus-presentation": {
    "path": "apps/web/src/storyFocus.ts",
    "symbol": "storyFocusPresentation",
    "language": "typescript",
    "startLine": 8,
    "endLine": 13,
    "highlightLine": 8,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function storyFocusPresentation(",
      "  selectedId: string,",
      "  targetIds: readonly string[],",
      "  targetRelationIds: readonly string[],",
      "  options: {",
      "    storyOpen: boolean;"
    ],
    "text": "export function storyFocusPresentation(\n  selectedId: string,\n  targetIds: readonly string[],\n  targetRelationIds: readonly string[],\n  options: {\n    storyOpen: boolean;"
  },
  "code:web-stories:frame-entities": {
    "path": "apps/web/src/storyFraming.ts",
    "symbol": "frameEntities",
    "language": "typescript",
    "startLine": 119,
    "endLine": 124,
    "highlightLine": 119,
    "frozenRevision": "golden-worktree-okie-2026-07-14-v1",
    "lines": [
      "export function frameEntities(",
      "  scene: AtlasScene,",
      "  entityIds: readonly string[],",
      "  viewport: ViewportSize,",
      "  safeArea = storySafeArea(viewport),",
      "  options: FrameEntitiesOptions = {},"
    ],
    "text": "export function frameEntities(\n  scene: AtlasScene,\n  entityIds: readonly string[],\n  viewport: ViewportSize,\n  safeArea = storySafeArea(viewport),\n  options: FrameEntitiesOptions = {},"
  },
} as const satisfies Readonly<Record<string, SourceExcerpt>>;
