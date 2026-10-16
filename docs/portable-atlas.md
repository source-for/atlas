# Local scans and the portable viewer

Portable v1 reads a committed Git revision, builds a deterministic atlas, and opens it in a static browser application. One repository is open at a time. No application server or LLM is required.

## Install

The CLI is the npm package `@sourcefor/atlas`, with one executable, `sourcefor-atlas`. It needs only Node 22+ and Git: no Rust toolchain and no Okie checkout. The package bundles the prebuilt portable viewer, so `export` works without building one.

Once the package is published, run it without installing:

```sh
npx @sourcefor/atlas --source /path/to/repo --quick --out /path/to/scan
```

`pnpm dlx @sourcefor/atlas …` works the same way. Until then, build the tarball from this checkout. `pnpm build:portable` compiles the WASM renderer, so first run `pnpm install` and have Rust 1.87 with the `wasm32-unknown-unknown` target and wasm-pack 0.13+ installed (see the root README):

```sh
pnpm build:portable
pnpm package:cli
cd dist/okie-cli
npm pack
```

Install that tarball into a local tools directory, for example `npm install --prefix /tmp/sourcefor-tools /absolute/path/to/sourcefor-atlas-0.1.0.tgz`. The executable is then `/tmp/sourcefor-tools/node_modules/.bin/sourcefor-atlas`; add that directory to PATH for the commands below. Nothing in these steps publishes a package.

The package includes the three reusable skills under `skills/`: `okie-scan`, `okie-enrich`, and `okie-package`. Point your agent at the relevant `SKILL.md`, or copy its directory into your agent's supported skill location. Its npm dependencies are pinned to exact versions and include the TypeScript compiler and the native Rust syntax parser (`tree-sitter`, with prebuilt binaries for macOS, Linux and Windows on x64 and arm64). On a platform without a prebuilt parser, scans still succeed: Rust is recorded as `unavailable` and the CLI prints one warning. Rust semantic indexing additionally needs `rust-analyzer` and `rust-src` from a matching Rust toolchain.

**Contributors on pnpm 10.** This repository pins pnpm 11.10 in `packageManager`. Run `corepack enable` (or `corepack pnpm …`). Corepack reads each project's `packageManager`, so this repo gets pnpm 11.10 and yours keeps its own. `npx` users need no pnpm.

## Scan a committed repository

```sh
sourcefor-atlas --source /path/to/repo --revision HEAD --full \
  --out /path/to/scan --emit-prompt /path/to/prompts
```

The scan materializes raw committed Git blobs in a temporary tree. It leaves local edits and untracked files alone and excludes them from the artifact. Source identity, evidence, excerpts and links all refer to the selected commit. V1 does not scan uncommitted snapshots. A committed symlink is never listed as a source file. One whose target resolves inside the repository is kept, so config reads and import resolution can follow it; escaping (absolute or `../`), dangling and looping links are never materialized (or are removed from a `gh:` tarball) and never read. Submodules are skipped. A local commit and a `gh:` tarball of it therefore leave the same tree. Counts appear in `analysis.limitations` (present only when non-empty), alongside files excluded under `testdata/` directories. Blobs are read in bounded chunks; a repository over 250,000 files, 2 GiB of blobs or a 256 MiB tree listing fails fast with a typed `ScanSizeLimitError` before any blob is read.

Open `/path/to/scan/atlas.okie.json` in the portable viewer. Existing snapshot/view/story outputs are also retained. Add `--include-source` to bundle full referenced source files; excerpts are included by default. Use `--repository-url https://github.com/owner/repo` for a local repository's source links. GitHub sources such as `--source gh:owner/repo@revision` include their canonical URL automatically.

`--full` requests TypeScript/JavaScript semantic resolution and Rust SCIP indexing. Missing package dependencies, configuration, inactive Rust targets or unavailable tooling can leave gaps. The isolated committed tree does not borrow potentially dirty workspace dependencies. Inspect `analysis.adapters[].limitations`, also available from the viewer's Analysis coverage disclosure. `--quick` explicitly uses syntax-only extraction. A reference is not automatically classified as a call; absent edges do not establish that code is unused. Python and Go semantic adapters are deferred.

`analysis.membership` is present only when discovery folded a re-export shim or found a container-membership warning. It lists `reexportAliases` (`{ path, target, unit }`: a file outside every workspace member that only re-exports `target`, counted in `target`'s container and never cited as evidence) and `diagnostics` (non-fatal `severity: "warning"` rows, currently `file-in-multiple-containers` and `reexport-across-containers`). Viewers accept any non-empty diagnostic code. The CLI writes the same report to `membership-report.json`.

## Optional enrichment

Load the `okie-enrich` skill with the original artifact, emitted prompts and matching repository. It guides the agent to add grounded descriptions in packet-named extraction documents. Merge those documents without rescanning:

```sh
sourcefor-atlas enrich --bundle /path/to/scan/atlas.okie.json \
  --docs /path/to/enrichment-docs --out /path/to/enriched.okie.json
```

Read the generated enrichment report next to the output. Invalid scopes are rejected and remain deterministic. The CLI command itself does not call an LLM; authoring the documents consumes agent capacity. Retaining prompts allows subsequent enrichment without another scan.

## Build a static viewer

From the Okie checkout:

```sh
pnpm build:portable
```

Serve `apps/web/dist-portable` with a static HTTP server to open the empty viewer and its local file picker/drop zone. Files are read in the browser. Browser storage is optional convenience storage; retain the JSON artifact as the durable copy. Replace opens another scan. Forget closes the active atlas and attempts to remove its remembered copy.

For a viewer that opens a bundled atlas directly:

```sh
sourcefor-atlas export --bundle /path/to/scan/atlas.okie.json --out /path/to/empty-site
python3 -m http.server 4175 --directory /path/to/empty-site
```

`export` uses the viewer bundled with the CLI. Pass `--viewer /path/to/okie/apps/web/dist-portable` to use another build; running the CLI from source, which has no bundled viewer, requires it. The bundled `viewer/manifest.json` lists the artifact formats the viewer opens and a hash of its files.

Open `http://localhost:4175`. The relative asset build also supports hosting under a subdirectory. Use HTTP hosting; direct `file://` opening is not supported. Each packaged directory and artifact version has its own browser storage slot, so a remembered scan cannot replace another site's packaged atlas accidentally.

The source tab shows frozen excerpts immediately and can display bundled full files. If an exact GitHub source URL is available, retrieval is an explicit user action. Hosted sign-in and Ask actions are omitted in portable mode. Exporting a folder does not upload or publish it.

## Artifact compatibility

The artifact is UTF-8 JSON with `format: "okie-atlas"` and `version: 1`. It contains the pinned repository identity, semantic snapshot, view, story catalog, analyzer coverage and optional full-file `sources`. An optional `generator: { name, version }` names the tool that wrote it (the CLI writes `@sourcefor/atlas` and its version); it is informational and does not change the format version. Renderer scenes are compiled by the viewer from those semantic inputs. Source excerpts remain on snapshot entities whether or not full files are included.

V1 imports are capped at 128 MiB and validated before compilation or persistence. Unsupported format versions, malformed model fields, unsafe file paths and mixed source revisions are rejected with an error. There is no implicit migration or best-effort version coercion. Future incompatible formats require a new version and an explicit validated migration or a matching viewer; retain the original artifact rather than rewriting it in place.
