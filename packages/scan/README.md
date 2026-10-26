# @okie/scan

Deterministic local-path repository scanner — R1 of the [scan runner](../../docs/roadmap/scan-runner.md).
Turns a pinned git working tree into an evidence-backed `ArchitectureSnapshot` (plus a
renderable view/story/scene/timeline) by walking TypeScript **syntax only** — no type
checker, no `node_modules`, no network.

Packaged and installed as `@sourcefor/atlas` with one executable, `sourcefor-atlas` (names in
[`product.json`](product.json); install steps in [`docs/portable-atlas.md`](../../docs/portable-atlas.md)).
From this checkout, `pnpm --filter @okie/scan scan --source <path> …` runs the same CLI from source.

```
sourcefor-atlas --source <path> [--out <dir>] [--system-name <name>] [--repo <slug>]
sourcefor-atlas --source <path> --emit-packets <dir>
sourcefor-atlas --source <path> --emit-prompt <dir>
sourcefor-atlas --source <path> --enrich-from <dir>
sourcefor-atlas --source <path> --lcov <path>
sourcefor-atlas --source <path> --component-map <path>
```

Defaults: `--source` = cwd, `--out` = `<source>/fixtures/scan` (gitignored). Outputs
`extraction.json`, `snapshot.json`, `view.json`, `story.json`, `stories.json`, `scene.json`, `timeline.json`.

Container membership is exclusive: each source file belongs to at most one container,
and with nested workspace members the most specific package root wins. A file outside
every member whose statements are only relative re-exports of one file owned by a
member or crate (e.g. a root Vercel `api/share.ts` =
`export { default } from '../apps/web/api/share.ts'`) is folded into its target instead
of becoming a second "tooling" component; importers of the shim resolve to the target.
Folded shims are not evidence (never `sourceRefs`). They are listed, with any
container-membership warnings (`file-in-multiple-containers`,
`reexport-across-containers`), in `membership-report.json` and, when non-empty, in the
portable atlas's `analysis.membership`. Warnings never fail a scan.

## Pipeline

1. **Pin** — `git rev-parse HEAD` + `HEAD^{tree}`; `generatedAt` is the commit's own
   committer date (`git show -s --format=%cI`), never wall-clock, so a re-scan of a commit
   is byte-identical.
2. **Discover** — the committed tree (raw blobs streamed in bounded `git cat-file --batch`
   chunks; size limits in `SCAN_SIZE_LIMITS`) or a `gh:` tarball walk, filtered to source
   extensions minus the named exclusions below; canonical sort. Symlinks are never listed as
   source files: in-repo ones are kept for config/import resolution, escaping / dangling /
   looping ones are dropped, submodules skipped — all counted in `analysis.limitations`.
3. **Extract** — one `ts.createSourceFile` per file; map to the C4 hierarchy (below);
   static `import`/`export … from` specifiers become `dependsOn` relations.
4. **Gate** — build one `ArchitectureExtraction` → `validateArchitectureExtraction` →
   `adaptArchitectureExtraction` → `ArchitectureSnapshot` (identity defaults: lineageId =
   stable ID, fingerprint = content hash).
5. **View + compile** — synthesize a validator-satisfying view, a deterministic multi-step
   C4 overview story (system → containers → a representative component/code descent;
   `overview-story.ts` `buildOverviewStory`). After a gated enrichment pass, step
   narration may mention accepted section summaries; step count and reveals stay
   the C4 tour. Then `buildC4ProjectionBundle` → `compileC4Scene`/`compileC4Timeline`.
   The scan also emits **user-flow stories** from documented templates
   (`flow-story.ts` `USER_FLOW_TEMPLATES`: paste-a-repo `/new`, Ask, embed/oEmbed)
   when those surfaces exist in the snapshot. Overview stays the default C4 nest
   tour; flows are additional selectable stories. Copy is structural (entity name,
   kind, role) unless an accepted `responsibility` is present. `story.json` remains
   the overview; `stories.json` is the catalog (overview first). Generic repos
   without those files publish overview only.

## Structure mapping (R1 — deterministic truth layer)

| C4 level | Derived from |
|---|---|
| `softwareSystem` | the repository (one) |
| `externalSystem` | the **top-N most-imported service-boundary runtime dependencies** (APIs/platforms at L1; not UI/framework/utils) |
| `container` | each workspace member with source, a synthetic **tooling** container for non-member scripts, and each Rust crate |
| `component` | **one per source file** |
| `code` | **one per top-level named declaration** (exported or not), anchored `path`+`symbol`+line range |

### Explicit component membership

`--component-map <path>` optionally layers an authored architectural interpretation over the observed file graph. It accepts a version-1 JSON document with `containers[]`, each containing a `containerId` and explicit components (`id`, `name`, `paths`). Paths may be partial: unmapped files retain their file-components. A file has one owner, code symbols and their source anchors stay unchanged, and invalid input rejects atomically to the unchanged file graph. The emitted `component-map-report.json` records acceptance and external-path/SHA-256 provenance; a local CLI map is external to the pinned Git revision. Rejected maps emit the unchanged scan and rejection report, print the reasons, and exit with status 1. No partially mapped artifact is emitted.

### System context (L1) — external dependencies

The top level must show how the system meets the world. The scan derives `externalSystem` entities
deterministically from **third-party runtime dependencies that are service boundaries**
(APIs/platforms), not UI/framework/utility libraries (CLA-97):

- **Allowlist = runtime `dependencies`** (never `devDependencies`) declared by the root and every
  workspace member. Local protocols (`workspace:`/`file:`/`link:`) are first-party and excluded — so a
  CSS-only member like `@okie/theme` never appears. A bare import counts only if its package is on
  the allowlist, which also drops node builtins and type-only/dev tooling.
- **L1 classification** (`isL1ExternalSystemPackage`): keep SDKs/cloud/database/API clients
  (e.g. `@anthropic-ai/sdk`, `stripe`, `pg`); drop fonts, UI frameworks, compilers, bundlers, and
  utilities (`@fontsource/*`, `react`, `react-dom`, `dompurify`, `clsx`, `mermaid`, `typescript`,
  `vite`, `zod`, …). Unknown npm packages default to drop — most `dependencies` entries are
  implementation libraries. Dropped packages attach to the importing container's `technology` so
  they remain reachable in inspector/detail, not as L1 cards.
- **Selection** is the top `MAX_EXTERNAL_SYSTEMS` (8) **service-boundary** packages by
  `(import-site count desc, package name asc)` — a documented, deterministic constant. Evidence is
  a capped canonical selection of the real import statements (`path`+line) plus the `package.json`
  declaration line.
- **Relations** are `container → externalSystem` (`dependsOn`), so at **L1** they collapse to
  `system → externalSystem` interactions and at **L2** they attribute the dependency to the importing
  container. Persons/externalSystems are laid out in the context band by the C4 projection automatically.
- Scanning Okie yields e.g. `@anthropic-ai/sdk` at L1; `react` / `@fontsource/*` / `dompurify` stay
  on the web container's technology list.
- **Rust crate dependencies** (`Cargo.toml`, e.g. `wgpu`) are a documented follow-up: crate
  outline does not rank third-party `use` frequency for L1 externals.

### Deliberate calls (do not "fix" without reading this)

- **Component = file, not directory.** This is the deterministic *structural* truth. Collapsing
  files into logical/conceptual components (e.g. the hand-authored golden fixture's "Application
  shell") requires semantic judgement — that is **R2 agent enrichment's** job, not R1's. `apps/web`
  therefore renders ~50 file-components; that is honest, not a bug.
- **All top-level declarations, not just `export`ed ones.** Some pinned anchors (e.g.
  `CanvasViewport` in `App.tsx`) are non-exported top-level functions.
- **`packages/theme` is skipped** — it ships CSS tokens only, zero `.ts`, so it yields no
  container (the golden fixture has no theme container either).
- **Rust crates drill to L3/L4** — each crate `.rs` file is a file-component; top-level
  `mod` / struct / enum / fn and impl methods (`Type::method`) are code entities
  (tree-sitter-rust). Technology stays `Rust` (CLA-102). Hang-guard stays 2000.
  Integration tests under `tests/` and `*_qa.rs` are excluded like TS tests.
- **Observed language tags** (CLA-102) — `TypeScript` / `JavaScript` / `Rust` from
  file extensions (and Rust crate units). They prepend onto CLA-97 library names
  on the same container. `.tsx` is TypeScript, not a React claim. Golden curated
  badges (`TypeScript · Rust · WebAssembly · wgpu`) are a different fixture.
- Derived structure legitimately differs from the golden fixture's *conceptual* grouping and IDs.
  The dogfooding gate is about **evidence coverage** (every golden `.ts/.tsx/.mjs` `path`+`symbol`
  anchor appears among scan `code` entities), not ID equality. Rust golden path+symbol
  anchors are covered the same way once outlined.

## Coverage & repository shapes

Discovery generalizes beyond Okie's own layout (validated against third-party clones):

- **Workspace members** are read from `pnpm-workspace.yaml` `packages:` **and** the root
  `package.json` `workspaces` (array form, or yarn classic's `{ "packages": [...] }`; `nohoist`
  ignored). When both exist the members are the **union** of their include globs, minus the union
  of every `!negation` (applied after all includes). Globs: `*` (within one segment) and `**`
  (one or more segments); `?`, `[...]` and `{a,b}` are not supported.
- **Rust crates** come from the root `Cargo.toml` `[workspace] members` (globs or paths) minus
  `exclude`; a matched directory counts only with a tracked `Cargo.toml`. Without declared
  members the conventional `crates/<name>/Cargo.toml` layout is used (still minus `exclude`).
  Files belong to the deepest root across crates and JS members (same dir: the crate). A crate
  with no scanned source file (e.g. only `benches/`/`tests/`) is not a container, and fixture
  names (`examples`, `e2e`, …) skip Cargo members exactly like JS members. Without JS members the
  root container is kept without source of its own only when the root `package.json` declares
  `exports`/`main`/`types`/`module`/`bin` or runtime `dependencies` (a Cargo virtual workspace or a
  tooling-only manifest yields no empty root).
- **Crate edges** come from `Cargo.toml` `path` dependencies (inline, `[dependencies.x]`,
  inherited `workspace = true`) and from root **`[patch.<source>]` path overrides**: a crate that
  depends on `foo` by registry version or git URL gets a `foo` crate edge when the root manifest
  patches that source's `foo` to an in-repo crate (tokio's `[patch.crates-io] tokio = { path =
  "tokio" }`); the edge cites both lines. As in Cargo, a patch is used only when the patched
  crate's version (its `[workspace.package]` one when inherited, `0.0.0` when absent) satisfies the
  dependent's requirement, prereleases included. A patch path outside the repository is never
  followed; one naming no scanned crate, or whose version no scanned crate's normal dependency
  accepts, records nothing — all three are listed in `analysis.limitations`. Every
  Cargo.toml form (literal strings, quoted and dotted keys, multi-line inline tables) is read by the
  one Cargo reader, `parseCargoManifest`.
- **Declarations without a name** — a syntax error the parser recovers from with a missing
  identifier (`export default interface {}`, `enum {}` in babel's parser fixtures) — become code
  entities named `default` (a default export) or `anonymous <kind>`, never a blank name. A name
  over the gate's 160 characters is shortened for display with an ellipsis (a file-component keeps
  its path tail); ids still derive from the full path/symbol and `sourceRefs.symbol` is never cut.
- **Single-package repos** (no workspace members) become **one root container**, named and
  evidenced from the root `package.json` (falling back to the directory name). The synthetic
  `tooling` container only appears when non-member scripts sit beside real workspace members.
- **Unresolved relative imports** (no relation recorded, no tracked file named) are listed in
  `analysis.limitations` with file:line and specifier (capped). A target inside a `node_modules`
  directory is never listed: the scanner does not model package-manager contents, and never reads
  the disk for it, so a local checkout and a tarball agree.
- **Extensions:** `.ts/.tsx/.mts/.cts/.js/.mjs/.cjs/.jsx/.rs` are scanned. In a TypeScript repo
  (root tsconfig *or* any TypeScript source) a `.js` file is left out when it sits under a
  `test/`, `tests/`, `fixture(s)/`, `__fixtures__/`, `vendor/` or `third_party/` directory
  (whole segment), is `*.min.js`, or is compiled output beside a same-stem `.ts`/`.tsx` in its
  directory (a `.d.ts` alone does not count). Those are **counted by reason in
  `analysis.limitations`**, never dropped silently. A pure-JS repo scans every `.js`.
- **Excluded** (a named, tested list): `*.d.ts`, `dist/`, `*.test.*`, `*.spec.*`, `*.bench.*`,
  `__tests__/`, `__mocks__/`, `testdata/` (conventional test-data dirs; count reported in
  `analysis.limitations`), Rust `tests/` / `benches/` / `examples/` / `*_qa.rs`.
- **Fixture members** whose path matches `playground/example/e2e/fixtures/demo/sandbox` are skipped
  by default (with a summary count); pass `--include-members` to scan them.
- **System name** comes from the root `package.json` `name` (fallback: directory basename).

The scan prints a summary of everything it left out (skipped `.js` by reason, skipped members,
unresolved relative imports) so
omissions are always visible. Large repos currently stress the *scene compile* (edge routing),
not the deterministic extraction — scoped compilation is tracked separately.

## Optional lcov sidecar (L4 health — untested ranges)

If an `lcov.info` sidecar is present, the scan overlays **untested instrumented line ranges**
onto overlapping L4 code entities and a **file-level hit rate** ("this file 30%"). No extra
nodes. Same facts flow to the inspector and WebMCP/Ask.

- `--lcov <path>` points at an lcov.info file (cwd or scan-root relative, or absolute).
- Without `--lcov`, the scan looks under the scan root for `coverage/lcov.info`, then
  `lcov.info`, then `coverage/lcov/lcov.info` (first existing file wins).
- **No sidecar → omit coverage.** Cyclomatic complexity and clone `duplicates` still overlay.
  Do not invent 0%. Files that are not in the report stay omitted. Observed 0% from the
  sidecar (LH=0, LF>0) is kept.
- Coverage is a scan-time overlay, never `ArchitectureExtraction` input. There is no CRAP
  headline score.

## Source text is not sanitized

**Source excerpts are not sanitized.** Anything committed in the lines an atlas shows, including secrets,
appears verbatim. Review a repository's committed content before publishing an atlas of it.

- **Code snippets: always on.** Every scan writes bounded windows of the referenced JavaScript, TypeScript and Rust
  declarations into `snapshot.json` and `atlas.okie.json` (`sourceExcerpts`). No flag turns them off. The hosted
  operator scan writes them too, and export and publish carry the captured snapshot and its excerpt packets as they
  are. The only scrub is GitHub-token shapes (`ghp_…`, `github_pat_…`); API keys, passwords and connection strings
  stay as written.
- **Full files: `--include-source`, off by default.** Only the CLI sets it; the hosted operator and legacy scan paths
  never do. It adds `sources` to `atlas.okie.json`: the raw text of every referenced file, including referenced
  manifests (`package.json`, `Cargo.toml`, `README.md`, `pnpm-workspace.yaml`), with no scrub at all. A secret
  written in a manifest appears verbatim there, even though the dependency facts redact it.
- **What is redacted.** These fields strip URL userinfo, query strings, credential-looking fragments and token
  shapes; dependency-fact specs and Cargo `[patch]` paths also replace an absolute local path with `<absolute path>`.
  (Diagnostic lines rewrite only the known machine prefixes such as the checkout, scratch and home directories;
  other absolute paths in them are not replaced.)
  - requested specs in dependency facts (`git:`, `npm:` aliases, `path:` and `file:` wrappers included);
  - Cargo `[patch]` keys and paths;
  - other limitation and diagnostic lines (unresolved imports, Cargo and rust-analyzer errors, TypeScript
    diagnostics).

  A Cargo version requirement the scanner cannot parse, or not written in a syntax Cargo accepts (a leading zero, an
  empty prerelease or build identifier), is shown as `[unsupported requirement]` in dependency facts and `[patch]` lines; the package name and
  manifest `path:line` stay. A resolved lockfile version (npm or Cargo) that is not strict semver is shown as `[unsupported
  version]`. A
  `package.json` `name` that npm would refuse is never used as a name or ID: the unit keeps its directory name and
  the scan reports `Invalid package name at <manifest>:<line>`. This covers only those structured fields. It does not
  guarantee that an atlas is free of secrets.
- **Known limitation: numeric password before a raw `/`.** A malformed URL whose unencoded password is all digits
  (at most 65535) and is followed by `/` (`https://user:12345/x@host/…`) cannot be told from `host:port/path@…`, the
  shape of a valid scoped tarball URL (`https://registry:8443/@scope/pkg/-/pkg-1.0.0.tgz`), and is not redacted.
  Redaction of malformed URLs is not comprehensive.
- **Not redacted: repository paths.** Committed file and directory paths (`sourceRefs`, evidence, entity paths and
  the IDs derived from them) are kept exactly as committed, like source text. A path that itself contains a
  credential appears verbatim there.

## Determinism

Output is byte-identical across shuffled discovery order: IDs derive from canonical source
identity (path/symbol) with collision suffixes assigned by canonical sort, and
`adaptArchitectureExtraction` + `compileC4Scene` re-sort everything by ID. `git ls-files`
order, filesystem order, and iteration order cannot affect the bytes.

## GitHub acquisition (R3 — paste a repo, get an atlas)

`sourcefor-atlas --source gh:owner/repo[@ref]` scans a public repository with no local clone:

1. **Resolve** the ref to an immutable commit via the GitHub REST API (unauthenticated).
   No ref → the repo's `default_branch`. Falls back to the `gh` CLI transparently on a
   rate-limit/403/private-404 (uses the operator's stored auth). **No tokens are read from
   env or embedded, and messages are scrubbed before logging.**
2. **Fetch** the codeload `tar.gz` at that SHA into a temp dir (capped — default 150 MB,
   `--max-tarball-mb`), extract, scan, **discard**. Nothing long-lived; the commit/tree SHA
   is the identity (the [scan-runner](../../docs/roadmap/scan-runner.md) checkout strategy).
3. **Pin** `commitSha` + `treeSha` from the API; `generatedAt` = the commit's **committer
   date** (never wall-clock), so two scans of the same source at the same SHA are
   **byte-identical** across all six artifacts.

A tarball has no `.git`, so discovery walks the extracted tree (`discoverExtractedTree`)
through the **same** filter/assembly core as the `git ls-files` path (`discoverFromFiles`).
A GitHub archive already contains exactly the committed tree at the SHA (untracked/gitignored
content was never archived), so a plain walk reproduces gitignore-aware discovery without
parsing `.gitignore`. **Divergence to note:** `git archive` honors `.gitattributes
export-ignore`, so a rare export-ignored-but-tracked path is present under a local scan yet
absent from a tarball. Failure modes are explicit and non-fatal to the CLI: repo/ref not
found, rate-limited (with the `gh`-fallback hint), tarball over cap, and a non-TS/JS repo
(0 candidate files → a message naming the extension policy).

## Multi-repo output + serving

A local scan still writes to `fixtures/scan/` (the Okie self-scan — unchanged, back-compat).
A `gh:` scan writes to **`fixtures/scan/<owner>__<repo>/`** and (re)writes a deterministic
**`fixtures/scan/index.json`** manifest — a slug-sorted list of
`{slug, repositoryId, commitSha, generatedAt, entityCount}` over every per-repo slot, so
multiple scanned repos coexist.

The web app selects a scanned repo on the already-preserved `fixture` query param:
`?fixture=scan` loads the root self-scan; **`?fixture=scan:<slug>`** loads
`fixtures/scan/<slug>/`. Riding the `fixture` param (rather than a new `repo=` key, which
would collide with the reserved navigation `repo` = repositoryId) keeps the selector in the
URL across reload/share **without touching the pinned navigation machinery**. An unknown slug
fails closed to the full-page scan error listing the available slugs. This per-repo
storage/URL shape is what a future hosted embed (a static app build + per-repo trio assets +
manifest picker) builds on.

## Enrichment (R2a — agents propose, validators dispose)

R1 produces file-components (deterministic structural truth). Live packet enrichment
asks for **section summaries** of scanner-scoped containers/components (and optionally
one code entity). Those documents merge only if the existing enrichment gate accepts
them; hallucinated ids and out-of-scope entities reject that scope and it stays
deterministic. Recorded regrouping / actor documents still merge when they satisfy
the gate.

- `sourcefor-atlas --emit-packets <dir>` writes one bounded, **redacted** packet per code-bearing
  container (`container__<id>.json`) plus a content-addressed `manifest.json`. A packet contains
  only that container's scope — its file-components, code entities (id/name/symbol/line ranges),
  touching relations, and capped file headers. Never a byte from outside the scope. It also writes
  one repo-wide **system packet** (`system__<id>.json`, see below). A container whose code-bearing
  file-components exceed `MAX_COMPONENTS_PER_PACKET` (`maxListItems − 3` = 61) emits additional
  remainder packets (`container__<id>.2.json`, …) covering the leftover scanner ids. The cap
  does not drop files. Empty components (no top-level declaration) still have no packet rows.
- `sourcefor-atlas --emit-prompt <dir>` is concat sugar on that same loop (local working tree only). It
  writes the **same packet files** as `--emit-packets`, plus one `<packet>.prompt.md` per packet.
  Each prompt is the frozen [`enrichment-prompt.md`](./enrichment-prompt.md) bytes, then the packet
  JSON, then an appendix (scanned `commitSha` / `treeHash`, packet filename, file tree, ownership
  tree, and optional observed CODEOWNERS `pathOwners`). The appendix is data, not new instructions. Same scan SHA → byte-identical prompt+packet
  files. See [`.cursor/skills/okie-enrich/SKILL.md`](../../.cursor/skills/okie-enrich/SKILL.md).
  Packets that carry observed lcov `untestedRanges` stamp `okie-enrichment/v3` and concatenate
  [`enrichment-prompt-v3.md`](./enrichment-prompt-v3.md) instead. Frozen v2
  (`enrichment-prompt.md`) is not rewritten. v3 may name **untested behaviours** in
  `untestedBehaviours` grounded in those ranges + `nearbyTests`. Without ranges, omit that
  field — do not invent coverage or a CRAP headline. Hallucinated ranges fail the merge gate.
- `sourcefor-atlas --enrich-from <dir>` reads one `ArchitectureExtraction` per packet (and, optionally,
  one keyed by the **system id**) and merges the accepted ones, emitting `enrichment-report.json`.
  Write each document with the **same filename as the packet**, including remainder
  `container__<id>.2.json`. Multiple accepted summary docs for one container **union** their
  `responsibility` prose. See [`enrichment-prompt.md`](./enrichment-prompt.md) for the v2 agent
  contract (`okie-enrichment/v2`) and [`enrichment-prompt-v3.md`](./enrichment-prompt-v3.md) when
  packets carry observed untested ranges (`okie-enrichment/v3`).

### System-scope enrichment (R2b — top-level actors)

Track A derives external *systems* deterministically, but the **persons** at the edge (User,
Developer, AI Agent (MCP), CI…) are judgement, not parsing. The **system packet** carries the
top-level shape — the container list, the deterministic external systems, and short README
teasers — with a `scopePaths` allowlist (the READMEs + container evidence anchors). A
system-scope document (keyed by the system id) may attach section summaries (`responsibility`)
on the restated system/containers, and may still ADD `person` entities plus person-touching
relations. It may **not** add or mutate a component, code, or unknown container, and it may
not author non-person (structural) edges. Any violation rejects the **whole** document
atomically (the deterministic base still publishes).

Each document is validated **atomically** — any failure leaves that scope on the deterministic
file-component base (deterministic always publishes):

1. **Gate** — `validateArchitectureExtraction` must return `[]`.
2. **Scope** — every cited path is inside the packet's scope. Hallucinated ids reject the document.
3. **Observed-facts immutability** — restated code must exist in the base with byte-identical
   `name` + `sourceRefs` (path/symbol/lines). Summaries may add `responsibility` only.
4. **Summaries vs regrouping** — a summary document restates scanner-scoped container/component
   ids (code optional, no re-parent). A regrouping document must still re-parent exactly the
   container's code entities (total partition) into new logical components.

### Chosen representations (documented per the extraction-gate contract)

- **Full-subtree restatement.** The gate resolves parents within the document, so a proposal
  restates `{system, container, proposed components, re-parented code}`. System/container are
  structural anchors (id-matched, content ignored — the base wins).
- **File cohesion.** All code entities of one path must share a proposed parent (group whole files,
  never split a file's symbols). This is the natural logical granularity **and** makes the
  file→logical mapping a function, so the merge can remap the deterministic intra-container
  file→file import edges to **logical→logical** (dedup + drop self-loops), preserving the dependency
  graph. `container→container` edges pass through unchanged.
- **Empty components** (files with no top-level declaration, e.g. a re-export barrel) are not
  enrichment targets; they remain deterministic file-components. On this repo that is
  `apps/web/src/inspector/inspectorSupport.ts`, not `vite.config.ts` (which is code-bearing).

Merging is order-independent (accepted proposals apply in canonical container-id order; entities
and relations re-sort by id) and reads no wall-clock/randomness, so the same base + documents
always yield byte-identical output (recorded-replay class).
