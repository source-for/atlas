import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ArchitectureExtraction } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment } from "./enrich.js";
import { coverageByCodeIdFromEntities, parseLcov } from "./lcov.js";
import { nearbyTestCandidatePaths, nearbyTestsForCode } from "./nearby-tests.js";
import {
  buildEnrichmentPackets,
  ENRICHMENT_PROMPT_VERSION,
  ENRICHMENT_PROMPT_VERSION_V3,
} from "./packet.js";
import { concatenateEnrichmentPrompt, readFrozenEnrichmentPrompt } from "./prompt.js";
import { buildScanArtifacts } from "./scan.js";

const tangledSource = [
  "export function tangled(x: number) {",
  "  if (x === 1) return 1;",
  "  if (x === 2) return 2;",
  "  if (x === 3) return 3;",
  "  if (x === 4) return 4;",
  "  if (x === 5) return 5;",
  "  if (x === 6) return 6;",
  "  return x;",
  "}",
].join("\n");

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": `export function alpha() { return 1; }\nexport const A = 1;\n${tangledSource}\n`,
  "pkg/a/src/index.test.ts": "import { tangled } from './index.js';\ntest('tangled returns 1', () => { tangled(1); });\n",
  "pkg/a/src/util.ts": "export function helper() { return 2; }\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
};

const syntheticLcov = [
  "TN:",
  "SF:pkg/a/src/index.ts",
  "DA:1,1",
  "DA:3,1",
  "DA:4,0",
  "DA:5,0",
  "DA:6,0",
  "DA:7,1",
  "LF:6",
  "LH:3",
  "end_of_record",
].join("\n");

const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

function discovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts"],
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
    ],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"],
      ["pkg/a/src/util.ts", "pkg/a"],
      ["pkg/b/src/main.ts", "pkg/b"],
    ]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

function base(): ArchitectureExtraction {
  return extractArchitecture({ discovery: discovery(), readFile: read, systemName: "Acme", systemSlug: "acme" });
}

function coverageMap(extraction: ArchitectureExtraction) {
  return coverageByCodeIdFromEntities(extraction.entities, { path: "lcov.info", files: parseLcov(syntheticLcov) });
}

function summaryWithBehaviours(
  extraction: ArchitectureExtraction,
  codeId: string,
  behaviours: Array<{ startLine: number; endLine: number; behaviour: string }>,
): Record<string, unknown> {
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const code = extraction.entities.find(entity => entity.id === codeId)!;
  const component = extraction.entities.find(entity => entity.id === code.parentId)!;
  return {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      {
        id: "container:pkg-a",
        kind: "container",
        parentId: system.id,
        name: "a",
        responsibility: "Scanner-scoped container summary.",
        sourceRefs: [],
      },
      {
        id: component.id,
        kind: "component",
        parentId: "container:pkg-a",
        name: component.name,
        responsibility: `Summary of ${component.name}.`,
        sourceRefs: [],
      },
      {
        id: code.id,
        kind: "code",
        parentId: code.parentId,
        name: code.name,
        responsibility: "Optional in-scope code summary.",
        untestedBehaviours: behaviours,
        sourceRefs: code.sourceRefs.map(ref => ({ ...ref })),
      },
    ],
    relations: [],
  };
}

test("v2 frozen prompt is unchanged: no untestedBehaviours contract, still okie-enrichment/v2", () => {
  const v2 = readFrozenEnrichmentPrompt();
  const v2Path = fileURLToPath(new URL("../enrichment-prompt.md", import.meta.url));
  assert.equal(v2, readFileSync(v2Path, "utf8"));
  assert.match(v2, /okie-enrichment\/v2/);
  assert.doesNotMatch(v2, /untestedBehaviours/);
  assert.doesNotMatch(v2, /okie-enrichment\/v3/);
  assert.doesNotMatch(v2, /\bCRAP\b/);
});

test("v3 prompt versions the contract and names grounded untested behaviours", () => {
  const v3 = readFrozenEnrichmentPrompt(ENRICHMENT_PROMPT_VERSION_V3);
  assert.match(v3, /okie-enrichment\/v3/);
  assert.match(v3, /untestedBehaviours/);
  assert.match(v3, /nearbyTests/);
  assert.match(v3, /untestedRanges/);
  assert.match(v3, /Do not compute CRAP/);
  assert.notEqual(v3, readFrozenEnrichmentPrompt());
});

test("without a sidecar, packets stay v2 and do not invent coverage or nearby tests", () => {
  const { packets, manifest } = buildEnrichmentPackets(base(), read);
  assert.equal(manifest.promptVersion, ENRICHMENT_PROMPT_VERSION);
  const a = packets.find(packet => packet.containerId === "container:pkg-a")!;
  assert.equal(a.promptVersion, ENRICHMENT_PROMPT_VERSION);
  assert.ok(a.code.every(item => item.untestedRanges === undefined));
  assert.ok(a.code.every(item => item.fileHitRate === undefined));
  assert.ok(a.code.every(item => item.nearbyTests === undefined));
});

test("with untested ranges, packets stamp v3 and carry ranges plus nearby tests", () => {
  const extraction = base();
  const { packets, manifest } = buildEnrichmentPackets(extraction, read, { coverageByCodeId: coverageMap(extraction) });
  assert.equal(manifest.promptVersion, ENRICHMENT_PROMPT_VERSION_V3);
  const a = packets.find(packet => packet.containerId === "container:pkg-a")!;
  assert.equal(a.promptVersion, ENRICHMENT_PROMPT_VERSION_V3);
  const tangled = a.code.find(item => item.id.endsWith(":tangled"));
  assert.ok(tangled);
  assert.deepEqual(tangled!.untestedRanges, [{ startLine: 4, endLine: 6 }]);
  assert.equal(typeof tangled!.fileHitRate, "number");
  assert.ok(tangled!.nearbyTests?.some(testFile => testFile.path === "pkg/a/src/index.test.ts"));
  assert.ok(tangled!.nearbyTests?.some(testFile => testFile.lines.some(line => line.includes("tangled"))));
  const alpha = a.code.find(item => item.id.endsWith(":alpha"));
  assert.equal(alpha?.untestedRanges, undefined);
  const b = packets.find(packet => packet.containerId === "container:pkg-b")!;
  assert.equal(b.promptVersion, ENRICHMENT_PROMPT_VERSION);
});

test("v3 emit-prompt concatenates the v3 prefix, not a rewritten v2 file", () => {
  const extraction = base();
  const { packets } = buildEnrichmentPackets(extraction, read, { coverageByCodeId: coverageMap(extraction) });
  const packet = packets.find(item => item.promptVersion === ENRICHMENT_PROMPT_VERSION_V3)!;
  const v3 = readFrozenEnrichmentPrompt(ENRICHMENT_PROMPT_VERSION_V3);
  const prompt = concatenateEnrichmentPrompt({
    prefix: v3,
    packet,
    appendix: {
      commitSha: "abc123def456abc123def456abc123def456abc1",
      treeHash: "def456abc123def456abc123def456abc123def4",
      packetFile: "container__pkg-a.json",
      fileTree: [],
      ownershipTree: { id: packet.containerId, name: packet.containerName, kind: "container", children: [] },
    },
  });
  assert.equal(prompt.startsWith(v3), true);
  assert.equal(prompt.startsWith(readFrozenEnrichmentPrompt()), false);
});

test("nearby tests are conventional siblings; missing files are omitted", () => {
  assert.ok(nearbyTestCandidatePaths("pkg/a/src/index.ts").includes("pkg/a/src/index.test.ts"));
  const found = nearbyTestsForCode("pkg/a/src/index.ts", "tangled", read);
  assert.equal(found[0]?.path, "pkg/a/src/index.test.ts");
  const missing = nearbyTestsForCode("pkg/a/src/util.ts", "helper", read);
  assert.deepEqual(missing, []);
});

test("grounded untested behaviours merge onto the snapshot; no CRAP headline", () => {
  const extraction = base();
  const tangledId = extraction.entities.find(entity => entity.id.endsWith(":tangled"))!.id;
  const coverageByCodeId = coverageMap(extraction);
  const { extraction: merged, report } = mergeEnrichment(
    extraction,
    new Map([["container:pkg-a", summaryWithBehaviours(extraction, tangledId, [
      { startLine: 4, endLine: 6, behaviour: "Does not cover the x===1/2/3 branches." },
    ])]]),
    { coverageByCodeId },
  );
  assert.equal(report.results[0]?.accepted, true);
  assert.equal(report.promptVersion, ENRICHMENT_PROMPT_VERSION_V3);
  const tangled = merged.entities.find(entity => entity.id === tangledId);
  assert.deepEqual(tangled?.untestedBehaviours, [
    { startLine: 4, endLine: 6, behaviour: "Does not cover the x===1/2/3 branches." },
  ]);
  assert.equal(JSON.stringify(merged).toLowerCase().includes("crap"), false);

  const pin = {
    commitSha: "abc123def456abc123def456abc123def456abc1",
    treeHash: "def456abc123def456abc123def456abc123def4",
    generatedAt: "2026-01-01T00:00:00.000Z",
  };
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
    lcovText: syntheticLcov,
    enrichmentDocs: new Map([["container:pkg-a", summaryWithBehaviours(extraction, tangledId, [
      { startLine: 4, endLine: 6, behaviour: "Does not cover the x===1/2/3 branches." },
    ])]]),
  });
  const snap = artifacts.snapshot.entities.find(entity => entity.id === tangledId);
  assert.deepEqual(snap?.coverageUntestedRanges, [{ startLine: 4, endLine: 6 }]);
  assert.deepEqual(snap?.untestedBehaviours, [
    { startLine: 4, endLine: 6, behaviour: "Does not cover the x===1/2/3 branches." },
  ]);
  assert.equal(JSON.stringify(artifacts.snapshot).toLowerCase().includes("crap"), false);
});

test("hallucinated untested behaviours fail the gate; the scope stays deterministic", () => {
  const extraction = base();
  const tangledId = extraction.entities.find(entity => entity.id.endsWith(":tangled"))!.id;
  const { extraction: merged, report } = mergeEnrichment(
    extraction,
    new Map([["container:pkg-a", summaryWithBehaviours(extraction, tangledId, [
      { startLine: 99, endLine: 120, behaviour: "Invented retry backoff." },
    ])]]),
    { coverageByCodeId: coverageMap(extraction) },
  );
  assert.equal(report.results[0]?.accepted, false);
  assert.ok(report.results[0]?.reasons.some(reason => reason.includes("not grounded")));
  assert.equal(JSON.stringify(merged), JSON.stringify(extraction));
  assert.equal(merged.entities.find(entity => entity.id === tangledId)?.untestedBehaviours, undefined);
});

test("without ranges / without sidecar, untested behaviours are invented coverage and reject", () => {
  const extraction = base();
  const alphaId = extraction.entities.find(entity => entity.id.endsWith(":alpha"))!.id;
  const withSidecarNoRanges = mergeEnrichment(
    extraction,
    new Map([["container:pkg-a", summaryWithBehaviours(extraction, alphaId, [
      { startLine: 1, endLine: 1, behaviour: "Invented uncovered alpha." },
    ])]]),
    { coverageByCodeId: coverageMap(extraction) },
  );
  assert.equal(withSidecarNoRanges.report.results[0]?.accepted, false);
  assert.ok(withSidecarNoRanges.report.results[0]?.reasons.some(reason => reason.includes("without observed untested ranges")));
  assert.equal(JSON.stringify(withSidecarNoRanges.extraction), JSON.stringify(extraction));

  const noSidecar = mergeEnrichment(
    extraction,
    new Map([["container:pkg-a", summaryWithBehaviours(extraction, alphaId, [
      { startLine: 1, endLine: 1, behaviour: "Invented uncovered alpha." },
    ])]]),
  );
  assert.equal(noSidecar.report.results[0]?.accepted, false);
  assert.equal(JSON.stringify(noSidecar.extraction), JSON.stringify(extraction));
  assert.equal(noSidecar.report.promptVersion, ENRICHMENT_PROMPT_VERSION);
});
