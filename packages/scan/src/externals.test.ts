import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ARCHITECTURE_EXTRACTION_LIMITS,
  buildC4ProjectionBundle,
  validateArchitectureExtraction,
  type ArchitectureExtractionEntity,
} from "@okie/architecture";
import type { Discovery, SourceUnit } from "./discover.js";
import {
  MAX_EXTERNAL_SYSTEMS,
  extractArchitecture,
  isL1ExternalSystemPackage,
  packageNameOfSpecifier,
  runtimeDependencyLines,
} from "./extract.js";
import { stableJson } from "./scan.js";
import { scanRepository } from "./scan.js";

// ---------------------------------------------------------------------------
// Unit tests for the two pure helpers.
// ---------------------------------------------------------------------------

test("packageNameOfSpecifier collapses subpaths and scopes; ignores relative", () => {
  assert.equal(packageNameOfSpecifier("react"), "react");
  assert.equal(packageNameOfSpecifier("react-dom/client"), "react-dom");
  assert.equal(packageNameOfSpecifier("@scope/pkg"), "@scope/pkg");
  assert.equal(packageNameOfSpecifier("@fontsource/ibm-plex-sans/latin-400.css"), "@fontsource/ibm-plex-sans");
  assert.equal(packageNameOfSpecifier("node:fs"), "node:fs"); // dropped later by the allowlist, not here
  assert.equal(packageNameOfSpecifier("./local"), undefined);
  assert.equal(packageNameOfSpecifier("../up"), undefined);
  assert.equal(packageNameOfSpecifier("@scope"), undefined); // scope with no package name
});

test("runtimeDependencyLines anchors keys inside dependencies only (not devDependencies)", () => {
  const manifest = [
    "{",
    '  "name": "x",',
    '  "dependencies": {',
    '    "react": "^19.0.0",',
    '    "mermaid": "11.0.0"',
    "  },",
    '  "devDependencies": {',
    '    "react": "^19.0.0",',
    '    "typescript": "^5.0.0"',
    "  }",
    "}",
  ].join("\n");
  const lines = runtimeDependencyLines(manifest);
  assert.equal(lines.get("react"), 4, "react anchored to its dependencies line, not the devDependencies one");
  assert.equal(lines.get("mermaid"), 5);
  // typescript lives only under devDependencies -> not anchored as a runtime dep.
  assert.equal(lines.get("typescript"), undefined);
});

test("runtimeDependencyLines handles an empty single-line dependencies object", () => {
  const manifest = ['{', '  "dependencies": {},', '  "devDependencies": { "typescript": "^5" }', "}"].join("\n");
  const lines = runtimeDependencyLines(manifest);
  assert.equal(lines.get("typescript"), undefined, "devDependencies after an empty deps block are not captured");
  assert.equal(lines.size, 0);
});

test("isL1ExternalSystemPackage keeps APIs/platforms and drops UI/framework/utils", () => {
  for (const keep of [
    "@anthropic-ai/sdk",
    "openai",
    "stripe",
    "pg",
    "@octokit/rest",
    "@aws-sdk/client-s3",
    "payments-sdk",
  ]) {
    assert.equal(isL1ExternalSystemPackage(keep), true, keep);
  }
  for (const drop of [
    "react",
    "react-dom",
    "react-router",
    "@fontsource/ibm-plex-sans",
    "dompurify",
    "clsx",
    "mermaid",
    "typescript",
    "vite",
    "zod",
    "lodash",
  ]) {
    assert.equal(isL1ExternalSystemPackage(drop), false, drop);
  }
});

// ---------------------------------------------------------------------------
// Synthetic repo fixture exercising selection, filtering, evidence, and relations.
// ---------------------------------------------------------------------------

const manifests: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme", dependencies: {}, devDependencies: { typescript: "^5.0.0" } }, null, 2),
  "pkg/app/package.json": JSON.stringify({
    name: "@acme/app",
    dependencies: {
      react: "^19.0.0",
      "@scope/ui": "^2.0.0",
      rare: "^1.0.0",
      stripe: "^17.0.0",
      "@acme/lib": "workspace:*",
    },
    devDependencies: { eslint: "^9.0.0" },
  }, null, 2),
  "pkg/lib/package.json": JSON.stringify({ name: "@acme/lib", dependencies: { react: "^19.0.0" } }, null, 2),
};

const sourceFilesText: Record<string, string> = {
  // stripe x1 (L1 service boundary); react x2 in app (framework → technology);
  // @scope/ui + rare (unknown libs → technology); workspace @acme/lib (unit edge);
  // fs builtin; relative import; typescript/eslint (devDep only → excluded).
  "pkg/app/src/a.ts": [
    'import React from "react";',
    'import { X } from "@scope/ui";',
    'import { L } from "@acme/lib";',
    'import { readFile } from "fs";',
    'import "./b.js";',
    'import { rare } from "rare";',
    'import Stripe from "stripe";',
    'import ts from "typescript";',
    'import lint from "eslint";',
    "export function a() {}",
  ].join("\n"),
  "pkg/app/src/b.ts": 'import React from "react";\nexport function b() {}\n',
  "pkg/lib/src/l.ts": 'import React from "react";\nexport function L() {}\n',
};

function syntheticDiscovery(): Discovery {
  const units: SourceUnit[] = [
    { kind: "member", dir: "pkg/app", name: "@acme/app", packageName: "@acme/app", evidencePath: "pkg/app", packageManifest: "pkg/app/package.json" },
    { kind: "member", dir: "pkg/lib", name: "@acme/lib", packageName: "@acme/lib", evidencePath: "pkg/lib", packageManifest: "pkg/lib/package.json" },
  ];
  return {
    sourceFiles: ["pkg/app/src/a.ts", "pkg/app/src/b.ts", "pkg/lib/src/l.ts"],
    units,
    unitByFile: new Map([
      ["pkg/app/src/a.ts", "pkg/app"], ["pkg/app/src/b.ts", "pkg/app"], ["pkg/lib/src/l.ts", "pkg/lib"],
    ]),
    unitByPackageName: new Map([["@acme/app", "pkg/app"], ["@acme/lib", "pkg/lib"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const readSynthetic = (path: string): string => {
  const text = manifests[path] ?? sourceFilesText[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

function externals(entities: readonly ArchitectureExtractionEntity[]): ArchitectureExtractionEntity[] {
  return entities.filter(entity => entity.kind === "externalSystem");
}

test("emits externalSystems for service-boundary deps; libraries become container technology", () => {
  const extraction = extractArchitecture({ discovery: syntheticDiscovery(), readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  assert.deepEqual(validateArchitectureExtraction(extraction), [], "external emission must stay gate-clean");

  const names = externals(extraction.entities).map(entity => entity.name).sort();
  assert.deepEqual(names, ["stripe"], "only declared, imported, service-boundary runtime deps");

  // fs is a node builtin (undeclared), typescript+eslint are devDependencies only,
  // @acme/lib is a workspace package -> a container edge, never an external.
  // react / @scope/ui / rare are UI/util libraries — not L1 cards (CLA-97).
  for (const excluded of ["fs", "typescript", "eslint", "@acme/lib", "react", "@scope/ui", "rare"]) {
    assert.ok(!names.includes(excluded), `${excluded} must not be an external system`);
  }
  // @acme/lib resolves to a container->container edge instead.
  const libId = extraction.entities.find(e => e.id === "external:acme-lib");
  assert.equal(libId, undefined, "no external:acme-lib entity");

  const app = extraction.entities.find(entity => entity.id === "container:pkg-app")!;
  const lib = extraction.entities.find(entity => entity.id === "container:pkg-lib")!;
  assert.deepEqual(app.technology, ["TypeScript", "@scope/ui", "rare", "react"], "language first, then excluded deps");
  assert.deepEqual(lib.technology, ["TypeScript", "react"]);
});

test("external ids/kinds are gate-valid and top-level (no parentId)", () => {
  const extraction = extractArchitecture({ discovery: syntheticDiscovery(), readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  const stripe = externals(extraction.entities).find(entity => entity.name === "stripe")!;
  assert.equal(stripe.id, "external:stripe");
  assert.equal(stripe.kind, "externalSystem");
  assert.equal(stripe.parentId, undefined, "external systems are top-level context");
});

test("external evidence: manifest declaration line + real import sites, within limits", () => {
  const extraction = extractArchitecture({ discovery: syntheticDiscovery(), readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  const stripe = externals(extraction.entities).find(entity => entity.name === "stripe")!;
  const paths = stripe.sourceRefs.map(ref => ref.path);
  assert.ok(paths.includes("pkg/app/package.json"), "carries a package.json declaration anchor");
  assert.ok(paths.includes("pkg/app/src/a.ts"), "carries the real import site");
  const decl = stripe.sourceRefs.find(ref => ref.path === "pkg/app/package.json")!;
  assert.equal(typeof decl.startLine, "number");
  assert.ok(stripe.sourceRefs.length <= ARCHITECTURE_EXTRACTION_LIMITS.maxSourceRefs);
});

test("relations attribute the service boundary to the importing container", () => {
  const extraction = extractArchitecture({ discovery: syntheticDiscovery(), readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" });
  const byId = new Map(extraction.entities.map(e => [e.id, e]));
  const stripeRels = extraction.relations.filter(r => r.to === "external:stripe");
  assert.deepEqual(stripeRels.map(r => r.from).sort(), ["container:pkg-app"]);
  for (const relation of stripeRels) {
    assert.equal(relation.kind, "dependsOn");
    assert.ok(relation.evidence.length >= 1 && relation.evidence.length <= ARCHITECTURE_EXTRACTION_LIMITS.maxEvidenceItems);
    assert.ok(byId.get(relation.from)?.kind === "container");
  }
  assert.equal(extraction.relations.some(r => r.to === "external:react"), false, "framework deps have no L1 relation");
});

test("selection keeps only the top-N service-boundary packages by (import count desc, name asc)", () => {
  // Nine single-import service-boundary deps -> exactly MAX_EXTERNAL_SYSTEMS survive, name-sorted.
  const names = ["stripe", "openai", "pg", "mongodb", "redis", "twilio", "firebase", "mysql2", "ioredis"];
  const rootManifest = JSON.stringify({ name: "m", dependencies: Object.fromEntries(names.map(n => [n, "^1.0.0"])) }, null, 2);
  const src = names.map(n => `import x from "${n}";`).join("\n") + "\nexport const z = 1;\n";
  const read = (path: string): string => {
    if (path === "package.json") return rootManifest;
    if (path === "m/src/index.ts") return src;
    throw new Error(`missing ${path}`);
  };
  const discovery: Discovery = {
    sourceFiles: ["m/src/index.ts"],
    units: [{ kind: "member", dir: "m", name: "@m/m", packageName: "@m/m", evidencePath: "m", packageManifest: "m/package.json" }],
    unitByFile: new Map([["m/src/index.ts", "m"]]),
    unitByPackageName: new Map([["@m/m", "m"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  const extraction = extractArchitecture({ discovery, readFile: read, systemName: "M", systemSlug: "m" });
  const emitted = externals(extraction.entities).map(e => e.name).sort();
  assert.equal(emitted.length, MAX_EXTERNAL_SYSTEMS);
  assert.deepEqual(emitted, ["firebase", "ioredis", "mongodb", "mysql2", "openai", "pg", "redis", "stripe"], "twilio dropped as the lowest-ranked");
});

test("external emission is byte-identical across shuffled discovery order", () => {
  const base = syntheticDiscovery();
  const canonical = stableJson(extractArchitecture({ discovery: base, readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" }));
  const shuffles: Discovery[] = [
    { ...base, sourceFiles: [...base.sourceFiles].reverse(), units: [...base.units].reverse() },
    { ...base, sourceFiles: [base.sourceFiles[2]!, base.sourceFiles[0]!, base.sourceFiles[1]!] },
  ];
  for (const [index, discovery] of shuffles.entries()) {
    const output = stableJson(extractArchitecture({ discovery, readFile: readSynthetic, systemName: "Acme", systemSlug: "acme" }));
    assert.equal(output, canonical, `external emission differs under shuffle ${index}`);
  }
});

// ---------------------------------------------------------------------------
// Real Okie scan: the obvious third parties surface with real import evidence and render at L1.
// ---------------------------------------------------------------------------

test("Okie scan L1 keeps service SDKs and drops UI/framework/utility packages", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { snapshot } = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie" });
  const ext = snapshot.entities.filter(entity => entity.kind === "externalSystem");
  const names = new Set(ext.map(entity => entity.name));

  assert.deepEqual([...names].sort(), ["@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "@typesafe-ai/sdk"], "Okie L1 externals are its service SDKs");
  for (const excluded of [
    "react", "react-dom", "mermaid", "typescript", "dompurify", "clsx",
    "@fontsource/ibm-plex-sans", "@fontsource/ibm-plex-mono",
  ]) {
    assert.ok(!names.has(excluded), `${excluded} must not be an L1 external system; saw ${[...names].sort().join(", ")}`);
  }
  assert.ok(![...names].some(name => name.startsWith("@okie/")), "no first-party @okie/* external systems");
  assert.ok(ext.length <= MAX_EXTERNAL_SYSTEMS);

  const sdk = ext.find(entity => entity.name === "@anthropic-ai/sdk")!;
  assert.ok(sdk.sourceRefs.some(ref => ref.path.startsWith("apps/server/")), "Anthropic SDK cites the server import");
  const sdkEdge = snapshot.relations.find(relation => relation.to === sdk.id && relation.from === "container:apps-server");
  assert.ok(sdkEdge, "Anthropic SDK is a dependency of the server container");
  const mcp = ext.find(entity => entity.name === "@modelcontextprotocol/sdk")!;
  assert.ok(mcp.sourceRefs.some(ref => ref.path === "apps/edge/src/mcp.ts"), "MCP SDK cites its edge transport import");
  assert.ok(snapshot.relations.some(relation => relation.to === mcp.id && relation.from === "container:apps-edge"));
  const jev = ext.find(entity => entity.name === "@typesafe-ai/sdk")!;
  assert.ok(jev.sourceRefs.some(ref => ref.path === "apps/server/src/operatorJudgments.ts"), "TypeSafe cites its server-only boundary");
  assert.ok(snapshot.relations.some(relation => relation.to === jev.id && relation.from === "container:apps-server"));

  const web = snapshot.entities.find(entity => entity.id === "container:apps-web");
  const scan = snapshot.entities.find(entity => entity.id === "container:packages-scan");
  const architecture = snapshot.entities.find(entity => entity.id === "container:packages-architecture");
  const engine = snapshot.entities.find(entity => entity.id === "container:crates-atlas-engine");
  const system = snapshot.entities.find(entity => entity.kind === "softwareSystem");
  assert.ok(web?.technology?.includes("TypeScript"), "web container names observed TypeScript");
  assert.ok(architecture?.technology?.includes("TypeScript"), "TS packages without L1 libraries still name TypeScript");
  assert.ok(engine?.technology?.includes("Rust"), "Rust crates name Rust");
  assert.ok(snapshot.entities.some(entity => entity.parentId === engine?.id), "Rust crates drill to L3/L4 outline children");
  assert.ok(system?.technology?.includes("TypeScript") && system?.technology?.includes("Rust"), "system unions observed languages");
  assert.ok(web?.technology?.includes("react"), "react remains on the web container for inspector/detail");
  assert.ok(web?.technology?.includes("react-dom"), "react-dom remains on the web container");
  assert.ok(web?.technology?.includes("dompurify"), "dompurify remains on the web container");
  assert.ok(web?.technology?.includes("mermaid"), "mermaid remains on the web container, not L1");
  assert.ok(web?.technology?.some(name => name.startsWith("@fontsource/")), "font packages remain on the web container");
  assert.ok(scan?.technology?.includes("typescript"), "typescript remains on the scan container");
  assert.equal(web?.technology?.includes("@anthropic-ai/sdk"), false, "L1 service boundaries are not duplicated as technology");
});

test("Okie externalSystems render in the L1 context band as system-context nodes", () => {
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const { snapshot } = scanRepository(repoRoot, { systemName: "Okie", repositorySlug: "okie" });
  const system = snapshot.entities.find(entity => entity.kind === "softwareSystem")!;
  // This assertion concerns L1 only; do not lay out thousands of unrelated code
  // nodes from the current checkout while checking external-system visibility.
  const bundle = buildC4ProjectionBundle(snapshot, { rootEntityId: system.id, focusEntityId: system.id, familyId: "view-family:okie:context-test", maxBand: "context" });
  const context = Object.values(bundle.projectionById).find(projection => projection.band === "context")!;

  const contextExternals = context.visualNodeIds
    .map(id => bundle.visualNodeById[id]!)
    .filter(node => node.kind === "externalSystem");
  assert.deepEqual(contextExternals.map(node => node.name).sort(), ["@anthropic-ai/sdk", "@modelcontextprotocol/sdk", "@typesafe-ai/sdk"], "only service-boundary externals appear as L1 context nodes");
  for (const banned of ["react", "dompurify", "mermaid", "typescript"]) {
    assert.equal(contextExternals.some(node => node.name === banned), false, `${banned} must not be an L1 visual node`);
  }
  // At L1 the container->external edges collapse to system->external interactions.
  const systemToExternal = context.visualEdgeIds
    .map(id => bundle.visualEdgeById[id]!)
    .filter(edge => bundle.visualNodeById[edge.toVisualId]?.kind === "externalSystem"
      && bundle.visualNodeById[edge.fromVisualId]?.kind === "softwareSystem");
  assert.ok(systemToExternal.length >= 1, "the system interacts with external systems at L1");
});
