# CLAUDE.md

Okie is a spatial explanation system for software: an evidence-backed architecture atlas that moves from system context (C4 L1) down to source code and plays deterministic guided stories. This repo is the first renderer vertical slice — a versioned semantic model, a deterministic scene compiler, a Rust/WASM renderer, deterministic fixtures, and a React shell. The semantic core is deterministic-first (observed facts before any LLM); forward design lives in `docs/roadmap/`.

## Commands

| Command | Purpose |
|---|---|
| `pnpm install` | Install deps (Node 22+, pnpm 11.10+, Rust 1.87 + `wasm32-unknown-unknown`). |
| `pnpm check` | Typecheck all workspaces (`tsc -b`). Regenerates WASM + stress fixture first. |
| `pnpm test` | All TS tests (packages via `node --test dist/*.test.js`; apps/web via vitest). |
| `cargo test --workspace` | All Rust tests. |
| `pnpm build` | Typecheck + `vite build`; regenerates release WASM + stress first. |
| `pnpm dev` | Vite dev server (port 4173). Regenerates WASM + stress first. |
| `pnpm generate:fixtures` | Regenerate golden source excerpts + demo snapshot/scene/timeline. Required after editing a pinned file (see GOTCHAS). |
| `pnpm generate:stress` | Regenerate the seeded 5k-node stress scene (gitignored). |
| `pnpm generate:wasm[:debug\|:release]` | Build `crates/atlas-wasm/pkg` via wasm-pack (profiling / dev / release). |

**wasm-pack 0.13+ is a hard prerequisite.** `pnpm check`, `dev`, and `build` deterministically regenerate optimized WASM and the stress fixture before TS/Vite start; without wasm-pack they stop with an explicit prerequisite error. Generated outputs are gitignored and rebuilt on demand.

## Layout

| Path | What |
|---|---|
| `packages/architecture` | `@okie/architecture` — semantic model, normalization, validation, extraction gate, C4 projection, routing. Source of truth: `src/model.ts`. |
| `packages/scene-compiler` | `@okie/scene-compiler` — deterministic scene/story/patch/timeline compiler; TS protocol mirror; hand-authored golden self-map. |
| `packages/theme` | `@okie/theme` — CSS design tokens only (`src/tokens.css`). |
| `crates/atlas-protocol` | Renderer protocol — Rust source of truth, v1 camelCase JSON. |
| `crates/atlas-engine` | CPU scene engine: retained state, LOD, culling, hit-test, patches, timeline. |
| `crates/atlas-gpu` | wgpu renderer (WebGPU/WebGL2): mesh + glyph atlas. |
| `crates/atlas-wasm` | Browser WASM bridge (`create_atlas_renderer`). |
| `apps/web` | `@okie/web` — React shell. |
| `scripts/` | `build-wasm.mjs`, `generate-stress.mjs`. |
| `fixtures/` | Deterministic semantic + compiled renderer fixtures. |
| `docs/` | `architecture/`, `product/`, `roadmap/` — see `ARCHITECTURE.md`. |

`apps/web/src` feature folders: `semantic/` (lens policy), `diagram/` (surfaces/adapters/workspace/Mermaid/SourceViewer), `inspector/`, `relations/` (projection/focus/framing), plus existing `navigation/`, `renderer/`, `editor/`, `provenance/`. Root holds the app shell (`App.tsx`, `main.tsx`, `app.css`, `icons.tsx`), the guided-story runtime (`storyPlayback.ts`, `storyFraming.ts`, `storyFocus.ts`, `cameraFlightController.ts`, `canvasAnimationPolicy.ts`), and cross-cutting acceptance tests (`bandPolicy.qa.test.ts`, `cinematicStory.qa.test.ts`, `appLayout.test.ts`).

## Conventions

- **Naming:** Rust `snake_case`; `@okie/*` packages `kebab-case`; `apps/web` `camelCase` modules + `PascalCase` React components.
- **Test suffixes:** `*.qa.test.ts` / `*_qa.rs` = acceptance / determinism-contract tests (encode frozen product invariants from `docs/`; change with extreme care). `*.test.ts` and inline Rust `#[cfg(test)]` = unit tests. Both run under the same globs.
- **Protocol mirror:** `crates/atlas-protocol` is the Rust source of truth; `packages/scene-compiler/src/protocol.ts` is its TS mirror. Both are v1, camelCase — change them together and keep checked fixtures in sync.
- **Barrels:** import packages by name (`@okie/architecture`), never deep paths. Internal files move freely as long as `src/index.ts` re-exports the same symbols. The only deep import is the WASM pkg (frozen; see GOTCHAS).

## Verification gates

Green is the contract. Before treating a change as done:
```
pnpm check && pnpm test && cargo test --workspace
```
Integration also runs `pnpm build`. After moving/renaming TS files, clear stale incremental state first: `pnpm -r exec tsc -b --clean` (or delete `*.tsbuildinfo`).

## GOTCHAS

- **Dogfooding pin — read before editing any "core" file.** The repo maps *itself*: 29 source files are path+symbol+line-anchored in the golden fixture (`scene-compiler/src/golden-fixture.ts` `anchorDefinitions` + generated `golden-source-excerpts.ts`, embedded in `fixtures/architecture/demo-snapshot.json`). Editing within ~6 lines of a pinned symbol — or moving/renaming a pinned file — shifts its excerpt. You must then run `pnpm generate:fixtures` **and** update the deliberate evidence-row hash pin in `scene-compiler/src/golden-c4-fixture.qa.test.ts` (a double-entry gate from `docs/architecture/ingestion-golden-tests.md`). Worked example: commit `2a30e28` — `protocol_runtime.rs` drifted → regenerate → hash pin `7e70dfae`→`b44ff782`, three excerpt anchors moved, no path/symbol/ID change. **Entity IDs are authored string literals, not path-derived** — moves change excerpt anchors, never IDs/fingerprints.
  - Pinned frontend (10): `App.tsx`; `navigation/{navigationState,historyController}.ts`; `provenance/presentation.ts`; `renderer/{Canvas2DRenderer,createRenderer,WasmRendererAdapter}.ts`; `storyPlayback.ts`; `storyFraming.ts`; `storyFocus.ts`.
  - Pinned backend (19): `architecture/src/{model,normalized,validation}.ts`; `scene-compiler/src/{compile-normalized,compile-scene,compile-story,generate-fixtures,protocol}.ts`; `atlas-engine/src/{protocol_runtime,lod,hit_test}.rs`; `atlas-gpu/src/{surface,mesh,glyph}.rs`; `atlas-protocol/src/{scene,patch}.rs`; `atlas-wasm/src/browser.rs`; `scripts/{build-wasm,generate-stress}.mjs`.
- **Flat package test glob.** `packages/*` run tests via `node --test dist/*.test.js` (depth-1). Never nest `packages/*/src` into subfolders — nested tests compile to `dist/**` and are silently skipped. (`apps/web` uses vitest and nests fine.)
- **Never hand-edit generated files:** `crates/atlas-wasm/pkg/`, `fixtures/renderer/stress-*.json`, `packages/scene-compiler/src/golden-source-excerpts.ts`, any `dist/`, any `*.tsbuildinfo`. Regenerate via the scripts above. `packages/scene-compiler/src/glyph-metrics.generated.ts` (the compiler's copy of the renderer glyph set and advances) is checked in but written from `crates/atlas-gpu/src/glyph.rs`: `cargo test -p atlas-gpu write_compiler_glyph_tables -- --ignored`; `cargo test` fails while it is stale.
- **`pnpm-workspace.yaml` uses `allowBuilds`** to whitelist native build scripts (e.g. `esbuild`). `allowBuilds` is the current pnpm key (v10.26+); it supersedes `onlyBuiltDependencies`/`neverBuiltDependencies`. Don't revert it to the deprecated key.
- **WASM import boundary (frozen):** `apps/web/src/renderer/WasmRendererAdapter.ts` imports `../../../../crates/atlas-wasm/pkg/atlas_wasm.js` (default `init` + `createAtlasRenderer`). Don't change that file's relative depth or `build-wasm.mjs`'s wasm-pack args / crate name.
- **Browser QA determinism:** stories auto-play in real time — to sample a step deterministically, jump to it and wait for `[data-playback-state="paused"]`, not a fixed delay. The GPU backend can silently fall back WebGPU→WebGL2 under automation; assert the active backend when a test depends on it.
- **Dev/diagnostics mode is hidden by default:** the renderer/backend pill, diagnostics panel, View/Edit mode toggle, and the `+ Diagram` create menu only render in dev mode — toggle with `Shift+Alt+D` (persisted as localStorage `okie.devMode`; the app shell exposes `data-dev-mode`). If you're debugging rendering and can't find the diagnostics pill, this is why.
- **Screen-recording outro is Cursor branding, not a crash:** saved Cursor screen recordings end with a short outro where the app is replaced by a black screen and a spinning white cube for the last ~1–2s. That frame is appended by the recording tool, not rendered by Okie — do not flag it as an app crash, GPU surface loss, or WebGL failure when reviewing QA videos.
