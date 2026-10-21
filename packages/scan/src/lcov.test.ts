import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  adaptArchitectureExtraction,
  validateArchitectureExtraction,
  validateSnapshot,
  type ArchitectureSnapshot,
} from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment } from "./enrich.js";
import {
  attachCoverage,
  fileHitRate,
  matchLcovSourcePath,
  normalizeLcovSourcePath,
  parseLcov,
  readLcov,
  untestedRangesFromHits,
} from "./lcov.js";
import { buildScanArtifacts } from "./scan.js";
import { testResolution } from "./test-resolution.js";

const cloneSource = (name: string, param: string): string => [
  `export function ${name}(${param}: number): number {`,
  `  if (${param} > 0) {`,
  `    const next = ${param} + 1;`,
  `    if (next % 2 === 0) return next * 3;`,
  `    return next - 1;`,
  `  }`,
  `  return 0;`,
  `}`,
].join("\n");

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
  "pkg/a/src/index.ts": `${cloneSource("alpha", "value")}\nexport const A = 1;\n${tangledSource}\n`,
  "pkg/a/src/util.ts": "export function helper() { return 2; }\n",
  "pkg/b/src/main.ts": `import { alpha } from '@acme/a';\n${cloneSource("beta", "count")}\n`,
};

/**
 * cloneSource is 8 lines, `export const A = 1` is line 9, tangled starts at 10.
 * DA zeros on tangled ifs (11–13) plus one beta branch.
 */
const syntheticLcov = [
  "TN:",
  "SF:pkg/a/src/index.ts",
  "DA:1,1",
  "DA:2,1",
  "DA:3,1",
  "DA:4,1",
  "DA:5,1",
  "DA:6,1",
  "DA:7,1",
  "DA:8,1",
  "DA:10,1",
  "DA:11,0",
  "DA:12,0",
  "DA:13,0",
  "DA:14,1",
  "DA:15,1",
  "LF:14",
  "LH:11",
  "end_of_record",
  "SF:/ci/workspace/pkg/b/src/main.ts",
  "DA:2,3",
  "DA:3,3",
  "DA:4,0",
  "DA:5,3",
  "LF:4",
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
    resolution: testResolution(new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]])),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const pin = { commitSha: "abc123", treeHash: "def456", generatedAt: "2026-01-01T00:00:00.000Z" };
const metadata = {
  snapshotId: "snapshot:acme",
  repositoryId: "repo:acme",
  commitSha: "abc123",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

test("parseLcov merges DA rows and keeps LF/LH hit rate", () => {
  const parsed = parseLcov(syntheticLcov);
  const index = parsed.get("pkg/a/src/index.ts")!;
  assert.equal(index.linesFound, 14);
  assert.equal(index.linesHit, 11);
  assert.equal(fileHitRate(index), 11 / 14);
  assert.equal(index.hitsByLine.get(11), 0);
  assert.equal(index.hitsByLine.get(14), 1);
  const main = parsed.get("ci/workspace/pkg/b/src/main.ts")!;
  assert.equal(fileHitRate(main), 0.75);
});

test("matchLcovSourcePath accepts CI prefixes and never invents unmatched files", () => {
  const known = new Set(["pkg/a/src/index.ts", "pkg/b/src/main.ts"]);
  assert.equal(normalizeLcovSourcePath("/ci/workspace/pkg/b/src/main.ts"), "ci/workspace/pkg/b/src/main.ts");
  assert.equal(matchLcovSourcePath("/ci/workspace/pkg/b/src/main.ts", known), "pkg/b/src/main.ts");
  assert.equal(matchLcovSourcePath("pkg/a/src/index.ts", known), "pkg/a/src/index.ts");
  assert.equal(matchLcovSourcePath("pkg/a/src/util.ts", known), undefined);
  assert.equal(matchLcovSourcePath("/tmp/other/src/index.ts", known), undefined);
});

test("untested ranges merge consecutive uncovered DA lines inside a symbol span", () => {
  const hits = new Map([[5, 1], [6, 0], [7, 0], [8, 0], [9, 1], [12, 0]]);
  assert.deepEqual(untestedRangesFromHits(hits, 5, 12), [
    { startLine: 6, endLine: 8 },
    { startLine: 12, endLine: 12 },
  ]);
  assert.deepEqual(untestedRangesFromHits(hits, 1, 4), []);
});

test("attachCoverage overlays untested ranges and file hit rate on existing code ids only", () => {
  const extraction = extractArchitecture({
    discovery: discovery(),
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.deepEqual(validateArchitectureExtraction(extraction), []);
  assert.ok(extraction.entities.every(entity => !("coverageFileHitRate" in entity)));
  assert.ok(extraction.entities.every(entity => !("coverageUntestedRanges" in entity)));
  const snapshot = adaptArchitectureExtraction(extraction, metadata);
  const ids = snapshot.entities.map(entity => entity.id);
  const overlaid = attachCoverage(snapshot, { path: "coverage/lcov.info", files: parseLcov(syntheticLcov) });
  assert.deepEqual(overlaid.entities.map(entity => entity.id), ids);
  assert.equal(overlaid.entities.some(entity => entity.id === "code:invented"), false);
  assert.deepEqual(validateSnapshot(overlaid), []);

  const alpha = overlaid.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!;
  const tangled = overlaid.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:tangled")!;
  const helper = overlaid.entities.find(entity => entity.id === "code:pkg-a-src-util-ts:helper")!;
  const beta = overlaid.entities.find(entity => entity.id === "code:pkg-b-src-main-ts:beta")!;
  const fileComponent = overlaid.entities.find(entity => entity.id === "component:pkg-a-src-index-ts")!;

  assert.equal(alpha.coverageFileHitRate, 11 / 14);
  assert.equal(alpha.coverageUntestedRanges, undefined, "covered symbol omits empty ranges");
  assert.equal(tangled.coverageFileHitRate, 11 / 14);
  assert.deepEqual(tangled.coverageUntestedRanges, [{ startLine: 11, endLine: 13 }]);
  assert.equal(helper.coverageFileHitRate, undefined, "file absent from sidecar stays omitted, not 0%");
  assert.equal(helper.coverageUntestedRanges, undefined);
  assert.equal(beta.coverageFileHitRate, 0.75);
  assert.deepEqual(beta.coverageUntestedRanges, [{ startLine: 4, endLine: 4 }]);
  assert.equal(fileComponent.coverageFileHitRate, undefined, "coverage overlays L4 code, not file components");
  assert.equal(JSON.stringify(overlaid).includes("crap"), false);
  assert.equal(JSON.stringify(overlaid).includes("CRAP"), false);
});

test("no sidecar omits coverage and still keeps complexity + clones", () => {
  const absent = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.ok(absent.snapshot.entities.every(entity => entity.coverageFileHitRate === undefined));
  assert.ok(absent.snapshot.entities.every(entity => entity.coverageUntestedRanges === undefined));
  assert.ok(absent.snapshot.entities.some(entity => entity.cyclomaticComplexity === 7));
  assert.ok(absent.snapshot.relations.some(relation => relation.kind === "duplicates"));
  assert.ok(absent.extraction.entities.every(entity => !("coverageFileHitRate" in entity)));

  const withSidecar = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: path => {
      if (path === "coverage/lcov.info") return syntheticLcov;
      return read(path);
    },
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const tangled = withSidecar.snapshot.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:tangled")!;
  assert.equal(tangled.coverageFileHitRate, 11 / 14);
  assert.deepEqual(tangled.coverageUntestedRanges, [{ startLine: 11, endLine: 13 }]);
  assert.equal(tangled.cyclomaticComplexity, 7);
  assert.ok(withSidecar.snapshot.relations.some(relation => relation.kind === "duplicates"));
  assert.ok(withSidecar.extraction.entities.every(entity => !("coverageFileHitRate" in entity)));
  assert.equal(withSidecar.snapshot.entities.find(entity => entity.id === "code:pkg-a-src-util-ts:helper")?.coverageFileHitRate, undefined);
});

test("explicit lcovText overlays the same way as a conventional sidecar", () => {
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
    lcovText: syntheticLcov,
  });
  assert.equal(artifacts.snapshot.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:tangled")?.coverageFileHitRate, 11 / 14);
});

test("observed 0% from the sidecar is kept; unmatched files still omit", () => {
  const zero = [
    "TN:",
    "SF:pkg/a/src/index.ts",
    "DA:1,0",
    "DA:2,0",
    "LF:2",
    "LH:0",
    "end_of_record",
  ].join("\n");
  const snapshot: ArchitectureSnapshot = {
    schemaVersion: 1,
    id: "snapshot:acme",
    repositoryId: "repo:acme",
    commitSha: "abc123",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entities: [
      { id: "system:acme", kind: "softwareSystem", name: "Acme", sourceRefs: [] },
      {
        id: "code:pkg-a-src-index-ts:alpha",
        kind: "code",
        name: "alpha",
        sourceRefs: [{ path: "pkg/a/src/index.ts", commitSha: "abc123", symbol: "alpha", startLine: 1, endLine: 3 }],
      },
      {
        id: "code:pkg-a-src-util-ts:helper",
        kind: "code",
        name: "helper",
        sourceRefs: [{ path: "pkg/a/src/util.ts", commitSha: "abc123", symbol: "helper", startLine: 1, endLine: 1 }],
      },
    ],
    relations: [],
  };
  const overlaid = attachCoverage(snapshot, { path: "lcov.info", files: parseLcov(zero) });
  assert.equal(overlaid.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")?.coverageFileHitRate, 0);
  assert.deepEqual(
    overlaid.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")?.coverageUntestedRanges,
    [{ startLine: 1, endLine: 2 }],
  );
  assert.equal(overlaid.entities.find(entity => entity.id === "code:pkg-a-src-util-ts:helper")?.coverageFileHitRate, undefined);
});

test("enrichment cannot mint coverage: unknown key rejects; overlay stays scan-time lcov", () => {
  const extraction = extractArchitecture({
    discovery: discovery(),
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const container = extraction.entities.find(entity => entity.id === "container:pkg-a")!;
  const components = extraction.entities.filter(entity => entity.kind === "component" && entity.parentId === "container:pkg-a");
  const minted = {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      {
        id: container.id, kind: "container", parentId: system.id, name: container.name,
        responsibility: "Invented coverage must not land.", sourceRefs: [],
      },
      ...components.map(component => ({
        id: component.id, kind: "component", parentId: container.id, name: component.name, sourceRefs: component.sourceRefs,
      })),
      {
        id: "code:pkg-a-src-index-ts:alpha",
        kind: "code",
        parentId: components[0]!.id,
        name: "alpha",
        sourceRefs: extraction.entities.find(entity => entity.id === "code:pkg-a-src-index-ts:alpha")!.sourceRefs,
        coverageFileHitRate: 0,
        coverageUntestedRanges: [{ startLine: 1, endLine: 99 }],
      },
    ],
    relations: [],
  };
  assert.ok(validateArchitectureExtraction(minted).some(issue => issue.path.includes("coverageFileHitRate") || issue.path.includes("coverageUntestedRanges")));
  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([["container:pkg-a", minted]]));
  assert.equal(report.results.find(result => result.containerId === "container:pkg-a")?.accepted, false);
  assert.ok(merged.entities.every(entity => !("coverageFileHitRate" in entity)));
});

test("readLcov uses the conventional coverage/lcov.info path and skips a missing sidecar", () => {
  assert.equal(readLcov(read), undefined);
  const present = readLcov(path => {
    if (path === "coverage/lcov.info") return syntheticLcov;
    throw new Error(`missing ${path}`);
  });
  assert.equal(present?.path, "coverage/lcov.info");
  assert.ok(present?.files.has("pkg/a/src/index.ts"));
});

test("THISS/okie working tree has no committed lcov sidecar, so coverage is honestly omitted", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  assert.equal(readLcov(path => readFileSync(`${repoRoot}${path}`, "utf8")), undefined);
});
