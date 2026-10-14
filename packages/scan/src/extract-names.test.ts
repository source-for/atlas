import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ARCHITECTURE_EXTRACTION_LIMITS, validateArchitectureExtraction } from "@okie/architecture";
import { entityDisplayName, parseSource, topLevelDeclarations } from "./extract.js";
import { scanRepository } from "./scan.js";

// CLA-587: babel/babel failed the extraction gate. Its parser fixtures hold syntax a
// recovering parser turns into a declaration with a MISSING (empty) identifier
// (`export default interface {}`), which became a blank code-entity name.

function committedRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "okie-names-"));
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, relative)), { recursive: true });
    writeFileSync(join(dir, relative), content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: dir });
  return dir;
}

test("a declaration whose identifier the parser recovered as missing gets a deterministic fallback name", () => {
  const names = (text: string): Array<[string, boolean]> =>
    topLevelDeclarations(parseSource("a.ts", text)).map(declaration => [declaration.name, declaration.exported]);
  assert.deepEqual(names("export default interface {}\n"), [["default", true]], "babel's typescript/interface/export-default fixture");
  assert.deepEqual(names("function () {}\n"), [["anonymous function", false]]);
  assert.deepEqual(names("enum {}\n"), [["anonymous enum", false]]);
  assert.deepEqual(names("enum {}\nenum {}\nexport interface Named {}\n"), [["anonymous enum", false], ["anonymous enum", false], ["Named", true]]);
});

const BROKEN_FIXTURES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "parser" }),
  "tsconfig.json": "{}",
  "src/index.ts": "export const ok = 1;\n",
  "src/export-default-interface.ts": "export default interface {}\n",
  "src/anonymous.ts": "enum {}\nenum {}\nfunction () {}\n",
};

for (const mode of ["quick", "full"] as const) {
  test(`${mode} scan of files with recovered empty identifiers passes the extraction gate with stable ids`, { timeout: 120_000 }, () => {
    const repo = committedRepo(BROKEN_FIXTURES);
    try {
      const first = scanRepository(repo, { analysisMode: mode });
      assert.deepEqual(validateArchitectureExtraction(first.extraction).filter(issue => /name|symbol/.test(issue.path)), []);
      for (const entity of first.extraction.entities) {
        assert.ok(entity.name.trim().length > 0, `${entity.id} has a name`);
        assert.ok([...entity.name].length <= ARCHITECTURE_EXTRACTION_LIMITS.maxNameCharacters, `${entity.id} name fits`);
      }
      const code = first.extraction.entities.filter(entity => entity.kind === "code").map(entity => [entity.id, entity.name]);
      assert.deepEqual(code.filter(([id]) => !id!.includes(":src-index-ts:")), [
        ["code:src-anonymous-ts:anonymous-enum", "anonymous enum"],
        ["code:src-anonymous-ts:anonymous-enum-2", "anonymous enum"],
        ["code:src-anonymous-ts:anonymous-function", "anonymous function"],
        ["code:src-export-default-interface-ts:default", "default"],
      ]);
      const second = scanRepository(repo, { analysisMode: mode });
      assert.equal(JSON.stringify(second.extraction), JSON.stringify(first.extraction), "byte-stable across runs");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
}

// The gate caps entity names at 160 code points. Names are display-only: ids derive from
// the full path/symbol, and sourceRefs.symbol keeps the full identifier.
const LONG_HEAD = "handle".repeat(30); // 180 characters
const LONG_DIR = `src/${"deeply-nested-directory-".repeat(4)}/${"another-long-segment-".repeat(4)}`;
const LONG_FILE = `${LONG_DIR}/module.ts`;

test("entityDisplayName: blank -> unnamed <kind>; over the limit -> ellipsis, path tail for components, head otherwise", () => {
  const limit = ARCHITECTURE_EXTRACTION_LIMITS.maxNameCharacters;
  assert.equal(entityDisplayName("code", "  "), "unnamed code");
  assert.equal(entityDisplayName("code", "short"), "short");
  const exact = "x".repeat(limit);
  assert.equal(entityDisplayName("code", exact), exact, "a name at the limit is unchanged");
  const code = entityDisplayName("code", `${LONG_HEAD}A`);
  assert.equal([...code].length, limit);
  assert.equal(code, `${LONG_HEAD.slice(0, limit - 1)}…`);
  const component = entityDisplayName("component", `${"d/".repeat(100)}file.ts`);
  assert.equal([...component].length, limit);
  assert.ok(component.startsWith("…") && component.endsWith("/file.ts"));
  assert.equal([...entityDisplayName("code", "😀".repeat(200))].length, limit, "counted in code points, never splitting a surrogate pair");
});

for (const mode of ["quick", "full"] as const) {
  test(`${mode} scan: names over 160 characters are shortened for display; ids stay unique and stable`, { timeout: 120_000 }, () => {
    const repo = committedRepo({
      "package.json": JSON.stringify({ name: "long" }),
      "tsconfig.json": "{}",
      [LONG_FILE]: `export const ${LONG_HEAD}A = 1;\nexport const ${LONG_HEAD}B = 2;\n`,
    });
    try {
      const first = scanRepository(repo, { analysisMode: mode });
      assert.deepEqual(validateArchitectureExtraction(first.extraction), []);
      const component = first.extraction.entities.find(entity => entity.kind === "component" && entity.sourceRefs[0]!.path === LONG_FILE)!;
      assert.ok([...LONG_FILE].length > ARCHITECTURE_EXTRACTION_LIMITS.maxNameCharacters);
      assert.ok(component.name.startsWith("…") && component.name.endsWith("/module.ts"), component.name);
      const code = first.extraction.entities.filter(entity => entity.kind === "code" && entity.sourceRefs[0]!.path === LONG_FILE);
      assert.equal(code.length, 2);
      assert.equal(code[0]!.name, code[1]!.name, "both display names share the cut head");
      assert.notEqual(code[0]!.id, code[1]!.id, "ids come from the full symbols, so they stay distinct");
      assert.deepEqual(code.map(entity => entity.sourceRefs[0]!.symbol).sort(), [`${LONG_HEAD}A`, `${LONG_HEAD}B`], "symbols are never cut");
      const second = scanRepository(repo, { analysisMode: mode });
      assert.equal(JSON.stringify(second.extraction), JSON.stringify(first.extraction), "byte-stable across runs");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
}

// CLA-587 review round 3: a parser-recovered declaration never takes a real declaration's
// id, and its evidence carries no invented symbol.
for (const mode of ["quick", "full"] as const) {
  test(`${mode} scan: real declarations keep their bare ids beside recovered ones; recovered anchors carry no invented symbol`, { timeout: 120_000 }, () => {
    const repo = committedRepo({
      "package.json": JSON.stringify({ name: "parser" }),
      "tsconfig.json": "{}",
      "src/a.ts": "enum {}\nexport const anonymousEnum = 1;\n",
      "src/b.ts": "export default interface {}\nexport const Default = 1;\n",
    });
    try {
      const first = scanRepository(repo, { analysisMode: mode });
      assert.deepEqual(validateArchitectureExtraction(first.extraction), []);
      const code = first.extraction.entities.filter(entity => entity.kind === "code")
        .map(entity => [entity.id, entity.name, entity.sourceRefs[0]!.symbol ?? null, entity.sourceRefs[0]!.startLine]);
      assert.deepEqual(code, [
        ["code:src-a-ts:anonymous-enum", "anonymousEnum", "anonymousEnum", 2],
        ["code:src-a-ts:anonymous-enum-2", "anonymous enum", null, 1],
        ["code:src-b-ts:default", "Default", "Default", 2],
        ["code:src-b-ts:default-2", "default", "default", 1],
      ]);
      const second = scanRepository(repo, { analysisMode: mode });
      assert.equal(JSON.stringify(second.extraction), JSON.stringify(first.extraction), "byte-stable across runs");
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
}
