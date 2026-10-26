#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, resolve } from "node:path";
import { buildEnrichmentPackets, containerIdFromFileName, ENRICHMENT_PROMPT_VERSION_V3 } from "./packet.js";
import { GithubAcquisitionError, isGithubSource, parseGithubSource, type GithubSourceRef } from "./github.js";
import { regenerateScanManifest } from "./manifest.js";
import { readFrozenEnrichmentPrompt, writeEnrichmentPackets, writePromptEmission } from "./prompt.js";
import { readCodeOwners } from "./codeowners.js";
import { coverageByCodeIdFromSnapshot } from "./lcov.js";
import { acquireCommittedTree } from "./pin.js";
import { scanAcquiredRepository, scanGithubRepository, scanOutputFiles, stableJson, type ScanArtifacts, type ScanOptions } from "./scan.js";
import { serializePortableAtlas } from '@okie/architecture';
import { runPackageViewer } from './package-viewer.js';
import { enrichPortableAtlas } from './portable-enrich.js';
import { parsePortableAtlas } from '@okie/architecture';
import { applyComponentMembership, type ComponentMapInput } from './component-map.js';
import { runConsumersQuery } from './consumers-cli.js';
import { product, productVersion } from './product.js';
import { rustParserUnavailable } from './analyzers.js';

interface CliArgs {
  source: string;
  github?: GithubSourceRef;
  out: string;
  /** Parent scan directory whose per-repo slots the manifest indexes (gh mode). */
  scanRoot?: string;
  options: ScanOptions;
  emitPacketsDir?: string;
  emitPromptDir?: string;
  enrichFromDir?: string;
  maxTarballBytes?: number;
  lcovPath?: string;
  repositoryUrl?: string;
  componentMapPath?: string;
}

function printUsage(): void {
  const pad = " ".repeat(product.bin.length);
  process.stdout.write([
    `${product.bin} ${productVersion()} — architecture atlas from a repository's committed source (${product.packageName})`,
    "",
    `Usage: ${product.bin} [--source <path | gh:owner/repo[@ref]>] [--out <dir>]`,
    `       ${pad} [--system-name <name>] [--repo <slug>] [--max-tarball-mb <n>]`,
    `       ${pad} [--emit-packets <dir>] [--emit-prompt <dir>] [--enrich-from <dir>]`,
    `       ${pad} [--revision <rev>] [--component-map <path>] [--include-members] [--public-api] [--lcov <path>]`,
    `       ${product.bin} export --bundle <atlas.okie.json> --out <empty-dir> [--viewer <built-dir>]`,
    `       ${product.bin} enrich --bundle <atlas.okie.json> --docs <enrichment-dir> --out <atlas.okie.json>`,
    `       ${product.bin} consumers <dependency> --bundle <atlas.okie.json> [--ecosystem npm|cargo] [--json] [--runtime-only]`,
    "",
    "  --source <src>      local git working tree, or gh:owner/repo[@ref] (default: cwd)",
    "  --out <dir>         output directory (default: <source>/fixtures/scan for a local",
    "                      scan; fixtures/scan/<owner>__<repo> for a gh: source)",
    "  --system-name       display name for the software system (default: derived)",
    "  --repo <slug>       repository slug for snapshot/repo IDs (default: derived)",
    "  --revision <rev>    local Git revision to scan (default: HEAD)",
    "  --component-map <p> explicit JSON component membership map; local external input is hash-pinned in component-map-report.json",
    "  --full / --quick    semantic analyzers (default) or syntax-only scan; limits are recorded",
    "  --include-source   include full referenced files in atlas.okie.json (snippets are always retained)",
    "                     SOURCE TEXT IS NOT SANITIZED: code snippets are always written (only GitHub-token",
    "                     shapes are scrubbed) and --include-source adds referenced files, manifests included,",
    "                     byte for byte. Committed secrets appear verbatim; review before publishing.",
    "  --repository-url <https-url>  explicit public repository URL to embed for a local scan",
    "  export              package a static atlas site (default viewer: the one bundled with this CLI)",
    "  enrich              merge agent-written enrichment docs into a portable atlas",
    "  consumers           who declares/imports/references a dependency (declarations alone are not use)",
    "  --max-tarball-mb    cap on a gh: tarball download (default: 150)",
    "  --emit-packets <d>  (local only) write bounded, redacted enrichment packets to <d>",
    "  --emit-prompt <d>   (local only) write packets plus concatenated prompts to <d>",
    "  --enrich-from <d>   read enrichment docs (same filenames as packets, including remainder `*.2.json`) from <d>, merge accepted",
    "  --include-members   scan fixture/example/playground/e2e workspace members too",
    "  --public-api        L4 code entities cover only the export surface (CLI opt-in;",
    "                      hosted /new uses the same default as the CLI: all top-level declarations)",
    "  --lcov <path>       optional lcov.info sidecar (untested ranges + file hit rate).",
    "                      Default lookup: coverage/lcov.info, lcov.info, coverage/lcov/lcov.info",
    "                      under the scan root. No sidecar → omit coverage; keep complexity + clones.",
    "",
  ].join("\n"));
}

function parseArgs(argv: readonly string[]): CliArgs {
  let source = process.cwd();
  let out = "";
  let emitPacketsDir: string | undefined;
  let emitPromptDir: string | undefined;
  let enrichFromDir: string | undefined;
  let maxTarballBytes: number | undefined;
  let lcovPath: string | undefined;
  let repositoryUrl: string | undefined;
  let componentMapPath: string | undefined;
  const options: ScanOptions = { analysisMode: 'full' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--source": source = next(); break;
      case "--out": out = next(); break;
      case "--system-name": options.systemName = next(); break;
      case "--repo": options.repositorySlug = next(); break;
      case "--revision": options.revision = next(); break;
      case "--component-map": componentMapPath = next(); break;
      case "--quick": options.analysisMode = 'quick'; break;
      case "--full": options.analysisMode = 'full'; break;
      case "--include-source": options.includeSource = true; break;
      case "--repository-url": repositoryUrl = validatedRepositoryUrl(next()); break;
      case "--max-tarball-mb": {
        const mb = Number.parseFloat(next());
        if (!Number.isFinite(mb) || mb <= 0) throw new Error("--max-tarball-mb must be a positive number");
        maxTarballBytes = Math.round(mb * 1024 * 1024);
        break;
      }
      case "--emit-packets": emitPacketsDir = next(); break;
      case "--emit-prompt": emitPromptDir = next(); break;
      case "--enrich-from": enrichFromDir = next(); break;
      case "--include-members": options.includeAllMembers = true; break;
      case "--public-api": options.codeSurface = "public"; break;
      case "--lcov": lcovPath = next(); break;
      case "--help": case "-h": printUsage(); process.exit(0); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (isGithubSource(source)) {
    const github = parseGithubSource(source);
    if (!github) throw new Error(`Invalid gh source “${source}” — expected gh:owner/repo[@ref]`);
    const resolvedOut = out ? resolve(out) : resolve(process.cwd(), "fixtures/scan", github.dirSlug);
    return {
      source,
      github,
      out: resolvedOut,
      scanRoot: dirname(resolvedOut),
      options,
      ...(enrichFromDir ? { enrichFromDir: resolve(enrichFromDir) } : {}),
      ...(emitPacketsDir ? { emitPacketsDir: resolve(emitPacketsDir) } : {}),
      ...(emitPromptDir ? { emitPromptDir: resolve(emitPromptDir) } : {}),
      ...(maxTarballBytes ? { maxTarballBytes } : {}),
      ...(lcovPath ? { lcovPath } : {}),
      ...(repositoryUrl ? { repositoryUrl } : {}),
      ...(componentMapPath ? { componentMapPath: resolve(componentMapPath) } : {}),
    };
  }

  const resolvedSource = resolve(source);
  return {
    source: resolvedSource,
    out: out ? resolve(out) : resolve(resolvedSource, "fixtures/scan"),
    options,
    ...(emitPacketsDir ? { emitPacketsDir: resolve(emitPacketsDir) } : {}),
    ...(emitPromptDir ? { emitPromptDir: resolve(emitPromptDir) } : {}),
    ...(enrichFromDir ? { enrichFromDir: resolve(enrichFromDir) } : {}),
    ...(maxTarballBytes ? { maxTarballBytes } : {}),
    ...(lcovPath ? { lcovPath } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(componentMapPath ? { componentMapPath: resolve(componentMapPath) } : {}),
  };
}

function validatedRepositoryUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("--repository-url must be an HTTPS URL without credentials"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("--repository-url must be an HTTPS URL without credentials");
  return url.toString();
}

/** Reads packet-named enrichment docs, grouping remainder `*.2.json` onto the same container. */
function readEnrichmentDocs(dir: string): Map<string, unknown> {
  const docs = new Map<string, unknown[]>();
  for (const file of readdirSync(dir).sort()) {
    if (file === "manifest.json" || file === "enrichment-report.json") continue;
    const containerId = containerIdFromFileName(file);
    if (!containerId) continue;
    const text = readFileSync(`${dir}/${file}`, "utf8");
    let value: unknown;
    try { value = JSON.parse(text); } catch { value = text; }
    const bucket = docs.get(containerId) ?? [];
    bucket.push(value);
    docs.set(containerId, bucket);
  }
  const unwrapped = new Map<string, unknown>();
  for (const [containerId, bucket] of docs) {
    unwrapped.set(containerId, bucket.length === 1 ? bucket[0]! : bucket);
  }
  return unwrapped;
}

/** Writes the six-artifact trio, story catalog, and optional enrichment report. */
function writeArtifacts(out: string, artifacts: ScanArtifacts, repositoryUrl?: string): void {
  mkdirSync(out, { recursive: true });
  const generator = { name: product.packageName, version: productVersion() };
  for (const [name, text] of Object.entries(scanOutputFiles(artifacts, repositoryUrl, generator))) writeFileSync(`${out}/${name}`, text);
  if (artifacts.componentMapReport && !artifacts.componentMapReport.accepted) process.exitCode = 1;
  // A missing native parser degrades Rust to `unavailable` (recorded in the atlas); say so once, never fail.
  const noRustParser = artifacts.analysis.adapters.some(adapter => adapter.language === "rust") ? rustParserUnavailable() : undefined;
  if (noRustParser) process.stderr.write(`${product.bin}: warning: Rust is not mapped. ${noRustParser}\n`);
}

/** CLA-263 membership warnings, capped like the folded-shim list (full list in membership-report.json). */
function membershipWarningLines(diagnostics: ScanArtifacts["membership"]["diagnostics"]): string {
  const shown = diagnostics.slice(0, 5).map(diagnostic => `  warning [${diagnostic.code}]: ${diagnostic.message}\n`).join("");
  return diagnostics.length > 5 ? `${shown}  ... ${diagnostics.length - 5} more membership warning(s) (see membership-report.json)\n` : shown;
}

/** What a repo without JS workspace members became: a root container and/or Rust crate containers. */
function singlePackageModeNote(snapshot: ScanArtifacts["snapshot"], rustCrates: number): string {
  if (rustCrates === 0) return "  single-package repo (no workspace) -> one root container\n";
  const hasRoot = snapshot.entities.filter(entity => entity.kind === "container").length > rustCrates;
  return `  no JS workspace members -> ${hasRoot ? "one root container + " : ""}${rustCrates} Rust crate container(s)\n`;
}

function summaryLines(artifacts: ScanArtifacts): string {
  const { snapshot, pin, enrichmentReport, discoverySummary } = artifacts;
  const enrichedNote = enrichmentReport
    ? `  enriched ${enrichmentReport.enrichedContainers.length}/${enrichmentReport.results.length} containers (see enrichment-report.json)\n`
    : "";
  const systemScopeNote = enrichmentReport?.systemScope
    ? (enrichmentReport.systemScope.accepted
      ? `  system-scope: added ${enrichmentReport.systemScope.persons} actor(s) + ${enrichmentReport.systemScope.relations} relation(s)\n`
      : `  system-scope: rejected (${enrichmentReport.systemScope.reasons.length} reason(s), see enrichment-report.json)\n`)
    : "";
  // Never hide what was left out — surface the redaction/omission decisions.
  const modeNote = discoverySummary.singlePackage ? singlePackageModeNote(snapshot, discoverySummary.rustCrates ?? 0) : "";
  const membersNote = discoverySummary.skippedMembers.length > 0
    ? `  skipped ${discoverySummary.skippedMembers.length} fixture/example member(s): ${discoverySummary.skippedMembers.slice(0, 5).join(", ")}${discoverySummary.skippedMembers.length > 5 ? " ..." : ""} (--include-members to scan)\n`
    : "";
  const limitationsNote = (artifacts.analysis.limitations ?? []).map(line => `  ${line}\n`).join("");
  const aliases = artifacts.membership.reexportAliases;
  const aliasNote = (aliases.length > 0
    ? `  folded ${aliases.length} re-export shim(s) into their target's container: ${aliases.slice(0, 5).map(alias => `${alias.path} -> ${alias.target}`).join(", ")}${aliases.length > 5 ? " ..." : ""} (see membership-report.json)\n`
    : "") + membershipWarningLines(artifacts.membership.diagnostics);
  const coverageCount = snapshot.entities.filter(entity => entity.coverageFileHitRate !== undefined).length;
  const coverageNote = coverageCount > 0
    ? `  lcov sidecar: ${coverageCount} code entit${coverageCount === 1 ? "y" : "ies"} with file hit rate / untested ranges\n`
    : "";
  const flowNote = artifacts.stories.length > 1
    ? `  stories: ${artifacts.stories.length} (overview + ${artifacts.stories.length - 1} user-flow)\n`
    : "  stories: 1 (overview)\n";
  const mapping = artifacts.componentMapReport;
  const mappingNote = !mapping ? "" : mapping.accepted
    ? `  component map: accepted (${mapping.mappedComponents} components, ${mapping.mappedPaths} files; see component-map-report.json)\n`
    : `  component map: REJECTED; retained original file graph (see component-map-report.json)\n${mapping.reasons.map(reason => `    ${reason}\n`).join('')}`;
  return `${product.bin}: ${snapshot.entities.length} entities, ${snapshot.relations.length} relations\n` +
    `  commit ${pin.commitSha}\n  tree   ${pin.treeHash}\n` +
    modeNote + membersNote + limitationsNote + aliasNote + coverageNote + flowNote + enrichedNote + systemScopeNote + mappingNote;
}

/** Rewrites <scanRoot>/index.json to index every per-repo scan slot deterministically. */
function refreshManifest(scanRoot: string): number {
  const manifest = regenerateScanManifest(scanRoot);
  mkdirSync(scanRoot, { recursive: true });
  writeFileSync(`${scanRoot}/index.json`, stableJson(manifest));
  return manifest.repos.length;
}

function resolveExplicitLcovPath(sourceRoot: string | undefined, lcovPath: string): string {
  if (isAbsolute(lcovPath)) return lcovPath;
  const fromCwd = resolve(lcovPath);
  if (existsSync(fromCwd)) return fromCwd;
  if (sourceRoot) {
    const fromSource = resolve(sourceRoot, lcovPath);
    if (existsSync(fromSource)) return fromSource;
  }
  return fromCwd;
}

function readExplicitLcov(sourceRoot: string | undefined, lcovPath: string): string {
  const resolved = resolveExplicitLcovPath(sourceRoot, lcovPath);
  try {
    return readFileSync(resolved, "utf8");
  } catch {
    throw new Error(`--lcov file not found: ${lcovPath}`);
  }
}

function readComponentMap(path: string): ComponentMapInput {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch { throw new Error(`--component-map file not found: ${path}`); }
  let document: unknown;
  try { document = JSON.parse(text); } catch { throw new Error(`--component-map is not valid JSON: ${path}`); }
  return { document, provenance: { kind: 'external', path, sha256: createHash('sha256').update(text).digest('hex') } };
}

async function runGithubScan(args: CliArgs): Promise<void> {
  const github = args.github!;
  if (args.emitPacketsDir || args.emitPromptDir) {
    process.stderr.write(`${product.bin}: --emit-packets/--emit-prompt is local-only (needs the working tree); skipping for gh source.\n`);
  }
  const scanOptions = {
    ...args.options,
    ...(args.enrichFromDir ? { enrichmentDocs: readEnrichmentDocs(args.enrichFromDir) } : {}),
    ...(args.maxTarballBytes ? { maxTarballBytes: args.maxTarballBytes } : {}),
    ...(args.lcovPath ? { lcovText: readExplicitLcov(undefined, args.lcovPath) } : {}),
    ...(args.componentMapPath ? { componentMap: readComponentMap(args.componentMapPath) } : {}),
  };
  const { artifacts, commitSha } = await scanGithubRepository(github, scanOptions);
  writeArtifacts(args.out, artifacts, `https://github.com/${github.owner}/${github.repo}`);
  const manifestCount = args.scanRoot ? refreshManifest(args.scanRoot) : 0;
  process.stdout.write(
    summaryLines(artifacts) +
    `  source gh:${github.owner}/${github.repo}${github.ref ? `@${github.ref}` : ""} -> ${commitSha.slice(0, 12)}\n` +
    `  wrote snapshot/view/story/stories/scene/timeline to ${args.out}\n` +
    `  manifest: ${manifestCount} repo(s) indexed in ${args.scanRoot}/index.json\n` +
    `  load in the app at /r/${github.owner}/${github.repo} or ?fixture=scan:${github.dirSlug}\n`,
  );
}

function runLocalScan(args: CliArgs): void {
  const scanOptions: ScanOptions = { ...args.options };
  if (args.enrichFromDir) scanOptions.enrichmentDocs = readEnrichmentDocs(args.enrichFromDir);
  if (args.lcovPath) scanOptions.lcovText = readExplicitLcov(args.source, args.lcovPath);
  if (args.componentMapPath) scanOptions.componentMap = readComponentMap(args.componentMapPath);

  const acquired = acquireCommittedTree(args.source, scanOptions.revision);
  try {
    const artifacts = scanAcquiredRepository(acquired, scanOptions);
    writeArtifacts(args.out, artifacts, args.repositoryUrl);

    if (args.emitPromptDir || args.emitPacketsDir) {
      const readFile = (repoRelativePath: string): string => readFileSync(`${acquired.root}/${repoRelativePath}`, "utf8");
      const coverageByCodeId = coverageByCodeIdFromSnapshot(artifacts.snapshot.entities);
      // Packets target the accepted mapped baseline, never post-enrichment
      // regrouping output. This keeps replay packets aligned with the next merge.
      const packetExtraction = scanOptions.componentMap
        ? applyComponentMembership(artifacts.baseExtraction, scanOptions.componentMap).extraction
        : artifacts.baseExtraction;
      const emitted = buildEnrichmentPackets(packetExtraction, readFile, { coverageByCodeId });
      if (args.emitPromptDir) {
        writePromptEmission(
          args.emitPromptDir,
          emitted,
          artifacts.pin,
          {
            v2: readFrozenEnrichmentPrompt(),
            v3: readFrozenEnrichmentPrompt(ENRICHMENT_PROMPT_VERSION_V3),
          },
          readCodeOwners(readFile)?.rules ?? [],
        );
      }
      if (args.emitPacketsDir && args.emitPacketsDir !== args.emitPromptDir) {
        writeEnrichmentPackets(args.emitPacketsDir, emitted);
      }
    }

    const packetNote = args.emitPacketsDir ? `  wrote enrichment packets to ${args.emitPacketsDir}\n` : "";
    const promptNote = args.emitPromptDir ? `  wrote enrichment prompts to ${args.emitPromptDir}\n` : "";
    process.stdout.write(summaryLines(artifacts) + packetNote + promptNote + `  wrote snapshot/view/story/stories/scene/timeline to ${args.out}\n`);
  } finally {
    acquired.cleanup();
  }
}

function runPortableEnrichment(args: readonly string[]): void {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key || !["--bundle", "--docs", "--out"].includes(key) || !value || value.startsWith("--")) {
      throw new Error(`Usage: ${product.bin} enrich --bundle <atlas.okie.json> --docs <enrichment-dir> --out <atlas.okie.json>`);
    }
    values.set(key, value);
  }
  const bundlePath = values.get("--bundle");
  const docs = values.get("--docs");
  const out = values.get("--out");
  if (!bundlePath || !docs || !out) throw new Error("Enrich requires --bundle, --docs and --out.");
  const result = enrichPortableAtlas(parsePortableAtlas(readFileSync(bundlePath, "utf8")), readEnrichmentDocs(docs));
  writeFileSync(resolve(out), serializePortableAtlas(result.bundle));
  writeFileSync(`${resolve(out)}.enrichment-report.json`, stableJson(result.report));
  process.stdout.write(`Enriched portable atlas written to ${resolve(out)}; report written to ${resolve(out)}.enrichment-report.json.\n`);
}

async function main(): Promise<void> {
  if (process.argv[2] === 'export') { runPackageViewer(process.argv.slice(3)); return; }
  if (process.argv[2] === 'enrich') { runPortableEnrichment(process.argv.slice(3)); return; }
  if (process.argv[2] === 'consumers') { process.stdout.write(runConsumersQuery(process.argv.slice(3))); return; }
  const args = parseArgs(process.argv.slice(2));
  if (args.github) await runGithubScan(args);
  else runLocalScan(args);
}

main().catch((error: unknown) => {
  if (error instanceof GithubAcquisitionError) {
    process.stderr.write(`${product.bin}: ${error.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${product.bin}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
