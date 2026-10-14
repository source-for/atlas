import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Packages whose ordering decides scan IDs, truncation, layout or output order (CLA-589). */
const SCANNED_PACKAGES = ["packages/scan/src", "packages/architecture/src", "packages/scene-compiler/src"];

interface LocaleOrderAllowance {
  /** Repo-relative path. */
  file: string;
  /** Text of the offending source line (trimmed) — survives line moves, not edits. */
  line: string;
  /** Why this use cannot change any ID, truncation, hash or output order. */
  reason: string;
}

/**
 * Locale-sensitive comparisons that are allowed to stay. Every entry needs a reason; an
 * entry that no longer matches anything fails the test so the list cannot rot.
 */
const ALLOWED: readonly LocaleOrderAllowance[] = [];

interface LocaleOrderUse {
  file: string;
  lineNumber: number;
  line: string;
  call: string;
}

/**
 * Every `localeCompare`, `Intl.Collator`, `toLocaleLowerCase`/`toLocaleUpperCase` use in a
 * TypeScript source — property accesses and string-keyed element accesses, never comments.
 */
function localeOrderUses(file: string, text: string): LocaleOrderUse[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  const uses: LocaleOrderUse[] = [];
  const record = (node: ts.Node, call: string): void => {
    const lineNumber = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    uses.push({ file, lineNumber, line: lines[lineNumber - 1]!.trim(), call });
  };
  const flagged = new Set(["localeCompare", "toLocaleLowerCase", "toLocaleUpperCase", "Collator"]);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && flagged.has(node.name.text)) {
      if (node.name.text !== "Collator" || (ts.isIdentifier(node.expression) && node.expression.text === "Intl")) record(node, node.name.text);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && flagged.has(node.argumentExpression.text)) {
      record(node, node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return uses;
}

function unallowed(uses: readonly LocaleOrderUse[], allowed: readonly LocaleOrderAllowance[]): { offending: LocaleOrderUse[]; stale: LocaleOrderAllowance[] } {
  const matches = (use: LocaleOrderUse, entry: LocaleOrderAllowance): boolean => entry.file === use.file && entry.line === use.line;
  return {
    offending: uses.filter(use => !allowed.some(entry => matches(use, entry))),
    stale: allowed.filter(entry => !uses.some(use => matches(use, entry))),
  };
}

function sourceFiles(directory: string): string[] {
  return readdirSync(join(repoRoot, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

test("CLA-589: scan, architecture and scene-compiler sources order text by code unit, not locale", () => {
  const files = SCANNED_PACKAGES.flatMap(sourceFiles);
  assert.ok(files.length > 100, `expected the three packages' sources, found ${files.length}`);
  const uses = files.flatMap(file => localeOrderUses(file, readFileSync(join(repoRoot, file), "utf8")));
  for (const entry of ALLOWED) assert.ok(entry.reason.trim().length > 0, `${entry.file}: allowlist entry needs a reason`);
  const { offending, stale } = unallowed(uses, ALLOWED);
  assert.deepEqual(offending.map(use => `${use.file}:${use.lineNumber} ${use.call}: ${use.line}`), [],
    "locale-sensitive ordering — use compareText from @okie/architecture, or allowlist with a reason");
  assert.deepEqual(stale, [], "allowlist entries that match nothing");
});

test("CLA-589: the locale-order lint sees calls, not comments, and honours allowlist entries", () => {
  const text = [
    "// a.localeCompare(b) in a comment is fine",
    "const s = names.sort((a, b) => a.localeCompare(b));",
    "const c = new Intl.Collator('lt');",
    "const u = name['toLocaleUpperCase']();",
    "const other = new Foo.Collator();",
  ].join("\n");
  const uses = localeOrderUses("x.ts", text);
  assert.deepEqual(uses.map(use => [use.lineNumber, use.call]), [[2, "localeCompare"], [3, "Collator"], [4, "toLocaleUpperCase"]]);
  const allowance = { file: "x.ts", line: "const c = new Intl.Collator('lt');", reason: "display only" };
  const stale = { file: "x.ts", line: "gone();", reason: "removed" };
  const result = unallowed(uses, [allowance, stale]);
  assert.deepEqual(result.offending.map(use => use.lineNumber), [2, 4]);
  assert.deepEqual(result.stale, [stale]);
});

/**
 * A repository whose scan diverges by locale under any collation-based order:
 * `app/src/mĵ.ts` and `app/src/mý.ts` both slug to `component:app-src-m-ts`, so their
 * relative order decides which keeps the bare ID and which gets `-2`. en-US collates
 * ĵ (a j) before ý (a y); Lithuanian puts y right after i, so ý comes first; code-unit
 * order (U+00FD < U+0135) also puts ý first. Their imports of `lib`, together with 23
 * `aNN.ts` files, give the app→lib relation 25 evidence rows for 24 slots, so the same
 * order decides which file's evidence is truncated away.
 */
function localeSensitiveRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "okie-cla589-"));
  const files: Record<string, string> = {
    "package.json": '{"name":"locale-order","private":true,"workspaces":["app","lib"]}\n',
    "app/package.json": '{"name":"app","dependencies":{"lib":"*"}}\n',
    "lib/package.json": '{"name":"lib"}\n',
    "lib/src/index.ts": "export const lib = 1;\n",
    "app/src/mĵ.ts": 'import { lib } from "lib";\nexport const j = lib;\n',
    "app/src/mý.ts": 'import { lib } from "lib";\nexport const y = lib;\n',
  };
  for (let index = 1; index <= 23; index += 1) {
    const name = `a${String(index).padStart(2, "0")}`;
    files[`app/src/${name}.ts`] = `import { lib } from "lib";\nexport const ${name} = lib;\n`;
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (args: string[]): void => { execFileSync("git", args, { cwd: dir, stdio: "ignore" }); };
  git(["init", "-q"]);
  git(["add", "."]);
  git(["-c", "user.name=Okie", "-c", "user.email=okie@example.test", "commit", "-q", "--no-gpg-sign", "-m", "fixture"]);
  return dir;
}

/**
 * Scans `dir` in a child process under `locale`. ICU reads the default locale from the
 * environment once, at process start, so a locale cannot be switched inside this process;
 * every locale variable is set explicitly so an inherited `LC_ALL` cannot mask `LANG`.
 */
function scanUnderLocale(dir: string, locale: string): { collator: string; files: Record<string, string> } {
  const scanModule = new URL("./scan.js", import.meta.url).href;
  const script = [
    `import { scanRepository, scanOutputFiles } from ${JSON.stringify(scanModule)};`,
    `const files = scanOutputFiles(scanRepository(${JSON.stringify(dir)}, { analysisMode: "quick" }));`,
    "process.stdout.write(JSON.stringify({ collator: new Intl.Collator().resolvedOptions().locale, files }));",
  ].join("\n");
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: locale, LANG: locale, LC_COLLATE: locale, LC_MESSAGES: locale };
  delete env.LANGUAGE;
  const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout) as { collator: string; files: Record<string, string> };
}

test("CLA-589: the same commit scans byte-identically under en_US and lt_LT", () => {
  const dir = localeSensitiveRepo();
  try {
    const en = scanUnderLocale(dir, "en_US.UTF-8");
    const lt = scanUnderLocale(dir, "lt_LT.UTF-8");
    // The locale really reached ICU in each child — otherwise this test proves nothing.
    assert.equal(en.collator, "en-US");
    assert.equal(lt.collator, "lt-LT");
    assert.deepEqual(Object.keys(lt.files), Object.keys(en.files));
    for (const name of Object.keys(en.files)) assert.equal(lt.files[name], en.files[name], `${name} differs between en_US and lt_LT`);

    // The fixture exercises identity and truncation: code-unit order gives ý the bare ID
    // and keeps its evidence.
    const extraction = JSON.parse(en.files["extraction.json"]!) as {
      entities: { id: string; name: string }[];
      relations: { id: string; evidence: { source: { path: string } }[] }[];
    };
    const component = (id: string): string | undefined => extraction.entities.find(entity => entity.id === id)?.name;
    assert.equal(component("component:app-src-m-ts"), "src/mý.ts");
    assert.equal(component("component:app-src-m-ts-2"), "src/mĵ.ts");
    const evidence = extraction.relations.find(relation => relation.id === "relation:app:lib")!.evidence.map(item => item.source.path);
    assert.equal(evidence.length, 24);
    assert.ok(evidence.includes("app/src/mý.ts") && !evidence.includes("app/src/mĵ.ts"), "the 24-row cap drops mĵ.ts, not mý.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
