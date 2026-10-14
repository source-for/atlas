import assert from "node:assert/strict";
import test from "node:test";
import { SOURCE_EXCERPT_LIMITS, validateSnapshot, normalizeArchitecture, selectArchitectureSnapshot, agentEvidence } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import { PORTABLE_CALL_CAPTURE_LIMITS, attachPortableSourceExcerpts, languageForScanPath, portableSourceExcerpt } from "./excerpt.js";
import { extractArchitecture } from "./extract.js";
import { buildScanArtifacts } from "./scan.js";

const pin = {
  commitSha: "abc123def456abc123def456abc123def456abc1",
  treeHash: "def456abc123def456abc123def456abc123def4",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const files: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": [
    "export function alpha() {",
    "  return 1;",
    "}",
    "export const A = 1;",
  ].join("\n") + "\n",
  "pkg/a/src/long.ts": [
    "export function longFn() {",
    ...Array.from({ length: 20 }, (_, index) => `  const n${index} = ${index};`),
    "  return n0;",
    "}",
  ].join("\n") + "\n",
  "pkg/a/src/wide.ts": [
    `export function wideFn(${"x".repeat(SOURCE_EXCERPT_LIMITS.maxLineCharacters)}: string) {`,
    "  return 1;",
    "  return 2;",
    "}",
  ].join("\n") + "\n",
};

function discovery(): Discovery {
  return {
    sourceFiles: ["pkg/a/src/index.ts", "pkg/a/src/long.ts", "pkg/a/src/wide.ts"],
    units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" }],
    unitByFile: new Map([
      ["pkg/a/src/index.ts", "pkg/a"],
      ["pkg/a/src/long.ts", "pkg/a"],
      ["pkg/a/src/wide.ts", "pkg/a"],
    ]),
    unitByPackageName: new Map([["@acme/a", "pkg/a"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const read = (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

test("languageForScanPath matches snapshot excerpt validation", () => {
  assert.equal(languageForScanPath("apps/web/src/App.tsx"), "tsx");
  assert.equal(languageForScanPath("packages/scan/src/excerpt.ts"), "typescript");
  assert.equal(languageForScanPath("scripts/build-wasm.mjs"), "javascript");
  assert.equal(languageForScanPath("crates/atlas-engine/src/lod.rs"), "rust");
  assert.equal(languageForScanPath("d.jsx"), undefined);
  assert.equal(languageForScanPath("README.md"), undefined);
});

test("portableSourceExcerpt clamps to architecture limits and scrubs GitHub tokens", () => {
  const planted = "gho_okieTestPlantedSecretCla54xxxx";
  const short = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    symbol: "alpha",
    startLine: 1,
    endLine: 3,
    frozenRevision: pin.commitSha,
    fileText: files["pkg/a/src/index.ts"]!,
  });
  assert.ok(short);
  assert.equal(short.startLine, 1);
  assert.equal(short.endLine, 3);
  assert.equal(short.highlightLine, 1);
  assert.equal(short.language, "typescript");
  assert.equal(short.frozenRevision, pin.commitSha);
  assert.ok(short.text.includes("export function alpha()"));
  assert.equal(short.text, short.lines.join("\n"));

  const long = portableSourceExcerpt({
    path: "pkg/a/src/long.ts",
    symbol: "longFn",
    startLine: 1,
    endLine: 23,
    frozenRevision: pin.commitSha,
    fileText: files["pkg/a/src/long.ts"]!,
  });
  assert.ok(long);
  assert.equal(long.lines.length, 23);
  assert.equal(long.endLine, 23);
  assert.equal(long.sourceStartLine, 1);
  assert.equal(long.sourceEndLine, 23);
  assert.ok(long.text.endsWith("  return n0;\n}"));
  assert.ok(long.text.startsWith("export function longFn()"));

  const redacted = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    symbol: "alpha",
    startLine: 1,
    endLine: 1,
    frozenRevision: pin.commitSha,
    fileText: `export function alpha() { return "${planted}"; }\n`,
  });
  assert.ok(redacted);
  assert.equal(redacted.text.includes(planted), false);
  assert.ok(redacted.text.includes("[redacted-token]"));
});

test("portableSourceExcerpt skips an overlong first line and records partial capture", () => {
  assert.equal(SOURCE_EXCERPT_LIMITS.maxLines, 48);
  assert.equal(SOURCE_EXCERPT_LIMITS.maxLineCharacters, 512);

  const skipped = portableSourceExcerpt({
    path: "pkg/a/src/wide.ts",
    symbol: "wideFn",
    startLine: 1,
    endLine: 4,
    frozenRevision: pin.commitSha,
    fileText: files["pkg/a/src/wide.ts"]!,
  });
  assert.ok(skipped);
  assert.equal(skipped.startLine, 2);
  assert.equal(skipped.endLine, 4);
  assert.equal(skipped.sourceStartLine, 1);
  assert.equal(skipped.sourceEndLine, 4);
  assert.equal(skipped.highlightLine, 2);
  assert.equal(skipped.lines[0], "  return 1;");
  assert.ok(!skipped.text.includes("export function wideFn"));
  assert.ok(skipped.lines.length <= SOURCE_EXCERPT_LIMITS.maxLines);
  assert.ok(skipped.lines.every(line => [...line].length <= SOURCE_EXCERPT_LIMITS.maxLineCharacters));

  const exactLimit = "x".repeat(SOURCE_EXCERPT_LIMITS.maxLineCharacters);
  const atLimit = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    startLine: 1,
    endLine: 1,
    frozenRevision: pin.commitSha,
    fileText: `${exactLimit}\n`,
  });
  assert.ok(atLimit);
  assert.equal(atLimit.startLine, 1);
  assert.equal(atLimit.lines[0], exactLimit);

  const onlyOverlong = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    startLine: 1,
    endLine: 1,
    frozenRevision: pin.commitSha,
    fileText: `${"x".repeat(SOURCE_EXCERPT_LIMITS.maxLineCharacters + 1)}\n`,
  });
  assert.equal(onlyOverlong, undefined);

  const planted = `gho_${"A".repeat(600)}`;
  const scrubbedFits = portableSourceExcerpt({
    path: "pkg/a/src/index.ts",
    symbol: "alpha",
    startLine: 1,
    endLine: 1,
    frozenRevision: pin.commitSha,
    fileText: `export function alpha() { return "${planted}"; }\n`,
  });
  assert.ok(scrubbedFits);
  assert.equal(scrubbedFits.startLine, 1);
  assert.equal(scrubbedFits.text.includes(planted), false);
});

test("scan snapshot attaches portable excerpts to code entities and never to containers", () => {
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.deepEqual(validateSnapshot(artifacts.snapshot), []);

  const alpha = artifacts.snapshot.entities.find(entity => entity.name === "alpha")!;
  const longFn = artifacts.snapshot.entities.find(entity => entity.name === "longFn")!;
  const wideFn = artifacts.snapshot.entities.find(entity => entity.name === "wideFn")!;
  const container = artifacts.snapshot.entities.find(entity => entity.kind === "container")!;
  const component = artifacts.snapshot.entities.find(entity => entity.kind === "component" && entity.name === "src/index.ts")!;

  assert.equal(alpha.kind, "code");
  assert.equal(alpha.sourceExcerpts?.length, 1);
  assert.ok(alpha.sourceExcerpts![0]!.text.includes("export function alpha()"));
  assert.equal(alpha.sourceRefs[0]!.startLine, alpha.sourceExcerpts![0]!.startLine);
  assert.equal(alpha.sourceRefs[0]!.endLine, alpha.sourceExcerpts![0]!.endLine);

  assert.equal(longFn.sourceExcerpts?.length, 1);
  assert.equal(longFn.sourceExcerpts![0]!.lines.length, 23);
  assert.equal(longFn.sourceRefs[0]!.endLine, longFn.sourceExcerpts![0]!.endLine);

  assert.equal(wideFn.sourceExcerpts?.length, 1);
  assert.equal(wideFn.sourceExcerpts![0]!.startLine, 2);
  assert.equal(wideFn.sourceRefs[0]!.startLine, 1);
  assert.equal(wideFn.sourceRefs.length, 1);
  assert.equal(wideFn.sourceRefs[0]!.endLine, 4);
  assert.ok(wideFn.sourceExcerpts![0]!.lines.every(line => [...line].length <= SOURCE_EXCERPT_LIMITS.maxLineCharacters));

  assert.equal(container.sourceExcerpts, undefined);
  assert.equal(component.sourceExcerpts, undefined);
  assert.ok(artifacts.snapshot.entities.filter(entity => entity.kind === "code")
    .every(entity => (entity.sourceExcerpts?.length ?? 0) === 1));
});

test("include-source bundles known files and never attempts a container directory anchor", () => {
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
    includeSource: true,
  });
  assert.deepEqual(artifacts.sources?.map(source => source.path), [
    "README.md",
    "pkg/a/src/index.ts",
    "pkg/a/src/long.ts",
    "pkg/a/src/wide.ts",
  ]);
});

test("extraction documents stay excerpt-free after the host attaches snapshot excerpts", () => {
  const extraction = extractArchitecture({
    discovery: discovery(),
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  assert.ok(extraction.entities.every(entity => !("sourceExcerpts" in entity)));
  const artifacts = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.ok(artifacts.extraction.entities.every(entity => !("sourceExcerpts" in entity)));
  const attached = attachPortableSourceExcerpts(artifacts.snapshot, read);
  assert.equal(attached.entities.find(entity => entity.name === "alpha")?.sourceExcerpts?.length, 1);
  assert.deepEqual(attached, artifacts.snapshot, "reattaching must not duplicate window references");
});

test("TS and Rust body capture preserves offset ranges and stops before neighbouring declarations", () => {
  for (const path of ["body.ts", "body.rs"]) {
    const body = [path.endsWith(".rs") ? "pub fn body() {" : "export function body() {",
      ...Array.from({ length: 17 }, (_, i) => `  // implementation ${i}`), "  perform_write();", "}"];
    const excerpt = portableSourceExcerpt({ path, symbol: "body", startLine: 4, endLine: 23,
      frozenRevision: pin.commitSha, fileText: ["// before", "", "// before", ...body, "NEIGHBOUR"].join("\r\n") });
    assert.ok(excerpt);
    assert.deepEqual(excerpt.lines, body);
    assert.deepEqual([excerpt.startLine, excerpt.endLine, excerpt.sourceStartLine, excerpt.sourceEndLine], [4, 23, 4, 23]);
    assert.equal(excerpt.text.includes("NEIGHBOUR"), false);
  }
});

test("line and text caps retain the original range and never fabricate complete capture", () => {
  const input = { path: "body.rs", symbol: "body", startLine: 3, endLine: 62, frozenRevision: pin.commitSha };
  const fileText = ["// before", "", ...Array.from({ length: 60 }, (_, i) => `// line ${i}`)].join("\n");
  const excerpt = portableSourceExcerpt({ ...input, fileText })!;
  assert.deepEqual([excerpt.startLine, excerpt.endLine, excerpt.sourceStartLine, excerpt.sourceEndLine], [3, 50, 3, 62]);
  assert.equal(excerpt.lines.length, 48);
  const wide = portableSourceExcerpt({ ...input, fileText: ["// before", "", ...Array(60).fill("x".repeat(100))].join("\n") })!;
  assert.equal(wide.lines.length, 40); // 40 × 100 + 39 separators = 4039; 41 exceeds 4096.
  assert.equal(wide.endLine, 42);
  assert.equal(wide.sourceEndLine, 62);
  const shortFile = portableSourceExcerpt({ ...input, fileText: "// before\n\nfirst\nlast" })!;
  assert.equal(shortFile.endLine, 4);
  assert.equal(shortFile.sourceEndLine, 62, "EOF must not make a longer observed range look complete");
});

test("portable validation binds both captured and original ranges to the same pinned symbol", () => {
  const artifacts = buildScanArtifacts({ discovery: discovery(), pin, readFile: read, repositorySlug: "acme", systemName: "Acme" });
  const wide = artifacts.snapshot.entities.find(entity => entity.name === "wideFn")!;
  const excerpt = wide.sourceExcerpts![0]!;
  assert.deepEqual(validateSnapshot(artifacts.snapshot), []);
  const original = structuredClone(artifacts.snapshot);
  for (const mutation of [
    { sourceStartLine: 3 }, { sourceEndLine: 3 }, { sourceEndLine: 5 }, { sourceStartLine: undefined },
  ]) {
    Object.assign(excerpt, { sourceStartLine: 1, sourceEndLine: 4 }, mutation);
    assert.ok(validateSnapshot(artifacts.snapshot).some(issue => issue.message.includes("original source range")));
  }
  const legacy = structuredClone(original);
  for (const entity of legacy.entities) for (const item of entity.sourceExcerpts ?? []) {
    entity.sourceRefs = [{ ...entity.sourceRefs[0]!, startLine: item.startLine, endLine: item.endLine }];
    delete item.sourceStartLine; delete item.sourceEndLine;
  }
  assert.deepEqual(validateSnapshot(legacy), [], "old excerpts remain valid without coverage claims");
  const wrongPin = structuredClone(original);
  wrongPin.entities.find(entity => entity.name === "wideFn")!.sourceRefs[0]!.commitSha = "different";
  assert.ok(validateSnapshot(wrongPin).some(issue => issue.message.includes("original source range")));
});

test("normalize and reattach preserve a single 1–83 declaration beside its partial 1–48 capture", () => {
  const original = buildScanArtifacts({ discovery: discovery(), pin, readFile: read, repositorySlug: "acme", systemName: "Acme" }).snapshot;
  const entity = original.entities.find(row => row.name === "longFn")!;
  delete entity.sourceExcerpts;
  entity.sourceRefs[0]!.endLine = 83;
  const load = (path: string) => path.endsWith("long.ts") ? Array(83).fill("// source").join("\n") : read(path);
  const attached = attachPortableSourceExcerpts(original, load);
  const normalized = normalizeArchitecture({ snapshot: attached });
  const roundTrip = selectArchitectureSnapshot(normalized, attached.id);
  const again = attachPortableSourceExcerpts(roundTrip, load);
  const result = again.entities.find(row => row.id === entity.id)!;
  assert.equal(result.sourceRefs.length, 1);
  assert.deepEqual([result.sourceRefs[0]!.startLine, result.sourceRefs[0]!.endLine], [1, 83]);
  assert.deepEqual([result.sourceExcerpts![0]!.startLine, result.sourceExcerpts![0]!.endLine, result.sourceExcerpts![0]!.sourceEndLine], [1, 48, 83]);
  assert.deepEqual(validateSnapshot(again), []);
});

test("unknown or invalid declaration ends do not synthesize a captured reference", () => {
  const original = buildScanArtifacts({ discovery: discovery(), pin, readFile: read, repositorySlug: "acme", systemName: "Acme" }).snapshot;
  const entity = original.entities.find(row => row.name === "wideFn")!;
  delete entity.sourceExcerpts;
  delete entity.sourceRefs[0]!.endLine;
  const attached = attachPortableSourceExcerpts(original, read);
  assert.deepEqual(attached, original);
  assert.deepEqual(validateSnapshot(attached), []);
  for (const endLine of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(portableSourceExcerpt({ path: "a.ts", startLine: 1, endLine, frozenRevision: pin.commitSha, fileText: "source" }), undefined);
  }
});

test("observed calls beyond the entry excerpt retain frozen bounded windows and declaration identity", () => {
  const original = buildScanArtifacts({ discovery: discovery(), pin, readFile: read, repositorySlug: "acme", systemName: "Acme" }).snapshot;
  const entity = original.entities.find(row => row.name === "longFn")!;
  const ref = entity.sourceRefs[0]!;
  ref.startLine = 1; ref.endLine = 240;
  const token = `gho_${"A".repeat(40)}`;
  const lines = Array.from({ length: 240 }, (_, index) => `// line ${index + 1}`);
  lines[74] = 'await submitAskQuestion();'; lines[144] = `await modelRequest("${token}");`;
  const relation = (anchor: number, commitSha = pin.commitSha) => ({ id: `call:${anchor}:${commitSha}`, from: entity.id, to: entity.id, kind: "calls" as const, evidence: [{ source: { path: ref.path, commitSha, startLine: anchor, endLine: anchor } }] });
  original.relations = [relation(145), relation(75), relation(220, "foreign")];
  const attached = attachPortableSourceExcerpts(original, path => path === ref.path ? lines.join("\n") : read(path));
  const result = attached.entities.find(row => row.id === entity.id)!;
  assert.equal(result.sourceExcerpts?.length, 3);
  for (const anchor of [75, 145]) assert.ok(result.sourceExcerpts!.some(window => window.highlightLine === anchor && window.startLine <= anchor && window.endLine >= anchor));
  assert.ok(!result.sourceExcerpts!.some(window => window.startLine <= 220 && window.endLine >= 220));
  assert.equal(result.sourceRefs.length, 1);
  for (const window of result.sourceExcerpts!) {
    assert.equal(window.frozenRevision, pin.commitSha);
    assert.deepEqual([window.sourceStartLine, window.sourceEndLine], [1, 240]);
    assert.ok(window.lines.length <= SOURCE_EXCERPT_LIMITS.maxLines);
    assert.ok(!window.text.includes(token));
  }
  assert.deepEqual(validateSnapshot(attached), []);
  const evidence = agentEvidence(attached, entity.id);
  assert.equal(evidence.status, "captured");
  assert.equal(evidence.truncated, true);
  for (const anchor of [75, 145]) assert.ok(evidence.excerpts.some(window => window.startLine <= anchor && window.endLine >= anchor));
  const reversed = attachPortableSourceExcerpts({ ...original, relations: [...original.relations].reverse() }, path => path === ref.path ? lines.join("\n") : read(path));
  assert.deepEqual(reversed.entities, attached.entities);
  const roundTrip = selectArchitectureSnapshot(normalizeArchitecture({ snapshot: attached }), attached.id);
  assert.equal(roundTrip.entities.find(row => row.id === entity.id)?.sourceExcerpts?.length, 3);
});

test("call-site capture stays bounded and cannot reach outside the declaration", () => {
  const original = buildScanArtifacts({ discovery: discovery(), pin, readFile: read, repositorySlug: "acme", systemName: "Acme" }).snapshot;
  const entity = original.entities.find(row => row.name === "longFn")!;
  const ref = entity.sourceRefs[0]!; ref.endLine = 400;
  original.relations = [75, 145, 215, 285, 355, 500].map(anchor => ({ id: `call:${anchor}`, from: entity.id, to: entity.id, kind: "calls", evidence: [{ source: { path: ref.path, commitSha: pin.commitSha, startLine: anchor, endLine: anchor } }] }));
  const attached = attachPortableSourceExcerpts(original, path => path === ref.path ? Array(600).fill('// source').join('\n') : read(path));
  const windows = attached.entities.find(row => row.id === entity.id)!.sourceExcerpts!;
  assert.equal(windows.length, 6);
  assert.deepEqual(windows.map(window => window.highlightLine), [1, 75, 145, 215, 285, 355]);
  assert.ok(windows.every(window => window.endLine <= 400));
  for (const focusLine of [0, 401, NaN, 2.5]) assert.equal(portableSourceExcerpt({ path: ref.path, startLine: 1, endLine: 400, frozenRevision: pin.commitSha, fileText: '// source', focusLine }), undefined);
});


test("large callers capture late calls while enforcing serialized UTF8 budgets", () => {
  const original = buildScanArtifacts({ discovery: discovery(), pin, readFile: read, repositorySlug: "acme", systemName: "Acme" }).snapshot;
  const entity = original.entities.find(row => row.name === "longFn")!;
  const ref = entity.sourceRefs[0]!; ref.endLine = 16000;
  const anchors = Array.from({ length: 200 }, (_, index) => 75 + index * 70);
  original.relations = anchors.map(anchor => ({ id: `call:${anchor}`, from: entity.id, to: entity.id, kind: "calls", evidence: [{ source: { path: ref.path, commitSha: pin.commitSha, startLine: anchor, endLine: anchor } }] }));
  const capture = (line: string) => attachPortableSourceExcerpts(original, path => path === ref.path ? Array(16000).fill(line).join("\n") : read(path));
  const small = capture("// call");
  const windows = small.entities.find(row => row.id === entity.id)!.sourceExcerpts!;
  assert.equal(windows.length, PORTABLE_CALL_CAPTURE_LIMITS.maxWindowsPerEntity);
  assert.ok(agentEvidence(small, entity.id, { sourcePath: ref.path, sourceLine: 5255 }).excerpts.some(window => window.startLine <= 5255 && window.endLine >= 5255));
  const large = capture("// " + "界".repeat(200));
  const bounded = large.entities.find(row => row.id === entity.id)!.sourceExcerpts!;
  assert.ok(bounded.length < PORTABLE_CALL_CAPTURE_LIMITS.maxWindowsPerEntity);
  assert.ok(bounded.reduce((sum, window) => sum + Buffer.byteLength(JSON.stringify(window), "utf8"), 0) <= PORTABLE_CALL_CAPTURE_LIMITS.maxBytesPerEntity);
  assert.deepEqual(validateSnapshot(large), []);
  const many = { ...original, entities: Array.from({ length: 24 }, (_, index) => ({ ...entity, id: `caller:${index}` })), relations: Array.from({ length: 24 }, (_, index) => original.relations.map(row => ({ ...row, id: `${row.id}:${index}`, from: `caller:${index}`, to: `caller:${index}` }))).flat() };
  const capped = attachPortableSourceExcerpts(many, () => Array(16000).fill("// " + "界".repeat(200)).join("\n"));
  const extra = capped.entities.reduce((sum, row) => sum + (row.sourceExcerpts ?? []).slice(1).reduce((bytes, window) => bytes + Buffer.byteLength(JSON.stringify(window), "utf8"), 0), 0);
  assert.ok(extra <= PORTABLE_CALL_CAPTURE_LIMITS.maxAdditionalBytesPerSnapshot);
  assert.ok(capped.entities.every(row => row.sourceExcerpts?.length));
});
