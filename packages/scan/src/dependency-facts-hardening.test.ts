import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEPENDENCY_FACTS_OMITTED_LIMIT, formatDependencyConsumerReport, parsePortableAtlas, queryDependencyConsumers, serializePortableAtlas, validateDependencyFacts,
  type DependencyFacts, type PortableAtlas,
} from "@okie/architecture";
import { analyzeTypeScript } from "./analyze-typescript.js";
import { runConsumersQuery } from "./consumers-cli.js";
import {
  buildDependencyFacts, cargoRequirementMatches, collectDependencyInputs, fitDependencyFacts, MAX_DROPPED_BY_DEPENDENCY, normalizeLockVersion,
  displayRequirement, packageJsonName, parseCargoManifest, parsePnpmLockImporters, redactSpec, redactText, stripTomlComment, type DependencyFactsInput,
} from "./dependency-facts.js";
import type { LanguageAnalysis } from "./language-analysis.js";
import { portableAtlasFromScan } from "./portable.js";
import { scanOutputFiles, scanRepository } from "./scan.js";
import { scrubCargoError } from "./analyze-rust.js";

const SHA = "a".repeat(40);
const reader = (files: Record<string, string>) => (path: string): string => {
  const text = files[path];
  if (text === undefined) throw new Error(`ENOENT ${path}`);
  return text;
};
const facts = (files: Record<string, string>, extra: Partial<DependencyFactsInput> = {}) => buildDependencyFacts({
  commitSha: SHA, sourceFiles: Object.keys(files).filter(path => /\.(rs|[cm]?[jt]sx?)$/.test(path)), readFile: reader(files), analysisMode: "quick", ...extra,
});
function tree(files: Record<string, string>, git = false): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "okie-deps-hard-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "x", "--no-gpg-sign"], { cwd: root });
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/; // everything but \n

// --- item 1 -----------------------------------------------------------------

test("item 1: type-position and `import type` references are typeOnly and --runtime-only filters them", () => {
  const repo = tree({
    "package.json": '{"name":"app","dependencies":{"pkg":"1","other":"1"}}',
    "tsconfig.json": '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","types":[]},"include":["src/**/*.ts"]}',
    "node_modules/pkg/package.json": '{"name":"pkg","types":"index.d.ts"}',
    "node_modules/pkg/index.d.ts": "export interface Opts { size: number }\nexport declare function run(): void;\nexport { Thing } from 'other';\n",
    "node_modules/other/package.json": '{"name":"other","types":"index.d.ts"}',
    "node_modules/other/index.d.ts": "export interface Thing { a: number }\n",
    "src/types.ts": "import type { Opts } from 'pkg';\nexport function same(o: Opts): Opts { return o; }\n",
    "src/b.ts": "import { Thing, run } from 'pkg';\nexport const t: Thing = { a: 1 };\ntype R = typeof run;\nexport const r: R = run;\nrun();\n",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const rows = (analysis.externalReferences ?? []).map(row => [row.path, row.startLine, row.package, row.symbol, row.kind, row.typeOnly]);
    assert.deepEqual(rows, [
      ["src/b.ts", 2, "other", "Thing", "uses", true],
      ["src/b.ts", 3, "pkg", "run", "uses", true],
      ["src/b.ts", 4, "pkg", "run", "uses", false],
      ["src/b.ts", 5, "pkg", "run", "calls", false],
      ["src/types.ts", 2, "pkg", "Opts", "uses", true],
      ["src/types.ts", 2, "pkg", "Opts", "uses", true],
    ], JSON.stringify(rows));
    const dependencyFacts = buildDependencyFacts({ commitSha: SHA, sourceFiles: ["src/b.ts", "src/types.ts"], readFile: path => readFileSync(join(repo.root, path), "utf8"), analysisMode: "full", languageAnalysis: analysis });
    const all = queryDependencyConsumers(dependencyFacts, "pkg");
    const types = all.consumers[0]!.files.find(file => file.path === "src/types.ts")!;
    assert.equal(types.typeOnly, true, "import type + type-position refs make the file type-only");
    const runtime = queryDependencyConsumers(dependencyFacts, "pkg", { includeTypeOnly: false });
    const refs = runtime.consumers.flatMap(row => row.files.flatMap(file => file.symbolReferences));
    assert.deepEqual(refs.map(row => [row.path, row.startLine, row.symbol, row.typeOnly]), [["src/b.ts", 4, "run", false], ["src/b.ts", 5, "run", false]]);
    assert.ok(!runtime.consumers[0]!.files.some(file => file.path === "src/types.ts"));
    assert.equal(runtime.summary.excludedTypeOnlySymbolReferences, 2, "run (typeof) + Opts (the two same-line Opts refs are one fact)");
    assert.equal(queryDependencyConsumers(dependencyFacts, "other", { includeTypeOnly: false }).consumers.length, 0, "a type-only re-export use is not runtime");
  } finally { repo.cleanup(); }
});

test("item 1 (round 2): value reads of interface-declared members stay runtime and survive --runtime-only", () => {
  const repo = tree({
    "package.json": '{"name":"app","dependencies":{"web":"1"}}',
    "tsconfig.json": '{"compilerOptions":{"strict":true,"target":"ES2022","module":"NodeNext","moduleResolution":"NodeNext","types":[]},"include":["src/**/*.ts"]}',
    "node_modules/web/package.json": '{"name":"web","types":"index.d.ts"}',
    "node_modules/web/index.d.ts": "export interface Request { query: Record<string, string> }\nexport interface Ref<T> { current: T }\nexport declare function useRef<T>(v: T): Ref<T>;\nexport declare function app(handler: (req: Request) => void): void;\n",
    "src/routes.ts": "import type { Request } from 'web';\nexport function handle(req: Request): string | undefined { return req.query.id; }\n",
    "src/ref.ts": "import { useRef } from 'web';\nconst r = useRef(1);\nexport const v = r.current;\n",
  });
  try {
    const analysis = analyzeTypeScript(repo.root);
    const rows = (analysis.externalReferences ?? []).map(row => [row.path, row.startLine, row.symbol, row.kind, row.typeOnly]);
    assert.deepEqual(rows, [
      ["src/ref.ts", 2, "useRef", "calls", false],
      ["src/ref.ts", 3, "Ref.current", "uses", false],
      ["src/routes.ts", 2, "Request.query", "uses", false],
      ["src/routes.ts", 2, "Request", "uses", true],
    ], JSON.stringify(rows));
    const dependencyFacts = buildDependencyFacts({ commitSha: SHA, sourceFiles: ["src/ref.ts", "src/routes.ts"], readFile: path => readFileSync(join(repo.root, path), "utf8"), analysisMode: "full", languageAnalysis: analysis });
    const runtime = queryDependencyConsumers(dependencyFacts, "web", { includeTypeOnly: false });
    const refs = runtime.consumers.flatMap(row => row.files.flatMap(file => file.symbolReferences)).map(row => [row.path, row.symbol]);
    assert.deepEqual(refs, [["src/ref.ts", "useRef"], ["src/ref.ts", "Ref.current"], ["src/routes.ts", "Request.query"]]);
    assert.equal(queryDependencyConsumers(dependencyFacts, "web").consumers[0]!.files.find(file => file.path === "src/routes.ts")!.typeOnly, false,
      "a file reading req.query touches a runtime object even with only `import type`");
  } finally { repo.cleanup(); }
});

// --- item 2 -----------------------------------------------------------------

test("item 2: a nested marker package.json does not own files; the nearest real package does", () => {
  const result = facts({
    "package.json": JSON.stringify({ name: "app", dependencies: { react: "^18" } }),
    "src/esm/package.json": '{"type":"module"}',
    "src/esm/a.ts": "import 'react';",
  });
  assert.deepEqual(result.packages.map(row => row.manifestPath), ["package.json"]);
  const report = queryDependencyConsumers(result, "react");
  assert.deepEqual(report.consumers.map(row => [row.package.manifestPath, row.undeclared]), [["package.json", false]]);
  assert.deepEqual(report.declaredWithoutObservedUse, []);
  // A nameless workspace member with no dependency section is still a package.
  const member = facts({ "package.json": '{"name":"root","workspaces":["apps/*"]}', "apps/x/package.json": '{"private":true}', "apps/x/a.ts": "import 'react';" }, { workspaceDirectories: ["apps/x"] });
  assert.deepEqual(member.imports.map(row => row.consumingPackage), ["apps/x/package.json"]);
});

// --- item 3 -----------------------------------------------------------------

test("item 3: a crate renamed at two versions resolves each by its requested range; an unselectable range is ambiguous", () => {
  const lock = ["[[package]]", 'name = "app"', 'version = "0.1.0"', "dependencies = [", ' "rand 0.7.3",', ' "rand 0.8.5",', "]", "",
    "[[package]]", 'name = "rand"', 'version = "0.7.3"', 'source = "registry+x"', "", "[[package]]", 'name = "rand"', 'version = "0.8.5"', 'source = "registry+x"'].join("\n");
  const result = facts({
    "Cargo.toml": '[package]\nname = "app"\n[dependencies]\nrand07 = { package = "rand", version = "0.7" }\nrand = "0.8"\n[dev-dependencies]\nrand-any = { package = "rand", version = "*" }\n',
    "Cargo.lock": lock, "src/lib.rs": "use rand07::Rng;\nuse rand::thread_rng;\n",
  });
  assert.deepEqual(result.declarations.map(row => [row.alias ?? row.dependency, row.resolution, row.resolvedVersions]), [
    ["rand", "resolved", ["0.8.5"]],
    ["rand07", "resolved", ["0.7.3"]],
    ["rand-any", "ambiguous", ["0.7.3", "0.8.5"]],
  ]);
  assert.equal(cargoRequirementMatches("0.7", "0.8.5"), false);
  assert.equal(cargoRequirementMatches("^0.7", "0.7.3"), true);
  assert.equal(cargoRequirementMatches("~1.2", "1.2.9"), true);
  assert.equal(cargoRequirementMatches(">=1, <2", "2.0.0"), false);
  assert.equal(cargoRequirementMatches("=1.2.3", "1.2.3"), true);
  assert.equal(cargoRequirementMatches("1.*", "1.9.0"), true);
  assert.equal(cargoRequirementMatches("git junk", "1.0.0"), undefined);
});

// --- item 4 -----------------------------------------------------------------

const CSI = "\u001b[31m";
const CLEAR = "\u001b[2J";
const OSC52 = "\u001b]52;c;cm0gLXJmIH4=\u0007";

function portableBundle(dependencies?: DependencyFacts): string {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), "utf8")
    .replaceAll("golden-worktree-okie-2026-07-14-v1", SHA));
  const bundle: PortableAtlas = { format: "okie-atlas", version: 1, repository: { commitSha: SHA, treeHash: "b".repeat(40) },
    snapshot: read("snapshot"), view: read("view"), story: read("story"), stories: [], analysis: { mode: "quick", adapters: [] },
    ...(dependencies ? { dependencies } : {}) };
  return JSON.stringify(bundle);
}

test("item 4a: consumers CLI never emits raw ESC/BEL/C1 bytes for hostile names, specs and paths", () => {
  // Scanned fixture: escapes in a dependency name, a requested spec, an import specifier and a file path.
  const scanned = facts({
    "package.json": JSON.stringify({ name: "app", dependencies: { [`evil${CSI}`]: "1", x: `1.0.0${OSC52}${CLEAR}` } }),
    "a.ts": `import 'x/${CSI}red';\n`,
    [`b${CLEAR}.ts`]: "import 'x';\n",
  });
  validateDependencyFacts(scanned, SHA); // capture never produces a bundle the loader rejects
  assert.ok(!scanned.declarations.some(row => row.dependency.startsWith("evil")), "control-character name skipped at capture");
  assert.ok(!scanned.imports.some(row => row.path.startsWith("b")), "control-character path skipped at capture");
  const bundlePath = "bundle.okie.json";
  const read = (path: string) => { assert.equal(path, bundlePath); return portableBundle(scanned); };
  for (const query of ["x", `x${CSI}`, "x\u009b2J"]) {
    const text = runConsumersQuery([query, "--bundle", bundlePath], read);
    assert.doesNotMatch(text, RAW_CONTROL, `human output for ${JSON.stringify(query)}`);
    assert.ok(text.includes("\ufffd"), "neutralized escapes stay visible");
    const json = runConsumersQuery([query, "--bundle", bundlePath, "--json"], read);
    assert.doesNotMatch(json, RAW_CONTROL, `json output for ${JSON.stringify(query)}`);
    JSON.parse(json);
  }
  assert.match(runConsumersQuery(["x\u009b2J", "--bundle", bundlePath, "--json"], read), /\\u009b2J/, "C1 CSI is JSON-escaped");
  // A hand-crafted bundle carrying raw escapes is rejected at load, before any output.
  const hostile = structuredClone(scanned);
  hostile.imports[0]!.specifier = `x${OSC52}`;
  hostile.declarations[0]!.requested = `1${CSI}`;
  assert.throws(() => runConsumersQuery(["x", "--bundle", bundlePath], () => portableBundle(hostile)), /control characters/);
  // And the formatter itself neutralizes an unvalidated in-memory report.
  const text = formatDependencyConsumerReport(queryDependencyConsumers(hostile, "x"));
  assert.doesNotMatch(text, RAW_CONTROL);
});

// --- item 5 -----------------------------------------------------------------

test("item 5: redactSpec strips userinfo (incl. a raw slash), queries, credential fragments, tokens and absolute paths", () => {
  const cases: Array<[string, string]> = [
    ["https://user:s3cr3t/pa@ss@example.com/v.tgz", "https://[redacted]@example.com/v.tgz"],
    ["https://deploy:hunter2@registry.example.com/r.tgz", "https://[redacted]@registry.example.com/r.tgz"],
    ["https://npm.example.com/t.tgz?token=abc123", "https://npm.example.com/t.tgz?[redacted]"],
    ["git+https://github.com/x/y.git#token=abc", "git+https://github.com/x/y.git#[redacted]"],
    ["git+https://github.com/x/y.git#v1.2.3", "git+https://github.com/x/y.git#v1.2.3"],
    ["git+ssh://git@github.com/x/u.git", "git+ssh://git@github.com/x/u.git"],
    ["https://host:8443/a@b", "https://host:8443/a@b"],
    ["file:/Users/alice/private/pkg", "file:<absolute path>"],
    ["link:/home/alice/x", "link:<absolute path>"],
    ["path:/Users/alice/crate", "path:<absolute path>"],
    ["/opt/x", "<absolute path>"],
    ["~/x", "<absolute path>"],
    ["C:\\Users\\alice\\x", "<absolute path>"],
    ["file:../local", "file:../local"],
    ["git+https://ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/x/z.git", "git+https://[redacted]@github.com/x/z.git"],
    ["npm:left-pad@^1.3.0", "npm:left-pad@^1.3.0"],
  ];
  for (const [input, expected] of cases) assert.equal(redactSpec(input), expected, input);
  assert.deepEqual(normalizeLockVersion("https://deploy:x@registry/x.tgz"), { kind: "source" });
  assert.deepEqual(normalizeLockVersion("github.com/x/y/abc123"), { kind: "source" });
  assert.deepEqual(normalizeLockVersion("/react@18.2.0"), { kind: "version", version: "18.2.0" });
  assert.deepEqual(normalizeLockVersion("link:../x"), { kind: "local" });
});

test("item 5b: no credential, query token, absolute path or lockfile URL version reaches the serialized bundle", () => {
  const secrets = ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", "s3cr3t", "pa@ss", "QUERYSECRET123", "secretuser", "LOCKSECRET", "glpat-abcdefghijklmnopqrst", "hunter2", "FRAGSECRET"];
  const repo = tree({
    "package.json": JSON.stringify({ name: "redact-demo", dependencies: {
      y: "git+https://user:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@github.com/x/y.git",
      v: "https://user:s3cr3t/pa@ss@example.com/v.tgz",
      t: "https://npm.example.com/t.tgz?token=QUERYSECRET123",
      f: "git+https://github.com/x/f.git#auth=FRAGSECRET",
      p: "file:/Users/secretuser/private/pkg",
      l: "^1.0.0",
    } }, null, 2),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/l": { version: "https://deploy:LOCKSECRET@registry.example.com/l.tgz" }, "node_modules/r": { version: "1.0.0", resolved: "https://deploy:hunter2@registry.example.com/r.tgz" } } }),
    "src/index.ts": "import y from 'y';\nimport l from 'l';\nexport const x = [y, l];\n",
    "crates/c/Cargo.toml": '[package]\nname = "c"\nversion = "0.1.0"\n\n[dependencies]\nfoo = { git = "https://oauth2:glpat-abcdefghijklmnopqrst@gitlab.com/x/foo.git", branch = "main" }\nbar = { path = "/Users/secretuser/bar" }\n',
    "crates/c/src/lib.rs": "use foo::X;\n",
  }, true);
  try {
    const artifacts = scanRepository(repo.root, { analysisMode: "quick" });
    const text = serializePortableAtlas(portableAtlasFromScan(artifacts));
    for (const secret of secrets) assert.ok(!text.includes(secret), `bundle leaks ${secret}`);
    const declarations = new Map(artifacts.dependencies.declarations.map(row => [row.alias ?? row.dependency, row]));
    assert.equal(declarations.get("v")!.requested, "https://[redacted]@example.com/v.tgz");
    assert.equal(declarations.get("p")!.requested, "file:<absolute path>");
    assert.equal(declarations.get("bar")!.requested, "path:<absolute path>");
    assert.deepEqual([declarations.get("l")!.resolution, declarations.get("l")!.resolvedVersions], ["unresolved", []], "a URL-shaped lock version is not a version");
    assert.match(declarations.get("l")!.reason!, /non-registry source/);
  } finally { repo.cleanup(); }
});

// CLA-654: wrapped specs (`git:<url>`, `npm:@x/y@<url>`, relative `path:`), unparsable Cargo requirements, opaque
// Cargo.lock versions, `[patch]` keys/paths and limitation lines reach no public output; valid semver is unchanged.
test("CLA-654: no credential reaches dependency facts, limitations or serialized outputs; valid versions stay", () => {
  const S = ["CLA654USER", "CLA654PASS", "CLA654QUERY", "CLA654LOCK", "CLA654REQ", "CLA654HOME", "CLA654ID", "CLA654COMMA", "CLA654FRAG"];
  // Free text: punctuation inside userinfo/queries never splits a credential off; fragments, queries and token shapes
  // follow redactSpec; optional chaining and plain prose are untouched; a second pass changes nothing.
  for (const [input, expected] of [
    ["fetch https://u:CLA654COMMA,rest@host.invalid/repo failed", "fetch https://[redacted]@host.invalid/repo failed"],
    ["Cannot find module './u:CLA654COMMA,rest@host.invalid/x'", "Cannot find module './[redacted]@host.invalid/x'"],
    ["see (https://u:CLA654(P)A[S]S@h/p?a=CLA654QUERY,x) now.", "see (https://[redacted]@h/p?[redacted]) now."],
    ["./missing#token=CLA654FRAG", "./missing#[redacted]"],
    ["./missing?x=CLA654QUERY", "./missing?[redacted]"],
    [`./missing-ghp_${"A".repeat(32)}`, "./missing-[redacted-token]"],
    ["at this.map?.getKey(x) and a?.b", "at this.map?.getKey(x) and a?.b"],
    ["git@github.com:x/y.git ok", "git@github.com:x/y.git ok"],
    // A real TS2835 diagnostic from the self-scan: a sentence-final `?` is not a query.
    ["a.ts: TS2835: Relative import paths need explicit file extensions. Did you mean '../../web/src/x.js'?", "a.ts: TS2835: Relative import paths need explicit file extensions. Did you mean '../../web/src/x.js'?"],
    ["[patch.https://[redacted]@h.invalid/p.git?[redacted]] x", "[patch.https://[redacted]@h.invalid/p.git?[redacted]] x"],
  ] as const) assert.equal(redactText(input), expected, input);
  // A numeric password before a raw `/` is userinfo once it cannot be a port; a real port stays.
  assert.equal(redactSpec("https://user:123456/with/slash@host.invalid/repo"), "https://[redacted]@host.invalid/repo");
  assert.equal(redactSpec("https://user:65536/x@host.invalid/repo"), "https://[redacted]@host.invalid/repo");
  // An unencoded `#`/`?` inside the password does not end the userinfo early; real fragments/queries and ports stay.
  assert.equal(redactSpec("git+https://deploy:CLA654PASS#x@github.com/o/r.git"), "git+https://[redacted]@github.com/o/r.git");
  assert.equal(redactSpec("https://user:pw?CLA654PASS@host/c.tgz"), "https://[redacted]@host/c.tgz");
  assert.equal(redactText("fetch https://u:a?b#CLA654PASS@h/r?token=Q#main failed"), "fetch https://[redacted]@h/r?[redacted]#main failed");
  for (const kept of ["git+https://github.com/x/y.git#v1.2.3", "https://host:8443/@scope/pkg/-/pkg-1.0.0.tgz"]) assert.equal(redactSpec(kept), kept);
  assert.equal(redactSpec("https://user:p%40ss%2Fw@host.invalid/repo"), "https://[redacted]@host.invalid/repo", "encoded userinfo");
  assert.equal(redactSpec("https://host:8443/a@b"), "https://host:8443/a@b");
  assert.equal(redactSpec("https://registry.example.com:8443/@scope/pkg/-/pkg-1.0.0.tgz"), "https://registry.example.com:8443/@scope/pkg/-/pkg-1.0.0.tgz", "scoped tarball host:port/path@");
  // A package's own name follows npm's new-package rules; the limitation names only the manifest line.
  for (const name of ["_x", ".x", "node_modules", "Favicon.ico", "@s/x y", "a/b", " x", "@s/.foo", "u:x@host", "a#b", "a?b", "\ud800", "a\udc00"]) {
    assert.deepEqual(packageJsonName(`{\n  "name": ${JSON.stringify(name)}\n}`, "p/package.json"), { limitation: "Invalid package name at p/package.json:2." }, name);
  }
  // The line is the top-level `name`, not a nested one before it.
  assert.deepEqual(packageJsonName('{\n "metadata": {"name": "nested-valid"},\n "name": "u:CLA654ID@host",\n "dependencies": {"core": "^1"}\n}', "p/package.json"), { limitation: "Invalid package name at p/package.json:3." });
  // Names npm ever accepted stay, legacy uppercase/builtin/special-character ones included (validForOldPackages).
  for (const name of ["@okie/web", "left-pad", "a.b_c-1", "@s/_x", "SharedLib", "JSONStream", "http", "@Scope/x", "x!"]) assert.deepEqual(packageJsonName(JSON.stringify({ name }), "package.json"), { name }, name);
  // Requirements are shown only in a syntax Cargo accepts; valid prerelease/build metadata is kept as written.
  for (const bad of ["1.2.3+..x", "01.2.3-x", "1.2.3-01", "1.*.3x"]) assert.equal(displayRequirement(bad), "[unsupported requirement]", bad);
  for (const ok of ["=1.2.3-alpha+build.4", "1.2.3-alpha+meta", "^1.2", ">=1, <2", "1.*", "~1.2.3-rc.1", "*"]) assert.equal(displayRequirement(ok), ok, ok);
  // A legacy name npm still accepts (`SharedLib`) keeps its entity name and its workspace import edge.
  const legacy = tree({
    "package.json": JSON.stringify({ name: "legacy-root", private: true, workspaces: ["packages/*"] }),
    "packages/shared/package.json": JSON.stringify({ name: "SharedLib", version: "1.0.0", main: "index.ts" }),
    "packages/shared/index.ts": "export const s = 1;\n",
    "packages/app/package.json": JSON.stringify({ name: "app", version: "1.0.0", dependencies: { SharedLib: "workspace:*" } }),
    "packages/app/index.ts": "import { s } from \"SharedLib\";\nexport const a = s;\n",
  }, true);
  try {
    const scanned = scanRepository(legacy.root, { analysisMode: "quick" });
    assert.ok(scanned.snapshot.entities.some(entity => entity.id === "container:packages-shared" && entity.name === "SharedLib"));
    assert.ok(scanned.snapshot.relations.some(relation => relation.from === "container:packages-app" && relation.to === "container:packages-shared"),
      scanned.snapshot.relations.map(relation => `${relation.from}->${relation.to}`).join("\n"));
    assert.ok(!(scanned.analysis.limitations ?? []).some(line => line.startsWith("Invalid package name")));
  } finally { legacy.cleanup(); }
  // Cargo names follow Cargo's own rule (XID start/continue, Unicode and uppercase valid). A name Cargo refuses is never
  // shown: the crate keeps its directory name, and a refused dependency key or `package =` rename records no edge.
  const crates = tree({
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\n"u:CLA654CARGOWS@h" = { path = "crates/bad" }\n\n[patch.crates-io]\n"u:CLA654CARGOPATCH@h" = { path = "crates/bad" }\nSharedCrate = { path = "crates/shared" }\n',
    "crates/core/Cargo.toml": '[package]\nname = "café"\nversion = "1.0.0"\n',
    "crates/core/src/lib.rs": "pub fn c() {}\n",
    "crates/shared/Cargo.toml": '[package]\nname = "SharedCrate"\nversion = "1.0.0"\n',
    "crates/shared/src/lib.rs": "pub fn s() {}\n",
    "crates/bad/Cargo.toml": '[package]\nname = "u:CLA654CARGONAME@host"\nversion = "1.0.0"\n',
    "crates/bad/src/lib.rs": "pub fn b() {}\n",
    // TOML escapes are decoded before the name is checked, as Cargo does: `\u0065sc` is `esc`.
    "crates/esc/Cargo.toml": '[package]\nname = "\\u0065sc"\nversion = "1.0.0"\n',
    "crates/esc/src/lib.rs": "pub fn e() {}\n",
    "crates/app/Cargo.toml": '[package]\nname = "app"\nversion = "1.0.0"\n\n[dependencies]\n"café" = { path = "../core" }\nshared = { path = "../shared", package = "Sh\\u0061redCrate" }\n"u:CLA654CARGOKEY@h" = { path = "../bad" }\nren = { path = "../bad", package = "u:CLA654CARGOREN@h" }\n\n[target.\'cfg(unix)\'.dependencies]\ntren = { path = "../bad", package = "u:CLA654CARGOTARGET@h" }\n\n[dependencies."\\u0065sc"]\npath = "../esc"\n\n[dependencies."u\\u003aCLA654CARGOESC\\u0040h"]\npath = "../bad"\n',
    "crates/app/src/lib.rs": "pub fn a() {}\n",
  }, true);
  try {
    const scanned = scanRepository(crates.root, { analysisMode: "quick" });
    const outputs = JSON.stringify(scanOutputFiles(scanned));
    for (const marker of ["CLA654CARGONAME", "CLA654CARGOKEY", "CLA654CARGOREN", "CLA654CARGOWS", "CLA654CARGOPATCH", "CLA654CARGOTARGET", "CLA654CARGOESC"]) assert.ok(!outputs.includes(marker), `serialized outputs leak ${marker}`);
    const names = new Map(scanned.snapshot.entities.map(entity => [entity.id, entity.name]));
    assert.deepEqual([names.get("container:crates-core"), names.get("container:crates-shared"), names.get("container:crates-bad"), names.get("container:crates-esc")], ["café", "SharedCrate", "bad", "esc"]);
    const edges = scanned.snapshot.relations.map(relation => `${relation.from}->${relation.to}`);
    assert.ok(edges.includes("container:crates-app->container:crates-core") && edges.includes("container:crates-app->container:crates-shared")
      && edges.includes("container:crates-app->container:crates-esc"), edges.join("\n"));
    assert.ok(!edges.includes("container:crates-app->container:crates-bad"), edges.join("\n"));
    const invalid = (scanned.analysis.limitations ?? []).filter(line => line.startsWith("Invalid"));
    // Location only, one per refused key/rename: [workspace.dependencies], [patch], [dependencies], a target table.
    assert.deepEqual(invalid, ["Invalid dependency name at Cargo.toml:5.", "Invalid dependency name at Cargo.toml:8.", "Invalid dependency name at crates/app/Cargo.toml:8.", "Invalid dependency name at crates/app/Cargo.toml:9.", "Invalid dependency name at crates/app/Cargo.toml:12.", "Invalid dependency name at crates/app/Cargo.toml:17.", "Invalid package name at crates/bad/Cargo.toml:2."]);
  } finally { crates.cleanup(); }
  // Any wrapper depth is peeled without recursion and without leaking the tail.
  const deep = redactSpec(`${"git:".repeat(5000)}https://u:CLA654PASS@host.invalid/repo`);
  assert.ok(deep.endsWith("git:https://[redacted]@host.invalid/repo") && !deep.includes("CLA654PASS"));
  assert.equal(redactSpec("git:https://CLA654USER:CLA654PASS@example.invalid/g.git?token=CLA654QUERY#main"), "git:https://[redacted]@example.invalid/g.git?[redacted]#main");
  assert.equal(redactSpec("npm:@other/lib@https://CLA654USER:CLA654PASS@example.invalid/x.tgz"), "npm:@other/lib@https://[redacted]@example.invalid/x.tgz");
  assert.equal(redactSpec("path:../../CLA654USER:CLA654PASS@outside"), "path:../../[redacted]@outside");
  assert.equal(redactSpec("CLA654USER:CLA654PASS@example.invalid:org/lib.git"), "[redacted]@example.invalid:org/lib.git");
  for (const kept of ["npm:left-pad@^1.3.0", "npm:@scope/x@1.2.3", "path:../core", "git:https://github.com/x/y.git#v1.2.3", "^1.2", ">=1, <2"]) assert.equal(redactSpec(kept), kept);
  const repo = tree({
    "package.json": JSON.stringify({ name: "redact654", private: true, workspaces: ["web", "bad"] }),
    "web/package.json": JSON.stringify({ name: "web", dependencies: { lib: "npm:@other/lib@https://CLA654USER:CLA654PASS@example.invalid/x.tgz", npmbad: "^1", npmok: "^1" } }),
    "web/package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/npmbad": { version: "1.2.3+..CLA654LOCK" }, "node_modules/npmok": { version: "1.2.3-alpha+build.4" } } }),
    "web/index.ts": "import { a } from './CLA654USER:CLA654PASS@host/a';\nexport const x = a;\n",
    "bad/package.json": JSON.stringify({ name: "u:CLA654ID@host", version: "1.0.0" }),
    "bad/index.ts": "export const bad = 1;\n",
    "Cargo.toml": '[workspace]\nmembers = ["app", "core", "mis"]\n\n[patch."https://CLA654USER:CLA654PASS@example.invalid/p.git?token=CLA654QUERY"]\nremote = { path = "/CLA654HOME/u:CLA654PASS@private" }\n\n[patch.crates-io]\ncore = { path = "core" }\nmis = { path = "mis" }\n',
    "Cargo.lock": 'version = 3\n\n[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["core", "opaque", "semverdep", "pre", "leadzero"]\n\n[[package]]\nname = "opaque"\nversion = "9.9.9CLA654LOCK"\n\n[[package]]\nname = "semverdep"\nversion = "1.2.3"\n\n[[package]]\nname = "pre"\nversion = "1.0.0-alpha.1+build.5"\n\n[[package]]\nname = "leadzero"\nversion = "1.2.3-..CLA654LOCK"\n\n[[package]]\nname = "core"\nversion = "1.0.0"\n',
    "app/Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n\n[dependencies]\ncore = "1.*.3CLA654REQ"\ngitdep = { git = "https://CLA654USER:CLA654PASS@example.invalid/g.git?token=CLA654QUERY", branch = "main" }\nescaped = { path = "../../CLA654USER:CLA654PASS@outside" }\nopaque = "9"\nsemverdep = "^1.2"\npre = "=1.0.0-alpha.1+build.5"\nleadzero = "1"\nmis = "1.2.3+..CLA654REQ"\npwdep = { git = "https://deploy:CLA654PASS#x@example.invalid/p.git" }\n\n[target.\'https://CLA654USER:CLA654PASS@h.invalid\'.dependencies]\ntdep = "1"\n',
    "app/src/lib.rs": "pub fn app() {}\n",
    "core/Cargo.toml": '[package]\nname = "core"\nversion = "1.0.0"\n',
    "core/src/lib.rs": "pub fn core() {}\n",
    "mis/Cargo.toml": '[package]\nname = "mis"\nversion = "2.0.0"\n',
    "mis/src/lib.rs": "pub fn mis() {}\n",
  }, true);
  try {
    const artifacts = scanRepository(repo.root, { analysisMode: "quick" });
    const outputs = JSON.stringify(scanOutputFiles(artifacts));
    for (const secret of S) assert.ok(!outputs.includes(secret), `serialized outputs leak ${secret}`);
    const rows = new Map(artifacts.dependencies.declarations.map(row => [row.alias ?? row.dependency, row]));
    assert.equal(rows.get("lib")!.requested, "npm:@other/lib@https://[redacted]@example.invalid/x.tgz");
    assert.equal(rows.get("gitdep")!.requested, "git:https://[redacted]@example.invalid/g.git?[redacted]#main");
    assert.equal(rows.get("escaped")!.requested, "path:../../[redacted]@outside");
    assert.equal(rows.get("core")!.requested, "[unsupported requirement]");
    // Cargo rejects `1.2.3+..x` (empty build identifier) though the matcher reads it: never echoed, in facts or mismatch lines.
    assert.equal(rows.get("mis")!.requested, "[unsupported requirement]");
    assert.equal(rows.get("pwdep")!.requested, "git:https://[redacted]@example.invalid/p.git");
    assert.equal(rows.get("tdep")!.target, "https://[redacted]@h.invalid", "a Cargo target key is redacted like a spec");
    assert.deepEqual(rows.get("opaque")!.resolvedVersions, ["[unsupported version]"]);
    assert.deepEqual([rows.get("semverdep")!.requested, rows.get("semverdep")!.resolvedVersions], ["^1.2", ["1.2.3"]], "valid semver is unchanged");
    assert.deepEqual([rows.get("pre")!.requested, rows.get("pre")!.resolvedVersions], ["=1.0.0-alpha.1+build.5", ["1.0.0-alpha.1+build.5"]], "prerelease + build kept");
    // npm lock versions follow the same rule: a malformed one is a placeholder, valid prerelease+build stays.
    assert.deepEqual(rows.get("npmbad")!.resolvedVersions, ["[unsupported version]"]);
    assert.deepEqual(rows.get("npmok")!.resolvedVersions, ["1.2.3-alpha+build.4"]);
    assert.deepEqual(rows.get("leadzero")!.resolvedVersions, ["[unsupported version]"], "an empty prerelease identifier is not semver");
    const limitations = artifacts.analysis.limitations ?? [];
    assert.ok(limitations.includes("Unresolved relative import web/index.ts:1: './[redacted]@host/a'"), limitations.join("\n"));
    assert.ok(limitations.includes("Cargo [patch] path resolves outside the repository; not followed, no crate edge recorded: Cargo.toml:5: [patch.https://[redacted]@example.invalid/p.git?[redacted]] remote = { path = '<absolute path>' }"), limitations.join("\n"));
    // An npm-invalid package name: no entity, ID or package row carries it; the unit keeps its directory name.
    assert.ok(limitations.includes("Invalid package name at bad/package.json:1."), limitations.join("\n"));
    assert.ok(artifacts.snapshot.entities.some(entity => entity.name === "bad"), "the member keeps its directory name");
    assert.equal(artifacts.dependencies.packages.find(row => row.manifestPath === "bad/package.json")?.name, "bad");
    assert.ok(limitations.some(line => line.startsWith("Cargo [patch] accepted by no scanned crate's normal dependency: version 2.0.0 does not satisfy app/Cargo.toml:13 requires [unsupported requirement];")), limitations.join("\n"));
    assert.ok(limitations.some(line => line.startsWith("Cargo [patch] not applied to a version requirement the scanner cannot parse: app/Cargo.toml:6 requires core [unsupported requirement];")), limitations.join("\n"));
  } finally { repo.cleanup(); }
  // TypeScript diagnostics reach coverage limitations redacted (the import below is unresolvable).
  const tsRepo = tree({
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "NodeNext", moduleResolution: "NodeNext", types: [] }, include: ["*.ts"] }),
    "a.ts": "import { x } from './u:CLA654TS@host/missing.js';\nexport const y = x;\n",
  });
  try {
    const lines = analyzeTypeScript(tsRepo.root, ["a.ts"]).coverage.flatMap(row => row.limitations);
    assert.ok(lines.some(line => line.includes("TS2307") && line.includes("./[redacted]@host/missing.js")), lines.join("\n"));
    assert.ok(!lines.some(line => line.includes("CLA654TS")), lines.join("\n"));
  } finally { tsRepo.cleanup(); }
  assert.equal(scrubCargoError("error: failed to fetch https://CLA654USER:CLA654PASS@host.invalid/p?auth=CLA654QUERY", []), "failed to fetch https://[redacted]@host.invalid/p?[redacted]");
});

// Accepted by the coordinator (CLA-654): Cargo-style `host:port/path@` must stay intact because scoped npm tarball
// URLs put `@` in the path, so an unencoded all-digit password <= 65535 before a raw `/` is indistinguishable.
test("KNOWN LIMITATION (CLA-654): an unencoded all-digit password <= 65535 before a raw `/` is not redacted", () => {
  assert.equal(redactSpec("https://user:12345/with/slash@host.invalid/repo"), "https://user:12345/with/slash@host.invalid/repo");
  assert.equal(redactSpec("https://registry.example.com:8443/@scope/pkg/-/pkg-1.0.0.tgz"), "https://registry.example.com:8443/@scope/pkg/-/pkg-1.0.0.tgz");
});

// --- item 6 -----------------------------------------------------------------

test("item 6: unowned files and cap notes are counted per ecosystem", () => {
  const result = facts({ "Cargo.toml": "[workspace]\nmembers=[]\n", "tools/x.rs": "use serde::X;", "package.json": '{"name":"a","dependencies":{"react":"1","vue":"1"}}', "a.ts": "import 'react';\nimport 'vue';\n" }, { limits: { maxImports: 1 } });
  const imports = (ecosystem: string) => result.coverage.find(row => row.ecosystem === ecosystem && row.evidence === "imports")!;
  assert.ok(imports("cargo").limitations.some(line => /1 file\(s\) with dependency evidence have no owning Cargo\.toml/.test(line)), imports("cargo").limitations.join("\n"));
  assert.ok(!imports("npm").limitations.some(line => /no owning/.test(line)), imports("npm").limitations.join("\n"));
  assert.ok(imports("npm").limitations.some(line => /Capped at 1 imports/.test(line)));
  assert.ok(!imports("cargo").limitations.some(line => /Capped/.test(line)), "cap note only where facts were dropped");
});

// --- item 7 -----------------------------------------------------------------

test("item 7: pnpm v5 peer-suffixed versions resolve to the package version", () => {
  const lock = "lockfileVersion: 5.4\n\nspecifiers:\n  react-dom: ^18\n\ndependencies:\n  react-dom: 18.2.0_react@17.0.2\n";
  assert.equal(parsePnpmLockImporters(lock).get(".")?.get("react-dom"), "18.2.0");
  assert.deepEqual(normalizeLockVersion("18.2.0_react@17.0.2"), { kind: "version", version: "18.2.0" });
  assert.deepEqual(normalizeLockVersion("1.0.0-beta.1_a@1.0.0+b@2.0.0"), { kind: "version", version: "1.0.0-beta.1" });
  const result = facts({ "package.json": JSON.stringify({ name: "a", dependencies: { "react-dom": "^18" } }), "pnpm-lock.yaml": lock, "a.ts": "import 'react-dom';" });
  assert.deepEqual(result.declarations.map(row => [row.resolution, row.resolvedVersions]), [["resolved", ["18.2.0"]]]);
});

// --- item 8 -----------------------------------------------------------------

test("item 8: invalid rows are skipped and counted; Cargo comments and multi-line tables never invent dependencies", () => {
  const manifest = parseCargoManifest([
    "[package]", 'name = "x"', "[dependencies]",
    'tokio = { version = "1", features = [', '  "rt",', '], default-features = false }',
    'foo = { version = "1",', '  package = "bar" }',
    'baz = "2" # package = "evil", version = "9"',
    'qux = { version = "3" } # git = "https://tok@example.com"',
    '"" = "1"',
  ].join("\n"));
  assert.deepEqual(manifest.entries.map(row => [row.key, row.version ?? "", row.package ?? "", row.git ?? ""]), [
    ["tokio", "1", "", ""], ["foo", "1", "bar", ""], ["baz", "2", "", ""], ["qux", "3", "", ""], ["", "1", "", ""],
  ]);
  assert.equal(stripTomlComment('a = "x # y" # z'), 'a = "x # y" ');
  for (const files of [
    { "package.json": JSON.stringify({ name: "a", dependencies: { "": "1", "ok": "1" } }), "a.ts": "import 'ok';" },
    { "Cargo.toml": '[package]\nname = "app"\n[dependencies]\n"" = "1"\n"bad name" = "1"\nok = "1"\n', "src/lib.rs": "use ok::X;" },
  ]) {
    const result = facts(files);
    validateDependencyFacts(result, SHA);
    assert.deepEqual(result.declarations.map(row => row.dependency), ["ok"]);
    const declarations = result.coverage.find(row => row.evidence === "declarations")!;
    assert.ok(declarations.limitations.some(line => /row\(s\) with invalid names or paths were skipped/.test(line)), declarations.limitations.join("\n"));
  }
});

test("item 8: the fact byte budget trims symbol references first, then imports, deterministically with counts", () => {
  const refs: NonNullable<LanguageAnalysis["externalReferences"]> = Array.from({ length: 200 }, (_, index) => ({ path: "a.ts", startLine: index + 1, endLine: index + 1, ecosystem: "npm", package: "react", symbol: `symbol${index}`, kind: "uses", analyzer: "typescript@5" }));
  const analysis: LanguageAnalysis = { schemaVersion: 1, definitions: [], references: [], modules: [], externalReferences: refs, coverage: [{ language: "typescript", tool: "typescript", version: "5", coverage: "semantic", indexedFiles: [], limitations: [] }] };
  const files = { "package.json": '{"name":"a","dependencies":{"react":"1"}}', "a.ts": Array.from({ length: 20 }, (_, index) => `import 'react/m${index}';`).join("\n") };
  const full = facts(files, { analysisMode: "full", languageAnalysis: analysis });
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const budget = size(full) - 1;
  const fitted = fitDependencyFacts(full, budget);
  assert.ok(size(fitted) <= budget);
  assert.equal(fitted.imports.length, full.imports.length, "imports kept while references absorb the cut");
  assert.ok(fitted.symbolReferences.length < full.symbolReferences.length);
  assert.deepEqual(fitted.symbolReferences, full.symbolReferences.slice(0, fitted.symbolReferences.length), "canonical prefix kept");
  const symbols = fitted.coverage.find(row => row.ecosystem === "npm" && row.evidence === "symbolReferences")!;
  assert.equal(symbols.dropped, full.symbolReferences.length - fitted.symbolReferences.length);
  assert.ok(symbols.limitations.some(line => line.includes("dependency fact budget")));
  const tight = fitDependencyFacts(full, size({ ...full, symbolReferences: [], imports: full.imports.slice(0, 5) }));
  assert.equal(tight.symbolReferences.length, 0);
  assert.ok(tight.imports.length < full.imports.length);
  assert.equal(tight.coverage.find(row => row.ecosystem === "npm" && row.evidence === "imports")!.dropped, full.imports.length - tight.imports.length);
  validateDependencyFacts(tight, SHA);
  assert.deepEqual(fitDependencyFacts(full, budget), fitted, "deterministic");
  assert.deepEqual(fitDependencyFacts(full, size(full)), full, "no-op when it fits");
});

test("item 8: dependency facts never push a bundle that fit before over the limit", () => {
  const repo = tree({
    "package.json": '{"name":"fit","dependencies":{"react":"1"}}',
    "src/index.ts": Array.from({ length: 400 }, (_, index) => `import 'react/m${index}';`).join("\n") + "\nexport const x = 1;\n",
  }, true);
  try {
    const artifacts = scanRepository(repo.root, { analysisMode: "quick" });
    const withoutFacts = Buffer.byteLength(serializePortableAtlas(portableAtlasFromScan({ ...artifacts, dependencies: { ...artifacts.dependencies, imports: [], declarations: [], symbolReferences: [], packages: [], coverage: [] } })));
    const limit = withoutFacts + 30_000;
    const bundle = portableAtlasFromScan(artifacts, undefined, limit);
    const text = serializePortableAtlas(bundle);
    assert.ok(Buffer.byteLength(text) <= limit, `${Buffer.byteLength(text)} > ${limit}`);
    assert.ok(bundle.dependencies!.imports.length < artifacts.dependencies.imports.length);
    assert.ok(bundle.dependencies!.coverage.some(row => row.evidence === "imports" && row.dropped > 0));
    parsePortableAtlas(text);
    // Rows cannot fit at all: a minimal facts object says so, and queries report the size limit.
    const standIn = { ...artifacts.dependencies, declarations: [], imports: [], symbolReferences: [],
      coverage: artifacts.dependencies.coverage.map(row => ({ ecosystem: row.ecosystem, evidence: row.evidence, status: "unavailable", limitations: [DEPENDENCY_FACTS_OMITTED_LIMIT], droppedByDependency: [], dropped: 99 })) };
    const omittedLimit = withoutFacts + Buffer.byteLength(JSON.stringify(standIn)) + 16;
    const omitted = portableAtlasFromScan(artifacts, undefined, omittedLimit);
    const omittedText = serializePortableAtlas(omitted);
    assert.ok(Buffer.byteLength(omittedText) <= omittedLimit, `${Buffer.byteLength(omittedText)} > ${omittedLimit}`);
    const loaded = parsePortableAtlas(omittedText).dependencies!;
    assert.ok(loaded, "a minimal facts object is kept");
    assert.deepEqual([loaded.declarations.length, loaded.imports.length, loaded.symbolReferences.length], [0, 0, 0]);
    assert.ok(loaded.coverage.every(row => row.status === "unavailable" && row.limitations.includes(DEPENDENCY_FACTS_OMITTED_LIMIT)));
    assert.equal(loaded.coverage.find(row => row.evidence === "imports")!.dropped, artifacts.dependencies.imports.length);
    const report = queryDependencyConsumers(loaded, "react");
    assert.deepEqual(report.coverage, [DEPENDENCY_FACTS_OMITTED_LIMIT]);
    const reportText = formatDependencyConsumerReport(report);
    assert.match(reportText, /omitted: bundle size limit/);
    assert.doesNotMatch(reportText, /predates/);
    // Last resort, only when even the stand-in cannot fit: the field is dropped rather than failing the export.
    assert.equal(portableAtlasFromScan(artifacts, undefined, withoutFacts + 10).dependencies, undefined);
  } finally { repo.cleanup(); }
});

test("round 2: many dropped dependencies stay within the byte budget; drop lists are bounded", () => {
  const references = Array.from({ length: 3000 }, (_, index) => ({ ecosystem: "npm" as const, dependency: `dep-number-${String(index).padStart(5, "0")}`, path: "a.ts", startLine: index + 1, endLine: index + 1, consumingPackage: "package.json", symbol: "x", kind: "uses" as const, typeOnly: false, analyzer: "typescript@5" }));
  const many: DependencyFacts = { schemaVersion: 1, commitSha: SHA, packages: [{ ecosystem: "npm", name: "a", manifestPath: "package.json", directory: "" }], declarations: [], imports: [], symbolReferences: references,
    coverage: [{ ecosystem: "npm", evidence: "symbolReferences", status: "partial", limitations: [], dropped: 0, droppedByDependency: [] }] };
  for (const budget of [20_000, 60_000, 200_000]) {
    const fitted = fitDependencyFacts(many, budget);
    const size = Buffer.byteLength(JSON.stringify(fitted));
    assert.ok(size <= budget, `${size} > ${budget}`);
    assert.ok(fitted.symbolReferences.length > 0, "rows are kept, not the whole object omitted");
    const row = fitted.coverage[0]!;
    assert.equal(row.dropped, 3000 - fitted.symbolReferences.length);
    assert.ok(row.droppedByDependency.length <= MAX_DROPPED_BY_DEPENDENCY);
    const more = row.limitations.find(line => / more dependencies had \d+ fact\(s\) dropped/.test(line))!;
    assert.ok(more, row.limitations.join("\n"));
    const [, hiddenDependencies, hiddenDropped] = /^(\d+) more dependencies had (\d+)/.exec(more)!;
    assert.equal(Number(hiddenDependencies) + row.droppedByDependency.length, row.dropped, "every dropped dependency is itemized or summed");
    assert.equal(Number(hiddenDropped) + row.droppedByDependency.reduce((sum, item) => sum + item.dropped, 0), row.dropped);
    validateDependencyFacts(fitted, SHA);
    assert.deepEqual(fitDependencyFacts(many, budget), fitted, "deterministic");
    assert.deepEqual(fitDependencyFacts(fitted, budget), fitted, "idempotent");
  }
});

// --- item 9 -----------------------------------------------------------------

test("item 9: manifests and lockfiles come only from inputs captured before analyzers ran", () => {
  const files: Record<string, string> = { "Cargo.toml": '[package]\nname = "app"\n[dependencies]\nrand = "0.8"\n', "src/lib.rs": "use rand::Rng;\n" };
  const inputs = collectDependencyInputs(["src/lib.rs"], reader(files));
  assert.deepEqual([...inputs.keys()], ["Cargo.toml"]);
  // An analyzer (cargo/rust-analyzer) writes Cargo.lock into the tree afterwards.
  files["Cargo.lock"] = '[[package]]\nname = "app"\nversion = "0.1.0"\ndependencies = ["rand"]\n\n[[package]]\nname = "rand"\nversion = "0.8.5"\nsource = "registry+x"\n';
  const result = facts(files, { manifestInputs: inputs });
  assert.deepEqual(result.declarations.map(row => [row.resolution, row.lockfilePath ?? "", row.reason ?? ""]), [["unresolved", "", "No committed Cargo.lock at or above this crate."]]);
});

const NOLOCK_CRATE: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "nolock"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nhelper = { path = "helper" }\nitoa = "1"\n',
  "src/lib.rs": "use helper::value;\npub fn f() -> u32 { let _ = itoa::Buffer::new(); value() }\n",
  "helper/Cargo.toml": '[package]\nname = "helper"\nversion = "0.1.0"\nedition = "2021"\n',
  "helper/src/lib.rs": "pub fn value() -> u32 { 1 }\n",
};

test("item 9: a Cargo.lock written by the analyzer mid-scan is never cited; quick and full declarations match (hermetic)", { skip: process.platform === "win32" ? "fake analyzer is a POSIX shell script" : false }, () => {
  // Hermetic stand-in for rust-analyzer: the full scan spawns `rust-analyzer scip <acquired root> …`
  // from PATH. This fake writes a Cargo.lock into the acquired tree (exactly what cargo does
  // during a real index) and then fails, so the lockfile appears only AFTER the scan began.
  const bin = tree({
    "rust-analyzer": [
      "#!/bin/sh",
      'if [ "$1" = "scip" ]; then',
      "  cat > \"$2/Cargo.lock\" <<'LOCK'",
      "version = 4", "", "[[package]]", 'name = "helper"', 'version = "0.1.0"', "",
      "[[package]]", 'name = "itoa"', 'version = "1.0.11"', 'source = "registry+https://github.com/rust-lang/crates.io-index"', "",
      "[[package]]", 'name = "nolock"', 'version = "0.1.0"', 'dependencies = [', ' "helper",', ' "itoa",', "]",
      "LOCK",
      // The scanner's child env is minimal (CLA-305), so the marker path is the script's own directory, not an env var.
      "  touch \"$(dirname \"$0\")/ran\"",
      "fi",
      "echo 'fake rust-analyzer: no index' >&2",
      "exit 1",
    ].join("\n") + "\n",
  });
  execFileSync("chmod", ["+x", join(bin.root, "rust-analyzer")]);
  const marker = join(bin.root, "ran");
  const repo = tree(NOLOCK_CRATE, true);
  const saved = { PATH: process.env.PATH };
  try {
    process.env.PATH = `${bin.root}:${process.env.PATH ?? ""}`;
    const quick = scanRepository(repo.root, { analysisMode: "quick" }).dependencies;
    const full = scanRepository(repo.root, { analysisMode: "full" }).dependencies;
    assert.doesNotThrow(() => readFileSync(marker), "the fake analyzer ran and wrote Cargo.lock into the acquired tree");
    const itoa = full.declarations.find(row => row.dependency === "itoa")!;
    assert.deepEqual([itoa.resolution, itoa.lockfilePath, itoa.resolvedVersions, itoa.reason],
      ["unresolved", undefined, [], "No committed Cargo.lock at or above this crate."], "declared facts reflect the committed tree");
    assert.ok(!full.declarations.some(row => row.lockfilePath !== undefined), "no analyzer-written lockfile is cited");
    assert.deepEqual(full.declarations, quick.declarations);
  } finally {
    process.env.PATH = saved.PATH;
    repo.cleanup();
    bin.cleanup();
  }
});

test("item 9 (network): real rust-analyzer + cargo resolution gives identical quick and full declarations", {
  timeout: 300_000,
  skip: process.env.OKIE_NETWORK_TESTS === "1" ? false : "requires crates.io (set OKIE_NETWORK_TESTS=1)",
}, () => {
  const repo = tree(NOLOCK_CRATE, true);
  try {
    const quick = scanRepository(repo.root, { analysisMode: "quick" }).dependencies;
    const full = scanRepository(repo.root, { analysisMode: "full" }).dependencies;
    assert.deepEqual(full.declarations, quick.declarations);
    assert.equal(full.declarations.find(row => row.dependency === "itoa")!.resolution, "unresolved");
  } finally { repo.cleanup(); }
});

// --- item 10 ----------------------------------------------------------------

test("item 10 (QA D2): an npm alias key and the real package name give the same consumers", () => {
  const result = facts({ "package.json": JSON.stringify({ name: "a", dependencies: { s: "npm:left-pad@^1.3.0" } }), "a.ts": "import s from 's';\nexport default s;\n" });
  assert.deepEqual(result.imports.map(row => [row.dependency, row.specifier]), [["left-pad", "s"]]);
  const byAlias = queryDependencyConsumers(result, "s");
  const byName = queryDependencyConsumers(result, "left-pad");
  assert.deepEqual(byAlias.consumers, byName.consumers);
  assert.equal(byAlias.consumers.length, 1);
  assert.deepEqual(byAlias.declaredWithoutObservedUse, []);
});

// --- honesty polish -------------------------------------------------------------

test("polish: declarations are partial by construction; no installation means npm references unavailable", () => {
  const result = facts({ "package.json": '{"name":"a","dependencies":{"x":"1"}}', "a.ts": "import 'x';" });
  const declarations = result.coverage.find(row => row.ecosystem === "npm" && row.evidence === "declarations")!;
  assert.equal(declarations.status, "partial");
  assert.ok(declarations.limitations.some(line => /Partial by construction/.test(line)));
  const analysis = (limitations: string[]): LanguageAnalysis => ({ schemaVersion: 1, definitions: [], references: [], modules: [], externalReferences: [], coverage: [{ language: "typescript", tool: "typescript", version: "5", coverage: "semantic", indexedFiles: [], limitations }] });
  for (const limitations of [[], ["No local dependency installation found; npm symbol references unavailable."]]) {
    const full = facts({ "package.json": '{"name":"a","dependencies":{"x":"1"}}', "a.ts": "import 'x';" }, { analysisMode: "full", languageAnalysis: analysis(limitations) });
    const npm = full.coverage.find(row => row.ecosystem === "npm" && row.evidence === "symbolReferences")!;
    assert.equal(npm.status, "unavailable");
    assert.ok(npm.limitations.includes("No local dependency installation found; npm symbol references unavailable."), npm.limitations.join("\n"));
    assert.ok(!npm.limitations.some(line => /Installed dependency types reused/.test(line)));
  }
});

test("polish: dependency context reports a missing installation instead of claiming reuse", () => {
  const repo = tree({ "committed/package.json": '{"name":"a","dependencies":{"x":"1"}}', "committed/a.ts": "import { v } from 'x'; export const y = v;\n", "working/package.json": '{"name":"a","dependencies":{"x":"1"}}' });
  try {
    const analysis = analyzeTypeScript(join(repo.root, "committed"), ["a.ts"], join(repo.root, "working"));
    const limits = analysis.coverage.flatMap(row => row.limitations);
    assert.ok(limits.includes("No local dependency installation found; npm symbol references unavailable."), limits.join("\n"));
    assert.ok(!limits.some(line => /Installed dependency types reused/.test(line)));
  } finally { repo.cleanup(); }
});

test("polish: tsconfig paths aliases that look like bare specifiers are skipped unless declared", () => {
  const result = facts({
    "package.json": '{"name":"a","dependencies":{"@real/pkg":"1"}}',
    "tsconfig.json": '{\n  // comments are allowed\n  "compilerOptions": { "paths": { "@lib/*": ["src/lib/*"], "@real/*": ["src/real/*"], "utils": ["src/utils.ts"] } }\n}',
    "src/a.ts": "import '@lib/x';\nimport 'utils';\nimport '@real/pkg';\nimport 'react';\n",
  });
  assert.deepEqual(result.imports.map(row => row.specifier), ["@real/pkg", "react"]);
  const imports = result.coverage.find(row => row.ecosystem === "npm" && row.evidence === "imports")!;
  assert.ok(imports.limitations.some(line => /2 import\(s\) matched a tsconfig paths alias/.test(line)), imports.limitations.join("\n"));
});

test("polish: Rust limits are stated and raw identifiers are normalized", () => {
  const result = facts({ "Cargo.toml": '[package]\nname = "app"\n[dependencies]\nmd-5 = "0.10"\nasync = "1"\n', "src/lib.rs": "use md5::Digest;\nuse r#async::X;\n" });
  assert.deepEqual(result.imports.map(row => row.dependency), ["async"]);
  const imports = result.coverage.find(row => row.ecosystem === "cargo" && row.evidence === "imports")!;
  assert.ok(imports.limitations.some(line => /md-5 → md5/.test(line) && /extern crate x as y/.test(line)));
});

test("polish: symbol references differing only by analyzer/version/typeOnly are not collapsed", () => {
  const base = { path: "a.ts", startLine: 1, endLine: 1, ecosystem: "npm" as const, package: "react", symbol: "X", kind: "uses" as const };
  const analysis: LanguageAnalysis = { schemaVersion: 1, definitions: [], references: [], modules: [], coverage: [{ language: "typescript", tool: "typescript", version: "5", coverage: "semantic", indexedFiles: [], limitations: [] }],
    externalReferences: [{ ...base, analyzer: "typescript@5" }, { ...base, analyzer: "typescript@6" }, { ...base, analyzer: "typescript@5", typeOnly: true }, { ...base, analyzer: "typescript@5" }] };
  const result = facts({ "package.json": '{"name":"a","dependencies":{"react":"1"}}', "a.ts": "import 'react';" }, { analysisMode: "full", languageAnalysis: analysis });
  assert.equal(result.symbolReferences.length, 3);
});
