import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  adaptArchitectureExtraction,
  validateArchitectureExtraction,
} from "@okie/architecture";
import {
  attachPathOwners,
  ownersForPath,
  parseCodeOwners,
  pathOwnerFacts,
  readCodeOwners,
} from "./codeowners.js";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment } from "./enrich.js";
import { buildScanArtifacts } from "./scan.js";
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
function discovery(): Discovery {
  return {
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
}

const metadata = {
  snapshotId: "snapshot:acme:abc123def456",
  repositoryId: "repo:acme",
  commitSha: "abc123def456",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const pin = {
  commitSha: "abc123def456abc123def456abc123def456abc1",
  treeHash: "def456abc123def456abc123def456abc123def4",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const githubExample = `
# default
*       @global-owner1 @global-owner2
*.js    @js-owner
*.go docs@example.com
/build/logs/ @octo-org/octocats
docs/*  docs@example.com
apps/ @octocat
/docs/ @doctocat
/apps/github @octocat
pkg/a/ @acme/a-team
pkg/a/src/index.ts @alice
`;

test("parseCodeOwners skips comments and keeps owner-less rules as ownership clears", () => {
  const rules = parseCodeOwners(githubExample);
  assert.equal(rules[0]?.pattern, "*");
  assert.deepEqual(rules[0]?.owners, ["@global-owner1", "@global-owner2"]);
  assert.ok(rules.some(rule => rule.pattern === "pkg/a/src/index.ts" && rule.owners.includes("@alice")));
  assert.equal(parseCodeOwners("# only comments\n\n").length, 0);
  const cleared = parseCodeOwners("README.md\n");
  assert.equal(cleared.length, 1);
  assert.equal(cleared[0]?.pattern, "README.md");
  assert.deepEqual(cleared[0]?.owners, []);
});

test("ownersForPath: GitHub last-matching-pattern-wins, including repo-wide *", () => {
  const rules = parseCodeOwners(githubExample);
  assert.deepEqual(ownersForPath("pkg/b/src/main.ts", rules), ["@global-owner1", "@global-owner2"]);
  assert.deepEqual(ownersForPath("pkg/a/src/index.ts", rules), ["@alice"]);
  assert.deepEqual(ownersForPath("pkg/a/src/util.ts", rules), ["@acme/a-team"]);
  assert.deepEqual(ownersForPath("apps/web/App.tsx", rules), ["@octocat"]);
  assert.deepEqual(ownersForPath("apps/github/cli.ts", rules), ["@octocat"]);
  assert.deepEqual(ownersForPath("docs/guide.md", rules), ["@doctocat"]);
  assert.deepEqual(ownersForPath("docs/nested/a.md", rules), ["@doctocat"]);
  assert.deepEqual(ownersForPath("lib/foo.js", rules), ["@js-owner"]);
  assert.deepEqual(ownersForPath("cmd/main.go", rules), ["docs@example.com"]);
  assert.deepEqual(ownersForPath("build/logs/app.log", rules), ["@octo-org/octocats"]);
  assert.deepEqual(ownersForPath("README.md", rules), ["@global-owner1", "@global-owner2"]);
});

test("ownersForPath: an owner-less later rule clears inherited ownership (GitHub /apps/github)", () => {
  const rules = parseCodeOwners("/apps/ @octocat\n/apps/github\n");
  assert.deepEqual(ownersForPath("apps/web/App.tsx", rules), ["@octocat"]);
  assert.deepEqual(ownersForPath("apps/github", rules), []);
  assert.deepEqual(ownersForPath("apps/github/api.ts", rules), []);
  assert.deepEqual(pathOwnerFacts(["apps/web/App.tsx", "apps/github/api.ts"], rules), [
    { path: "apps/web/App.tsx", owners: ["@octocat"] },
  ]);
});

test("ownersForPath: no rules or unmatched paths yield empty owners", () => {
  assert.deepEqual(ownersForPath("src/a.ts", []), []);
  assert.deepEqual(ownersForPath("src/a.ts", parseCodeOwners("docs/ @docs-team\n")), []);
});

test("readCodeOwners prefers .github/CODEOWNERS then root then docs/", () => {
  const github = readCodeOwners(path => {
    if (path === ".github/CODEOWNERS") return "* @github-file\n";
    throw new Error("missing");
  });
  assert.equal(github?.path, ".github/CODEOWNERS");
  assert.deepEqual(ownersForPath("a.ts", github!.rules), ["@github-file"]);

  const root = readCodeOwners(path => {
    if (path === "CODEOWNERS") return "* @root-file\n";
    throw new Error("missing");
  });
  assert.equal(root?.path, "CODEOWNERS");

  const docs = readCodeOwners(path => {
    if (path === "docs/CODEOWNERS") return "* @docs-file\n";
    throw new Error("missing");
  });
  assert.equal(docs?.path, "docs/CODEOWNERS");

  assert.equal(readCodeOwners(() => { throw new Error("missing"); }), undefined);
});

test("attachPathOwners overlays CODEOWNERS onto entities and omits the field when absent", () => {
  const extraction = extractArchitecture({
    discovery: discovery(),
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const snapshot = adaptArchitectureExtraction(extraction, metadata);
  const without = attachPathOwners(snapshot, []);
  assert.equal(without, snapshot);
  assert.ok(without.entities.every(entity => entity.owners === undefined));

  const withOwners = attachPathOwners(snapshot, parseCodeOwners(githubExample));
  const system = withOwners.entities.find(entity => entity.kind === "softwareSystem")!;
  const pkgA = withOwners.entities.find(entity => entity.id === "container:pkg-a")!;
  const pkgB = withOwners.entities.find(entity => entity.id === "container:pkg-b")!;
  const indexCode = withOwners.entities.find(entity => entity.sourceRefs.some(ref => ref.path === "pkg/a/src/index.ts" && entity.kind === "code"))!;
  const utilCode = withOwners.entities.find(entity => entity.sourceRefs.some(ref => ref.path === "pkg/a/src/util.ts" && entity.kind === "code"))!;

  assert.ok(system.owners?.includes("@alice"));
  assert.ok(system.owners?.includes("@acme/a-team"));
  assert.ok(system.owners?.includes("@global-owner1"));
  assert.deepEqual(pkgA.owners, ["@acme/a-team", "@alice"]);
  assert.deepEqual(pkgB.owners, ["@global-owner1", "@global-owner2"]);
  assert.deepEqual(indexCode.owners, ["@alice"]);
  assert.deepEqual(utilCode.owners, ["@acme/a-team"]);
  assert.ok(JSON.stringify(withOwners).includes("@alice"));
});

test("buildScanArtifacts attaches owners from CODEOWNERS and leaves them off when the tree has none", () => {
  const absent = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.ok(absent.snapshot.entities.every(entity => !entity.owners?.length));

  const ownedFiles: Record<string, string> = {
    ...files,
    "CODEOWNERS": "* @acme/maintainers\npkg/a/ @acme/a-team\n",
  };
  const present = buildScanArtifacts({
    discovery: discovery(),
    pin,
    readFile: path => {
      const text = ownedFiles[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    repositorySlug: "acme",
    systemName: "Acme",
  });
  const pkgA = present.snapshot.entities.find(entity => entity.id === "container:pkg-a")!;
  const pkgB = present.snapshot.entities.find(entity => entity.id === "container:pkg-b")!;
  assert.deepEqual(pkgA.owners, ["@acme/a-team"]);
  assert.deepEqual(pkgB.owners, ["@acme/maintainers"]);
  assert.ok(present.extraction.entities.every(entity => !("owners" in entity)));
});

test("enrichment cannot mint owners: unknown key rejects; overlay stays scan-time CODEOWNERS", () => {
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
        responsibility: "Invented owners must not land.", sourceRefs: [],
        owners: ["@invented-from-llm"],
      },
      ...components.map(component => ({
        id: component.id, kind: "component", parentId: "container:pkg-a", name: component.name,
        responsibility: `Summary of ${component.name}.`, sourceRefs: [],
      })),
    ],
    relations: [],
  };
  assert.ok(validateArchitectureExtraction(minted).some(issue => issue.path.includes("owners")));

  const { extraction: merged, report } = mergeEnrichment(extraction, new Map([["container:pkg-a", minted]]));
  assert.equal(report.results.find(result => result.containerId === "container:pkg-a")?.accepted, false);
  assert.ok(merged.entities.every(entity => !("owners" in entity)));
  assert.ok(merged.entities.every(entity => JSON.stringify(entity).includes("@invented-from-llm") === false));

  const snapshot = adaptArchitectureExtraction(merged, metadata);
  assert.ok(snapshot.entities.every(entity => entity.owners === undefined));
  const overlaid = attachPathOwners(snapshot, parseCodeOwners("* @observed-team\n"));
  assert.ok(overlaid.entities.some(entity => entity.owners?.includes("@observed-team")));
  assert.ok(overlaid.entities.every(entity => !entity.owners?.includes("@invented-from-llm")));
});

test("pathOwnerFacts is deterministic data for the emit-prompt appendix", () => {
  const rules = parseCodeOwners("* @root\npkg/a/ @a\n");
  const facts = pathOwnerFacts(["pkg/a/src/util.ts", "pkg/a/src/index.ts", "pkg/b/src/main.ts"], rules);
  assert.deepEqual(facts, pathOwnerFacts(["pkg/b/src/main.ts", "pkg/a/src/index.ts", "pkg/a/src/util.ts"], rules));
  assert.deepEqual(facts.map(fact => fact.path), ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts"]);
  assert.deepEqual(facts[0]?.owners, ["@a"]);
  assert.deepEqual(facts[2]?.owners, ["@root"]);
  assert.deepEqual(pathOwnerFacts(["pkg/a/src/index.ts"], []), []);
});

test("THISS/okie working tree has no CODEOWNERS, so owners are honestly omitted", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  assert.equal(readCodeOwners(path => readFileSync(`${repoRoot}${path}`, "utf8")), undefined);
});
