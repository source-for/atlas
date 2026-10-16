import { ARCHITECTURE_EXTRACTION_LIMITS, type ArchitectureExtraction, compareText } from "@okie/architecture";
import { containerScopes } from "./scope.js";
import { scrubGithubTokens } from "./redact.js";
import type { EntityCoverageOverlay } from "./lcov.js";
import { nearbyTestsForCode, type NearbyTestExcerpt } from "./nearby-tests.js";

/** Frozen v2 prompt/packet contract. Unchanged by v3. */
export const ENRICHMENT_PROMPT_VERSION = "okie-enrichment/v2";
/** v3 adds observed untested ranges + nearby tests so enrich can name untested behaviours. */
export const ENRICHMENT_PROMPT_VERSION_V3 = "okie-enrichment/v3";

/**
 * Max file-components in one container packet. A summary document restates
 * system + container + these components (+ optional one code entity). Sized to
 * the extraction `maxListItems` budget (64) minus those three slots. Overflow
 * becomes additional packets (same OSS loop) — never truncated / silently dropped.
 */
export const MAX_COMPONENTS_PER_PACKET = ARCHITECTURE_EXTRACTION_LIMITS.maxListItems - 3;

/** Header lines included per scope file. Bounded redaction budget — in-scope only. */
const MAX_HEADER_LINES = 24;

/** README lines exposed to the system-scope packet (root gets more; per-container is a teaser). */
const MAX_SYSTEM_README_LINES = 8;
const MAX_CONTAINER_README_LINES = 2;

export interface PacketComponent {
  id: string;
  name: string;
  path: string;
}

export interface PacketCode {
  id: string;
  name: string;
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  componentId: string;
  /** Observed lcov file hit rate (0–1). Omitted without a sidecar for this file. */
  fileHitRate?: number;
  /** Observed untested instrumented ranges overlapping this symbol. */
  untestedRanges?: Array<{ startLine: number; endLine: number }>;
  /** Capped sibling-test excerpts that mention this symbol. Context, not scopePaths. */
  nearbyTests?: NearbyTestExcerpt[];
}

export interface PacketRelation {
  id: string;
  from: string;
  to: string;
  kind: string;
}

export interface PacketExcerpt {
  path: string;
  startLine: number;
  endLine: number;
  lines: string[];
}

/**
 * The bounded, redacted context handed to one enrichment agent. Contains ONLY the
 * container's own scope — never a byte from outside it.
 */
export interface EnrichmentPacket {
  promptVersion: string;
  containerId: string;
  containerName: string;
  scopePaths: string[];
  components: PacketComponent[];
  code: PacketCode[];
  relations: PacketRelation[];
  excerpts: PacketExcerpt[];
  /** 1-based chunk index; present only when this container split across packets. */
  chunkIndex?: number;
  /** Total packets for this container; present only when split. */
  chunkCount?: number;
}

export interface PacketManifestEntry {
  containerId: string;
  file: string;
  hash: string;
  components: number;
  codeEntities: number;
}

export interface PacketManifest {
  promptVersion: string;
  packets: PacketManifestEntry[];
  /** The system-scope packet entry (present when the base has a system root). */
  systemPacket?: PacketManifestEntry;
}

export interface BuildEnrichmentPacketsOptions {
  /**
   * Observed lcov overlay keyed by code entity id. Absent / empty → packets stay
   * `okie-enrichment/v2` and carry no coverage fields (do not invent 0%).
   */
  coverageByCodeId?: ReadonlyMap<string, EntityCoverageOverlay>;
}

export interface EmittedPackets {
  packets: EnrichmentPacket[];
  /** One repo-wide packet for proposing top-level actors (persons) + their relations. */
  systemPacket?: SystemPacket;
  manifest: PacketManifest;
}

export interface SystemPacketNode {
  id: string;
  name: string;
}

export interface SystemReadmeExcerpt {
  path: string;
  lines: string[];
}

/**
 * The bounded, repo-wide context handed to a system-scope enrichment agent. Carries only the
 * top-level shape — the container list, the deterministic external systems, and short README
 * teasers — so an agent can propose the human/AI actors (persons) that interact with the
 * system and how they relate to its containers. It exposes no source bytes beyond README
 * headers, and `scopePaths` is exactly the set an accepted proposal may cite.
 */
export interface SystemPacket {
  promptVersion: string;
  scope: "system";
  systemId: string;
  systemName: string;
  /** The only paths a person/relation may cite: READMEs + container evidence anchors. */
  scopePaths: string[];
  containers: SystemPacketNode[];
  externalSystems: SystemPacketNode[];
  readme: SystemReadmeExcerpt[];
}

/** FNV-1a 32-bit content hash — deterministic, content-addressed packet identity. */
export function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function stable(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function chunkItems<T>(items: readonly T[], size: number): T[][] {
  if (items.length === 0) return [];
  if (items.length <= size) return [items.slice()];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * Builds packets for every code-bearing container. A container whose file-components
 * fit `MAX_COMPONENTS_PER_PACKET` still emits one packet (byte-compatible). Overflow
 * emits additional remainder packets covering the leftover scanner ids — never dropped.
 * Empty components (no top-level declarations) are NOT enrichment targets.
 */
export function buildEnrichmentPackets(
  extraction: ArchitectureExtraction,
  readFile: (repoRelativePath: string) => string,
  options: BuildEnrichmentPacketsOptions = {},
): EmittedPackets {
  const scopes = containerScopes(extraction);
  const coverageByCodeId = options.coverageByCodeId;
  const relationsFor = (memberIds: ReadonlySet<string>): PacketRelation[] =>
    extraction.relations
      .filter(relation => memberIds.has(relation.from) || memberIds.has(relation.to))
      .map(relation => ({ id: relation.id, from: relation.from, to: relation.to, kind: relation.kind }))
      .sort((left, right) => compareText(left.id, right.id));

  const packets: EnrichmentPacket[] = [];
  for (const [containerId, scope] of [...scopes.entries()].sort(([left], [right]) => compareText(left, right))) {
    if (scope.codeBearing.length === 0) continue; // nothing to regroup

    const components: PacketComponent[] = scope.codeBearing.map(component => ({
      id: component.id,
      name: component.name,
      path: scope.pathByComponentId.get(component.id) ?? "",
    }));
    const code: PacketCode[] = scope.code.map(codeEntity => {
      const source = codeEntity.sourceRefs[0];
      const overlay = coverageByCodeId?.get(codeEntity.id);
      const nearbyTests = overlay?.untestedRanges?.length && source?.path
        ? nearbyTestsForCode(source.path, source.symbol, readFile)
        : [];
      return {
        id: codeEntity.id,
        name: codeEntity.name,
        path: source?.path ?? "",
        ...(source?.symbol !== undefined ? { symbol: source.symbol } : {}),
        ...(source?.startLine !== undefined ? { startLine: source.startLine } : {}),
        ...(source?.endLine !== undefined ? { endLine: source.endLine } : {}),
        componentId: codeEntity.parentId ?? "",
        ...(overlay ? { fileHitRate: overlay.fileHitRate } : {}),
        ...(overlay?.untestedRanges?.length ? { untestedRanges: overlay.untestedRanges.map(range => ({
          startLine: range.startLine,
          endLine: range.endLine,
        })) } : {}),
        ...(nearbyTests.length ? { nearbyTests } : {}),
      };
    });
    const excerptsByPath = new Map<string, PacketExcerpt>();
    for (const path of scope.scopePaths) {
      const lines = scrubGithubTokens(readFile(path).replace(/\r\n/g, "\n")).split("\n").slice(0, MAX_HEADER_LINES);
      excerptsByPath.set(path, { path, startLine: 1, endLine: lines.length, lines });
    }

    const chunks = chunkItems(components, MAX_COMPONENTS_PER_PACKET);
    const chunkCount = chunks.length;
    chunks.forEach((chunk, index) => {
      const componentIds = new Set(chunk.map(component => component.id));
      const chunkCode = code.filter(item => componentIds.has(item.componentId));
      // `component.path` remains the primary path for compatibility, while the
      // packet scope must retain every implementation path of mapped components.
      // Component mappings cap source refs at 32; excerpts remain bounded to 24
      // lines per retained file and are never silently omitted.
      const chunkPaths = [...new Set(chunk.flatMap(component => scope.pathsByComponentId.get(component.id) ?? []))].sort();
      const memberIds = new Set<string>([containerId, ...componentIds, ...chunkCode.map(item => item.id)]);
      const hasUntestedRanges = chunkCode.some(item => (item.untestedRanges?.length ?? 0) > 0);
      packets.push({
        promptVersion: hasUntestedRanges ? ENRICHMENT_PROMPT_VERSION_V3 : ENRICHMENT_PROMPT_VERSION,
        containerId,
        containerName: scope.container.name,
        scopePaths: chunkPaths,
        components: chunk,
        code: chunkCode,
        relations: relationsFor(memberIds),
        excerpts: chunkPaths.flatMap(path => {
          const excerpt = excerptsByPath.get(path);
          return excerpt ? [excerpt] : [];
        }),
        ...(chunkCount > 1 ? { chunkIndex: index + 1, chunkCount } : {}),
      });
    });
  }

  const systemPacket = buildSystemPacket(extraction, readFile);
  const usesV3 = packets.some(packet => packet.promptVersion === ENRICHMENT_PROMPT_VERSION_V3);

  const manifest: PacketManifest = {
    promptVersion: usesV3 ? ENRICHMENT_PROMPT_VERSION_V3 : ENRICHMENT_PROMPT_VERSION,
    packets: packets.map(packet => ({
      containerId: packet.containerId,
      file: packetFileName(packet.containerId, packet.chunkIndex),
      hash: contentHash(stable(packet)),
      components: packet.components.length,
      codeEntities: packet.code.length,
    })),
    ...(systemPacket ? {
      systemPacket: {
        containerId: systemPacket.systemId,
        file: packetFileName(systemPacket.systemId),
        hash: contentHash(stable(systemPacket)),
        components: systemPacket.containers.length,
        codeEntities: 0,
      },
    } : {}),
  };
  return { packets, ...(systemPacket ? { systemPacket } : {}), manifest };
}

/** Repo-relative READMEs worth teasing at system scope: the root plus each container's dir. */
function systemReadmeExcerpts(
  containerDirs: readonly string[],
  readFile: (repoRelativePath: string) => string,
): SystemReadmeExcerpt[] {
  const readTeaser = (path: string, max: number): SystemReadmeExcerpt | undefined => {
    try {
      const lines = scrubGithubTokens(readFile(path).replace(/\r\n/g, "\n")).split("\n").slice(0, max);
      return lines.some(line => line.trim().length > 0) ? { path, lines } : undefined;
    } catch {
      return undefined;
    }
  };
  const excerpts: SystemReadmeExcerpt[] = [];
  const root = readTeaser("README.md", MAX_SYSTEM_README_LINES);
  if (root) excerpts.push(root);
  for (const dir of [...containerDirs].sort()) {
    if (!dir || dir === ".") continue;
    const teaser = readTeaser(`${dir}/README.md`, MAX_CONTAINER_README_LINES);
    if (teaser) excerpts.push(teaser);
  }
  return excerpts;
}

/**
 * Builds the repo-wide system-scope packet (top-level actors are judgement, not parsing).
 * Returns undefined when the extraction has no system root. `scopePaths` is derived purely
 * from the base (system + container evidence anchors) so it matches exactly what the merge
 * will accept as a citation — no packet/merge scope drift.
 */
export function buildSystemPacket(
  extraction: ArchitectureExtraction,
  readFile: (repoRelativePath: string) => string,
): SystemPacket | undefined {
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem");
  if (!system) return undefined;
  const node = (entity: { id: string; name: string }): SystemPacketNode => ({ id: entity.id, name: entity.name });

  const containers = extraction.entities.filter(entity => entity.kind === "container")
    .map(node).sort((left, right) => compareText(left.id, right.id));
  const externalSystems = extraction.entities.filter(entity => entity.kind === "externalSystem")
    .map(node).sort((left, right) => compareText(left.id, right.id));

  const containerDirs = extraction.entities
    .filter(entity => entity.kind === "container")
    .flatMap(entity => entity.sourceRefs.map(ref => ref.path));
  const scopePaths = [...new Set([
    ...extraction.entities.filter(entity => entity.kind === "softwareSystem" || entity.kind === "container")
      .flatMap(entity => entity.sourceRefs.map(ref => ref.path)),
  ])].sort();

  return {
    promptVersion: ENRICHMENT_PROMPT_VERSION,
    scope: "system",
    systemId: system.id,
    systemName: system.name,
    scopePaths,
    containers,
    externalSystems,
    readme: systemReadmeExcerpts(containerDirs, readFile),
  };
}

/**
 * Reversible packet file name for a container id: the single `:` becomes `__`
 * (slugs never contain `__`), so `containerIdFromFileName` can recover the id even
 * when the enrichment doc itself is malformed. Remainder packets for a split
 * container use `container__<id>.<n>.json` (n ≥ 2); chunk 1 keeps the unsuffixed name.
 */
export function packetFileName(containerId: string, chunkIndex?: number): string {
  const base = containerId.replace(/:/g, "__");
  return chunkIndex !== undefined && chunkIndex > 1 ? `${base}.${chunkIndex}.json` : `${base}.json`;
}

/** Inverse of packetFileName; returns undefined for names that aren't packet files. */
export function containerIdFromFileName(fileName: string): string | undefined {
  if (!fileName.endsWith(".json")) return undefined;
  const stem = fileName.slice(0, -".json".length);
  // Remainder packets: container__apps-web.2.json → container:apps-web
  const withoutChunk = stem.replace(/\.\d+$/, "");
  if (!withoutChunk) return undefined;
  return withoutChunk.replace(/__/g, ":");
}
