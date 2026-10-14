import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Discovery } from "./discover.js";
import { extractArchitecture } from "./extract.js";
import { mergeEnrichment } from "./enrich.js";
import {
  buildEnrichmentPackets,
  packetFileName,
  type EnrichmentPacket,
  ENRICHMENT_PROMPT_VERSION,
} from "./packet.js";
import {
  appendixForPacket,
  buildFileTree,
  concatenateEnrichmentPrompt,
  ownershipTreeFromPacket,
  promptFileName,
  readFrozenEnrichmentPrompt,
  writeEnrichmentPackets,
  writePromptEmission,
} from "./prompt.js";
import { stableJson } from "./scan.js";

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
    unitByPackageName: new Map([["@acme/a", "pkg/a"], ["@acme/b", "pkg/b"], ["@acme/c", "pkg/c"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
}
function base() {
  return extractArchitecture({ discovery: discovery(), readFile: read, systemName: "Acme", systemSlug: "acme" });
}

const PIN = {
  commitSha: "abc123def456abc123def456abc123def456abc1",
  treeHash: "def456abc123def456abc123def456abc123def4",
};

function fakePacket(): EnrichmentPacket {
  return {
    promptVersion: ENRICHMENT_PROMPT_VERSION,
    containerId: "container:pkg-a",
    containerName: "a",
    scopePaths: ["pkg/a/src/index.ts", "pkg/a/src/util.ts"],
    components: [
      { id: "component:pkg-a-src-index-ts", name: "index", path: "pkg/a/src/index.ts" },
      { id: "component:pkg-a-src-util-ts", name: "util", path: "pkg/a/src/util.ts" },
    ],
    code: [
      { id: "code:pkg-a:alpha", name: "alpha", path: "pkg/a/src/index.ts", componentId: "component:pkg-a-src-index-ts" },
    ],
    relations: [],
    excerpts: [],
  };
}

test("frozen prefix: generated prompt starts with exact enrichment-prompt.md bytes", () => {
  const prefix = readFrozenEnrichmentPrompt();
  assert.match(prefix, /okie-enrichment\/v2/);
  const packet = fakePacket();
  const prompt = concatenateEnrichmentPrompt({
    prefix,
    packet,
    appendix: appendixForPacket(packet, PIN, packet.containerId),
  });
  assert.equal(prompt.slice(0, prefix.length), prefix);
  assert.equal(prompt.startsWith(prefix), true);
});

test("concat only: does not template the frozen prefix", () => {
  const prefix = "# keep {{packet.id}} and {% if true %} literal\n";
  const packet = fakePacket();
  const prompt = concatenateEnrichmentPrompt({
    prefix,
    packet,
    appendix: appendixForPacket(packet, PIN, packet.containerId),
  });
  assert.equal(prompt.startsWith(prefix), true);
  assert.equal(prompt.includes("{{packet.id}}"), true);
  assert.equal(prompt.includes("{% if true %}"), true);
});

test("appendix-after-prompt: packet JSON then appendix, not mixed into the prefix", () => {
  const prefix = readFrozenEnrichmentPrompt();
  const packet = fakePacket();
  const packetJson = stableJson(packet);
  const appendix = appendixForPacket(packet, PIN, packet.containerId);
  const prompt = concatenateEnrichmentPrompt({ prefix, packet, appendix });
  const suffix = prompt.slice(prefix.length);
  assert.equal(suffix.startsWith(packetJson), true, "packet JSON must follow the frozen prefix immediately");
  const afterPacket = suffix.slice(packetJson.length);
  assert.equal(afterPacket, stableJson(appendix), "appendix JSON follows the packet JSON with no extra wrapping");
  const parsed = JSON.parse(afterPacket) as { commitSha: string; fileTree: unknown; ownershipTree: unknown };
  assert.equal(parsed.commitSha, PIN.commitSha);
  assert.ok(parsed.fileTree, "appendix carries file tree data");
  assert.ok(parsed.ownershipTree, "appendix carries ownership tree data");
  assert.equal(prefix.includes('"fileTree"'), false);
  assert.equal(prefix.includes('"ownershipTree"'), false);
  assert.equal(prefix.includes('"pathOwners"'), false);
  assert.ok(prompt.indexOf('"fileTree"') >= prefix.length + packetJson.length);
});

test("SHA stamp: appendix records commitSha, treeHash, and packet filename (not a host path)", () => {
  const packet = fakePacket();
  const appendix = appendixForPacket(packet, PIN, packet.containerId);
  assert.equal(appendix.commitSha, PIN.commitSha);
  assert.equal(appendix.treeHash, PIN.treeHash);
  assert.equal(appendix.packetFile, "container__pkg-a.json");
  assert.equal(appendix.packetFile, packetFileName(packet.containerId));
  const prompt = concatenateEnrichmentPrompt({
    prefix: readFrozenEnrichmentPrompt(),
    packet,
    appendix,
  });
  assert.equal(prompt.includes(PIN.commitSha), true);
  assert.equal(prompt.includes(PIN.treeHash), true);
  assert.equal(prompt.includes("container__pkg-a.json"), true);
  assert.equal(prompt.includes(tmpdir()), false);
  assert.doesNotMatch(prompt, /\/home\/|\/Users\/|C:\\/i);
});

test("byte-identical: same packet + pin yields identical prompt bytes", () => {
  const prefix = readFrozenEnrichmentPrompt();
  const packet = fakePacket();
  const appendix = appendixForPacket(packet, PIN, packet.containerId);
  const first = concatenateEnrichmentPrompt({ prefix, packet, appendix });
  const second = concatenateEnrichmentPrompt({ prefix, packet, appendix });
  assert.equal(first, second);
});

test("file tree and ownership tree are deterministic data derived from the packet", () => {
  const packet = fakePacket();
  assert.deepEqual(buildFileTree(packet.scopePaths), buildFileTree([...packet.scopePaths].reverse()));
  const tree = buildFileTree(packet.scopePaths);
  assert.equal(tree[0]?.name, "pkg");
  const ownership = ownershipTreeFromPacket(packet);
  assert.equal(ownership.id, "container:pkg-a");
  assert.equal(ownership.kind, "container");
  assert.ok(ownership.children.some(child => child.id === "component:pkg-a-src-index-ts"));
});

test("CODEOWNERS path owners ride the appendix as data, not new prompt instructions", () => {
  const prefix = readFrozenEnrichmentPrompt();
  assert.equal(prefix.includes("{{"), false, "frozen prompt stays untemplated");
  assert.equal(prefix.includes("{%"), false);
  const packet = fakePacket();
  const rules = [{ pattern: "*", owners: ["@acme/maintainers"] }, { pattern: "pkg/a/", owners: ["@acme/a-team"] }];
  const without = appendixForPacket(packet, PIN, packet.containerId);
  assert.equal(without.pathOwners, undefined);
  assert.equal(without.ownershipTree.owners, undefined);

  const withOwners = appendixForPacket(packet, PIN, packet.containerId, undefined, rules);
  assert.ok(withOwners.pathOwners?.length);
  assert.deepEqual(
    withOwners.pathOwners?.find(fact => fact.path === "pkg/a/src/index.ts")?.owners,
    ["@acme/a-team"],
  );
  assert.deepEqual(withOwners.ownershipTree.owners, ["@acme/a-team"]);
  const prompt = concatenateEnrichmentPrompt({ prefix, packet, appendix: withOwners });
  assert.equal(prompt.slice(0, prefix.length), prefix);
  const afterPrefix = prompt.slice(prefix.length);
  const packetJson = stableJson(packet);
  assert.equal(afterPrefix.startsWith(packetJson), true);
  const appendixJson = afterPrefix.slice(packetJson.length);
  assert.equal(appendixJson, stableJson(withOwners));
  assert.ok(appendixJson.includes('"pathOwners"'));
  assert.ok(appendixJson.includes("@acme/a-team"));
  assert.equal(prefix.includes("@acme/a-team"), false);
  assert.equal(prefix.includes("pathOwners"), false);
});

test("no secrets: planted tokens do not appear; generated files do not stamp host paths", () => {
  const plantedGho = "gho_okieTestPlantedSecretCla47xxxx";
  const plantedGhp = "ghp_okieTestPlantedSecretCla47xxxx";
  const plantedPat = "github_pat_okieTestPlantedSecretCla47xxxx";
  const withSecret: Record<string, string> = {
    ...files,
    "pkg/a/src/index.ts": `export function alpha() {}\nconst planted = "${plantedGho}";\nconst also = "${plantedGhp}";\n`,
    "README.md": `# Acme\ntoken ${plantedPat}\n`,
  };
  const readSecret = (path: string): string => {
    const text = withSecret[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const extraction = extractArchitecture({
    discovery: discovery(),
    readFile: readSecret,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const emitted = buildEnrichmentPackets(extraction, readSecret);
  const dir = mkdtempSync(join(tmpdir(), "okie-prompt-secret-"));
  try {
    writePromptEmission(dir, emitted, PIN, readFrozenEnrichmentPrompt());
    for (const file of readdirSync(dir)) {
      const body = readFileSync(`${dir}/${file}`, "utf8");
      assert.equal(body.includes(plantedGho), false, `${file} leaked planted gho token`);
      assert.equal(body.includes(plantedGhp), false, `${file} leaked planted ghp token`);
      assert.equal(body.includes(plantedPat), false, `${file} leaked planted github_pat token`);
      assert.equal(body.includes(dir), false, `${file} stamped the host output directory`);
      assert.doesNotMatch(body, /\/home\/|\/Users\/|C:\\/i);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writePromptEmission writes packet files identical to --emit-packets plus prompts", () => {
  const emitted = buildEnrichmentPackets(base(), read);
  const prefix = readFrozenEnrichmentPrompt();
  const packetsDir = mkdtempSync(join(tmpdir(), "okie-packets-"));
  const promptDir = mkdtempSync(join(tmpdir(), "okie-prompts-"));
  try {
    writeEnrichmentPackets(packetsDir, emitted);
    writePromptEmission(promptDir, emitted, PIN, prefix);
    const packetFiles = readdirSync(packetsDir).sort();
    for (const file of packetFiles) {
      assert.equal(
        readFileSync(`${promptDir}/${file}`, "utf8"),
        readFileSync(`${packetsDir}/${file}`, "utf8"),
        `${file} must match --emit-packets bytes`,
      );
    }
    const promptFiles = readdirSync(promptDir).filter(file => file.endsWith(".prompt.md"));
    assert.ok(promptFiles.length >= 2, "container + system prompts");
    for (const file of promptFiles) {
      const body = readFileSync(`${promptDir}/${file}`, "utf8");
      assert.equal(body.startsWith(prefix), true);
      assert.equal(body.includes(PIN.commitSha), true);
    }
    assert.equal(promptFileName("container:pkg-a"), "container__pkg-a.prompt.md");
  } finally {
    rmSync(packetsDir, { recursive: true, force: true });
    rmSync(promptDir, { recursive: true, force: true });
  }
});

test("hallucinated ids still reject the whole scope through --enrich-from merge", () => {
  const extraction = base();
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const ghost = {
    schemaVersion: 1,
    entities: [
      { id: system.id, kind: "softwareSystem", name: system.name, sourceRefs: [] },
      { id: "container:pkg-a", kind: "container", parentId: system.id, name: "a", sourceRefs: [] },
      { id: "code:ghost:nope", kind: "code", parentId: "component:pkg-a-src-index-ts", name: "nope", sourceRefs: [{ path: "pkg/a/src/index.ts" }] },
    ],
    relations: [],
  };
  const result = mergeEnrichment(extraction, new Map([["container:pkg-a", ghost]]));
  assert.equal(result.report.results[0]!.accepted, false);
  assert.equal(JSON.stringify(result.extraction), JSON.stringify(extraction));
  assert.ok(!result.extraction.entities.some(entity => entity.id === "code:ghost:nope"));
});

test("writePromptEmission is byte-identical across two writes of the same pin", () => {
  const emitted = buildEnrichmentPackets(base(), read);
  const prefix = readFrozenEnrichmentPrompt();
  const firstDir = mkdtempSync(join(tmpdir(), "okie-prompt-a-"));
  const secondDir = mkdtempSync(join(tmpdir(), "okie-prompt-b-"));
  try {
    writePromptEmission(firstDir, emitted, PIN, prefix);
    writePromptEmission(secondDir, emitted, PIN, prefix);
    const names = readdirSync(firstDir).sort();
    assert.deepEqual(readdirSync(secondDir).sort(), names);
    for (const name of names) {
      assert.equal(
        readFileSync(`${firstDir}/${name}`, "utf8"),
        readFileSync(`${secondDir}/${name}`, "utf8"),
        `${name} differed across writes`,
      );
    }
  } finally {
    rmSync(firstDir, { recursive: true, force: true });
    rmSync(secondDir, { recursive: true, force: true });
  }
});

test("writePromptEmission writes unique remainder packet files without overwriting chunk 1", () => {
  const { extraction, readHuge } = (() => {
    const sourceFiles: string[] = [];
    const files: Record<string, string> = {
      "README.md": "# Huge",
      "pkg/h/package.json": `${JSON.stringify({ name: "@acme/h" }, null, 2)}\n`,
    };
    const unitByFile = new Map<string, string>();
    const count = 70;
    for (let index = 0; index < count; index += 1) {
      const path = `pkg/h/src/f${String(index).padStart(3, "0")}.ts`;
      sourceFiles.push(path);
      files[path] = `export function fn${index}() { return ${index}; }\n`;
      unitByFile.set(path, "pkg/h");
    }
    const readHuge = (path: string): string => {
      const text = files[path];
      if (text === undefined) throw new Error(`missing ${path}`);
      return text;
    };
    const extraction = extractArchitecture({
      discovery: {
        sourceFiles,
        units: [{ kind: "member", dir: "pkg/h", name: "@acme/h", packageName: "@acme/h", evidencePath: "pkg/h", packageManifest: "pkg/h/package.json" }],
        unitByFile,
        unitByPackageName: new Map([["@acme/h", "pkg/h"]]),
        summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
      },
      readFile: readHuge,
      systemName: "Huge",
      systemSlug: "huge",
    });
    return { extraction, readHuge };
  })();
  const emitted = buildEnrichmentPackets(extraction, readHuge);
  const prefix = readFrozenEnrichmentPrompt();
  const dir = mkdtempSync(join(tmpdir(), "okie-chunk-prompt-"));
  try {
    writePromptEmission(dir, emitted, PIN, prefix);
    const names = readdirSync(dir);
    assert.equal(names.includes("container__pkg-h.json"), true);
    assert.equal(names.includes("container__pkg-h.2.json"), true);
    assert.equal(names.includes("container__pkg-h.prompt.md"), true);
    assert.equal(names.includes("container__pkg-h.2.prompt.md"), true);
    const first = JSON.parse(readFileSync(`${dir}/container__pkg-h.json`, "utf8")) as EnrichmentPacket;
    const second = JSON.parse(readFileSync(`${dir}/container__pkg-h.2.json`, "utf8")) as EnrichmentPacket;
    assert.equal(first.chunkIndex, 1);
    assert.equal(second.chunkIndex, 2);
    assert.notEqual(first.components[0]?.id, second.components[0]?.id);
    const prompt2 = readFileSync(`${dir}/container__pkg-h.2.prompt.md`, "utf8");
    assert.equal(prompt2.startsWith(prefix), true);
    assert.equal(prompt2.includes('"packetFile": "container__pkg-h.2.json"'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI --help documents --emit-prompt; --emit-packets is unchanged", () => {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.match(help, /--emit-prompt/);
  assert.match(help, /--emit-packets/);
  assert.match(help, /--enrich-from/);
});

test("okie-scan --emit-prompt is byte-identical on a re-scan of the same SHA", () => {
  const repo = mkdtempSync(join(tmpdir(), "okie-emit-prompt-repo-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    writeFileSync(`${repo}/package.json`, `${JSON.stringify({ name: "acme", private: true }, null, 2)}\n`);
    mkdirSync(`${repo}/src`);
    writeFileSync(`${repo}/src/index.ts`, "export function hello() { return 1; }\n");
    git(["init", "-b", "main"]);
    git(["config", "user.email", "okie@example.test"]);
    git(["config", "user.name", "okie"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    const sha = git(["rev-parse", "HEAD"]);
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const run = (out: string, promptDir: string): void => {
      execFileSync(process.execPath, [cli, "--source", repo, "--out", out, "--emit-prompt", promptDir], {
        encoding: "utf8",
      });
    };
    const out1 = join(repo, "out-1");
    const out2 = join(repo, "out-2");
    const prompt1 = join(repo, "prompt-1");
    const prompt2 = join(repo, "prompt-2");
    run(out1, prompt1);
    run(out2, prompt2);
    const names = readdirSync(prompt1).sort();
    assert.deepEqual(readdirSync(prompt2).sort(), names);
    assert.ok(names.some(name => name.endsWith(".prompt.md")));
    assert.ok(names.some(name => name.endsWith(".json")));
    for (const name of names) {
      const left = readFileSync(`${prompt1}/${name}`);
      const right = readFileSync(`${prompt2}/${name}`);
      assert.equal(Buffer.compare(left, right), 0, `${name} differed across re-scans of ${sha}`);
    }
    const prefix = readFrozenEnrichmentPrompt();
    const sample = names.find(name => name.endsWith(".prompt.md"))!;
    const body = readFileSync(`${prompt1}/${sample}`, "utf8");
    assert.equal(body.startsWith(prefix), true);
    assert.equal(body.includes(sha), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("CLI emits packets from the mapped baseline instead of post-enrichment regrouping", () => {
  const repo = mkdtempSync(join(tmpdir(), "okie-mapped-packet-repo-"));
  const work = mkdtempSync(join(tmpdir(), "okie-mapped-packet-work-"));
  const git = (args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  try {
    writeFileSync(`${repo}/package.json`, `${JSON.stringify({ name: "acme", private: true }, null, 2)}\n`);
    mkdirSync(`${repo}/src`);
    writeFileSync(`${repo}/src/a.ts`, "export const alpha = 1;\n");
    writeFileSync(`${repo}/src/b.ts`, "export const beta = 2;\n");
    git(["init", "-b", "main"]);
    git(["config", "user.email", "okie@example.test"]);
    git(["config", "user.name", "okie"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["add", "."]);
    git(["commit", "-m", "init"]);
    const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
    const baseOut = join(work, "base");
    execFileSync(process.execPath, [cli, "--source", repo, "--out", baseOut], { encoding: "utf8" });
    const base = JSON.parse(readFileSync(`${baseOut}/extraction.json`, "utf8")) as { entities: Array<{ id: string; kind: string; parentId?: string; name: string; sourceRefs: unknown[] }> };
    const system = base.entities.find(entity => entity.kind === "softwareSystem")!;
    const container = base.entities.find(entity => entity.kind === "container")!;
    const code = base.entities.filter(entity => entity.kind === "code");
    const mappedId = "component:acme-source-capability";
    const regroupedId = "component:acme-post-enrichment";
    const mapPath = join(work, "component-map.json");
    writeFileSync(mapPath, JSON.stringify({ version: 1, containers: [{ containerId: container.id, components: [{ id: mappedId, name: "Source capability", paths: ["src/a.ts", "src/b.ts"] }] }] }));
    const docs = join(work, "docs");
    mkdirSync(docs);
    writeFileSync(join(docs, packetFileName(container.id)), JSON.stringify({
      schemaVersion: 1,
      entities: [
        { id: system.id, kind: system.kind, name: system.name, sourceRefs: [] },
        { id: container.id, kind: container.kind, parentId: system.id, name: container.name, sourceRefs: [] },
        { id: regroupedId, kind: "component", parentId: container.id, name: "Post-enrichment regroup", sourceRefs: [] },
        ...code.map(entity => ({ id: entity.id, kind: "code", parentId: regroupedId, name: entity.name, sourceRefs: entity.sourceRefs })),
      ],
      relations: [],
    }));
    const out = join(work, "out");
    const packets = join(work, "packets");
    execFileSync(process.execPath, [cli, "--source", repo, "--out", out, "--component-map", mapPath, "--enrich-from", docs, "--emit-packets", packets], { encoding: "utf8" });
    const finalExtraction = JSON.parse(readFileSync(`${out}/extraction.json`, "utf8")) as { entities: Array<{ id: string }> };
    assert.ok(finalExtraction.entities.some(entity => entity.id === regroupedId), "enrichment regrouping was accepted");
    const packet = JSON.parse(readFileSync(join(packets, packetFileName(container.id)), "utf8")) as EnrichmentPacket;
    assert.deepEqual(packet.components.map(component => component.id), [mappedId]);
    assert.equal(packet.components.some(component => component.id === regroupedId), false);
    assert.deepEqual(packet.scopePaths, ["src/a.ts", "src/b.ts"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
