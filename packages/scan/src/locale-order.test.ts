import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

/** Packages whose ordering decides scan IDs, truncation, layout or output order (CLA-589). */
const PACKAGE_NAMES = ["scan", "architecture", "scene-compiler"];
const SCANNED_PACKAGES = PACKAGE_NAMES
  .flatMap(name => [`packages/${name}/src`, `packages/${name}/scripts`])
  .filter(directory => existsSync(join(repoRoot, directory)));

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
 * Every locale-dependent text API in a TypeScript or JavaScript source: `localeCompare`,
 * `toLocaleLowerCase`/`toLocaleUpperCase`, `toLocaleString`/`toLocaleDateString`/
 * `toLocaleTimeString`, and the `Intl` constructors (`Collator`, `NumberFormat`, …). It sees
 * property accesses, string-keyed element accesses, destructured bindings and destructuring
 * assignments (`({ localeCompare: compare } = String.prototype)`), with `Intl` reached as
 * `Intl`, `(Intl)`, `globalThis.Intl`, `window['Intl']` or a nested `{ Intl: { Collator } }`
 * pattern — never comments. `Intl.Collator` is always reported: text is ordered by code unit,
 * whatever the locale. The one exemption is `Intl.Segmenter` called with a string literal
 * naming a concrete tag (`new Intl.Segmenter('en', …)`, not `''` or `'und'`), which does not
 * depend on the machine.
 */
function localeOrderUses(file: string, text: string): LocaleOrderUse[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const lines = text.split("\n");
  const uses: LocaleOrderUse[] = [];
  const record = (node: ts.Node, call: string): void => {
    const lineNumber = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    uses.push({ file, lineNumber, line: lines[lineNumber - 1]!.trim(), call });
  };
  const methods = new Set(["localeCompare", "toLocaleLowerCase", "toLocaleUpperCase", "toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);
  const constructors = new Set(["Collator", "NumberFormat", "DateTimeFormat", "ListFormat", "PluralRules", "RelativeTimeFormat", "DisplayNames", "DurationFormat", "Segmenter"]);
  /** The text of a property key: `key`, `'key'` or `['key']`. */
  const keyText = (key: ts.PropertyName | undefined): string | undefined => {
    if (key === undefined) return undefined;
    if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;
    if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression)) return key.expression.text;
    return undefined;
  };
  /** `ts.skipParentheses`, which the public typings do not export. */
  const skipParentheses = (expression: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(expression) ? skipParentheses(expression.expression) : expression;
  /** Whether an expression is `Intl`: `Intl`, `(Intl)`, `globalThis.Intl` or `window['Intl']`. */
  const isIntl = (expression: ts.Expression): boolean => {
    const bare = skipParentheses(expression);
    if (ts.isIdentifier(bare)) return bare.text === "Intl";
    if (ts.isPropertyAccessExpression(bare)) return bare.name.text === "Intl";
    return ts.isElementAccessExpression(bare) && ts.isStringLiteralLike(bare.argumentExpression) && bare.argumentExpression.text === "Intl";
  };
  /** Whether a read of `name` from an object whose owner `isOwnerIntl` reports is locale-dependent. */
  const flagged = (name: string | undefined, isOwnerIntl: () => boolean): name is string =>
    name !== undefined && (methods.has(name) || (constructors.has(name) && isOwnerIntl()));
  /** Whether `Intl.X` is the callee of a call or `new` whose first argument is a string literal naming a concrete tag. */
  const namesLocale = (access: ts.Expression): boolean => {
    let callee: ts.Node = access;
    while (ts.isParenthesizedExpression(callee.parent)) callee = callee.parent;
    const call = callee.parent;
    if (!(ts.isCallExpression(call) || ts.isNewExpression(call)) || call.expression !== callee) return false;
    const first = call.arguments?.[0];
    return first !== undefined && ts.isStringLiteralLike(first) && first.text !== "" && !/^und(?:-|$)/i.test(first.text);
  };
  /** Whether an object binding pattern destructures `Intl`: `= Intl`, or nested under an `Intl` key. */
  const bindingFromIntl = (pattern: ts.ObjectBindingPattern): boolean => {
    const owner = pattern.parent;
    if (ts.isBindingElement(owner)) return (keyText(owner.propertyName) ?? (ts.isIdentifier(owner.name) ? owner.name.text : undefined)) === "Intl";
    const initializer = (ts.isVariableDeclaration(owner) || ts.isParameter(owner)) ? owner.initializer : undefined;
    return initializer !== undefined && isIntl(initializer);
  };
  /** The node an assignment pattern sits in, past parentheses. */
  const container = (node: ts.Node): ts.Node => {
    let parent = node.parent;
    while (ts.isParenthesizedExpression(parent)) parent = parent.parent;
    return parent;
  };
  /** The value a destructuring-assignment pattern reads from, if `node` is one: `({ … } = value)`, nested in arrays, objects and spreads. */
  const assignmentSource = (node: ts.Node): ts.Expression | "nested" | undefined => {
    const parent = container(node);
    if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && skipParentheses(parent.left) === node) {
      // Inside an enclosing pattern, `{ b } = fallback` is a default and reads from the enclosing key.
      return assignmentSource(parent) === undefined ? parent.right : "nested";
    }
    if ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) && parent.initializer === node) return "nested";
    if (ts.isPropertyAssignment(parent) && parent.initializer === node) return assignmentSource(parent.parent) === undefined ? undefined : "nested";
    if (ts.isArrayLiteralExpression(parent) || ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) {
      const outer = ts.isArrayLiteralExpression(parent) ? parent : parent.parent;
      return assignmentSource(outer) === undefined ? undefined : "nested";
    }
    return undefined;
  };
  /** Whether an object-literal assignment pattern destructures `Intl`: `= Intl`, or nested under an `Intl` key. */
  const assignmentFromIntl = (pattern: ts.ObjectLiteralExpression): boolean => {
    let inner: ts.Node = pattern;
    if (ts.isBinaryExpression(container(pattern))) inner = container(pattern);
    const owner = container(inner);
    if (ts.isPropertyAssignment(owner)) return keyText(owner.name) === "Intl";
    const value = assignmentSource(pattern);
    return value !== undefined && value !== "nested" && isIntl(value);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node)) {
      if (flagged(node.name.text, () => isIntl(node.expression)) && !(node.name.text === "Segmenter" && namesLocale(node))) record(node, node.name.text);
    } else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
      const name = node.argumentExpression.text;
      if (flagged(name, () => isIntl(node.expression)) && !(name === "Segmenter" && namesLocale(node))) record(node, name);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      const pattern = node.parent;
      const key = keyText(node.propertyName) ?? (ts.isIdentifier(node.name) ? node.name.text : undefined);
      if (flagged(key, () => bindingFromIntl(pattern))) record(node, key);
    } else if ((ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) && ts.isObjectLiteralExpression(node.parent) && assignmentSource(node.parent) !== undefined) {
      const pattern = node.parent;
      const key = keyText(node.name);
      if (flagged(key, () => assignmentFromIntl(pattern))) record(node, key);
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
    return /\.(?:tsx?|mjs|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
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

test("CLA-589: the locale-order lint sees destructured locale APIs, aliases and nested Intl patterns", () => {
  const text = [
    "const { Collator } = Intl;",
    "const { Collator: C } = Intl;",
    "const { localeCompare } = String.prototype;",
    "const { localeCompare: compare } = String.prototype;",
    "const { 'toLocaleLowerCase': lower } = String.prototype;",
    "const { Intl: { Collator: Nested } } = globalThis;",
    "const { Collator: notIntl } = shapes;",
    "const { localeName } = options;",
    "function sortBy({ ['localeCompare']: compare }: string) {}",
  ].join("\n");
  assert.deepEqual(localeOrderUses("x.ts", text).map(use => [use.lineNumber, use.call]),
    [[1, "Collator"], [2, "Collator"], [3, "localeCompare"], [4, "localeCompare"], [5, "toLocaleLowerCase"], [6, "Collator"], [9, "localeCompare"]]);
});

test("CLA-589: the locale-order lint sees Intl reached indirectly and destructuring assignments", () => {
  const text = [
    "const c = new globalThis.Intl.Collator();",
    "const { Collator } = globalThis.Intl;",
    "const p = new (Intl).Collator();",
    "let compare; ({ localeCompare: compare } = String.prototype);",
    "({ localeCompare } = String.prototype);",
    "({ Intl: { Collator: Nested } } = globalThis);",
    "[{ toLocaleUpperCase: upper }] = [String.prototype];",
    "const w = window['Intl'].Collator;",
    "const q = new (Intl.Collator)();",
    "({ Collator: notIntl } = shapes);",
    "const literal = { localeCompare: compare };",
    "const r = new globalThis.Shapes.Collator();",
    "({ Intl: { Collator } = {} } = globalThis);",
    "({ proto: { localeCompare } = {} } = shapes);",
    "for ({ localeCompare } of protos);",
    "use([{ localeCompare: c } = String.prototype]);",
    "({ Collator } = (globalThis.Intl));",
    "const list = { items: [{ localeCompare: compare }] };",
  ].join("\n");
  assert.deepEqual(localeOrderUses("x.ts", text).map(use => [use.lineNumber, use.call]),
    [[1, "Collator"], [2, "Collator"], [3, "Collator"], [4, "localeCompare"], [5, "localeCompare"], [6, "Collator"], [7, "toLocaleUpperCase"], [8, "Collator"], [9, "Collator"],
      [13, "Collator"], [14, "localeCompare"], [15, "localeCompare"], [16, "localeCompare"], [17, "Collator"]]);
});

test("CLA-589: the locale-order lint bans Collator and locale formatting; only Intl.Segmenter may name a concrete locale", () => {
  const text = [
    "const a = count.toLocaleString();",
    "const b = date.toLocaleDateString();",
    "const c = date.toLocaleTimeString();",
    "const d = new Intl.NumberFormat().format(n);",
    "const e = new Intl.DateTimeFormat();",
    "const f = new Intl.ListFormat().format(names);",
    "const g = new Intl.PluralRules();",
    "const h = new Intl.RelativeTimeFormat();",
    "const i = new Intl.DisplayNames(undefined, { type: 'region' });",
    "const j = new Intl.Segmenter();",
    "const k = Intl.NumberFormat(locale);",
    "const { DateTimeFormat } = Intl;",
    "const l = count['toLocaleString']();",
    "const m = new Intl.Segmenter('en', { granularity: 'grapheme' });",
    "const n = new Intl.Collator('en').compare;",
    "const o = Intl.NumberFormat(`en`);",
    "const p = new (Intl.ListFormat)('en');",
    "const q = new Intl.PluralRules('en-US');",
    "const r = Intl.getCanonicalLocales();",
    "const s = new Intl.Collator('lt');",
    "const t = new Intl.NumberFormat('und');",
    "const u = new Intl.NumberFormat('en');",
    "const v = new Intl.Segmenter('und');",
    "const w = new Intl.Segmenter('');",
    "const x = new Intl.DurationFormat().format({ hours: 1 });",
    "const y = new Intl.DurationFormat('en');",
    "const z = new Intl.Segmenter(`en-US`);",
  ].join("\n");
  assert.deepEqual(localeOrderUses("x.ts", text).map(use => [use.lineNumber, use.call]),
    [[1, "toLocaleString"], [2, "toLocaleDateString"], [3, "toLocaleTimeString"], [4, "NumberFormat"], [5, "DateTimeFormat"],
      [6, "ListFormat"], [7, "PluralRules"], [8, "RelativeTimeFormat"], [9, "DisplayNames"], [10, "Segmenter"], [11, "NumberFormat"],
      [12, "DateTimeFormat"], [13, "toLocaleString"], [15, "Collator"], [16, "NumberFormat"], [17, "ListFormat"], [18, "PluralRules"],
      [20, "Collator"], [21, "NumberFormat"], [22, "NumberFormat"], [23, "Segmenter"], [24, "Segmenter"], [25, "DurationFormat"], [26, "DurationFormat"]]);
});

test("CLA-589: the locale-order lint walks every scanned package's src and the golden-excerpt generator script", () => {
  const files = SCANNED_PACKAGES.flatMap(sourceFiles);
  assert.ok(files.includes("packages/scene-compiler/scripts/generate-golden-source-excerpts.mjs"), "the walk must read .mjs files under packages/*/scripts");
  for (const name of PACKAGE_NAMES) {
    assert.ok(files.some(file => file.startsWith(`packages/${name}/src/`)), `the walk must read packages/${name}/src`);
  }
});

test("CLA-589: the locale-order lint reads .mjs scripts", () => {
  const text = "entries.sort(([left], [right]) => left.localeCompare(right));";
  assert.deepEqual(localeOrderUses("x.mjs", text).map(use => [use.lineNumber, use.call]), [[1, "localeCompare"]]);
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
