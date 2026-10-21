import assert from "node:assert/strict";
import test from "node:test";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment } from "./enrich.js";
import { applyComponentMembership } from "./component-map.js";
import { buildEnrichmentPackets, containerIdFromFileName, contentHash, packetFileName, ENRICHMENT_PROMPT_VERSION, MAX_COMPONENTS_PER_PACKET } from "./packet.js";
import { testResolution } from "./test-resolution.js";

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\nimport './util.js';\n",
  "pkg/a/src/util.ts": "export function helper() {}\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
  "pkg/c/src/config.ts": "export default 1;\n",
};
const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};
function base() {
  const discovery: Discovery = {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts", "pkg/c/src/config.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
      { kind: "member", dir: "pkg/c", name: "@acme/c", packageName: "@acme/c", evidencePath: "pkg/c", packageManifest: "pkg/c/package.json" },
    ],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"], ["pkg/a/src/util.ts", "pkg/a"],
      ["pkg/b/src/main.ts", "pkg/b"], ["pkg/c/src/config.ts", "pkg/c"],
    ]),
    resolution: testResolution(new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"], ["@acme/c", "pkg/c"]])),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  return extractArchitecture({ discovery, readFile: read, systemName: "Acme", systemSlug: "acme" });
}

test("emits one packet per code-bearing container, strictly redacted to scope", () => {
  const { packets } = buildEnrichmentPackets(base(), read);
  // pkg/c has only an empty component (export default) -> no packet.
  assert.deepEqual(packets.map(packet => packet.containerId).sort(), ["container:pkg-a", "container:pkg-b"]);

  const a = packets.find(packet => packet.containerId === "container:pkg-a")!;
  assert.equal(a.promptVersion, ENRICHMENT_PROMPT_VERSION);
  assert.ok(a.scopePaths.every(path => path.startsWith("pkg/a/")), "scope paths in-scope only");
  assert.ok(a.excerpts.every(excerpt => a.scopePaths.includes(excerpt.path)), "excerpts in-scope only");
  assert.ok(a.code.every(code => code.path.startsWith("pkg/a/")), "code in-scope only");
  // hard redaction: not a single byte references pkg/b or pkg/c.
  const serialized = JSON.stringify(a);
  assert.equal(serialized.includes("pkg/b/"), false);
  assert.equal(serialized.includes("pkg/c/"), false);
  // every code entity names the component it currently belongs to (for re-parenting).
  assert.ok(a.code.every(code => a.components.some(component => component.id === code.componentId)));
});

test("mapped multi-file components retain every implementation path in packet scope and excerpts", () => {
  const mapped = applyComponentMembership(base(), {
    document: {
      version: 1,
      containers: [{
        containerId: "container:pkg-a",
        components: [{
          id: "component:pkg-a-source-viewing",
          name: "Source viewing",
          paths: ["pkg/a/src/index.ts", "pkg/a/src/util.ts"],
        }],
      }],
    },
  });
  assert.equal(mapped.report.accepted, true);
  const packet = buildEnrichmentPackets(mapped.extraction, read).packets.find(value => value.containerId === "container:pkg-a")!;
  assert.equal(packet.components[0]?.path, "pkg/a/src/index.ts", "primary component path remains compatible");
  assert.deepEqual(packet.scopePaths, ["pkg/a/src/index.ts", "pkg/a/src/util.ts"]);
  assert.deepEqual(packet.excerpts.map(excerpt => excerpt.path), packet.scopePaths);
  assert.deepEqual([...new Set(packet.code.map(code => code.path))].sort(), packet.scopePaths);
});

test("packet excerpts apply the existing GitHub token scrub (planted secret stays off the wire)", () => {
  const planted = "gho_okieTestPlantedSecretCla25xxxx";
  const withSecret: Record<string, string> = {
    ...files,
    "pkg/a/src/index.ts": `export function alpha() {}\nconst planted = "${planted}";\n`,
    "README.md": `# Acme\ntoken ${planted}\n`,
  };
  const readSecret = (path: string): string => {
    const text = withSecret[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const extraction = extractArchitecture({
    discovery: {
      sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts", "pkg/c/src/config.ts"],
      units: [
        { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
        { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
        { kind: "member", dir: "pkg/c", name: "@acme/c", packageName: "@acme/c", evidencePath: "pkg/c", packageManifest: "pkg/c/package.json" },
      ],
      unitByFile: new Map([
        ["pkg/a/src/index.ts", "pkg/a"], ["pkg/a/src/util.ts", "pkg/a"],
        ["pkg/b/src/main.ts", "pkg/b"], ["pkg/c/src/config.ts", "pkg/c"],
      ]),
      resolution: testResolution(new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"], ["@acme/c", "pkg/c"]])),
      summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
    },
    readFile: readSecret,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const emitted = buildEnrichmentPackets(extraction, readSecret);
  const a = emitted.packets.find(packet => packet.containerId === "container:pkg-a")!;
  const packetJson = JSON.stringify(a);
  const systemJson = JSON.stringify(emitted.systemPacket);
  assert.equal(packetJson.includes(planted), false);
  assert.equal(systemJson.includes(planted), false);
  assert.ok(a.excerpts.some(excerpt => excerpt.lines.some(line => line.includes("[redacted-token]"))));
  assert.ok(emitted.systemPacket?.readme.some(excerpt => excerpt.lines.some(line => line.includes("[redacted-token]"))));
  // scope redaction still holds
  assert.equal(packetJson.includes("pkg/b/"), false);
});

test("manifest is content-addressed and deterministic; file names round-trip", () => {
  const first = buildEnrichmentPackets(base(), read).manifest;
  const second = buildEnrichmentPackets(base(), read).manifest;
  assert.deepEqual(first, second, "manifest is deterministic");
  assert.equal(first.promptVersion, ENRICHMENT_PROMPT_VERSION);
  for (const entry of first.packets) {
    assert.match(entry.hash, /^[0-9a-f]{8}$/);
    assert.equal(entry.file, packetFileName(entry.containerId));
    assert.equal(containerIdFromFileName(entry.file), entry.containerId, "file name reverses to the container id");
  }
  // a changed packet must change its hash.
  assert.notEqual(contentHash("a"), contentHash("b"));
  assert.equal(contentHash("stable"), contentHash("stable"));
});

test("remainder packet filenames reverse to the container id", () => {
  assert.equal(packetFileName("container:apps-web"), "container__apps-web.json");
  assert.equal(packetFileName("container:apps-web", 1), "container__apps-web.json");
  assert.equal(packetFileName("container:apps-web", 2), "container__apps-web.2.json");
  assert.equal(containerIdFromFileName("container__apps-web.json"), "container:apps-web");
  assert.equal(containerIdFromFileName("container__apps-web.2.json"), "container:apps-web");
  assert.equal(containerIdFromFileName("container__apps-web.3.json"), "container:apps-web");
});

function hugeExtraction(fileCount: number) {
  const sourceFiles: string[] = [];
  const files: Record<string, string> = {
    "README.md": "# Huge",
    "pkg/h/package.json": `${JSON.stringify({ name: "@acme/h" }, null, 2)}\n`,
  };
  const unitByFile = new Map<string, string>();
  for (let index = 0; index < fileCount; index += 1) {
    const path = `pkg/h/src/f${String(index).padStart(3, "0")}.ts`;
    sourceFiles.push(path);
    files[path] = `export function fn${index}() { return ${index}; }\n`;
    unitByFile.set(path, "pkg/h");
  }
  const readHuge = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const discovery: Discovery = {
    sourceFiles,
    units: [{ kind: "member", dir: "pkg/h", name: "@acme/h", packageName: "@acme/h", evidencePath: "pkg/h", packageManifest: "pkg/h/package.json" }],
    unitByFile,
    resolution: testResolution(new Map([["@acme/h", "pkg/h"]])),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  return { extraction: extractArchitecture({ discovery, readFile: readHuge, systemName: "Huge", systemSlug: "huge" }), readHuge };
}

test("huge container splits into remainder packets; the cap does not drop leftover file-components", () => {
  const { extraction, readHuge } = hugeExtraction(MAX_COMPONENTS_PER_PACKET + 9);
  const emitted = buildEnrichmentPackets(extraction, readHuge);
  const web = emitted.packets.filter(packet => packet.containerId === "container:pkg-h");
  assert.equal(web.length, 2, "overflow must emit a remainder packet, not truncate");
  assert.equal(web[0]!.components.length, MAX_COMPONENTS_PER_PACKET);
  assert.equal(web[1]!.components.length, 9);
  assert.equal(web[0]!.chunkIndex, 1);
  assert.equal(web[1]!.chunkIndex, 2);
  assert.equal(web[0]!.chunkCount, 2);
  const ids = web.flatMap(packet => packet.components.map(component => component.id)).sort();
  const expected = extraction.entities
    .filter(entity => entity.kind === "component" && entity.parentId === "container:pkg-h")
    .map(entity => entity.id)
    .sort();
  assert.deepEqual(ids, expected, "every code-bearing file-component must appear in some packet");
  assert.equal(emitted.manifest.packets.filter(entry => entry.containerId === "container:pkg-h").length, 2);
  assert.equal(emitted.manifest.packets.find(entry => entry.file === "container__pkg-h.2.json")?.components, 9);
  const serializedSecond = JSON.stringify(web[1]);
  for (const component of web[0]!.components) {
    assert.equal(serializedSecond.includes(component.id), false, "remainder packet must not repeat the first chunk's ids");
  }
});

test("one summary document per remainder packet restates only that packet's ids; merge covers all leftover files", () => {
  const { extraction, readHuge } = hugeExtraction(MAX_COMPONENTS_PER_PACKET + 9);
  const emitted = buildEnrichmentPackets(extraction, readHuge);
  const chunks = emitted.packets.filter(packet => packet.containerId === "container:pkg-h");
  assert.equal(chunks.length, 2);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const docs = chunks.map(packet => {
    const componentIds = new Set(packet.components.map(component => component.id));
    const entities = [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: packet.containerId, kind: "container", parentId: system.id, name: packet.containerName, sourceRefs: [] },
      ...packet.components.map(component => ({
        id: component.id, kind: "component", parentId: packet.containerId, name: component.name,
        responsibility: `Summary of ${component.name}.`, sourceRefs: [],
      })),
    ];
    for (const entity of entities.filter(item => item.kind === "component")) {
      assert.equal(componentIds.has(entity.id), true, `${entity.id} must belong to ${packetFileName(packet.containerId, packet.chunkIndex)}`);
    }
    return { schemaVersion: 1, entities, relations: [] };
  });
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([["container:pkg-h", docs]]));
  assert.equal(report.results[0]!.accepted, true, report.results[0]?.reasons.join("; "));
  assert.equal(report.results[0]!.components, MAX_COMPONENTS_PER_PACKET + 9);
  const summarized = merged.entities.filter(entity =>
    entity.kind === "component" && entity.parentId === "container:pkg-h" && entity.responsibility);
  assert.equal(summarized.length, MAX_COMPONENTS_PER_PACKET + 9);
});

test("a container at the cap still emits one packet", () => {
  const { extraction, readHuge } = hugeExtraction(MAX_COMPONENTS_PER_PACKET);
  const emitted = buildEnrichmentPackets(extraction, readHuge);
  const web = emitted.packets.filter(packet => packet.containerId === "container:pkg-h");
  assert.equal(web.length, 1);
  assert.equal(web[0]!.chunkIndex, undefined);
  assert.equal(web[0]!.components.length, MAX_COMPONENTS_PER_PACKET);
});
