import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildEnrichmentPackets,
  extractArchitecture,
  MAX_COMPONENTS_PER_PACKET,
  mergeEnrichment,
  type Discovery,
  type EmittedPackets,
  type EnrichmentPacket,
  type SystemPacket,
} from "@okie/scan";
import {
  createEnricher,
  enrichmentChatCompletionsBody,
  enrichmentStreamParams,
  MAX_ENRICHABLE_CODE_ENTITIES,
  packetUserMessage,
  parseChatCompletionDocument,
  looksLikeExtractionEnvelope,
  EXTRACTION_TOOL_NAME,
  extractionEnvelopeSkeleton,
  resolveEnrichmentPassModelId,
} from "./enrichment.js";
import {
  createGlobalEnrichmentSpend,
  clampEnrichmentBudget,
} from "./globalSpend.js";
import {
  createLlmGatewayClient,
  DEFAULT_MAX_ENRICHMENT_TOKENS,
  LlmGatewayError,
  resolveEnrichmentBudget,
  resolveLlmGatewayConfig,
} from "./llmGateway.js";
import { createDefaultEnricherFactory } from "./scanService.js";

/** THISS/okie `@okie/web` first-packet code-entity count that 400 used to skip (CLA-71). */
const THISS_OKIE_APPS_WEB_FIRST_PACKET_CODE_ENTITIES = 474;

const containerPacket = (containerId: string, codeCount = 2): EnrichmentPacket => ({
  promptVersion: "okie-enrichment/v2",
  containerId,
  containerName: containerId,
  scopePaths: ["src/a.ts"],
  components: [{ id: `component:${containerId}`, name: "src/a.ts", path: "src/a.ts" }],
  code: Array.from({ length: codeCount }, (_, index) => ({
    id: `code:a-${index}`,
    name: `symbol${index}`,
    path: "src/a.ts",
    componentId: `component:${containerId}`,
  })),
  relations: [],
  excerpts: [],
});

const systemPacket: SystemPacket = {
  promptVersion: "okie-enrichment/v2",
  scope: "system",
  systemId: "system:acme",
  systemName: "Acme",
  scopePaths: ["README.md"],
  containers: [{ id: "container:pkg-a", name: "pkg-a" }],
  externalSystems: [],
  readme: [],
};

const packets = (overrides: Partial<EmittedPackets> = {}): EmittedPackets => ({
  packets: [containerPacket("container:pkg-a")],
  systemPacket,
  manifest: { promptVersion: "okie-enrichment/v2", packets: [] },
  ...overrides,
});

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "../../..");

type ExtractionDoc = { schemaVersion: number; entities: Array<{ id: string; kind: string }>; relations: unknown[] };

function asDocArray(value: unknown): unknown[] {
  assert.ok(Array.isArray(value), "remainder packets must group onto one container id");
  return value;
}

function componentEntities(doc: unknown): Array<{ id: string; kind: string }> {
  const record = doc && typeof doc === "object" ? doc as ExtractionDoc : undefined;
  return (record?.entities ?? []).filter(entity => entity.kind === "component");
}

function loadAppsWebFixture(name: "container__apps-web.json" | "container__apps-web.2.json"): ExtractionDoc {
  return JSON.parse(readFileSync(join(repoRoot, "fixtures/enrichment/thiss-okie", name), "utf8")) as ExtractionDoc;
}

function summaryFromPacket(
  packet: EnrichmentPacket,
  systemId: string,
  systemName: string,
  extraEntities: object[] = [],
): ExtractionDoc {
  return {
    schemaVersion: 1,
    entities: [
      { id: systemId, kind: "softwareSystem", name: systemName, sourceRefs: [] },
      {
        id: packet.containerId, kind: "container", parentId: systemId, name: packet.containerName,
        responsibility: `Summary of ${packet.containerName} chunk ${packet.chunkIndex ?? 1}.`,
        sourceRefs: [],
      },
      ...packet.components.map(component => ({
        id: component.id, kind: "component", parentId: packet.containerId, name: component.name,
        responsibility: `Summary of ${component.name}.`, sourceRefs: [],
      })),
      ...extraEntities,
    ] as ExtractionDoc["entities"],
    relations: [],
  };
}

function hugeExtraction(fileCount: number) {
  const sourceFiles: string[] = [];
  const files: Record<string, string> = {
    "README.md": "# Huge",
    "pkg/h/package.json": `${JSON.stringify({ name: "@acme/h" }, null, 2)}\n`,
  };
  const unitByFile = new Map<string, string>();
  for (let index = 0; index < fileCount; index += 1) {
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
  const discovery: Discovery = {
    sourceFiles,
    units: [{ kind: "member", dir: "pkg/h", name: "@acme/h", packageName: "@acme/h", evidencePath: "pkg/h", packageManifest: "pkg/h/package.json" }],
    unitByFile,
    unitByPackageName: new Map([["@acme/h", "pkg/h"]]),
    summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
  };
  return { extraction: extractArchitecture({ discovery, readFile: readHuge, systemName: "Huge", systemSlug: "huge" }), readHuge };
}

async function listenFakeGateway(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake gateway has no port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections();
      server.close(error => { if (error) reject(error); else resolve(); });
    }),
  };
}

test("enricher requests one doc per container plus the system scope, threading the system id", async () => {
  const calls: Array<{ id: string; kind: string; systemId: string }> = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    generate: async (packet, kind, systemId) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      calls.push({ id, kind, systemId });
      return { document: { doc: id } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual([...docs.keys()].sort(), ["container:pkg-a", "container:pkg-b", "system:acme"]);
  assert.deepEqual(calls.map(call => call.kind), ["system", "container", "container"]);
  assert.equal(calls[0]!.id, "system:acme");
  assert.ok(calls.every(call => call.systemId === "system:acme"));
});

test("remainder packets for the same container union; later chunk does not overwrite the first", async () => {
  const first = loadAppsWebFixture("container__apps-web.json");
  const remainder = loadAppsWebFixture("container__apps-web.2.json");
  assert.equal(componentEntities(first).length, 61, "chunk 1 restates 61 @okie/web file-components");
  assert.equal(componentEntities(remainder).length, 7, "remainder restates the leftover 7");

  const enrich = createEnricher({
    maxConcurrent: 2,
    generate: async (packet, kind) => {
      if (kind === "system") return { document: { schemaVersion: 1, entities: [], relations: [] } };
      const scoped = packet as EnrichmentPacket;
      if (scoped.chunkIndex === 1) {
        await new Promise(resolve => { setTimeout(resolve, 40); });
        return { document: first };
      }
      return { document: remainder };
    },
  });
  const docs = await enrich(packets({
    packets: [
      { ...containerPacket("container:apps-web"), chunkIndex: 1, chunkCount: 2 },
      { ...containerPacket("container:apps-web"), chunkIndex: 2, chunkCount: 2 },
    ],
  }));
  const grouped = asDocArray(docs.get("container:apps-web"));
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0], first, "packet order, not completion order");
  assert.equal(grouped[1], remainder);
  const unioned = new Set(grouped.flatMap(doc => componentEntities(doc).map(entity => entity.id)));
  assert.equal(unioned.size, 68, "hosted enrichWithPackets must keep 68 @okie/web file-components, not 7");
  assert.notEqual(componentEntities(grouped.at(-1)).length, 68);
  assert.equal(componentEntities(grouped.at(-1)).length, 7, "last-write-wins would have kept only the remainder");
});

test("hosted remainder packets union through the gate: 68 file-components, not 7", async () => {
  const fileCount = MAX_COMPONENTS_PER_PACKET + 7;
  const { extraction, readHuge } = hugeExtraction(fileCount);
  const emitted = buildEnrichmentPackets(extraction, readHuge);
  const chunks = emitted.packets.filter(packet => packet.containerId === "container:pkg-h");
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0]!.components.length, MAX_COMPONENTS_PER_PACKET);
  assert.equal(chunks[1]!.components.length, 7);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;

  const enrich = createEnricher({
    maxConcurrent: 2,
    generate: async (packet, kind, systemId) => {
      if (kind === "system") {
        return {
          document: {
            schemaVersion: 1,
            entities: [{ id: systemId, kind: "softwareSystem", name: system.name, responsibility: "Huge test system.", sourceRefs: [] }],
            relations: [],
          },
        };
      }
      return { document: summaryFromPacket(packet as EnrichmentPacket, systemId, system.name) };
    },
  });
  const docs = await enrich(emitted);
  const grouped = asDocArray(docs.get("container:pkg-h"));
  assert.equal(componentEntities(grouped.at(-1)).length, 7, "overwrite would keep only the remainder chunk");
  const { extraction: merged, report } = mergeEnrichment(extraction, docs);
  const web = report.results.find(result => result.containerId === "container:pkg-h");
  assert.equal(web?.accepted, true, web?.reasons.join("; "));
  assert.equal(web?.components, fileCount);
  const summarized = merged.entities.filter(entity =>
    entity.kind === "component" && entity.parentId === "container:pkg-h" && entity.responsibility);
  assert.equal(summarized.length, 68, "union must keep 68 file-component summaries, not 7");
});

test("a hallucinated-id remainder rejects that document; the sibling packet still merges", async () => {
  const fileCount = MAX_COMPONENTS_PER_PACKET + 7;
  const { extraction, readHuge } = hugeExtraction(fileCount);
  const emitted = buildEnrichmentPackets(extraction, readHuge);
  const chunks = emitted.packets.filter(packet => packet.containerId === "container:pkg-h");
  const firstIds = new Set(chunks[0]!.components.map(component => component.id));
  const remainderIds = new Set(chunks[1]!.components.map(component => component.id));
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;

  const enrich = createEnricher({
    maxConcurrent: 1,
    generate: async (packet, kind, systemId) => {
      if (kind === "system") {
        return {
          document: {
            schemaVersion: 1,
            entities: [{ id: systemId, kind: "softwareSystem", name: system.name, responsibility: "Huge test system.", sourceRefs: [] }],
            relations: [],
          },
        };
      }
      const scoped = packet as EnrichmentPacket;
      const extra = scoped.chunkIndex === 2 ? [{
        id: "code:ghost:nope",
        kind: "code",
        parentId: scoped.components[0]!.id,
        name: "nope",
        sourceRefs: [{ path: scoped.scopePaths[0] ?? "pkg/h/src/f000.ts" }],
      }] : [];
      return { document: summaryFromPacket(scoped, systemId, system.name, extra) };
    },
  });
  const docs = await enrich(emitted);
  const grouped = asDocArray(docs.get("container:pkg-h"));
  assert.equal(grouped.length, 2, "the hallucinated remainder is still handed to the gate");
  const { extraction: merged, report } = mergeEnrichment(extraction, docs);
  assert.equal(report.results.find(result => result.containerId === "container:pkg-h")?.accepted, true);
  const summarized = merged.entities.filter(entity =>
    entity.kind === "component" && entity.parentId === "container:pkg-h" && entity.responsibility);
  for (const id of firstIds) {
    assert.equal(merged.entities.find(entity => entity.id === id)?.responsibility, `Summary of ${merged.entities.find(entity => entity.id === id)?.name}.`);
  }
  assert.equal(summarized.length, firstIds.size, "rejected remainder must not drop the accepted sibling");
  for (const id of remainderIds) {
    assert.equal(merged.entities.find(entity => entity.id === id)?.responsibility, undefined);
  }
  assert.ok(!merged.entities.some(entity => entity.id === "code:ghost:nope"));
});

test("a per-scope failure omits only that scope and never throws", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      if (kind === "container" && (packet as EnrichmentPacket).containerId === "container:pkg-b") {
        throw new Error("rate limited");
      }
      return { document: { ok: true } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual([...docs.keys()].sort(), ["container:pkg-a", "system:acme"]);
  assert.ok(notes.some(note => note.includes("container:pkg-b") && note.includes("stays deterministic")));
});

test("oversized packets are skipped with a visible note; the system packet still runs", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    generate: async () => ({ document: { ok: true } }),
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:huge", MAX_ENRICHABLE_CODE_ENTITIES + 1)],
  }));
  assert.equal(docs.has("container:huge"), false);
  assert.equal(docs.has("system:acme"), true);
  assert.ok(notes.some(note => note.includes("container:huge") && note.includes("cap")));
});

test("CLA-71: published code cap asks a 474-entity @okie/web first packet and its remainder", async () => {
  assert.equal(MAX_ENRICHABLE_CODE_ENTITIES, 500);
  assert.ok(MAX_ENRICHABLE_CODE_ENTITIES >= THISS_OKIE_APPS_WEB_FIRST_PACKET_CODE_ENTITIES);
  const notes: string[] = [];
  const called: Array<{ id: string; kind: string; code: number }> = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    generate: async (packet, kind) => {
      if (kind === "system") {
        called.push({ id: (packet as SystemPacket).systemId, kind, code: 0 });
        return { document: { ok: "system" } };
      }
      const scoped = packet as EnrichmentPacket;
      called.push({ id: scoped.containerId, kind, code: scoped.code.length });
      return { document: { ok: scoped.containerId, chunk: scoped.chunkIndex } };
    },
    onProgress: note => notes.push(note),
  });
  const docs = await enrich(packets({
    packets: [
      { ...containerPacket("container:apps-web", THISS_OKIE_APPS_WEB_FIRST_PACKET_CODE_ENTITIES), chunkIndex: 1, chunkCount: 2 },
      { ...containerPacket("container:apps-web", 40), chunkIndex: 2, chunkCount: 2 },
    ],
  }));
  const grouped = asDocArray(docs.get("container:apps-web"));
  assert.equal(grouped.length, 2);
  assert.equal(called[0]!.kind, "system");
  assert.deepEqual(called.filter(call => call.id === "container:apps-web").map(call => call.code), [
    THISS_OKIE_APPS_WEB_FIRST_PACKET_CODE_ENTITIES,
    40,
  ]);
  assert.ok(docs.has("system:acme"));
  assert.ok(notes.every(note => !note.includes("skipped") || !note.includes("container:apps-web")));
  assert.ok(notes.every(note => !note.includes("okie-test-llm-key")));
});

test("CLA-71: oversized first packet skip still asks a fitting remainder of the same container", async () => {
  const called: Array<{ id: string; chunk?: number; code: number }> = [];
  const notes: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    generate: async (packet, kind) => {
      if (kind === "system") {
        called.push({ id: (packet as SystemPacket).systemId, code: 0 });
        return { document: { ok: "system" } };
      }
      const scoped = packet as EnrichmentPacket;
      called.push({
        id: scoped.containerId,
        ...(scoped.chunkIndex !== undefined ? { chunk: scoped.chunkIndex } : {}),
        code: scoped.code.length,
      });
      return { document: { ok: scoped.containerId } };
    },
    onProgress: note => notes.push(note),
  });
  const docs = await enrich(packets({
    packets: [
      { ...containerPacket("container:apps-web", MAX_ENRICHABLE_CODE_ENTITIES + 1), chunkIndex: 1, chunkCount: 2 },
      { ...containerPacket("container:apps-web", 40), chunkIndex: 2, chunkCount: 2 },
    ],
  }));
  assert.equal(docs.has("container:apps-web"), true);
  assert.equal(docs.has("system:acme"), true);
  assert.deepEqual(called.filter(call => call.id === "container:apps-web"), [
    { id: "container:apps-web", chunk: 2, code: 40 },
  ]);
  assert.ok(notes.some(note => note.includes("container:apps-web") && note.includes("chunk 1") && note.includes("cap")));
});

test("CLA-71: system packet is first so a 200k token cap cannot starve it after three container proposals", async () => {
  assert.equal(DEFAULT_MAX_ENRICHMENT_TOKENS, 200_000);
  const called: string[] = [];
  const notes: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxTokens: DEFAULT_MAX_ENRICHMENT_TOKENS },
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      return {
        document: { ok: id },
        usage: { totalTokens: kind === "system" ? 5_000 : 70_000 },
      };
    },
  });
  const docs = await enrich(packets({
    packets: [
      containerPacket("container:pkg-a"),
      containerPacket("container:pkg-b"),
      containerPacket("container:pkg-c"),
      containerPacket("container:pkg-d"),
    ],
  }));
  assert.equal(called[0], "system:acme");
  assert.ok(docs.has("system:acme"));
  assert.ok(called.includes("container:pkg-a"));
  assert.equal(called.includes("container:pkg-d"), false, "fourth container still hits the 200k cap");
  assert.ok(notes.some(note => note.includes("max tokens") && note.includes("skipping")));
  assert.ok(notes.every(note => !note.includes("okie-test-llm-key")));
});

test("no system packet means no enrichment at all (no gate anchor)", async () => {
  let called = 0;
  const enrich = createEnricher({ generate: async () => { called += 1; return { document: {} }; } });
  const docs = await enrich({
    packets: [containerPacket("container:pkg-a")],
    manifest: { promptVersion: "okie-enrichment/v2", packets: [] },
  });
  assert.equal(docs.size, 0);
  assert.equal(called, 0);
});

test("gateway progress notes include the model id and never a tokenized URL", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const urlToken = "okie-test-url-token-cla29-fake";
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    gateway: {
      baseUrl: `https://okietest:${urlToken}@example.invalid/v1?api_key=${urlToken}`,
      modelId: "acme/fast",
    },
    generate: async () => ({ document: { ok: true } }),
  });
  await enrich(packets());
  const gatewayNote = notes.find(note => note.includes("llm gateway"));
  assert.ok(gatewayNote);
  assert.match(gatewayNote, /llm gateway example\.invalid model acme\/fast/);
  assert.doesNotMatch(gatewayNote, /https:\/\//);
  assert.ok(notes.every(note => !note.includes(fakeKey)));
  assert.ok(notes.every(note => !note.includes(urlToken)));
});

test("enrichment pass uses the configured model id, not a hardcoded table", () => {
  assert.equal(resolveEnrichmentPassModelId({ modelId: "anthropic/claude-sonnet-4" }), "anthropic/claude-sonnet-4");
  assert.equal(resolveEnrichmentPassModelId({ modelId: "acme/cheap" }), "acme/cheap");
  assert.equal(resolveEnrichmentPassModelId({ gateway: { baseUrl: "https://example.gateway/v1", modelId: "openrouter/foo" } }), "openrouter/foo");
  assert.equal(resolveEnrichmentPassModelId({ modelId: "operator/wins", gateway: { baseUrl: "https://x", modelId: "gateway/loses" } }), "operator/wins");
  assert.equal(resolveEnrichmentPassModelId({ modelId: "  " }), undefined);

  const params = enrichmentStreamParams("acme/cheap", "system", "system:acme", systemPacket);
  assert.equal(params.model, "acme/cheap");
  assert.throws(() => enrichmentStreamParams("  ", "system", "system:acme", systemPacket), /empty model id/);

  const src = readFileSync(join(fileURLToPath(new URL(".", import.meta.url)), "../src/enrichment.ts"), "utf8");
  assert.doesNotMatch(src, /claude-opus-4-8/);
  assert.doesNotMatch(src, /ENRICHMENT_MODEL/);
});

test("empty model id fails the enrichment pass without producing docs", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    onProgress: note => notes.push(note),
    modelId: "",
  });
  await assert.rejects(() => enrich(packets()), /empty model id/);
  assert.equal(notes.length, 0);
});

test("configured model id appears in progress notes when the pass runs", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    modelId: "openai/gpt-4o-mini",
    onProgress: note => notes.push(note),
    generate: async () => ({ document: { ok: true } }),
  });
  await enrich(packets());
  assert.ok(notes.some(note => note.includes("model openai/gpt-4o-mini")));
  assert.ok(notes.every(note => !note.includes("claude-opus-4-8")));
});

test("total failure (e.g. bad credentials) throws instead of reporting empty success", async () => {
  const enrich = createEnricher({
    generate: async () => {
      throw new Error("Could not resolve authentication method.");
    },
  });
  await assert.rejects(
    () => enrich(packets()),
    /all 2 enrichment scope\(s\) failed — first error: Could not resolve authentication method\./,
  );
});

test("scan-level max scopes skips remaining scopes without throwing", async () => {
  const notes: string[] = [];
  const called: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxScopes: 1 },
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      return { document: { ok: id } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(called, ["system:acme"]);
  assert.deepEqual([...docs.keys()], ["system:acme"]);
  assert.ok(notes.some(note => note.includes("max scopes") && note.includes("skipping")));
  assert.ok(notes.every(note => !note.includes("okie-test-llm-key")));
});

test("scan-level max tokens skips remaining scopes after usage is reported", async () => {
  const called: string[] = [];
  const notes: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxTokens: 100 },
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      return { document: { ok: id }, usage: { totalTokens: 100 } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(called, ["system:acme"]);
  assert.deepEqual([...docs.keys()], ["system:acme"]);
  assert.ok(notes.some(note => note.includes("max tokens")));
});

test("scan-level max dollars applies only when the gateway reports cost", async () => {
  const withCost: string[] = [];
  const costEnrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxDollars: 0.5 },
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      withCost.push(id);
      return { document: { ok: id }, usage: { totalTokens: 10, costUsd: 0.5 } };
    },
  });
  const costDocs = await costEnrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(withCost, ["system:acme"]);
  assert.deepEqual([...costDocs.keys()], ["system:acme"]);

  const withoutCost: string[] = [];
  const noCostEnrich = createEnricher({
    maxConcurrent: 1,
    budget: { maxDollars: 0.01 },
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      withoutCost.push(id);
      return { document: { ok: id }, usage: { totalTokens: 10 } };
    },
  });
  const noCostDocs = await noCostEnrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(withoutCost.sort(), ["container:pkg-a", "container:pkg-b", "system:acme"]);
  assert.equal(noCostDocs.size, 3);
});

test("a per-request timeout omits that scope and continues the others", async () => {
  const notes: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 2,
    budget: { requestTimeoutMs: 40 },
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      if (kind === "container" && (packet as EnrichmentPacket).containerId === "container:pkg-a") {
        await new Promise(() => {});
      }
      return { document: { ok: true } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.equal(docs.has("container:pkg-a"), false);
  assert.equal(docs.has("container:pkg-b"), true);
  assert.equal(docs.has("system:acme"), true);
  assert.ok(notes.some(note => note.includes("container:pkg-a") && note.includes("timeout")));
});

test("gateway 429 skips remaining scopes and throws so the job can record enrichment failed", async () => {
  const called: string[] = [];
  const notes: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    onProgress: note => notes.push(note),
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      if (id === "container:pkg-b") {
        throw new LlmGatewayError("llm gateway 429: too many requests", { kind: "rate_limit", status: 429 });
      }
      return { document: { ok: id } };
    },
  });
  await assert.rejects(
    () => enrich(packets({
      packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b"), containerPacket("container:pkg-c")],
    })),
    /enrichment failed \(llm gateway 429: too many requests\); remaining scopes skipped/,
  );
  assert.deepEqual(called, ["system:acme", "container:pkg-a", "container:pkg-b"]);
  assert.ok(notes.some(note => note.includes("skipping") && note.includes("remaining")));
});

test("gateway 5xx skips remaining scopes and throws", async () => {
  const called: string[] = [];
  const enrich = createEnricher({
    maxConcurrent: 1,
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      if (id === "container:pkg-a") {
        throw new Error("llm gateway 503: unavailable");
      }
      return { document: { ok: id } };
    },
  });
  await assert.rejects(
    () => enrich(packets({
      packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
    })),
    /remaining scopes skipped/,
  );
  assert.deepEqual(called, ["system:acme", "container:pkg-a"]);
});

test("fake HTTP gateway: 429 skips remaining scopes and redacts the key", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const hits: number[] = [];
  const fake = await listenFakeGateway((request, response) => {
    hits.push(Date.now());
    if (request.url !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end("no");
      return;
    }
    if (hits.length === 1) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        choices: [{ message: { content: "{\"ok\":true}" } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.02 },
      }));
      return;
    }
    if (hits.length === 2) {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `rate limited ${fakeKey}` } }));
      return;
    }
    response.writeHead(500);
    response.end("should not be called");
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const notes: string[] = [];
    const enrich = createEnricher({
      maxConcurrent: 1,
      onProgress: note => notes.push(note),
      generate: async () => {
        const result = await client.chatCompletions({ messages: [{ role: "user", content: "packet" }] });
        return result.usage
          ? { document: result.json, usage: result.usage }
          : { document: result.json };
      },
    });
    await assert.rejects(
      () => enrich(packets({
        packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b"), containerPacket("container:pkg-c")],
      })),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.match(message, /llm gateway 429/);
        assert.match(message, /remaining scopes skipped/);
        assert.doesNotMatch(message, new RegExp(fakeKey));
        return true;
      },
    );
    assert.equal(hits.length, 2, "third scope must not hit the gateway after 429");
    assert.ok(notes.every(note => !note.includes(fakeKey)));
  } finally {
    await fake.close();
  }
});

const GATE_DOC = { schemaVersion: 1, entities: [], relations: [] };

function chatCompletionReply(document: unknown, usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) {
  return {
    choices: [{ message: { role: "assistant", content: JSON.stringify(document) } }],
    ...(usage ? { usage } : {}),
  };
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

test("chat-completions body is the bounded packet, not Anthropic Messages fields", () => {
  const packet = containerPacket("container:pkg-a");
  const body = enrichmentChatCompletionsBody("acme/fast", "container", "system:acme", packet);
  assert.equal(body.model, "acme/fast");
  assert.equal(typeof body.max_tokens, "number");
  assert.equal("thinking" in body, false);
  assert.equal("output_config" in body, false);
  assert.equal("system" in body, false);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0]!.role, "system");
  assert.match(messages[0]!.content, /architecture curator/);
  assert.equal(messages[1]!.role, "user");
  assert.equal(messages[1]!.content, packetUserMessage("container", "system:acme", packet));
  assert.match(messages[1]!.content, /"containerId": "container:pkg-a"/);
  assert.match(messages[1]!.content, /Envelope to fill:/);
  assert.match(messages[1]!.content, /"schemaVersion": 1/);
  assert.match(messages[1]!.content, /do not split this envelope across agents/);
  const skeleton = extractionEnvelopeSkeleton("container", "system:acme", packet);
  assert.equal(skeleton.schemaVersion, 1);
  assert.deepEqual(skeleton.relations, []);
  assert.ok(skeleton.entities.every(entity => Array.isArray(entity.sourceRefs)));
  assert.ok(skeleton.entities.every(entity => !("responsibility" in entity)));
  assert.ok(skeleton.entities.some(entity => entity.id === "container:pkg-a" && entity.kind === "container"));
  assert.ok(messages[1]!.content.includes(JSON.stringify(skeleton, null, 2)));
  const schema = (body.response_format as { json_schema: { schema: { properties: { entities: { items: { properties: { id: { enum?: string[] } } } } } } } }).json_schema.schema;
  assert.deepEqual(schema.properties.entities.items.properties.id.enum, skeleton.entities.map(entity => entity.id));
  assert.doesNotMatch(messages[1]!.content, /WHOLE_REPO_SENTINEL/);
  const format = body.response_format as { type: string; json_schema: { name: string; strict?: boolean } };
  assert.equal(format.type, "json_schema");
  assert.equal(format.json_schema.name, "architecture_extraction");
  assert.equal(format.json_schema.strict, true);
  const tools = body.tools as Array<{ type: string; function: { name: string; strict?: boolean } }>;
  assert.equal(tools[0]!.type, "function");
  assert.equal(tools[0]!.function.name, EXTRACTION_TOOL_NAME);
  assert.equal(tools[0]!.function.strict, true);
  const choice = body.tool_choice as { type: string; function: { name: string } };
  assert.equal(choice.type, "function");
  assert.equal(choice.function.name, EXTRACTION_TOOL_NAME);
  assert.throws(() => enrichmentChatCompletionsBody("  ", "system", "system:acme", systemPacket), /empty model id/);
});

test("v3 packets get the untested-behaviour addendum; v2 packets do not rewrite the frozen contract", () => {
  const v2 = containerPacket("container:pkg-a");
  const v2Body = enrichmentChatCompletionsBody("acme/fast", "container", "system:acme", v2);
  const v2System = (v2Body.messages as Array<{ content: string }>)[0]!.content;
  assert.doesNotMatch(v2System, /untestedBehaviours/);
  assert.doesNotMatch(v2System, /okie-enrichment\/v3/);

  const v3: EnrichmentPacket = {
    ...v2,
    promptVersion: "okie-enrichment/v3",
    code: [{
      id: "code:a-0",
      name: "symbol0",
      path: "src/a.ts",
      componentId: "component:container:pkg-a",
      untestedRanges: [{ startLine: 4, endLine: 6 }],
      nearbyTests: [{ path: "src/a.test.ts", startLine: 1, endLine: 2, lines: ["tangled"] }],
    }],
  };
  const v3Body = enrichmentChatCompletionsBody("acme/fast", "container", "system:acme", v3);
  const v3System = (v3Body.messages as Array<{ content: string }>)[0]!.content;
  assert.match(v3System, /untestedBehaviours/);
  assert.match(v3System, /Do not author coverageFileHitRate/);
  const schema = (v3Body.response_format as { json_schema: { schema: { properties: { entities: { items: { properties: { id: { enum?: string[] }; untestedBehaviours?: unknown } } } } } } }).json_schema.schema;
  assert.ok(schema.properties.entities.items.properties.untestedBehaviours);
  assert.ok(schema.properties.entities.items.properties.id.enum?.includes("code:a-0"));
});

test("prompts ask for a short summary of this packet's scope only", () => {
  const container = enrichmentChatCompletionsBody("acme/fast", "container", "system:acme", containerPacket("container:pkg-a"));
  const system = enrichmentChatCompletionsBody("acme/fast", "system", "system:acme", systemPacket);
  const containerMessages = container.messages as Array<{ role: string; content: string }>;
  const systemMessages = system.messages as Array<{ role: string; content: string }>;
  assert.match(containerMessages[0]!.content, /short summary of THIS packet's scope only/);
  assert.match(containerMessages[0]!.content, /section summary, not a free-form dump/);
  assert.match(containerMessages[0]!.content, /"schemaVersion":1/);
  assert.match(containerMessages[0]!.content, /flat array of entity objects/);
  assert.match(containerMessages[0]!.content, /Do not nest softwareSystems, containers, components, or codeEntities/);
  assert.doesNotMatch(containerMessages[0]!.content, /Propose LOGICAL COMPONENTS that regroup/);
  assert.doesNotMatch(containerMessages[0]!.content, /Restate EVERY code entity/);
  assert.match(containerMessages[1]!.content, /Envelope to fill:/);
  assert.match(containerMessages[1]!.content, /"containerId": "container:pkg-a"/);
  assert.doesNotMatch(containerMessages[1]!.content, /WHOLE_REPO_SENTINEL/);
  assert.doesNotMatch(containerMessages[1]!.content, /okie-test-llm-key/);

  assert.match(systemMessages[0]!.content, /short summary of THIS packet's scope only/);
  assert.match(systemMessages[0]!.content, /"schemaVersion":1/);
  assert.match(systemMessages[0]!.content, /Do not nest softwareSystems, containers, components, or codeEntities/);
  assert.doesNotMatch(systemMessages[0]!.content, /Propose the TOP-LEVEL ACTORS/);
  assert.match(systemMessages[1]!.content, /Summarize THIS packet's scope only/);
  assert.match(systemMessages[1]!.content, /Envelope to fill:/);
  assert.match(systemMessages[1]!.content, /"systemId": "system:acme"/);
  assert.doesNotMatch(systemMessages[1]!.content, /WHOLE_REPO_SENTINEL/);
});

test("parseChatCompletionDocument reads JSON content the gate already consumes", () => {
  assert.deepEqual(parseChatCompletionDocument(chatCompletionReply(GATE_DOC)), GATE_DOC);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { content: [{ type: "text", text: JSON.stringify(GATE_DOC) }] } }],
  }), GATE_DOC);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { content: "```json\n" + JSON.stringify(GATE_DOC) + "\n```" } }],
  }), GATE_DOC);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { content: GATE_DOC } }],
  }), GATE_DOC);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{ message: { content: "Here is the document:\n```json\n" + JSON.stringify(GATE_DOC) + "\n```\n" } }],
  }), GATE_DOC);
  assert.throws(() => parseChatCompletionDocument({
    choices: [{ message: { parsed: GATE_DOC, content: "" } }],
  }), /missing message content/);
  assert.throws(() => parseChatCompletionDocument({
    choices: [{ message: { content: "Sure, here you go: " + JSON.stringify(GATE_DOC) } }],
  }), /not JSON/);
  assert.throws(() => parseChatCompletionDocument({ choices: [] }), /missing message content/);
  assert.throws(() => parseChatCompletionDocument({
    choices: [{ message: { content: "not-json" } }],
  }), /not JSON/);
  assert.deepEqual(parseChatCompletionDocument({
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          type: "function",
          function: { name: EXTRACTION_TOOL_NAME, arguments: JSON.stringify(GATE_DOC) },
        }],
      },
    }],
  }), GATE_DOC);
});

test("gateway adapter posts each packet to chat/completions and keys docs by container id", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const posted: Array<{ url: string; authorization: string | null; body: Record<string, unknown> }> = [];
  const fake = await listenFakeGateway(async (request, response) => {
    const raw = await readRequestBody(request);
    const authorization = typeof request.headers.authorization === "string"
      ? request.headers.authorization
      : null;
    posted.push({
      url: request.url ?? "",
      authorization,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    const user = ((posted.at(-1)!.body.messages as Array<{ role: string; content: string }>)
      .find(message => message.role === "user")?.content) ?? "";
    const id = user.includes("container:pkg-b")
      ? "container:pkg-b"
      : user.includes("System packet:")
        ? "system:acme"
        : "container:pkg-a";
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(
      { ...GATE_DOC, id },
      { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
    )));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const notes: string[] = [];
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
      onProgress: note => notes.push(note),
    });
    const docs = await enrich(packets({
      packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
    }));
    assert.deepEqual([...docs.keys()].sort(), ["container:pkg-a", "container:pkg-b", "system:acme"]);
    assert.deepEqual(docs.get("container:pkg-a"), { ...GATE_DOC, id: "container:pkg-a" });
    assert.deepEqual(docs.get("container:pkg-b"), { ...GATE_DOC, id: "container:pkg-b" });
    assert.deepEqual(docs.get("system:acme"), { ...GATE_DOC, id: "system:acme" });
    assert.equal(posted.length, 3);
    assert.ok(posted.every(call => call.url === "/v1/chat/completions"));
    assert.ok(posted.every(call => call.authorization === `Bearer ${fakeKey}`));
    assert.ok(posted.every(call => call.body.model === "acme/fast"));
    const firstUser = (posted[0]!.body.messages as Array<{ content: string }>)[1]!.content;
    assert.match(firstUser, /"systemId": "system:acme"/);
    assert.match(firstUser, /System packet:/);
    assert.doesNotMatch(firstUser, /container:pkg-b/);
    assert.doesNotMatch(firstUser, /WHOLE_REPO_SENTINEL/);
    const secondUser = (posted[1]!.body.messages as Array<{ content: string }>)[1]!.content;
    assert.match(secondUser, /"containerId": "container:pkg-a"/);
    assert.doesNotMatch(secondUser, /container:pkg-b/);
    const thirdUser = (posted[2]!.body.messages as Array<{ content: string }>)[1]!.content;
    assert.match(thirdUser, /"containerId": "container:pkg-b"/);
    assert.doesNotMatch(thirdUser, /container:pkg-a/);
    assert.ok(posted.every(call => !("thinking" in call.body)));
    assert.ok(notes.some(note => note.includes("llm gateway") && note.includes("acme/fast")));
    assert.ok(notes.every(note => !note.includes(fakeKey)));
  } finally {
    await fake.close();
  }
});

test("onUsage records fake-gateway usage onto a shared global spend ledger", async () => {
  const fakeKey = "okie-test-llm-key-cla38-fake";
  const spend = createGlobalEnrichmentSpend({ maxTokens: 10_000 });
  const fake = await listenFakeGateway((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(GATE_DOC, {
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
    })));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const notes: string[] = [];
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
      budget: clampEnrichmentBudget(resolveEnrichmentBudget({}), spend),
      onUsage: usage => spend.record(usage),
      onProgress: note => notes.push(note),
    });
    await enrich(packets());
    assert.ok(spend.snapshot().tokens >= 10);
    assert.equal(spend.isExhausted(), false);
    assert.ok(notes.every(note => !note.includes(fakeKey)));
  } finally {
    await fake.close();
  }
});

test("billed malformed gateway replies still count toward the global cap", async () => {
  const fakeKey = "okie-test-llm-key-cla38-fake";
  const spend = createGlobalEnrichmentSpend({ maxTokens: 80 });
  const hits: number[] = [];
  const fake = await listenFakeGateway((_request, response) => {
    hits.push(1);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "not-json {" } }],
      usage: { prompt_tokens: 70, completion_tokens: 10, total_tokens: 80, cost: 0.02 },
    }));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const notes: string[] = [];
    const enrich = createEnricher({
      modelId: "acme/fast",
      gateway: client,
      budget: clampEnrichmentBudget(resolveEnrichmentBudget({}), spend),
      onUsage: usage => spend.record(usage),
      budgetExhausted: () => spend.isExhausted(),
      onProgress: note => notes.push(note),
    });
    await assert.rejects(() => enrich(packets()), /enrichment scope\(s\) failed|not JSON/);
    assert.ok(spend.snapshot().tokens >= 80);
    assert.equal(spend.isExhausted(), true);
    assert.ok(hits.length >= 1);
    assert.ok(hits.length <= 2, "remaining scopes must stop once the global cap is billed");
    assert.ok(notes.every(note => !note.includes(fakeKey)));
    assert.ok(JSON.stringify(spend.snapshot()).includes(fakeKey) === false);
  } finally {
    await fake.close();
  }
});

test("onUsage serializes scopes so a global token cap cannot be double-spent", async () => {
  const spend = createGlobalEnrichmentSpend({ maxTokens: 100 });
  const called: string[] = [];
  const enrich = createEnricher({
    budget: { maxTokens: 10_000 },
    onUsage: usage => spend.record(usage),
    budgetExhausted: () => spend.isExhausted(),
    generate: async (packet, kind) => {
      const id = kind === "container"
        ? (packet as EnrichmentPacket).containerId
        : (packet as SystemPacket).systemId;
      called.push(id);
      return { document: { ok: id }, usage: { totalTokens: 100 } };
    },
  });
  const docs = await enrich(packets({
    packets: [containerPacket("container:pkg-a"), containerPacket("container:pkg-b")],
  }));
  assert.deepEqual(called, ["system:acme"]);
  assert.deepEqual([...docs.keys()], ["system:acme"]);
  assert.equal(spend.snapshot().tokens, 100);
  assert.equal(spend.isExhausted(), true);
});

test("default enricher factory drives packets through chatCompletions on a fake gateway", async () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const posted: string[] = [];
  const fake = await listenFakeGateway(async (request, response) => {
    posted.push(await readRequestBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(GATE_DOC)));
  });
  try {
    const hook = createDefaultEnricherFactory("auto", {
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    })(() => {});
    assert.ok(hook);
    const docs = await hook(packets());
    assert.deepEqual([...docs.keys()].sort(), ["container:pkg-a", "system:acme"]);
    assert.deepEqual(docs.get("container:pkg-a"), GATE_DOC);
    assert.equal(posted.length, 2);
    const userMessages = posted.map(raw => {
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      return body.messages.find(message => message.role === "user")?.content ?? "";
    });
    assert.ok(userMessages.some(content => /"containerId": "container:pkg-a"/.test(content)));
    assert.ok(userMessages.some(content => /"systemId": "system:acme"/.test(content)));
    assert.ok(posted.every(body => !body.includes(fakeKey)));
    assert.ok(posted.every(body => !body.includes("WHOLE_REPO_SENTINEL")));
  } finally {
    await fake.close();
  }
});

test("CLA-606: the anthropic provider passes OKIE_LLM_API_KEY and its base URL explicitly; ANTHROPIC_* env is never read", async () => {
  const optedKey = "okie-test-cla606-anthropic-opted-fake";
  const sniffed = { ANTHROPIC_API_KEY: "okie-test-cla606-sniffed-key-fake", ANTHROPIC_AUTH_TOKEN: "okie-test-cla606-sniffed-token-fake", ANTHROPIC_BASE_URL: "http://127.0.0.1:9/never" };
  const seen: Array<{ url: string; apiKey: string | undefined; authorization: string | undefined }> = [];
  const fake = await listenFakeGateway((request, response) => {
    seen.push({ url: request.url ?? "", apiKey: request.headers["x-api-key"] as string | undefined, authorization: request.headers.authorization });
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fake" } }));
  });
  const saved = Object.fromEntries(Object.keys(sniffed).map(name => [name, process.env[name]]));
  Object.assign(process.env, sniffed); // the SDK reads process.env itself when not given explicit values
  try {
    const hook = createDefaultEnricherFactory("auto", {
      OKIE_LLM_PROVIDER: "anthropic",
      OKIE_LLM_BASE_URL: fake.baseUrl.replace(/\/v1$/, ""),
      OKIE_LLM_API_KEY: optedKey,
      OKIE_LLM_MODEL: "claude-test",
      ...sniffed,
    })(() => {});
    assert.ok(hook);
    await hook(packets()).catch(() => undefined);
    assert.ok(seen.length > 0, "requests went to the configured base URL, not ANTHROPIC_BASE_URL");
    for (const request of seen) {
      assert.match(request.url, /^\/v1\/messages/);
      assert.equal(request.apiKey, optedKey);
      assert.equal(request.authorization, undefined, "ANTHROPIC_AUTH_TOKEN must not be added");
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    await fake.close();
  }
});

test("CLA-606: ANTHROPIC_CUSTOM_HEADERS cannot add or override credentials or headers on the anthropic provider", async () => {
  const optedKey = "okie-test-cla606-anthropic-opted-fake";
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const fake = await listenFakeGateway((request, response) => {
    seen.push(request.headers);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fake" } }));
  });
  const saved = process.env.ANTHROPIC_CUSTOM_HEADERS;
  // The SDK reads this from process.env in its constructor and merges it after the auth headers.
  process.env.ANTHROPIC_CUSTOM_HEADERS = "x-api-key: okie-test-cla606-header-key-fake\nAuthorization: Bearer okie-test-cla606-header-token-fake\nX-Okie-Leak: yes";
  try {
    const hook = createDefaultEnricherFactory("auto", {
      OKIE_LLM_PROVIDER: "anthropic",
      OKIE_LLM_BASE_URL: fake.baseUrl.replace(/\/v1$/, ""),
      OKIE_LLM_API_KEY: optedKey,
      OKIE_LLM_MODEL: "claude-test",
    })(() => {});
    assert.ok(hook);
    await hook(packets()).catch(() => undefined);
    assert.ok(seen.length > 0);
    for (const headers of seen) {
      assert.equal(headers["x-api-key"], optedKey);
      assert.equal(headers.authorization, undefined);
      assert.equal(headers["x-okie-leak"], undefined);
    }
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS; else process.env.ANTHROPIC_CUSTOM_HEADERS = saved;
    await fake.close();
  }
});

test("CLA-606 review 2: env custom headers that collide with SDK defaults never reach the request; SDK defaults survive", async () => {
  const optedKey = "okie-test-cla606-anthropic-opted-fake";
  const seen: Array<Record<string, string | string[] | undefined>> = [];
  const fake = await listenFakeGateway((request, response) => {
    seen.push(request.headers);
    response.writeHead(400, { "content-type": "application/json" });
    response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fake" } }));
  });
  const saved = process.env.ANTHROPIC_CUSTOM_HEADERS;
  process.env.ANTHROPIC_CUSTOM_HEADERS = "Anthropic-Version: 1999-01-01\ncontent-type: text/plain\nX-Okie-Leak: yes";
  try {
    const hook = createDefaultEnricherFactory("auto", { OKIE_LLM_PROVIDER: "anthropic", OKIE_LLM_BASE_URL: fake.baseUrl.replace(/\/v1$/, ""), OKIE_LLM_API_KEY: optedKey, OKIE_LLM_MODEL: "claude-test" })(() => {});
    assert.ok(hook);
    await hook(packets()).catch(() => undefined);
    assert.ok(seen.length > 0);
    for (const headers of seen) {
      assert.equal(headers["anthropic-version"], "2023-06-01");
      assert.equal(headers["content-type"], "application/json");
      assert.equal(headers["x-okie-leak"], undefined);
      assert.equal(headers["x-api-key"], optedKey);
    }
    assert.equal(process.env.ANTHROPIC_CUSTOM_HEADERS, "Anthropic-Version: 1999-01-01\ncontent-type: text/plain\nX-Okie-Leak: yes", "the env itself is left as it was");
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_CUSTOM_HEADERS; else process.env.ANTHROPIC_CUSTOM_HEADERS = saved;
    await fake.close();
  }
});

test("CLA-606 review 2: ANTHROPIC_LOG cannot make the SDK log the key, URL or packets", async () => {
  const optedKey = "okie-test-cla606-anthropic-logged-fake";
  const fake = await listenFakeGateway((_request, response) => {
    response.writeHead(400, { "content-type": "text/plain" });
    response.end(`bad key ${optedKey}`);
  });
  const saved = process.env.ANTHROPIC_LOG;
  process.env.ANTHROPIC_LOG = "debug";
  const methods = ["debug", "info", "warn", "error", "log"] as const;
  const originals = methods.map(name => console[name]);
  const logged: string[] = [];
  for (const name of methods) console[name] = (...args: unknown[]) => { logged.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); };
  try {
    const baseUrl = fake.baseUrl.replace(/\/v1$/, "");
    const hook = createDefaultEnricherFactory("auto", { OKIE_LLM_PROVIDER: "anthropic", OKIE_LLM_BASE_URL: baseUrl, OKIE_LLM_API_KEY: optedKey, OKIE_LLM_MODEL: "claude-test" })(() => {});
    assert.ok(hook);
    await hook(packets()).catch(() => undefined);
    const text = logged.join("\n");
    assert.ok(!text.includes(optedKey), "the key reached console");
    assert.ok(!text.includes(baseUrl), "the base URL reached console");
    assert.ok(!text.includes("container:pkg-a"), "packet content reached console");
  } finally {
    methods.forEach((name, index) => { console[name] = originals[index]!; });
    if (saved === undefined) delete process.env.ANTHROPIC_LOG; else process.env.ANTHROPIC_LOG = saved;
    await fake.close();
  }
});

test("a planted secret in source does not appear in the outbound chatCompletions JSON body", async () => {
  const planted = "gho_okieTestPlantedSecretCla25xxxx";
  const fakeKey = "okie-test-llm-key-cla25-fake";
  const sourceFiles: Record<string, string> = {
    "README.md": `# Acme\n`,
    "src/index.ts": `export const ping = () => "pong";\nconst planted = "${planted}";\n`,
  };
  const read = (path: string): string => {
    const text = sourceFiles[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const extraction = extractArchitecture({
    discovery: {
      sourceFiles: ["src/index.ts"],
      units: [{ kind: "root", dir: "", name: "acme-app", packageName: "acme-app", packageManifest: "package.json", evidencePath: "package.json" }],
      unitByFile: new Map([["src/index.ts", ""]]),
      unitByPackageName: new Map([["acme-app", ""]]),
      summary: { singlePackage: true, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
    },
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  const emitted = buildEnrichmentPackets(extraction, read);
  assert.ok(emitted.packets.length > 0);

  const leakedPacket = containerPacket("container:pkg-a");
  leakedPacket.excerpts = [{
    path: "src/a.ts",
    startLine: 1,
    endLine: 2,
    lines: [`export const ping = () => "pong";`, `const token = "${planted}";`],
  }];

  const posted: string[] = [];
  const fake = await listenFakeGateway(async (request, response) => {
    posted.push(await readRequestBody(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(GATE_DOC)));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
    });
    await enrich(packets({
      packets: [...emitted.packets, leakedPacket],
      ...(emitted.systemPacket ? { systemPacket: emitted.systemPacket } : {}),
    }));
    assert.ok(posted.length > 0, "gateway must receive at least one chatCompletions POST");
    for (const body of posted) {
      assert.equal(body.includes(planted), false, "planted source secret must not appear in outbound JSON");
      assert.equal(body.includes(fakeKey), false, "operator key must not appear in outbound JSON");
      assert.equal(body.includes("WHOLE_REPO_SENTINEL"), false);
    }
    assert.ok(posted.some(body => body.includes("[redacted-token]")));
    assert.ok(posted.some(body => body.includes("container:pkg-a")));
    const raw = JSON.stringify(leakedPacket);
    assert.equal(raw.includes(planted), true, "fixture packet still contains the planted secret before the gateway path");
  } finally {
    await fake.close();
  }
});

function acmeExtraction() {
  const files: Record<string, string> = {
    "README.md": "# Acme\n",
    "pkg/a/package.json": `${JSON.stringify({ name: "@acme/a" }, null, 2)}\n`,
    "pkg/a/src/index.ts": "export function alpha() { return 1; }\n",
  };
  const read = (path: string): string => {
    const text = files[path];
    if (text === undefined) throw new Error(`missing ${path}`);
    return text;
  };
  const extraction = extractArchitecture({
    discovery: {
      sourceFiles: ["pkg/a/src/index.ts"],
      units: [{ kind: "member", dir: "pkg/a", name: "@acme/a", packageName: "@acme/a", evidencePath: "pkg/a", packageManifest: "pkg/a/package.json" }],
      unitByFile: new Map([["pkg/a/src/index.ts", "pkg/a"]]),
      unitByPackageName: new Map([["@acme/a", "pkg/a"]]),
      summary: { singlePackage: false, includedJs: false, skippedJsFiles: 0, skippedMembers: [] },
    },
    readFile: read,
    systemName: "Acme",
    systemSlug: "acme",
  });
  return { extraction, read };
}

function cla70NestedDump(
  packet: EnrichmentPacket,
  systemId: string,
  systemName: string,
): Record<string, unknown> {
  return {
    softwareSystems: [{ id: systemId, name: systemName, responsibility: "Demo system." }],
    containers: [{
      id: packet.containerId,
      parentId: systemId,
      name: packet.containerName,
      responsibility: `Summary of ${packet.containerName}.`,
      sourceRefs: packet.scopePaths[0] ?? "pkg/a/src/index.ts",
    }],
    components: packet.components.map(component => ({
      id: component.id,
      parentId: packet.containerId,
      name: component.name,
      responsibility: `Summary of ${component.name}.`,
      sourceRefs: { path: component.path },
    })),
    codeEntities: [],
  };
}

function systemEnvelope(systemId: string, systemName: string, packet: EnrichmentPacket): ExtractionDoc {
  return {
    schemaVersion: 1,
    entities: [
      { id: systemId, kind: "softwareSystem", name: systemName, responsibility: "Demo system.", sourceRefs: [] },
      {
        id: packet.containerId, kind: "container", parentId: systemId, name: packet.containerName,
        responsibility: `Summary of ${packet.containerName}.`,
        sourceRefs: [],
      },
    ] as unknown as ExtractionDoc["entities"],
    relations: [],
  };
}

test("parseChatCompletionDocument does not flatten a nested CLA-70 dump", () => {
  const nested = {
    softwareSystems: [{ id: "system:okie", name: "okie", responsibility: "Spatial atlas." }],
    containers: [{
      id: "container:apps-server",
      parentId: "system:okie",
      name: "@okie/server",
      responsibility: "Hosted scan HTTP.",
      sourceRefs: "apps/server/src/main.ts",
    }],
    codeEntities: [{ id: "code:apps-server-src-main-ts:main", name: "main" }],
  };
  const parsed = parseChatCompletionDocument(chatCompletionReply(nested)) as Record<string, unknown>;
  assert.equal("schemaVersion" in parsed, false);
  assert.equal("entities" in parsed, false);
  assert.ok(Array.isArray(parsed.softwareSystems));
  assert.ok(Array.isArray(parsed.containers));
  assert.ok(Array.isArray(parsed.codeEntities));
  assert.deepEqual(parsed, nested);
});

test("packet skeleton is not applied to a nested CLA-70 dump", () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const nested = cla70NestedDump(packet, system.id, system.name);
  const parsed = parseChatCompletionDocument(chatCompletionReply(nested)) as Record<string, unknown>;
  const skeleton = extractionEnvelopeSkeleton("container", system.id, packet);
  assert.notDeepEqual(parsed, skeleton);
  assert.equal(looksLikeExtractionEnvelope(parsed), false);
  assert.equal(looksLikeExtractionEnvelope(skeleton), true);
  const { report, extraction: merged } = mergeEnrichment(extraction, new Map([[packet.containerId, parsed]]));
  assert.equal(report.results.find(item => item.containerId === packet.containerId)?.accepted, false);
  assert.equal(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility, undefined);
});

test("nested CLA-70 dump is still rejected; that scope stays deterministic", () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const nested = cla70NestedDump(packet, system.id, system.name);
  const parsed = parseChatCompletionDocument(chatCompletionReply(nested));
  const { report, extraction: merged } = mergeEnrichment(extraction, new Map([[packet.containerId, parsed]]));
  const result = report.results.find(item => item.containerId === packet.containerId);
  assert.equal(result?.accepted, false, result?.reasons.join("; "));
  assert.ok(result?.reasons.some(reason => /schemaVersion|entities/.test(reason)));
  assert.equal(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility, undefined);
});

test("true flat envelope with existing ids is still accepted", () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const envelope = summaryFromPacket(packet, system.id, system.name);
  const parsed = parseChatCompletionDocument(chatCompletionReply(envelope));
  assert.deepEqual(parsed, envelope);
  const { report, extraction: merged } = mergeEnrichment(extraction, new Map([[packet.containerId, parsed]]));
  const result = report.results.find(item => item.containerId === packet.containerId);
  assert.equal(result?.accepted, true, result?.reasons.join("; "));
  const container = merged.entities.find(entity => entity.id === packet.containerId);
  assert.ok(container?.responsibility);
  assert.notEqual(container?.responsibility, "");
});

test("invented ids are still rejected", () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const envelope = summaryFromPacket(packet, system.id, system.name, [{
    id: "code:ghost:nope",
    kind: "code",
    parentId: packet.components[0]!.id,
    name: "nope",
    sourceRefs: [{ path: packet.scopePaths[0] ?? "pkg/a/src/index.ts" }],
    responsibility: "Hallucinated.",
  }]);
  const parsed = parseChatCompletionDocument(chatCompletionReply(envelope));
  const { report, extraction: merged } = mergeEnrichment(extraction, new Map([[packet.containerId, parsed]]));
  assert.equal(report.results.find(item => item.containerId === packet.containerId)?.accepted, false);
  assert.equal(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility, undefined);
  assert.ok(!merged.entities.some(entity => entity.id === "code:ghost:nope"));
});

test("fake HTTP gateway nested C4 dump is rejected by the merge gate", async () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const fakeKey = "okie-test-llm-key-cla70-fake";
  const fake = await listenFakeGateway(async (request, response) => {
    const raw = await readRequestBody(request);
    const user = ((JSON.parse(raw) as { messages: Array<{ role: string; content: string }> })
      .messages.find(message => message.role === "user")?.content) ?? "";
    const document = user.includes("System packet:")
      ? {
        softwareSystem: {
          id: system.id,
          name: system.name,
          responsibility: "Demo system.",
          containers: [{
            id: packet.containerId,
            name: packet.containerName,
            responsibility: `Summary of ${packet.containerName}.`,
            sourceRefs: [],
          }],
        },
      }
      : cla70NestedDump(packet, system.id, system.name);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(document)));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
    });
    const docs = await enrich(emitted);
    const { report, extraction: merged } = mergeEnrichment(extraction, docs);
    const container = report.results.find(item => item.containerId === packet.containerId);
    assert.equal(container?.accepted, false, container?.reasons.join("; "));
    assert.equal(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility, undefined);
    assert.equal(report.systemScope?.accepted, false);
  } finally {
    await fake.close();
  }
});

test("fake HTTP gateway flat envelope is accepted by the merge gate", async () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const fakeKey = "okie-test-llm-key-cla70-fake";
  const fake = await listenFakeGateway(async (request, response) => {
    const raw = await readRequestBody(request);
    const user = ((JSON.parse(raw) as { messages: Array<{ role: string; content: string }> })
      .messages.find(message => message.role === "user")?.content) ?? "";
    const document = user.includes("System packet:")
      ? systemEnvelope(system.id, system.name, packet)
      : summaryFromPacket(packet, system.id, system.name);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(document)));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
    });
    const docs = await enrich(emitted);
    const { report, extraction: merged } = mergeEnrichment(extraction, docs);
    const container = report.results.find(item => item.containerId === packet.containerId);
    assert.equal(container?.accepted, true, container?.reasons.join("; "));
    assert.ok(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility);
    assert.equal(report.systemScope?.accepted, true, report.systemScope?.reasons.join("; "));
  } finally {
    await fake.close();
  }
});

test("looksLikeExtractionEnvelope is the gate envelope, not a nested dump", () => {
  assert.equal(looksLikeExtractionEnvelope(GATE_DOC), true);
  assert.equal(looksLikeExtractionEnvelope({
    softwareSystems: [{ id: "system:okie", name: "okie" }],
    containers: [{ id: "container:apps-server", sourceRefs: "apps/server/src/main.ts" }],
  }), false);
  assert.equal(looksLikeExtractionEnvelope({
    schemaVersion: 1,
    entities: [{
      id: "system:okie", kind: "softwareSystem", name: "okie", sourceRefs: "README.md",
    }],
    relations: [],
  }), false);
  assert.equal(looksLikeExtractionEnvelope({
    schemaVersion: 1,
    entities: [{
      id: "code:ghost:nope", kind: "code", name: "nope", parentId: "component:x", sourceRefs: [],
    }],
    relations: [],
  }), true);
});

test("a nested first reply is retried once as the envelope; it is not coerced", async () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const fakeKey = "okie-test-llm-key-cla70-fake";
  const posted: Array<{ userCount: number; hasTool: boolean; strict: boolean | undefined; retryHasSkeleton: boolean }> = [];
  const fake = await listenFakeGateway(async (request, response) => {
    const raw = await readRequestBody(request);
    const body = JSON.parse(raw) as {
      messages: Array<{ role: string; content: string }>;
      tools?: unknown;
      response_format?: { json_schema?: { strict?: boolean } };
    };
    const userCount = body.messages.filter(message => message.role === "user").length;
    const retryUser = body.messages.filter(message => message.role === "user").at(-1)?.content ?? "";
    posted.push({
      userCount,
      hasTool: JSON.stringify(body.tools ?? []).includes(EXTRACTION_TOOL_NAME),
      strict: body.response_format?.json_schema?.strict,
      retryHasSkeleton: userCount > 1 && retryUser.includes("Envelope to fill:") && retryUser.includes('"schemaVersion":1'),
    });
    const isSystem = body.messages.some(message => message.role === "user" && message.content.includes("System packet:"));
    const retry = userCount > 1;
    const document = retry
      ? (isSystem ? systemEnvelope(system.id, system.name, packet) : summaryFromPacket(packet, system.id, system.name))
      : cla70NestedDump(packet, system.id, system.name);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(document)));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
    });
    const docs = await enrich(emitted);
    const { report, extraction: merged } = mergeEnrichment(extraction, docs);
    const container = report.results.find(item => item.containerId === packet.containerId);
    assert.equal(container?.accepted, true, container?.reasons.join("; "));
    assert.ok(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility);
    assert.ok(posted.some(call => call.userCount === 1));
    assert.ok(posted.some(call => call.userCount > 1));
    assert.ok(posted.every(call => call.hasTool));
    assert.ok(posted.every(call => call.strict === true));
    assert.ok(posted.some(call => call.retryHasSkeleton));
  } finally {
    await fake.close();
  }
});

test("a nested dump that stays nested after one retry is still rejected", async () => {
  const { extraction, read } = acmeExtraction();
  const emitted = buildEnrichmentPackets(extraction, read);
  const packet = emitted.packets.find(item => item.containerId === "container:pkg-a");
  assert.ok(packet);
  const system = extraction.entities.find(entity => entity.kind === "softwareSystem")!;
  const fakeKey = "okie-test-llm-key-cla70-fake";
  let posts = 0;
  const fake = await listenFakeGateway(async (request, response) => {
    posts += 1;
    const raw = await readRequestBody(request);
    const user = ((JSON.parse(raw) as { messages: Array<{ role: string; content: string }> })
      .messages.find(message => message.role === "user")?.content) ?? "";
    const document = user.includes("System packet:")
      ? { softwareSystem: { id: system.id, name: system.name } }
      : cla70NestedDump(packet, system.id, system.name);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatCompletionReply(document)));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: fakeKey,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const enrich = createEnricher({
      maxConcurrent: 1,
      modelId: "acme/fast",
      gateway: client,
    });
    const docs = await enrich(emitted);
    const { report, extraction: merged } = mergeEnrichment(extraction, docs);
    assert.equal(report.results.find(item => item.containerId === packet.containerId)?.accepted, false);
    assert.equal(merged.entities.find(entity => entity.id === packet.containerId)?.responsibility, undefined);
    assert.ok(posts >= 4, "container + system each retry once");
  } finally {
    await fake.close();
  }
});
