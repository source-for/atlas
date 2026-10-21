import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { SOURCE_EXCERPT_LIMITS, STORY_AUTHORING_LIMITS, type ArchitectureStory } from "@okie/architecture";
import { boundedDisplayText } from "./story-authoring.js";
import { OVERSIZED_SYMBOLS_SHOWN, oversizedSymbolLimitations, scanRepository, type ScanArtifacts } from "./scan.js";

// CLA-594 items 3-4.
// Names: a package name (npm allows 214 characters) is interpolated into the story title,
// step titles, narrations and the view name. Those are presentation only and are cut with
// an ellipsis; ids still derive from the full name.
// Symbols: an identifier over the 256-character evidence symbol limit is never truncated
// (a cut symbol names nothing in the source). Its sourceRefs and moduleExport evidence keep
// the exact path and lines without a symbol, and analysis.limitations reports the gap.

function committedRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "okie-long-names-"));
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
  return dir;
}

function scan(files: Record<string, string>, mode: "quick" | "full"): ScanArtifacts {
  const repo = committedRepo(files);
  try { return scanRepository(repo, { analysisMode: mode }); } finally { rmSync(repo, { recursive: true, force: true }); }
}

const codePoints = (text: string): number => Array.from(text).length;

function assertStoryWithinLimits(story: ArchitectureStory): void {
  assert.ok(codePoints(story.title) <= STORY_AUTHORING_LIMITS.maxTitleCharacters, `${story.id} title fits`);
  for (const step of story.steps) {
    assert.ok(codePoints(step.title) <= STORY_AUTHORING_LIMITS.maxStepTitleCharacters, `${story.id} ${step.id} title fits`);
    assert.ok(codePoints(step.narration) <= STORY_AUTHORING_LIMITS.maxNarrationCharacters, `${story.id} ${step.id} narration fits`);
  }
}

test("boundedDisplayText: unchanged at the limit, ellipsis one over, never splits a surrogate pair", () => {
  assert.equal(boundedDisplayText("x".repeat(160), 160), "x".repeat(160));
  assert.equal(boundedDisplayText("x".repeat(161), 160), `${"x".repeat(159)}…`);
  const astral = "𝒜".repeat(161); // 322 UTF-16 units, 161 code points
  assert.equal(boundedDisplayText("𝒜".repeat(160), 160), "𝒜".repeat(160), "160 astral code points fit");
  assert.equal(boundedDisplayText(astral, 160), `${"𝒜".repeat(159)}…`);
});

const nameOf = (length: number, tail: string): string => `pkg-${"n".repeat(length - 4 - tail.length)}${tail}`;

for (const mode of ["quick", "full"] as const) {
  test(`${mode}: a 170-character package name bounds story/view text, keeps full-name identity`, { timeout: 120_000 }, () => {
    const files = (name: string) => ({ "package.json": JSON.stringify({ name }), "tsconfig.json": "{}", "src/index.ts": "export const ok = 1;\n" });
    const a = scan(files(nameOf(170, "a")), mode);
    const b = scan(files(nameOf(170, "b")), mode);
    for (const artifacts of [a, b]) for (const story of artifacts.stories) assertStoryWithinLimits(story);
    assert.equal(codePoints(a.story.title), STORY_AUTHORING_LIMITS.maxTitleCharacters);
    assert.ok(a.story.title.endsWith("…"));
    assert.ok(codePoints(a.view.name) <= 170, "view name uses the bounded display name");
    const systemId = (artifacts: ScanArtifacts) => artifacts.extraction.entities.find(entity => entity.kind === "softwareSystem")!.id;
    assert.notEqual(systemId(a), systemId(b), "names sharing the first 169 characters keep distinct ids");
    assert.equal(a.story.title, b.story.title, "only the display text was cut");

    // Boundary: a 151-character name makes a 160-character title, which is not cut.
    const exact = scan(files(nameOf(151, "z")), mode);
    assert.equal(exact.story.title, `${nameOf(151, "z")} overview`);
  });

  test(`${mode}: eight workspace packages with 170-character names keep narrations within the limit`, { timeout: 120_000 }, () => {
    const files: Record<string, string> = { "package.json": JSON.stringify({ name: "root", private: true, workspaces: ["packages/*"] }), "tsconfig.json": "{}" };
    for (let index = 0; index < 8; index += 1) {
      files[`packages/p${index}/package.json`] = JSON.stringify({ name: nameOf(170, String(index).padStart(2, "0")) });
      files[`packages/p${index}/src/index.ts`] = `export const v${index} = ${index};\n`;
    }
    const artifacts = scan(files, mode);
    for (const story of artifacts.stories) assertStoryWithinLimits(story);
    const containers = artifacts.story.steps.find(step => step.id === "step:containers");
    assert.ok(containers, "the containers step is kept");
    assert.ok(containers.narration.endsWith("…"), "the over-long narration is cut, not dropped");
    assert.equal(artifacts.extraction.entities.filter(entity => entity.kind === "container").length, 8);
  });
}

// Identifiers at and around the 256-code-point evidence symbol limit.
const LIMIT = SOURCE_EXCERPT_LIMITS.maxSymbolCharacters;
const AT_LIMIT = "a".repeat(LIMIT);
const ASTRAL_AT_LIMIT = "𝒜".repeat(LIMIT); // 512 UTF-16 units: fits by code point
const SHARED = "b".repeat(LIMIT);
const OVER_X = `${SHARED}x`; // 257, same first 256 characters as OVER_Y
const OVER_Y = `${SHARED}y`;
const RUST_AT_LIMIT = "r".repeat(LIMIT);
const RUST_OVER = "s".repeat(LIMIT + 1);

const SYMBOL_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "long-symbols" }),
  "tsconfig.json": "{}",
  "src/index.ts": [
    `export const ${AT_LIMIT} = 1;`,
    `export const ${ASTRAL_AT_LIMIT} = 2;`,
    `export function ${OVER_X}() {`,
    `  return ${AT_LIMIT};`,
    `}`,
    `export const ${OVER_Y} = 3;`,
    "",
  ].join("\n"),
  "crate/Cargo.toml": "[package]\nname = \"crate\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
  "crate/src/lib.rs": `pub fn ${RUST_AT_LIMIT}() {}\npub fn ${RUST_OVER}() {}\n`,
};

for (const mode of ["quick", "full"] as const) {
  test(`${mode}: identifiers over ${LIMIT} characters anchor on exact path+lines with an explicit limitation`, { timeout: 180_000 }, () => {
    const artifacts = scan(SYMBOL_FILES, mode);
    const code = new Map(artifacts.extraction.entities.filter(entity => entity.kind === "code").map(entity => [entity.sourceRefs[0]!.startLine + "@" + entity.sourceRefs[0]!.path, entity]));
    const at = (path: string, line: number) => code.get(`${line}@${path}`)!;

    // At the limit (ASCII and astral by code point): symbol kept on sourceRefs and exposure.
    for (const [line, symbol] of [[1, AT_LIMIT], [2, ASTRAL_AT_LIMIT]] as const) {
      const entity = at("src/index.ts", line);
      assert.equal(entity.sourceRefs[0]!.symbol, symbol, `line ${line} keeps its symbol`);
      assert.equal(entity.exposure?.[0]?.evidence.source.symbol, symbol);
    }
    assert.equal(at("crate/src/lib.rs", 1).sourceRefs[0]!.symbol, RUST_AT_LIMIT);

    // Over the limit: no symbol, exact lines, distinct ids despite a shared 256-character prefix.
    const overX = at("src/index.ts", 3);
    const overY = at("src/index.ts", 6);
    const rustOver = at("crate/src/lib.rs", 2);
    assert.deepEqual(overX.sourceRefs, [{ path: "src/index.ts", startLine: 3, endLine: 5 }]);
    assert.deepEqual(overX.exposure?.[0]?.evidence.source, { path: "src/index.ts", startLine: 3, endLine: 5 });
    assert.deepEqual(overY.sourceRefs, [{ path: "src/index.ts", startLine: 6, endLine: 6 }]);
    assert.deepEqual(overY.exposure?.[0]?.evidence.source, { path: "src/index.ts", startLine: 6, endLine: 6 });
    assert.deepEqual(rustOver.sourceRefs, [{ path: "crate/src/lib.rs", startLine: 2, endLine: 2 }]);
    assert.notEqual(overX.id, overY.id);

    // No anchor anywhere in the published artifacts carries a cut symbol.
    const published = JSON.stringify([artifacts.snapshot, artifacts.stories]);
    for (const prefix of [SHARED, "s".repeat(LIMIT)]) {
      assert.equal(published.includes(`"symbol":"${prefix}"`), false, "no truncated symbol anchor");
    }

    // A usage from the oversized declaration still records a line-anchored relation.
    const uses = artifacts.extraction.relations.filter(relation => relation.from === overX.id && relation.to === at("src/index.ts", 1).id);
    assert.equal(uses.length, 1, "relation from the oversized declaration is kept");
    assert.ok(uses[0]!.evidence.every(evidence => evidence.source.symbol === undefined && evidence.source.startLine === 4));

    assert.deepEqual((artifacts.analysis.limitations ?? []).filter(line => /identifier/.test(line)), [
      `3 declaration identifier(s) exceed the ${LIMIT}-character evidence symbol limit; their evidence carries path and lines but no symbol.`,
      `Oversized identifier crate/src/lib.rs:2 (${LIMIT + 1} characters)`,
      `Oversized identifier src/index.ts:3 (${LIMIT + 1} characters)`,
      `Oversized identifier src/index.ts:6 (${LIMIT + 1} characters)`,
    ]);
  });
}

test("oversizedSymbolLimitations: empty when none, itemizes up to the cap and counts the rest", () => {
  assert.deepEqual(oversizedSymbolLimitations([]), []);
  const many = Array.from({ length: OVERSIZED_SYMBOLS_SHOWN + 1 }, (_, index) => ({ path: "a.ts", line: index + 1, characters: 300 }));
  const lines = oversizedSymbolLimitations(many);
  assert.equal(lines.length, OVERSIZED_SYMBOLS_SHOWN + 2);
  assert.equal(lines.at(-1), "+1 more oversized identifier(s) not itemized.");
});
