import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RepositoryPin } from "./pin.js";
import {
  packetFileName,
  type EmittedPackets,
  type EnrichmentPacket,
  type SystemPacket,
  ENRICHMENT_PROMPT_VERSION,
  ENRICHMENT_PROMPT_VERSION_V3,
} from "./packet.js";
import { pathOwnerFacts, type CodeOwnerRule, type PathOwnerFact } from "./codeowners.js";
import { scrubGithubTokens } from "./redact.js";
import { compareText } from "@okie/architecture";

/**
 * Frozen enrichment prompt bytes. v2 (`enrichment-prompt.md`) is the default
 * contract. v3 is a separate file — never a silent rewrite of v2.
 */
export function frozenEnrichmentPromptPath(version: string = ENRICHMENT_PROMPT_VERSION): string {
  const file = version === ENRICHMENT_PROMPT_VERSION_V3
    ? "../enrichment-prompt-v3.md"
    : "../enrichment-prompt.md";
  return fileURLToPath(new URL(file, import.meta.url));
}

/** Exact bytes of the frozen prompt for `version` (utf8). */
export function readFrozenEnrichmentPrompt(version: string = ENRICHMENT_PROMPT_VERSION): string {
  return readFileSync(frozenEnrichmentPromptPath(version), "utf8");
}

export function prefixForPromptVersion(version: string, prefixes: EnrichmentPromptPrefixes): string {
  return version === ENRICHMENT_PROMPT_VERSION_V3 ? prefixes.v3 : prefixes.v2;
}

export interface EnrichmentPromptPrefixes {
  v2: string;
  v3: string;
}

/** Prompt sidecar next to a packet file: `container__<id>.prompt.md` (`.2` for remainder packets). */
export function promptFileName(id: string, chunkIndex?: number): string {
  return packetFileName(id, chunkIndex).replace(/\.json$/, ".prompt.md");
}

/** Same bytes as `stableJson` in scan.ts / CLI packet files. */
function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export interface FileTreeNode {
  name: string;
  path?: string;
  children?: FileTreeNode[];
}

export interface OwnershipNode {
  id: string;
  name: string;
  kind: string;
  /** Observed CODEOWNERS for this node's paths. Omitted when none. */
  owners?: string[];
  children: OwnershipNode[];
}

/**
 * Data concatenated after the frozen prefix and packet JSON. Not instructions.
 * `packetFile` is the enrich-from filename (same as the packet), never a host path.
 */
export interface EnrichmentPromptAppendix {
  commitSha: string;
  treeHash: string;
  packetFile: string;
  fileTree: FileTreeNode[];
  ownershipTree: OwnershipNode;
  /** Observed CODEOWNERS path owners in this packet's scope. Omitted when none. */
  pathOwners?: PathOwnerFact[];
}

export function isSystemPacket(packet: EnrichmentPacket | SystemPacket): packet is SystemPacket {
  return "scope" in packet && packet.scope === "system";
}

/** Nested directory tree from repo-relative paths. Sorted at every level. */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", children: [] };
  for (const path of [...paths].sort()) {
    const parts = path.split("/").filter(part => part.length > 0);
    let cursor = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index]!;
      const isFile = index === parts.length - 1;
      cursor.children ??= [];
      let child = cursor.children.find(node => node.name === name);
      if (!child) {
        child = isFile ? { name, path } : { name, children: [] };
        cursor.children.push(child);
      }
      cursor = child;
    }
  }
  const sortTree = (nodes: FileTreeNode[]): FileTreeNode[] => {
    nodes.sort((left, right) => compareText(left.name, right.name));
    for (const node of nodes) {
      if (node.children) sortTree(node.children);
    }
    return nodes;
  };
  return sortTree(root.children ?? []);
}

/** C4 ownership derived from the packet only — no extra I/O, no out-of-scope ids. */
export function ownershipTreeFromPacket(packet: EnrichmentPacket | SystemPacket): OwnershipNode {
  if (isSystemPacket(packet)) {
    const children: OwnershipNode[] = [
      ...packet.containers.map(container => ({
        id: container.id, name: container.name, kind: "container", children: [] as OwnershipNode[],
      })),
      ...packet.externalSystems.map(external => ({
        id: external.id, name: external.name, kind: "externalSystem", children: [] as OwnershipNode[],
      })),
    ].sort((left, right) => compareText(left.id, right.id));
    return { id: packet.systemId, name: packet.systemName, kind: "softwareSystem", children };
  }

  const codeByComponent = new Map<string, OwnershipNode[]>();
  for (const code of packet.code) {
    const bucket = codeByComponent.get(code.componentId) ?? [];
    bucket.push({ id: code.id, name: code.name, kind: "code", children: [] });
    codeByComponent.set(code.componentId, bucket);
  }
  for (const bucket of codeByComponent.values()) {
    bucket.sort((left, right) => compareText(left.id, right.id));
  }
  const children = packet.components
    .map(component => ({
      id: component.id,
      name: component.name,
      kind: "component",
      children: codeByComponent.get(component.id) ?? [],
    }))
    .sort((left, right) => compareText(left.id, right.id));
  return { id: packet.containerId, name: packet.containerName, kind: "container", children };
}

function uniqueSortedOwners(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

/** Overlay observed path owners onto the C4 tree. Data only — not new prompt instructions. */
function withPathOwners(
  node: OwnershipNode,
  packet: EnrichmentPacket | SystemPacket,
  ownersByPath: ReadonlyMap<string, readonly string[]>,
): OwnershipNode {
  const pathById = new Map<string, string>();
  if (!isSystemPacket(packet)) {
    for (const component of packet.components) pathById.set(component.id, component.path);
    for (const code of packet.code) pathById.set(code.id, code.path);
  }
  const scopeUnion = uniqueSortedOwners([...ownersByPath.values()].flat());
  const visit = (current: OwnershipNode): OwnershipNode => {
    const children = current.children.map(visit);
    const path = pathById.get(current.id);
    const owners = path
      ? [...(ownersByPath.get(path) ?? [])]
      : ((current.kind === "softwareSystem" || current.kind === "container") && current.id === node.id
        ? scopeUnion
        : undefined);
    return {
      ...current,
      ...(owners?.length ? { owners } : {}),
      children,
    };
  };
  return visit(node);
}

/**
 * Concatenate-only prompt: frozen prefix bytes, then packet JSON (same bytes as the
 * packet file), then the appendix JSON. No Jinja, no parameterization of the prefix.
 */
export function concatenateEnrichmentPrompt(params: {
  prefix: string;
  packet: EnrichmentPacket | SystemPacket;
  appendix: EnrichmentPromptAppendix;
}): string {
  const head = params.prefix.endsWith("\n") ? params.prefix : `${params.prefix}\n`;
  const packetJson = stableJson(params.packet);
  const appendixJson = scrubGithubTokens(stableJson(params.appendix));
  return `${head}${packetJson}${appendixJson}`;
}

export function appendixForPacket(
  packet: EnrichmentPacket | SystemPacket,
  pin: Pick<RepositoryPin, "commitSha" | "treeHash">,
  id: string,
  chunkIndex?: number,
  rules: readonly CodeOwnerRule[] = [],
): EnrichmentPromptAppendix {
  const facts = pathOwnerFacts(packet.scopePaths, rules);
  const ownersByPath = new Map(facts.map(fact => [fact.path, fact.owners]));
  return {
    commitSha: pin.commitSha,
    treeHash: pin.treeHash,
    packetFile: packetFileName(id, chunkIndex),
    fileTree: buildFileTree(packet.scopePaths),
    ownershipTree: withPathOwners(ownershipTreeFromPacket(packet), packet, ownersByPath),
    ...(facts.length ? { pathOwners: facts } : {}),
  };
}

/** Writes the `--emit-packets` layout (one JSON per packet, including remainder `*.2.json`). */
export function writeEnrichmentPackets(dir: string, emitted: EmittedPackets): void {
  mkdirSync(dir, { recursive: true });
  for (const packet of emitted.packets) {
    writeFileSync(`${dir}/${packetFileName(packet.containerId, packet.chunkIndex)}`, stableJson(packet));
  }
  if (emitted.systemPacket) {
    writeFileSync(`${dir}/${packetFileName(emitted.systemPacket.systemId)}`, stableJson(emitted.systemPacket));
  }
  writeFileSync(`${dir}/manifest.json`, stableJson(emitted.manifest));
}

/** Writes one concatenated `.prompt.md` per packet (prefix + packet JSON + appendix). */
export function writeEnrichmentPrompts(
  dir: string,
  emitted: EmittedPackets,
  pin: Pick<RepositoryPin, "commitSha" | "treeHash">,
  prefix: string | EnrichmentPromptPrefixes,
  rules: readonly CodeOwnerRule[] = [],
): void {
  mkdirSync(dir, { recursive: true });
  const prefixes: EnrichmentPromptPrefixes = typeof prefix === "string"
    ? { v2: prefix, v3: prefix }
    : prefix;
  const writeOne = (id: string, packet: EnrichmentPacket | SystemPacket, chunkIndex?: number): void => {
    writeFileSync(`${dir}/${promptFileName(id, chunkIndex)}`, concatenateEnrichmentPrompt({
      prefix: prefixForPromptVersion(packet.promptVersion, prefixes),
      packet,
      appendix: appendixForPacket(packet, pin, id, chunkIndex, rules),
    }));
  };
  for (const packet of emitted.packets) writeOne(packet.containerId, packet, packet.chunkIndex);
  if (emitted.systemPacket) writeOne(emitted.systemPacket.systemId, emitted.systemPacket);
}

/**
 * `--emit-prompt` output: same packet files as `--emit-packets`, plus concatenated prompts.
 * Does not invent a merge path — merge remains `--enrich-from`.
 */
export function writePromptEmission(
  dir: string,
  emitted: EmittedPackets,
  pin: Pick<RepositoryPin, "commitSha" | "treeHash">,
  prefix: string | EnrichmentPromptPrefixes,
  rules: readonly CodeOwnerRule[] = [],
): void {
  writeEnrichmentPackets(dir, emitted);
  writeEnrichmentPrompts(dir, emitted, pin, prefix, rules);
}
