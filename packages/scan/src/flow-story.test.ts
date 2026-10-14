import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateStory } from "@okie/architecture";
import type { Discovery } from "./discover.js";
import {
  buildUserFlowStories,
  findFlowEntity,
  publishedStoryCatalog,
  USER_FLOW_TEMPLATES,
} from "./flow-story.js";
import { buildScanArtifacts, scanRepository, stableJson } from "./scan.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const flowFiles: Record<string, string> = {
  "README.md": "# Acme",
  "pkg/a/src/index.ts": "export function alpha() {}\nexport const A = 1;\nimport './util.js';\n",
  "pkg/a/src/util.ts": "export function helper() {}\n",
  "pkg/b/src/main.ts": "import { alpha } from '@acme/a';\nexport class Beta {}\n",
  "apps/web/src/scanLanding.tsx": "export function ScanLandingScreen() { return null; }\n",
  "apps/web/src/App.tsx": "export function App() { return null; }\n",
  "apps/web/src/ask/askAtlas.ts": "export async function submitAskQuestion() { return {}; }\n",
  "apps/web/src/oembed.ts": "export function handleOembedRequest() { return { status: 200 }; }\n",
  "apps/web/src/embedCanvas.ts": "export function autoGpuAttemptOrder() { return ['webgl2']; }\n",
  "apps/server/src/scanService.ts": "export function createScanJobRunner() { return {}; }\n",
  "apps/server/src/ask.ts": "export async function answerAskQuestion() { return {}; }\n",
};

function discovery(includeFlows: boolean): Discovery {
  const extras = includeFlows
    ? [
      "apps/web/src/scanLanding.tsx",
      "apps/web/src/App.tsx",
      "apps/web/src/ask/askAtlas.ts",
      "apps/web/src/oembed.ts",
      "apps/web/src/embedCanvas.ts",
      "apps/server/src/scanService.ts",
      "apps/server/src/ask.ts",
    ]
    : [];
  const sourceFiles = ["pkg/a/src/index.ts", "pkg/a/src/util.ts", "pkg/b/src/main.ts", ...extras];
  const unitByFile = new Map([
    ["pkg/a/src/index.ts", "pkg/a"],
    ["pkg/a/src/util.ts", "pkg/a"],
    ["pkg/b/src/main.ts", "pkg/b"],
    ...extras.map(file => [file, file.startsWith("apps/server/") ? "pkg/b" : "pkg/a"] as const),
  ]);
  return {
    sourceFiles,
    units: [
      { kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" },
      { kind: "member", dir: "pkg/b", name: "@acme/b", packageName: "@acme/b", evidencePath: "pkg/b", packageManifest: "pkg/b/package.json" },
    ],
    unitByFile,
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}

const pin = {
  commitSha: "abc123def456abc123def456abc123def456abc1",
  treeHash: "def456abc123def456abc123def456abc123def4",
  generatedAt: "2026-01-01T00:00:00.000Z",
};

const read = (path: string): string => {
  const text = flowFiles[path];
  if (text === undefined) throw new Error(`missing ${path}`);
  return text;
};

function artifacts(includeFlows: boolean) {
  return buildScanArtifacts({
    discovery: discovery(includeFlows),
    pin,
    readFile: read,
    repositorySlug: "acme",
    systemName: "Acme",
  });
}

test("scan without THISS/okie surfaces publishes overview only", () => {
  const result = artifacts(false);
  assert.equal(result.story.id, "story:acme:overview");
  assert.deepEqual(result.stories.map(story => story.id), ["story:acme:overview"]);
  assert.equal(result.catalog.schemaVersion, 1);
  assert.equal(result.catalog.stories.length, 1);
  assert.equal(result.catalog.stories[0]?.id, result.story.id);
});

test("matching surfaces publish overview plus deterministic user-flow stories", () => {
  const result = artifacts(true);
  assert.equal(result.story.id, "story:acme:overview");
  assert.ok(result.stories.length > 1, "expected overview plus at least one flow");
  assert.equal(result.stories[0]?.id, "story:acme:overview");
  const flowIds = result.stories.slice(1).map(story => story.id);
  assert.deepEqual(flowIds, [
    "story:acme:paste-a-repo",
    "story:acme:ask",
    "story:acme:embed",
  ]);
  assert.equal(result.catalog.stories.length, result.stories.length);
  assert.equal(stableJson(publishedStoryCatalog(result.stories)), stableJson(result.catalog));

  for (const story of result.stories) {
    assert.deepEqual(validateStory(result.snapshot, result.view, story), [], story.id);
    for (const step of story.steps) {
      if (!story.id.endsWith(":overview")) assert.equal(step.focusEntityIds.length, 1, `${story.id} ${step.id}`);
      assert.ok(step.focusEntityIds.every(id => result.snapshot.entities.some(entity => entity.id === id)));
      assert.match(step.narration, /\S/u);
      assert.equal(/scanned at commit/i.test(step.narration), false);
    }
  }

  const paste = result.stories.find(story => story.id === "story:acme:paste-a-repo")!;
  assert.ok(paste.steps.some(step => step.reveal === "container"));
  assert.ok(paste.steps.some(step => step.reveal === "component"));
  assert.ok(paste.steps.some(step => step.reveal === "code"));
  const codeStep = paste.steps.find(step => step.reveal === "code")!;
  assert.equal(codeStep.focusEntityIds.length, 1);
  const codeEntity = result.snapshot.entities.find(entity => entity.id === codeStep.focusEntityIds[0]);
  assert.equal(codeEntity?.kind, "code");
  assert.match(codeStep.narration, /createScanJobRunner is a code in this flow/);
  assert.equal(codeStep.narration.includes("invent"), false);
});

test("flow copy stays structural without summaries and polishes accepted responsibility", () => {
  const off = artifacts(true);
  const pasteOff = off.stories.find(story => story.id === "story:acme:paste-a-repo")!;
  const codeOff = pasteOff.steps.find(step => step.id === "step:paste-scan")!;
  assert.match(codeOff.narration, /is a code in this flow \(the scan job that publishes the atlas\)\./);
  assert.equal(codeOff.narration.includes("invented"), false);

  const featuredId = codeOff.focusEntityIds[0]!;
  const polished = {
    ...off.snapshot,
    entities: off.snapshot.entities.map(entity =>
      entity.id === featuredId
        ? { ...entity, responsibility: "Scanner-scoped scan runner summary." }
        : entity),
  };
  const flows = buildUserFlowStories(polished, off.view, "acme", "Acme");
  const pasteOn = flows.find(story => story.id === "story:acme:paste-a-repo")!;
  const codeOn = pasteOn.steps.find(step => step.id === "step:paste-scan")!;
  assert.match(codeOn.narration, /Scanner-scoped scan runner summary\./);
  assert.deepEqual(pasteOn.steps.map(step => ({ id: step.id, focusEntityIds: step.focusEntityIds, reveal: step.reveal })),
    pasteOff.steps.map(step => ({ id: step.id, focusEntityIds: step.focusEntityIds, reveal: step.reveal })));
});

test("templates skip a flow when a required surface is missing", () => {
  const partialFiles = { ...flowFiles };
  delete partialFiles["apps/server/src/scanService.ts"];
  const sourceFiles = discovery(true).sourceFiles.filter(file => file !== "apps/server/src/scanService.ts");
  const unitByFile = new Map([...discovery(true).unitByFile].filter(([file]) => file !== "apps/server/src/scanService.ts"));
  const result = buildScanArtifacts({
    discovery: { ...discovery(true), sourceFiles, unitByFile },
    pin,
    readFile: path => {
      const text = partialFiles[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    },
    repositorySlug: "acme",
    systemName: "Acme",
  });
  assert.equal(result.stories.some(story => story.id === "story:acme:paste-a-repo"), false);
  assert.ok(result.stories.some(story => story.id === "story:acme:ask"));
  assert.equal(result.story.id, "story:acme:overview");
});

test("Okie self-scan publishes overview plus user-flow stories on real entity ids", () => {
  const { story, stories, snapshot, view } = scanRepository(repoRoot, {
    systemName: "Okie",
    repositorySlug: "thiss-okie",
  });
  assert.equal(story.id, "story:thiss-okie:overview");
  assert.ok(stories.length > 1, `expected overview plus flows, got ${stories.map(item => item.id).join(",")}`);
  assert.equal(stories[0]?.id, story.id);
  assert.ok(stories.some(item => item.id === "story:thiss-okie:paste-a-repo"));
  assert.ok(stories.some(item => item.id === "story:thiss-okie:ask"));
  assert.ok(stories.some(item => item.id === "story:thiss-okie:embed"));

  for (const item of stories) {
    assert.deepEqual(validateStory(snapshot, view, item), [], item.id);
  }

  const paste = stories.find(item => item.id === "story:thiss-okie:paste-a-repo")!;
  assert.ok(paste.steps.every(step => step.focusEntityIds.length === 1), "each flow step centers one entity");
  const codeStep = paste.steps.find(step => step.reveal === "code");
  assert.ok(codeStep, "paste-a-repo flow includes a code step for CLA-55 isolate");
  const focused = snapshot.entities.find(entity => entity.id === codeStep!.focusEntityIds[0]);
  assert.equal(focused?.kind, "code");
  assert.equal(focused?.parentId !== undefined, true);
});

test("flow entity lookup is path+symbol and walks to a container", () => {
  const result = artifacts(true);
  const landing = findFlowEntity(result.snapshot.entities, {
    path: "apps/web/src/scanLanding.tsx",
    kind: "component",
  });
  assert.ok(landing);
  assert.equal(landing.kind, "component");
  const web = findFlowEntity(result.snapshot.entities, {
    path: "apps/web/src/scanLanding.tsx",
    kind: "container",
  });
  assert.ok(web);
  assert.equal(web.kind, "container");
  assert.equal(landing.parentId, web.id);
  assert.equal(
    findFlowEntity(result.snapshot.entities, { path: "apps/web/src/missing.ts", kind: "code" }),
    undefined,
  );
  assert.equal(USER_FLOW_TEMPLATES.length, 3);
});
