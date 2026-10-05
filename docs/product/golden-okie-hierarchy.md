# Golden Okie hierarchy

Status: frozen for the first four-level self-map fixture.

This document defines the product taxonomy, evidence-backed copy, and presentation policy for the Okie repository map. It is the fixture contract, not a description of a future repository scanner. Claims below are grounded in the current worktree. Fixture source references must use the listed repository-relative paths and symbols; they must not claim that uncommitted worktree files exist in `HEAD`.

Golden responsibilities are curated, inferred summaries with linked worktree evidence. They have no numeric confidence score. The inspector must not fabricate a percentage or describe the synthetic golden-worktree revision marker as a commit SHA.

The map proves one complete path from product context to source while exposing the other implemented runtime boundaries. It deliberately omits billing, collaboration, embeds, exports, and AI ingestion because this repository does not implement them.

## Frozen taxonomy

IDs are stable product IDs. Labels and responsibilities are user-facing copy. A responsibility is an inferred summary of the cited source, not source text.

The golden fixture uses a strict containment chain: the Okie software system is a root; every container has the system as parent; every component has exactly one container parent; every code anchor has exactly one component parent. People and external systems remain roots. The fixture does not skip a level, use relations as containment, or classify files as components.

### L1 · Context

| ID | Kind | Label | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| `actor:developer` | person | Developer / maintainer | Explores an unfamiliar codebase from system context to source evidence. | `README.md` (`Okie`, lines 1–5); `apps/web/src/App.tsx` (`App`) |
| `system:okie` | software system | Okie | Evidence-backed architecture atlas with semantic zoom and deterministic guided stories. | `README.md` (`Okie`, lines 1–5); `docs/architecture/renderer.md` (`Product boundary`) |
| `external:source-repository` | external system | Source repository | Supplies worktree source references used to support architecture claims. | `packages/architecture/src/model.ts` (`SourceRef`, `Evidence`, `ArchitectureSnapshot`) |
| `external:browser-graphics` | external system | Browser graphics platform | Provides the canvas, WebAssembly runtime, and WebGPU or WebGL2 surface used to render the atlas. | `crates/atlas-wasm/src/browser.rs` (`create_atlas_renderer`); `apps/web/src/renderer/createRenderer.ts` (`createRenderer`) |

L1 relationships:

| ID | From → to | Label | Evidence |
| --- | --- | --- | --- |
| `relation:developer-explores-okie` | Developer / maintainer → Okie | explores architecture and source | `README.md` lines 1–5; `apps/web/src/App.tsx` (`App`) |
| `relation:okie-source-evidence` | Okie → Source repository | links claims to source evidence | `packages/architecture/src/model.ts` (`SourceRef`, `Evidence`) |
| `relation:okie-renders-browser` | Okie → Browser graphics platform | renders through WASM and WebGPU/WebGL2 | `apps/web/src/renderer/createRenderer.ts` (`createRenderer`); `crates/atlas-wasm/src/browser.rs` (`create_atlas_renderer`) |

### L2 · Containers

All L2 entities have parent `system:okie`.

| ID | Label | Responsibility | Technology | Evidence |
| --- | --- | --- | --- | --- |
| `container:web-app` | Atlas web app | Owns the browser shell, navigation, inspection, search, camera controls, and guided-story experience. | React · TypeScript | `apps/web/src/App.tsx` (`App`, `CanvasViewport`) |
| `container:architecture-model` | Architecture model | Defines versioned architecture claims, evidence, views, hierarchy, zoom policy, and story state. | TypeScript | `packages/architecture/src/model.ts`; `packages/architecture/src/normalized.ts` |
| `container:scene-compiler` | Scene compiler | Deterministically converts semantic architecture and stories into renderer scenes, patches, and timelines. | TypeScript | `packages/scene-compiler/src/compile-scene.ts` (`compileScene`); `packages/scene-compiler/src/compile-story.ts` (`compileStory`); `packages/scene-compiler/src/compile-normalized.ts` |
| `container:rust-renderer` | Rust / WASM renderer | Validates, culls, hit-tests, animates, and draws scene-protocol objects through GPU-backed browser rendering. | Rust · WebAssembly · wgpu | `crates/atlas-engine/src/protocol_runtime.rs` (`ProtocolEngine`); `crates/atlas-gpu/src/surface.rs` (`GpuRenderer`); `crates/atlas-wasm/src/browser.rs` (`WasmAtlasRenderer`) |
| `container:tooling` | Build and fixture tooling | Builds the WASM package and generates deterministic demo and stress fixtures. | Node.js · wasm-pack | `scripts/build-wasm.mjs`; `scripts/generate-stress.mjs`; `packages/scene-compiler/src/generate-fixtures.ts` |

L2 relationships:

| ID | From → to | Label | Evidence |
| --- | --- | --- | --- |
| `relation:model-to-compiler` | Architecture model → Scene compiler | provides snapshots, views, and stories | `docs/architecture/renderer.md` (`Product boundary`); `packages/scene-compiler/src/compile-scene.ts` (`compileScene`); `packages/scene-compiler/src/compile-story.ts` (`compileStory`) |
| `relation:compiler-to-renderer` | Scene compiler → Rust / WASM renderer | emits protocol scenes, patches, and timelines | `docs/architecture/renderer.md` (`Product boundary`); `packages/scene-compiler/src/protocol.ts`; `crates/atlas-protocol/src/scene.rs`; `crates/atlas-protocol/src/patch.rs`; `crates/atlas-protocol/src/timeline.rs` |
| `relation:web-controls-renderer` | Atlas web app → Rust / WASM renderer | sends scenes, camera input, visibility, and playback time | `apps/web/src/renderer/WasmRendererAdapter.ts`; `crates/atlas-wasm/src/browser.rs` (`WasmAtlasRenderer`) |
| `relation:tooling-builds-renderer` | Build and fixture tooling → Rust / WASM renderer | builds browser WASM | `scripts/build-wasm.mjs` |
| `relation:tooling-generates-scenes` | Build and fixture tooling → Scene compiler | generates checked deterministic fixtures | `packages/scene-compiler/src/generate-fixtures.ts` |

### L3 · Components

#### Atlas web app

| ID | Label | Responsibility | Evidence |
| --- | --- | --- | --- |
| `component:web-shell` | Application shell | Composes the canvas, level rail, search, inspector, diagnostics, and story controls. | `apps/web/src/App.tsx` (`App`) |
| `component:web-navigation` | Navigation and history | Canonicalizes shareable URL state and separates pushed navigation from replaced selection and camera state. | `apps/web/src/navigation/navigationState.ts`; `apps/web/src/navigation/historyController.ts` |
| `component:web-renderer-host` | Renderer host | Creates GPU or Canvas2D backends and forwards scene, camera, input, and visibility state. | `apps/web/src/renderer/createRenderer.ts`; `apps/web/src/renderer/WasmRendererAdapter.ts`; `apps/web/src/renderer/Canvas2DRenderer.ts` |
| `component:web-stories` | Guided story player | Frames story entities, interpolates camera flights, and presents deterministic focus and flow state. | `apps/web/src/storyPlayback.ts`; `apps/web/src/storyFraming.ts`; `apps/web/src/storyFocus.ts` |
| `component:web-provenance` | Evidence presentation | Distinguishes observed facts, deterministic inference, and AI-authored explanation. | `apps/web/src/provenance/presentation.ts` (`presentClaimProvenance`) |

#### Architecture model

| ID | Label | Responsibility | Evidence |
| --- | --- | --- | --- |
| `component:model-schema` | Semantic schema | Defines entities, relations, evidence, snapshots, views, stories, and user overrides. | `packages/architecture/src/model.ts` |
| `component:model-normalized` | Normalized state | Stores qualified identities and indexed rows for snapshots, hierarchy, layouts, zoom bands, and stories. | `packages/architecture/src/normalized.ts` (`NormalizedArchitecture`, `normalizeArchitecture`) |
| `component:model-scoping` | Hierarchy selectors | Reconstructs snapshots and selects a view scoped to a root entity. | `packages/architecture/src/normalized.ts` (`selectArchitectureSnapshot`, `selectArchitectureView`, `selectScopedView`) |
| `component:model-validation` | Architecture validation | Rejects invalid snapshots, views, stories, geometry, evidence, and overrides before compilation. | `packages/architecture/src/validation.ts` (`validateSnapshot`, `validateView`, `validateStory`, `validateOverrides`) |

#### Scene compiler

| ID | Label | Responsibility | Evidence |
| --- | --- | --- | --- |
| `component:compiler-scene` | Scene compilation | Maps visible semantic entities and relations to bounded renderer objects and paths. | `packages/scene-compiler/src/compile-scene.ts` (`compileScene`) |
| `component:compiler-story` | Story compilation | Converts narrated focus steps into deterministic camera and emphasis keyframes. | `packages/scene-compiler/src/compile-story.ts` (`compileStory`) |
| `component:compiler-normalized` | Scoped scene and patch compilation | Selects a root-scoped view and diffs retained scenes into revisioned patches. | `packages/scene-compiler/src/compile-normalized.ts` (`compileNormalizedScene`, `diffSceneSnapshots`, `compileNormalizedPatch`) |
| `component:compiler-protocol` | TypeScript protocol mirror | Defines the TypeScript scene, patch, primitive, LOD, and timeline payloads sent to Rust. | `packages/scene-compiler/src/protocol.ts` |

#### Rust / WASM renderer

| ID | Label | Responsibility | Evidence |
| --- | --- | --- | --- |
| `component:renderer-protocol` | Versioned renderer protocol | Validates scene objects, representations, paths, patches, and timelines at the Rust boundary. | `crates/atlas-protocol/src/scene.rs`; `crates/atlas-protocol/src/patch.rs`; `crates/atlas-protocol/src/timeline.rs` |
| `component:renderer-engine` | Scene engine | Owns retained scene state, semantic LOD, visibility, camera, culling, hit testing, patches, and timeline sampling. | `crates/atlas-engine/src/protocol_runtime.rs` (`ProtocolEngine`); `crates/atlas-engine/src/camera.rs`; `crates/atlas-engine/src/lod.rs` |
| `component:renderer-gpu` | GPU renderer | Builds mesh and glyph data, initializes WebGPU/WebGL2, and submits visible frame geometry. | `crates/atlas-gpu/src/surface.rs` (`GpuRenderer`); `crates/atlas-gpu/src/mesh.rs`; `crates/atlas-gpu/src/glyph.rs` |
| `component:renderer-wasm` | Browser WASM bridge | Deserializes host payloads and exposes scene, patch, camera, visibility, picking, and timeline controls to JavaScript. | `crates/atlas-wasm/src/browser.rs` (`WasmAtlasRenderer`) |

#### Build and fixture tooling

| ID | Label | Responsibility | Evidence |
| --- | --- | --- | --- |
| `component:tooling-wasm` | WASM build driver | Selects release, profiling, or debug wasm-pack builds and reports missing prerequisites. | `scripts/build-wasm.mjs` |
| `component:tooling-fixtures` | Fixture generator | Compiles the checked semantic fixture into renderer scene and timeline JSON. | `packages/scene-compiler/src/generate-fixtures.ts` |
| `component:tooling-stress` | Stress scene generator | Generates seeded large scenes for renderer profiling. | `scripts/generate-stress.mjs` |

### L4 · Curated source anchors

L4 is a curated implementation index, not a file tree or AST graph. Each component exposes at most three anchors in the golden fixture. File-only anchors are allowed when a module is the meaningful unit.

| Parent | Label | Source reference |
| --- | --- | --- |
| Application shell | `App` | `apps/web/src/App.tsx`, symbol `App` |
| Application shell | `CanvasViewport` | `apps/web/src/App.tsx`, symbol `CanvasViewport` |
| Navigation and history | `NavigationState` | `apps/web/src/navigation/navigationState.ts`, symbol `NavigationState` |
| Navigation and history | `canonicalNavigationUrl()` | `apps/web/src/navigation/navigationState.ts`, symbol `canonicalNavigationUrl` |
| Navigation and history | `createNavigationHistoryController()` | `apps/web/src/navigation/historyController.ts`, symbol `createNavigationHistoryController` |
| Renderer host | `createRenderer()` | `apps/web/src/renderer/createRenderer.ts`, symbol `createRenderer` |
| Renderer host | `WasmRendererAdapter` | `apps/web/src/renderer/WasmRendererAdapter.ts`, symbol `WasmRendererAdapter` |
| Renderer host | `Canvas2DRenderer` | `apps/web/src/renderer/Canvas2DRenderer.ts`, symbol `Canvas2DRenderer` |
| Guided story player | `createStoryFlight()` | `apps/web/src/storyPlayback.ts`, symbol `createStoryFlight` |
| Guided story player | `frameEntities()` | `apps/web/src/storyFraming.ts`, symbol `frameEntities` |
| Guided story player | `storyFocusPresentation()` | `apps/web/src/storyFocus.ts`, symbol `storyFocusPresentation` |
| Evidence presentation | `presentClaimProvenance()` | `apps/web/src/provenance/presentation.ts`, symbol `presentClaimProvenance` |
| Semantic schema | `ArchitectureSnapshot` | `packages/architecture/src/model.ts`, symbol `ArchitectureSnapshot` |
| Semantic schema | `ArchitectureEntity` | `packages/architecture/src/model.ts`, symbol `ArchitectureEntity` |
| Semantic schema | `ArchitectureStory` | `packages/architecture/src/model.ts`, symbol `ArchitectureStory` |
| Normalized state | `normalizeArchitecture()` | `packages/architecture/src/normalized.ts`, symbol `normalizeArchitecture` |
| Normalized state | `NormalizedArchitecture` | `packages/architecture/src/normalized.ts`, symbol `NormalizedArchitecture` |
| Hierarchy selectors | `selectScopedView()` | `packages/architecture/src/normalized.ts`, symbol `selectScopedView` |
| Hierarchy selectors | `selectArchitectureSnapshot()` | `packages/architecture/src/normalized.ts`, symbol `selectArchitectureSnapshot` |
| Architecture validation | `validateSnapshot()` | `packages/architecture/src/validation.ts`, symbol `validateSnapshot` |
| Architecture validation | `validateView()` | `packages/architecture/src/validation.ts`, symbol `validateView` |
| Architecture validation | `validateStory()` | `packages/architecture/src/validation.ts`, symbol `validateStory` |
| Scene compilation | `compileScene()` | `packages/scene-compiler/src/compile-scene.ts`, symbol `compileScene` |
| Story compilation | `compileStory()` | `packages/scene-compiler/src/compile-story.ts`, symbol `compileStory` |
| Scoped scene and patch compilation | `compileNormalizedScene()` | `packages/scene-compiler/src/compile-normalized.ts`, symbol `compileNormalizedScene` |
| Scoped scene and patch compilation | `diffSceneSnapshots()` | `packages/scene-compiler/src/compile-normalized.ts`, symbol `diffSceneSnapshots` |
| TypeScript protocol mirror | `SceneSnapshot` | `packages/scene-compiler/src/protocol.ts`, symbol `SceneSnapshot` |
| TypeScript protocol mirror | `Timeline` | `packages/scene-compiler/src/protocol.ts`, symbol `Timeline` |
| Versioned renderer protocol | `SceneSnapshot::validate()` | `crates/atlas-protocol/src/scene.rs`, symbol `SceneSnapshot::validate` |
| Versioned renderer protocol | `ScenePatch::validate_against()` | `crates/atlas-protocol/src/patch.rs`, symbol `ScenePatch::validate_against` |
| Scene engine | `ProtocolEngine` | `crates/atlas-engine/src/protocol_runtime.rs`, symbol `ProtocolEngine` |
| Scene engine | `LodController` | `crates/atlas-engine/src/lod.rs`, symbol `LodController` |
| Scene engine | `hit_test()` | `crates/atlas-engine/src/hit_test.rs`, symbol `hit_test` |
| GPU renderer | `GpuRenderer` | `crates/atlas-gpu/src/surface.rs`, symbol `GpuRenderer` |
| GPU renderer | `build_mesh()` | `crates/atlas-gpu/src/mesh.rs`, symbol `build_mesh` |
| GPU renderer | `GlyphAtlas` | `crates/atlas-gpu/src/glyph.rs`, symbol `GlyphAtlas` |
| Browser WASM bridge | `WasmAtlasRenderer` | `crates/atlas-wasm/src/browser.rs`, symbol `WasmAtlasRenderer` |
| Browser WASM bridge | `createAtlasRenderer()` | `crates/atlas-wasm/src/browser.rs`, symbol `create_atlas_renderer` |
| WASM build driver | `scripts/build-wasm.mjs` | `scripts/build-wasm.mjs` |
| Fixture generator | `packages/scene-compiler/src/generate-fixtures.ts` | `packages/scene-compiler/src/generate-fixtures.ts` |
| Stress scene generator | `scripts/generate-stress.mjs` | `scripts/generate-stress.mjs` |

## Representation policy

Semantic detail and hierarchy scope are separate state. Wheel or pinch changes detail; it never changes the current root. Parent and child representations crossfade through the renderer's LOD bands.

| Level | Canvas label policy | Default edge policy | Inspector default |
| --- | --- | --- | --- |
| L1 Context | Kind, name, one-line role. Hide technology and source paths. | Show the three context relationships. Label all because the graph is deliberately small. | System purpose, people/external relationships, evidence summary, `Open inside`. |
| L2 Containers | Name and one-line responsibility. Show technology only when selected or sufficiently zoomed. | Show the five evidence-backed container relationships. Fade non-neighbor edges to 25% when a node is selected. | Responsibility, technology, direct relationships, source evidence, `Open inside`. |
| L3 Components | Name and one-line responsibility. Reveal a short module path only at the upper half of the L3 band. | Show edges whose endpoints are both inside the current container plus at most two one-hop boundary portals. Labels appear only for the selected node's edges or the active story trace. | Component role, local relationships, source anchors, `Open inside`. |
| L4 Code | Symbol or module name plus one truncated repository-relative path. Do not put prose paragraphs on the canvas. | Hide containment edges. Show only curated call/dependency edges in the current component, and only when evidenced. Never infer an AST or import graph for presentation. | Full path, symbol/lines, worktree source reference, parent component, `Open source`. |

Global density rules:

- At L1–L3 focus zoom, primary titles render at least 12 CSS px, supporting copy at least 10 CSS px, and short uppercase kind kickers at least 9 CSS px. L4 is an overview preset: its 14/10/11 px symbol/kicker/signature (raised from 11.2/7.2/7.4 px by CLA-381) grows to about 32/23/25 px in the explicit owner runway. Measure projected glyph height, not world-space `fontSize`.
- A viewport may present at most 12 peer nodes with readable primary labels at once without clustering or progressive reveal. A larger scope may continue beyond the viewport or nest those peers inside labelled parent boundaries.
- Edge labels are a scarce annotation layer: selected adjacency, story traces, and hovered edges outrank the rest.
- External relations terminate at a labelled boundary portal below L1; they do not stretch across every nested layer.
- Confidence and provenance live in the inspector. They do not compete with the map's orientation labels.
- L4 anchors are curated implementation entry points. Directories, generated output, tests, and every declaration are not automatically map nodes.
- Canvas summaries truncate deterministically at a word boundary with `…`; raw glyph clipping and partial words are not acceptable. The inspector retains the complete responsibility. L4 paths use a middle ellipsis that preserves the repository area and filename.
- All curated L1 and L2 primary names display in full at their band focus zoom. Ellipsis is a fallback for long component or symbol names, not the normal orientation treatment for the golden context and container maps.

### Typography roles

The GPU renderer must honor the authored font role; a single bitmap or monospace atlas for every primitive is not an acceptable approximation.

| Role | Face and weight | L1 focus px | L2 focus px | L3 focus px | L4 focus px |
| --- | --- | ---: | ---: | ---: | ---: |
| Kind kicker | IBM Plex Sans, 600, uppercase | 13.5 | 10 | 10 | 10 |
| Primary name | IBM Plex Sans, 600 | 20 | 15.5 | 16.5 | — |
| Responsibility | IBM Plex Sans, 400 | 15.5 | 11 | 11 | — |
| Edge label | IBM Plex Sans, 500 | ≥ 10 | ≥ 10 | selected/story only | selected/story only |
| Code symbol | IBM Plex Mono, 600 | — | — | — | 14 |
| Signature excerpt | IBM Plex Mono, 400 | — | — | — | 11 |

The compiler converts these focus targets to world units using each band's authored preset. At the `32` camera maximum, L4 projects to about 23 px kickers, 32 px symbols, and 25 px signatures rather than growing without a bound. Non-code titles, responsibilities, kind labels, and relation labels never use the code font. Baselines reserve at least `1.2 × fontSize` for kickers/titles and `1.35 × fontSize` for each supporting-copy line (`cardTitleStep` / `cardDescriptionStep`). Support copy wraps to 3 lines at L1/L2 and 2 at L3/L4 (CLA-381); no glyph box may intersect another line or a node edge.

The selected UI and diagram family is IBM Plex Sans with IBM Plex Mono. Identical 1540×754 L1 and scoped L4 trials rejected Geist Sans/Mono as too generic and Source Sans 3/Source Code Pro as too soft for the architectural hierarchy. The browser pins `@fontsource/ibm-plex-sans@5.2.8` and `@fontsource/ibm-plex-mono@5.2.7`. The GPU pins the official `IBM/plex` `v6.4.2` tag at commit `242c4cccd37e87985a5337815c99b960ef13c65c`, vendors the OFL-1.1 license, and derives its raster atlas and compiler advance table from the same five TTF files:

| Face | SHA-256 |
| --- | --- |
| `IBMPlexSans-Regular.ttf` | `975dcda37d80f038dcd143c22e33ca2d97a0cc5a929aace1c749153b0fe1afa5` |
| `IBMPlexSans-Medium.ttf` | `331c8639d7598b2cde62a911a71db195e30cb655cd6bdf2e324a7e984955f907` |
| `IBMPlexSans-SemiBold.ttf` | `a20caf8286023a6a7a85e40b1d2a4ae9fc3e3b1f9eda8f4c542dd4986af67bb1` |
| `IBMPlexMono-Regular.ttf` | `fe11304a5fe956d5744e9b6a246cc83d90425245e75a62230044966ca96a7f50` |
| `IBMPlexMono-SemiBold.ttf` | `c9417148ce13f8fa7d2d5c9180bbc141f72aa0d814ffeb280f6904dc2b1bbd7a` |

### Zoom distribution

The interactive C4 camera is clamped to `0.32–32`. Forced presets follow one approximately `2.65×` progression: `0.75 → 1.99 → 5.27 → 13.96`. Authored LOD ranges still overlap and retain per-band hysteresis, so the new readable scale does not create a hard representation cut.

| Band | Enter | Exit | Rail preset | Dominant useful dwell |
| --- | ---: | ---: | ---: | ---: |
| L1 Context | `0` (camera min `0.32`) | `1.30` | `0.75` | `0.32–1.159` |
| L2 Containers | `1.16` | `3.75` | `1.99` | `1.16–3.349` |
| L3 Components | `3.35` | `7.95` | `5.27` | `3.35–7.099` |
| L4 Code | `7.10` | none (camera max `32`) | `13.96` | `7.10–32` |

At the minimum, a 480-unit L1 card remains about 154 CSS px wide instead of collapsing below 90 px. Scaling every world-space rectangle alone would not achieve this: a fit operation would divide the camera zoom by the same scale and cancel the apparent size. Readability comes from the higher camera floor, compact use of the authored world layout, and explicit framing ceilings.

Normal L4 story and rail framing stops at the `13.96` focus preset. Explicit L4 owner framing may use the `13.96–32` runway and should place the owner's major dimension at 75–90% of the measured safe viewport. For the golden GPU renderer owner, the 1672×918 QA map reaches 71.9% width and 88.9% height at `32`; the 936×616 safe region inside a 1136×768 crop fits at `20.86`, reaching 83.7% width and 86.4% height. This makes the code container the composition without permanently inflating every L4 label.

`Fit architecture to view` fits the entities currently painted in the visible projection (the active C4 band, including context peers at L1), not the root entity's full descendant scope, inside the measured safe viewport with 24 CSS px inner padding. The safe viewport excludes the top bar and map heading, inspector, level rail, story player, and bottom controls. Fit clamps to the active band's dominant interval and never changes detail, root, selection, or history depth. Load and empty-canvas clicks do not re-fit the camera. `Open inside` uses the root-scope fitter in the next band rather than merely centering a fixed preset. If all curated peers cannot fit at or above the band's lower dominant threshold, the composition fails and the layout must be tightened.

### Semantic lens

Wheel and pinch detail use one spatial lens, not a global level swap. The lens expands exactly one hierarchy branch while keeping orientation context around it.

#### Target and coverage

- The target is the deepest expandable boundary in the current band under the wheel pointer or pinch centroid. A candidate must contain the anchor by at least 24 CSS px so edge jitter does not retarget it.
- If the anchor is over no expandable boundary, use the entity under the measured safe-viewport center. If that also fails, use the selected expandable entity, then the current root.
- Coverage uses the target's **next-band boundary bounds** projected through the current camera into the measured safe viewport. `major = max(projectedWidth / safeWidth, projectedHeight / safeHeight)` and `minor = min(...)`. The next boundary, rather than the small collapsed card, makes the rule stable across differently sized hierarchy levels.
- Inward input becomes eligible at the target band's authored enter zoom (`1.16`, `3.35`, or `7.10`) and arms the assist when its authored coverage gate passes. There is no upper scale cutoff below the `32` camera maximum: if coverage has not passed at the old global exit, that branch remains collapsed while zoom continues. After the authored dwell, the next semantic band commits and completes through the same reversible projection interpolation.
- Outward input reverses the same interpolation from its current progress. The child band relinquishes ownership when `major ≤ 0.58`, `minor ≤ 0.26`, or camera zoom is more than `0.04` below that target band's authored enter zoom. This hysteresis prevents flicker without trapping tiny labels on screen.

#### Composition and camera assist

- The target card grows into its next-band boundary; children appear inside that same boundary. It does not disappear and reappear at an unrelated map position.
- Only the target branch expands. Its siblings retain their current-band collapsed cards and dim to contextual weight; their children never leak into the scene. The immediate parent boundary, one readable ancestor label, and evidenced external boundary portals remain. Zoom-out restores the prior geometry, opacity, and routes by running the same progress backward.
- The camera stays pointer-anchored until the assist arms. It then blends the target center toward the safe-viewport center by at most 68%, using a retargetable 260 ms ease-out on desktop and 320 ms on mobile. User zoom remains authoritative; a post-gesture fit may correct zoom by at most 6% to clear the 24 px safe padding.
- Retargeting is allowed only before 50% transition progress, after the replacement target owns the anchor by 24 px for 80 ms. After 50%, the target is locked through settlement. Pointer-down pan, `Escape`, a level-rail command, breadcrumb navigation, story playback, or explicit `Open inside` cancels the assist immediately and preserves the camera reached so far. No animation queues behind a canceled assist.

#### State, focus, and accessibility

- Continuous wheel/pinch, lens identity, semantic detail, and camera settlement use `history.replaceState`; they never change the current root, selection, inspector entity, DOM focus, or history depth. Canonical state adds the stable settled `lens=<entityId>` alongside `detail` and camera. Fractional transition progress is not serialized; copying mid-transition resolves to the nearest stable side at 50%.
- `Open inside` is the explicit commit: it changes root and selection together, frames the next band, and performs exactly one history push. Rail changes are explicit detail commands but remain replacements. Breadcrumb root navigation retains its existing push semantics.
- Canvas wheel/pinch never steals focus. If zoom-out removes the explorer row that currently owns keyboard focus, focus moves to the stable Entity list summary and the live region announces that the selected descendant is hidden at the parent scope. Selection remains intact so `Show on map` can restore its lens.
- On mobile the anchor is the pinch centroid and the gesture must accumulate 12% inward scale before arming. The ratios above use the mobile measured safe viewport. The inspector is an overlay and blocks map-lens gestures while open; its explicit `Open inside` action remains available.
- With reduced motion, camera assist and spatial morphing are disabled. The semantic swap occurs once the gesture settles across the same thresholds, the user's camera is preserved, and rail or `Open inside` fits immediately without animation.

### Collision acceptance

- Node rectangles never overlap peer rectangles at a band preset.
- Routed lines terminate on node boundaries; they do not run through node interiors.
- A visible edge label owns an unobstructed padded rectangle. It may not overlap a node, another label, an arrowhead, or UI chrome.
- L1 shows all four context nodes at 1280×720 with the inspector open. L2 shows all five containers without peer overlap. The selected L3 container shows all four local components at once. The golden L4 root shows both curated anchors at once.
- These checks are repeated at 1440×960, the supplied 1540×754 screenshot dimensions, 1280×720, and 390×844. On mobile the inspector begins closed and opens as an overlay; the current root and at least one actionable child remain visible behind no permanent chrome.

Relation projection rules:

- Project each relation endpoint to its nearest visible ancestor in the active semantic band.
- If both endpoints project to the same visible entity, suppress the resulting self-edge. Internal traffic belongs in that entity's inspector summary until both endpoints are visible.
- Collapse multiple projected relations with the same visible endpoints and relation kind into one edge. Preserve the deterministic underlying-relation count and evidence union for inspection.
- Keep the authored label when every collapsed relation shares it. Otherwise use the deterministic plural form, for example `3 calls`; do not synthesize a causal description.
- Containment is communicated by nested bounds and breadcrumbs, never by a second set of containment arrows.

## Parent context and orientation

- The current root owns the viewport. Its parent remains visible as a subdued boundary with a pinned top-left label while descendants are visible.
- At least one ancestor label remains on canvas at L2–L4, even when its physical boundary extends beyond the viewport.
- Parent fill stays quiet enough that child cards remain the dominant hit targets. Clicking empty boundary space selects the parent; it does not drill.
- Sibling containers outside the current root become compact boundary portals. They must not compete with local components.
- Breadcrumb buttons render ancestry through the current root. The current root is marked as the page and is not a drill action. A selected descendant may appear after it as a non-navigational location label, for example `Okie / Architecture model / Hierarchy selectors / selectScopedView()` where `Hierarchy selectors` is the root and `selectScopedView()` is selected.
- The level rail communicates representation detail only. Its labels are `L1 Context`, `L2 Containers`, `L3 Components`, and `L4 Code`.
- The status hint is explicit: `Pinch or wheel to zoom · drag to pan · click to inspect · double-click to open inside` (CLA-326: two-finger trackpad scroll pans; pinch, mouse wheel and Cmd/Ctrl+scroll zoom).

## Selection and drill copy

- Single click or tap: select. Update `sel` and the inspector; preserve root and camera.
- `Open inside`, double-click, or Enter on a selected L1–L3 node: drill. Set `root`, frame the new scope, and push history.
- The node affordance is `Open inside ↘`; do not use `View component map`, which couples copy to one level.
- The inspector secondary camera action is `Show on map`, matching the active interaction-semantics contract.
- L4 has no deeper map action. Its primary action is `Open source ↗`.
- Clicking a breadcrumb changes root and pushes history. Browser Back restores the exact prior root, selection, camera, and detail.
- Search selection frames and selects the result. Opening it is a second explicit action.
- Level-rail clicks change the detail preset and its corresponding camera zoom around the current viewport center; they never rewrite root or selection.
- When no explicit selection exists, the inspector describes the current root.

## Golden acceptance path

The primary review path is:

1. Start at `system:okie` with the developer and two external systems visible.
2. Select Okie without camera movement.
3. Use `Open inside` to enter the L2 container map.
4. Select `Architecture model`, then drill to its four L3 components.
5. Select `Hierarchy selectors`, then drill to its curated L4 anchors.
6. Select `selectScopedView()` and verify the inspector shows its path and source action.
7. Use breadcrumb and browser Back to restore each prior root and camera.
8. Change the level rail at every root and verify that detail and camera zoom change while root and selection remain stable.

The review fails if a single click drills, if a level-rail click changes root, if Back loses the previous camera, if a parent disappears without an orientation label, or if unsupported future capabilities appear as observed architecture.
