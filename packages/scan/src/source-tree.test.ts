import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { discoverExtractedTree, discoverRepository, type Discovery } from "./discover.js";
import { acquireCommittedTree, readBlobsInChunks } from "./pin.js";
import { scanRepository } from "./scan.js";
import { classifyTreeSymlinks, detachSymlinks, foldCollidingPaths, planBlobChunks, safeRegularFile, ScanSizeLimitError, SCAN_SIZE_LIMITS, type SkippedTreeEntries } from "./source-tree.js";

const gitEnv = { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` };
const git = (cwd: string, args: string[], input?: string): string =>
  execFileSync("git", args, { cwd, env: gitEnv, encoding: "utf8", ...(input !== undefined ? { input } : {}) }).trim();

function write(root: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function link(root: string, links: Record<string, string>): void {
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    symlinkSync(target, join(root, path));
  }
}

/** Every symlink under `dir` as `relative path -> target` (lstat walk; never follows). */
function symlinksUnder(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) found[relative(dir, path)] = readlinkSync(path);
      else if (entry.isDirectory() && entry.name !== ".git") visit(path);
    }
  };
  visit(dir);
  return found;
}

/** A committed repo in `<base>/repo` beside `<base>/outside` (which links may point into). */
function withCommittedRepo(files: Record<string, string>, links: Record<string, string>, run: (repo: string, base: string) => void, prepare?: (repo: string) => void): void {
  const base = mkdtempSync(join(tmpdir(), "okie-links-"));
  const repo = join(base, "repo");
  try {
    mkdirSync(repo);
    write(base, { "outside/package.json": '{"name":"leaked"}\n', "outside/workspace.yaml": "packages:\n  - 'pkgs/*'\n", "outside/secret.ts": "export const secret = 1;\n" });
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "okie@example.test"]);
    git(repo, ["config", "user.name", "Okie"]);
    write(repo, files);
    link(repo, links);
    git(repo, ["add", "-A"]);
    prepare?.(repo);
    git(repo, ["commit", "-qm", "links"]);
    run(repo, base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** Committed-Git acquisition + discovery, exactly as `scanRepository` wires it. */
function committedDiscovery(repo: string, run: (discovery: Discovery, root: string) => void): void {
  const acquired = acquireCommittedTree(repo);
  try {
    run(discoverExtractedTree(acquired.root, { skippedEntries: acquired.skipped }), acquired.root);
  } finally {
    acquired.cleanup();
  }
}

/** A GitHub-style tarball of the commit (git archive keeps symlinks), acquired + discovered as `scanGithubRepository` does. */
function tarballDiscovery(repo: string, base: string, run: (discovery: Discovery, root: string) => void): void {
  const root = join(base, "tarball", "repo-sha");
  mkdirSync(root, { recursive: true });
  execFileSync("sh", ["-c", `git archive --format=tar HEAD | tar -x -C '${root}'`], { cwd: repo, env: gitEnv });
  const removed = detachSymlinks(root);
  run(discoverExtractedTree(root, { skippedEntries: removed }), root);
}

const comparable = (discovery: Discovery): string => JSON.stringify({
  sourceFiles: discovery.sourceFiles,
  units: discovery.units,
  unitByFile: [...discovery.unitByFile],
  unitByPackageName: [...discovery.unitByPackageName],
  summary: discovery.summary,
});

// A workspace whose config reaches through in-repo links, plus every hostile link shape.
const MIXED_FILES: Record<string, string> = {
  "package.json": '{"name":"links"}\n',
  "tsconfig.base.json": "{}\n",
  "config/workspace.yaml": "packages:\n  - 'pkgs/*'\n",
  "pkgs/a/package.json": '{"name":"@x/a"}\n',
  "pkgs/a/index.ts": "export const a = 1;\n",
  "pkgs/b/package.json": '{"name":"@x/b"}\n',
  "pkgs/b/index.ts": 'import { a } from "@x/a";\nexport const b = a;\n',
  "pkgs/c/index.ts": "export const c = 1;\n",
};
const MIXED_LINKS: Record<string, string> = {
  // in-root: kept, followed for config/imports, never listed as source
  "tsconfig.json": "tsconfig.base.json",
  "pnpm-workspace.yaml": "config/workspace.yaml",
  "pkgs/a/alias.ts": "index.ts",
  "pkgs-link": "pkgs",
  // escaping: relative ../, absolute, a chain through an escaping link, a config out of the root
  "pkgs/a/escape.ts": "../../../../../../etc/passwd",
  "abs.ts": "/etc/hosts",
  "chain.ts": "abs.ts",
  "pkgs/c/package.json": "../../../outside/package.json",
  // unresolved: dangling, two-link loop, self-loop
  "pkgs/a/gone.ts": "missing.ts",
  "loop-a": "loop-b",
  "loop-b": "loop-a",
  "self": "self",
};
const MIXED_SKIPPED: SkippedTreeEntries = { symlinksInternal: 4, symlinksEscaping: 4, symlinksUnresolved: 4, submodules: 0 };
const KEPT_LINKS = { "tsconfig.json": "tsconfig.base.json", "pnpm-workspace.yaml": "config/workspace.yaml", "pkgs/a/alias.ts": "index.ts", "pkgs-link": "pkgs" };

test("in-root links are kept and honoured; escaping/dangling/looping ones removed; git and tarball discovery identical", () => {
  withCommittedRepo(MIXED_FILES, MIXED_LINKS, (repo, base) => {
    let committed = "";
    committedDiscovery(repo, (discovery, root) => {
      assert.deepEqual(symlinksUnder(root), KEPT_LINKS, "only in-root links are materialized (as the same relative links)");
      assert.equal(discovery.summary.singlePackage, false, "the in-root linked pnpm-workspace.yaml is honoured");
      assert.deepEqual(discovery.units.map(unit => unit.name), ["@x/a", "@x/b", "Build & fixture tooling"]);
      assert.deepEqual(discovery.sourceFiles, ["pkgs/a/index.ts", "pkgs/b/index.ts", "pkgs/c/index.ts"], "no link is listed as a source file; linked dirs not descended");
      assert.deepEqual(discovery.summary.skippedEntries, MIXED_SKIPPED);
      assert.ok(safeRegularFile(root, "tsconfig.json"), "in-root linked tsconfig is readable");
      committed = comparable(discovery);
    });
    tarballDiscovery(repo, base, (discovery, root) => {
      assert.deepEqual(symlinksUnder(root), KEPT_LINKS, "escaping, dangling and looping links are detached");
      assert.equal(comparable(discovery), committed, "a gh: tarball and a local commit discover identically");
      assert.ok(!JSON.stringify(discovery).includes("leaked"), "a package.json linked out of the root is never read");
    });
    assert.equal(readFileSync(join(base, "outside/secret.ts"), "utf8"), "export const secret = 1;\n", "link targets are untouched");
  });
});

test("an in-root linked tsconfig.json is honoured on both paths; an escaping one is not", () => {
  // The link target is NOT itself a root tsconfig name, so only following the link can make this a TS repo.
  const files = { "package.json": '{"name":"plain-js"}\n', "config/tsconfig.shared.json": "{}\n", "lib/index.js": "module.exports = 1;\n", "lib/bundle.min.js": "1;\n" };
  for (const [target, honoured] of [["config/tsconfig.shared.json", true], ["../outside/package.json", false]] as const) {
    withCommittedRepo(files, { "tsconfig.json": target }, (repo, base) => {
      const check = (discovery: Discovery): void => {
        // A root tsconfig makes this a TypeScript repo: minified `.js` is skipped (and counted).
        assert.equal(discovery.summary.includedJs, !honoured, target);
        assert.deepEqual(discovery.sourceFiles, honoured ? ["lib/index.js"] : ["lib/bundle.min.js", "lib/index.js"], target);
      };
      committedDiscovery(repo, check);
      tarballDiscovery(repo, base, check);
      check(discoverRepository(repo));
    });
  }
});

test("scan limitations report kept and removed links and submodules; working-tree discovery agrees", () => {
  withCommittedRepo(MIXED_FILES, MIXED_LINKS, repo => {
    const expected = { ...MIXED_SKIPPED, submodules: 1 };
    const acquired = acquireCommittedTree(repo);
    try {
      assert.deepEqual(acquired.skipped, { ...expected, symlinksInternal: 0 }, "acquisition counts what it did not keep");
      assert.throws(() => lstatSync(join(acquired.root, "vendor/sub")), /ENOENT/, "submodule not materialized");
    } finally {
      acquired.cleanup();
    }
    const artifacts = scanRepository(repo);
    assert.deepEqual(artifacts.discoverySummary.skippedEntries, expected);
    assert.deepEqual(artifacts.analysis.limitations, [
      "12 committed symlink(s) were not scanned as source: 4 resolve inside the repository (followed only for config/imports; not listed as separate source files); 4 point outside the repository (absolute or ../ target; never read); 4 are dangling, loop or collide with another path (not followed).",
      "1 Git submodule(s) were not scanned (their content is another repository).",
    ]);
    const paths = new Set(artifacts.snapshot.entities.flatMap(entity => entity.sourceRefs.map(ref => ref.path)));
    assert.ok(paths.has("pkgs/a/index.ts"));
    assert.ok(![...paths].some(path => /alias|escape|gone|loop|self|secret|pkgs-link|chain|abs/.test(path)), [...paths].join(","));
    assert.deepEqual(scanRepository(repo).analysis.limitations, artifacts.analysis.limitations, "deterministic");
    assert.deepEqual(discoverRepository(repo).summary.skippedEntries, expected);
  }, repo => {
    // A gitlink (submodule) without .gitmodules: the tree records a commit entry.
    git(repo, ["update-index", "--add", "--cacheinfo", `160000,${"a".repeat(40)},vendor/sub`]);
  });
});

/** Every entry (files, dirs, links) under `dir`, relative, lstat-based. */
function listAll(dir: string): string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      found.push(relative(dir, path) + (entry.isSymbolicLink() ? " -> " + readlinkSync(path) : entry.isDirectory() ? "/" : ""));
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(path);
    }
  };
  visit(dir);
  return found.sort();
}

function caseInsensitiveTmp(): boolean {
  const probe = mkdtempSync(join(tmpdir(), "okie-case-probe-"));
  try {
    writeFileSync(join(probe, "CaseProbe"), "");
    return existsSync(join(probe, "caseprobe"));
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

test("foldCollidingPaths flags case / NFC aliases through any prefix, deterministically", () => {
  const all = ["d1/Y", "d1/y/L", "src/a.ts", "Src/b.ts", "caf\u00e9/x", "cafe\u0301/y", "ok/link", "ok/file.ts"];
  assert.deepEqual([...foldCollidingPaths(all, ["d1/Y", "d1/y/L", "Src/b.ts", "cafe\u0301/y", "ok/link"])].sort(), ["Src/b.ts", "cafe\u0301/y", "d1/Y", "d1/y/L"]);
});

test("case-aliased tree entries never place a link outside (or through a link inside) the tree", { skip: caseInsensitiveTmp() ? false : "tmp filesystem is case-sensitive: the aliasing cannot occur here (collision detection is still covered above)" }, () => {
  withCommittedRepo({ "package.json": '{"name":"case-alias"}\n', "index.ts": "export {};\n" }, {}, repo => {
    const tempRoot = mkdtempSync(join(tmpdir(), "okie-private-temp-"));
    try {
      const acquired = acquireCommittedTree(repo, "HEAD", { tempRoot });
      try {
        const [temporary] = readdirSync(tempRoot);
        assert.deepEqual(readdirSync(join(tempRoot, temporary!)), ["repo"], "nothing is written beside the tree");
        const inside = listAll(acquired.root);
        assert.ok(!inside.some(entry => entry.includes("->")), `no link is materialized: ${inside.join(", ")}`);
        assert.ok(!inside.includes("L") && !inside.includes("escaped"), inside.join(", "));
        // d1/Y (lexically in-root) and d1/y/L alias each other: both skipped as unresolved.
        assert.equal(acquired.skipped.symlinksUnresolved, 3, "d1/Y, d1/y/L and the case alias of index.ts");
        assert.equal(acquired.skipped.symlinksInternal, 0);
        // A.ts / a.ts land in one file (first spelling, last-written content); D vs d/x.ts
        // is a file/dir conflict: one side is skipped and counted, nothing crashes.
        assert.equal(acquired.skipped.pathCollisions, 1);
      } finally {
        acquired.cleanup();
      }
      assert.deepEqual(readdirSync(tempRoot), [], "cleanup removes everything");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, repo => {
    const blob = (text: string): string => git(repo, ["hash-object", "-w", "--stdin"], text);
    // Case-aliased regular files can't coexist in a case-insensitive working tree: index them directly.
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob("export const upper = 1;\n")},A.ts`]);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob("export const lower = 2;\n")},a.ts`]);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob("file\n")},D`]);
    git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob("export {};\n")},d/x.ts`]);
    // d1/Y -> .. (root: lexically in-root) ; d1/y/L -> escaped name ; INDEX.TS -> case alias of index.ts
    git(repo, ["update-index", "--add", "--cacheinfo", `120000,${blob("..")},d1/Y`]);
    git(repo, ["update-index", "--add", "--cacheinfo", `120000,${blob("../../index.ts")},d1/y/L`]);
    git(repo, ["update-index", "--add", "--cacheinfo", `120000,${blob("a.ts")},INDEX.TS`]);
  });
});

test("tree-only symlink classification resolves chains, directory prefixes and loops without the filesystem", () => {
  const files = ["src/a.ts", "pkg/lib/index.ts"];
  const links = new Map([
    ["alias.ts", "src/a.ts"],
    ["lib", "pkg/lib"],
    ["via-dir.ts", "lib/index.ts"],
    ["chain.ts", "alias.ts"],
    ["up.ts", "src/../../x"],
    ["deep/escape.ts", "../../x"],
    ["abs", "/usr/bin/env"],
    ["loop1", "loop2/x"],
    ["loop2", "loop1"],
    ["gone.ts", "nope.ts"],
    ["root-dir", "."],
  ]);
  assert.deepEqual(classifyTreeSymlinks(links, files), { symlinksInternal: 5, symlinksEscaping: 3, symlinksUnresolved: 3, submodules: 0 });
});

test("symlink entries count toward maxFiles and an oversized link blob is never read", () => {
  withCommittedRepo({ "package.json": '{"name":"big-link"}\n', "index.ts": "export {};\n" }, { "alias.ts": "index.ts" }, repo => {
    const tempRoot = mkdtempSync(join(tmpdir(), "okie-private-temp-"));
    try {
      assert.throws(() => acquireCommittedTree(repo, "HEAD", { limits: { maxFiles: 3 }, tempRoot }),
        (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "files" && error.actual === 4);
      const acquired = acquireCommittedTree(repo, "HEAD", { tempRoot });
      try {
        assert.equal(acquired.skipped.symlinksUnresolved, 1, "a >4 KiB target cannot resolve; classified without reading");
        assert.throws(() => lstatSync(join(acquired.root, "huge-link")), /ENOENT/);
        assert.deepEqual(symlinksUnder(acquired.root), { "alias.ts": "index.ts" });
      } finally {
        acquired.cleanup();
      }
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, repo => {
    const blob = git(repo, ["hash-object", "-w", "--stdin"], "x".repeat(5000));
    git(repo, ["update-index", "--add", "--cacheinfo", `120000,${blob},huge-link`]);
  });
});

test("planBlobChunks keeps each chunk within the bound; an oversized blob gets its own chunk", () => {
  assert.deepEqual(planBlobChunks([], 10), []);
  assert.deepEqual(planBlobChunks([5, 5, 5, 20, 1, 1], 10), [[0, 2], [2, 3], [3, 4], [4, 6]]);
  assert.deepEqual(planBlobChunks([10, 10], 10), [[0, 1], [1, 2]], "exactly at the bound fits");
  assert.deepEqual(planBlobChunks([4, 7], 10), [[0, 1], [1, 2]], "one over the bound splits");
  assert.deepEqual(planBlobChunks([0, 0, 0], 1), [[0, 3]]);
  assert.deepEqual(planBlobChunks([3, 3, 3], 1), [[0, 1], [1, 2], [2, 3]]);
  // Invariants on a pseudo-random plan: contiguous, covering, bounded unless single.
  const sizes = Array.from({ length: 200 }, (_, index) => (index * 7919) % 97);
  const plan = planBlobChunks(sizes, 150);
  assert.equal(plan[0]![0], 0);
  assert.equal(plan.at(-1)![1], sizes.length);
  plan.forEach(([start, end], index) => {
    assert.ok(end > start);
    if (index > 0) assert.equal(start, plan[index - 1]![1]);
    const total = sizes.slice(start, end).reduce((sum, size) => sum + size, 0);
    assert.ok(total <= 150 || end - start === 1);
    if (end < sizes.length) assert.ok(total + sizes[end]! > 150, "chunks are maximal");
  });
});

function withSizedRepo(run: (repo: string, files: Record<string, string>) => void): void {
  const repo = mkdtempSync(join(tmpdir(), "okie-chunks-"));
  const files: Record<string, string> = {
    "package.json": '{"name":"chunks"}\n',
    "src/a.ts": "export const a = 1;\n",
    "src/b.ts": "export const b = 2;\n",
    "src/big.ts": `export const big = "${"x".repeat(5000)}";\n`,
    "src/empty.ts": "",
    "bin/tool.mjs": "export const tool = 3;\n",
  };
  try {
    git(repo, ["init", "-q", "-b", "main"]);
    git(repo, ["config", "user.email", "okie@example.test"]);
    git(repo, ["config", "user.name", "Okie"]);
    write(repo, files);
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-qm", "sized"]);
    run(repo, files);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

test("large output: blobs stream through bounded cat-file chunks (tiny injected bound)", () => {
  withSizedRepo((repo, files) => {
    for (const batchBytes of [1, 30, 64, SCAN_SIZE_LIMITS.batchBytes]) {
      const acquired = acquireCommittedTree(repo, "HEAD", { limits: { batchBytes } });
      try {
        for (const [path, text] of Object.entries(files)) assert.equal(readFileSync(join(acquired.root, path), "utf8"), text, `${path} @ ${batchBytes}`);
      } finally {
        acquired.cleanup();
      }
    }
    // The reader delivers every blob once, in order, whatever the bound.
    const listing = git(repo, ["ls-tree", "-rl", "HEAD"]).split("\n").map(line => {
      const [meta, path] = line.split("\t");
      const parts = meta!.split(/ +/);
      return { hash: parts[2]!, size: Number(parts[3]), path: path! };
    });
    for (const batchBytes of [1, 25, 100_000]) {
      const seen: number[] = [];
      readBlobsInChunks(repo, listing, batchBytes, (index, bytes) => {
        seen.push(index);
        assert.equal(bytes.toString("utf8"), files[listing[index]!.path]);
      });
      assert.deepEqual(seen, listing.map((_, index) => index));
    }
    // With the tiny bound, every blob is its own cat-file call; with the default, one call.
    const tiny = planBlobChunks(listing.map(entry => entry.size), 1);
    assert.ok(tiny.length >= listing.filter(entry => entry.size > 0).length, "one call per non-empty blob");
    assert.ok(tiny.every(([start, end]) => listing.slice(start, end).filter(entry => entry.size > 0).length <= 1));
    assert.equal(planBlobChunks(listing.map(entry => entry.size), SCAN_SIZE_LIMITS.batchBytes).length, 1);
  });
});

test("oversized repositories fail fast with a typed ScanSizeLimitError", () => {
  withSizedRepo(repo => {
    const tempRoot = mkdtempSync(join(tmpdir(), "okie-private-temp-"));
    try {
      assert.throws(() => acquireCommittedTree(repo, "HEAD", { limits: { maxFiles: 3 }, tempRoot }), (error: unknown) => {
        assert.ok(error instanceof ScanSizeLimitError);
        assert.equal(error.kind, "files");
        assert.equal(error.limit, 3);
        assert.equal(error.actual, 6);
        assert.match(error.message, /too large to scan/);
        return true;
      });
      assert.throws(() => acquireCommittedTree(repo, "HEAD", { limits: { maxBytes: 1000 }, tempRoot }),
        (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "bytes" && error.limit === 1000 && error.actual > 5000);
      assert.throws(() => acquireCommittedTree(repo, "HEAD", { limits: { maxListingBytes: 64 }, tempRoot }),
        (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "listing" && error.limit === 64);
      assert.deepEqual(readdirSync(tempRoot), [], "raised before any temporary tree is created");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }

    assert.throws(() => discoverRepository(repo, { limits: { maxFiles: 2 } }), (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "files");
    assert.throws(() => discoverRepository(repo, { limits: { maxListingBytes: 16 } }), (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "listing");
    assert.throws(() => discoverExtractedTree(repo, { limits: { maxFiles: 2 } }), (error: unknown) => error instanceof ScanSizeLimitError && error.kind === "files");
    // The documented defaults admit microsoft/TypeScript (66,763 files / ~412 MB).
    assert.ok(SCAN_SIZE_LIMITS.maxFiles >= 3 * 66_763 && SCAN_SIZE_LIMITS.maxBytes >= 4 * 412 * 1024 * 1024);
  });
});
