---
name: okie-scan
description: Scan a committed repository into a portable Okie architecture atlas, reporting semantic analysis coverage and source evidence. Use when a user wants to map a local codebase or generate a scan artifact.
---

# Scan a repository

Use the installed `sourcefor-atlas` CLI (npm package `@sourcefor/atlas`). Inspect `sourcefor-atlas --help` for the available version. It needs Node 22+ and Git. This skill does not require an Okie server, an API key, or an LLM scan service.

Identify the requested repository and revision (default HEAD). A commit is required in v1. The CLI acquires committed bytes into an isolated tree; leave the user's checkout and uncommitted changes intact. Explain that those changes are excluded.

Run a full scan into a clearly named output directory:

```sh
sourcefor-atlas --source <repo> --revision <commit> --out <output> --full --emit-prompt <prompts>
```

TypeScript/JavaScript use the TypeScript compiler. Rust uses `rust-analyzer scip`; an installed Rust toolchain, rust-analyzer and rust-src are needed. If the CLI warns that Rust is not mapped (no tree-sitter native build for this platform), tell the user: Rust coverage is `unavailable` and only the TypeScript/JavaScript part is mapped. Missing dependencies or toolchains can reduce coverage. Do not claim a complete call graph from a successful command alone. `--quick` is the explicit syntax fallback. Python/Go semantic analysis is not part of v1.

Read `atlas.okie.json` and report its revision, `analysis.adapters` coverage/limitations, and output location. Check a representative symbol's source and relationships. Distinguish resolved calls from broader references and uncaptured relationships.

Snippets are included by default. Add `--include-source` when the user wants full repository files inside the artifact; otherwise source viewing retains excerpts and available commit links. Use `--repository-url <https-url>` when a local scan should link back to its repository.

The artifact is usable without enrichment. Recommend the optional `okie-enrich` skill for explanations; explain that enrichment uses agent capacity and run it only when requested. Retain emitted prompts for that later step. The separate `okie-package` skill prepares a static viewer; neither scanning nor packaging authorizes publication.
