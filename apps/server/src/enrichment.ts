import Anthropic from "@anthropic-ai/sdk";
import { scrubGithubTokens, type EmittedPackets, type EnrichmentPacket, type SystemPacket, ENRICHMENT_PROMPT_VERSION_V3 } from "@okie/scan";
import {
  DEFAULT_MAX_ENRICHMENT_DOLLARS,
  DEFAULT_MAX_ENRICHMENT_SCOPES,
  DEFAULT_MAX_ENRICHMENT_TOKENS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  isUsableModelId,
  requireUsableModelId,
  safeGatewayProvider,
  shouldSkipRemainingScopes,
  withDeadline,
  type EnrichmentBudget,
  type GatewayUsage,
  type LlmChatCompletionResult,
} from "./llmGateway.js";

/**
 * Live-LLM enrichment adapter (scan-runner M3): turns the scanner's bounded,
 * redacted packets into gate-shaped section summaries. The adapter is
 * deliberately dumb about correctness — every document it returns still goes
 * through `mergeEnrichment`'s atomic per-document gate, so a hallucinated id or an
 * out-of-scope entity rejects THAT document and the deterministic base publishes
 * for the rejected chunk. Remainder packets for the same container are grouped
 * into an array (OSS `--enrich-from` shape); a bad remainder does not drop an
 * accepted sibling. Resilience contract (see GithubScanOptions.enrichWithPackets): a
 * per-scope failure omits that scope's doc; a total failure returns an empty map.
 */

/**
 * Per-packet skip: a chunk with more code entities than this is left
 * deterministic (remainder chunks for the same container can still be asked).
 * 500 covers THISS/okie `@okie/web` chunk 1 (474) so the overview-tour
 * container is not skipped solely for 474 > 400. Not the 2000 hang-guard.
 */
export const MAX_ENRICHABLE_CODE_ENTITIES = 500;

const MAX_OUTPUT_TOKENS = 64_000;

export type PacketKind = "container" | "system";

/** One scope's proposal: the document the gate consumes, plus optional gateway usage. */
export interface EnrichmentProposal {
  document: unknown;
  usage?: GatewayUsage;
}

/** The one seam that touches the network: packet in, parsed JSON document out. */
export type EnrichmentGenerator = (
  packet: EnrichmentPacket | SystemPacket,
  kind: PacketKind,
  /** The base system id every document must restate (the merge gate's anchor). */
  systemId: string,
) => Promise<EnrichmentProposal>;

/** OpenAI-compatible gateway seam. `chatCompletions` is what packet HTTP uses (CLA-23). */
export interface EnrichmentGateway {
  baseUrl: string;
  modelId: string;
  chatCompletions?: (body: Record<string, unknown>) => Promise<LlmChatCompletionResult>;
}

export interface EnricherOptions {
  /** Injectable generator (tests). Default: gateway `chatCompletions`, else `anthropic`, else the pass fails. */
  generate?: EnrichmentGenerator;
  /**
   * Operator-configured model id (CLA-21). Opaque string the gateway understands.
   * Empty fails the pass. Packet HTTP uses this id rather than a hardcoded model table.
   */
  modelId?: string;
  /**
   * OpenAI-compatible gateway (CLA-20/23). When `chatCompletions` is present, packets
   * POST there.
   */
  gateway?: EnrichmentGateway;
  /**
   * The `anthropic` provider (CLA-606): key and base URL are passed to the SDK explicitly, so it never
   * reads ANTHROPIC_* env vars or a local profile. Without this (or a gateway) the pass fails, never egresses.
   */
  anthropic?: { apiKey: string; baseUrl: string };
  /** Per-request timeout + scan-level caps (CLA-22). Defaults are the documented constants. */
  budget?: Partial<EnrichmentBudget>;
  /**
   * Called after each scope that reports usage — including billed replies whose
   * content later fails to parse — so a process-wide ceiling (CLA-38) cannot be
   * bypassed by malformed responses. Presence of this hook serializes scopes
   * (maxConcurrent defaults to 1) so concurrent in-flight calls cannot double-spend
   * the remaining global headroom.
   */
  onUsage?: (usage: GatewayUsage) => void;
  /** Extra stop condition (CLA-38 global ledger already exhausted). */
  budgetExhausted?: () => boolean;
  /** Concurrent in-flight scopes (default 2 — bounded, order-independent by design). */
  maxConcurrent?: number;
  onProgress?: (note: string) => void;
}

function resolveBudget(partial?: Partial<EnrichmentBudget>): EnrichmentBudget {
  return {
    requestTimeoutMs: partial?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxScopes: partial?.maxScopes ?? DEFAULT_MAX_ENRICHMENT_SCOPES,
    maxTokens: partial?.maxTokens ?? DEFAULT_MAX_ENRICHMENT_TOKENS,
    maxDollars: partial?.maxDollars ?? DEFAULT_MAX_ENRICHMENT_DOLLARS,
  };
}

function addDollars(left: number, right: number): number {
  return Math.round((left + right) * 1e6) / 1e6;
}

/** Model id the pass will send. Gateway overlay wins only when `modelId` is unset. */
export function resolveEnrichmentPassModelId(options: EnricherOptions): string | undefined {
  const configured = options.modelId ?? options.gateway?.modelId;
  return isUsableModelId(configured) ? configured!.trim() : undefined;
}

const ENTITY_KIND_ENUM = [
  "softwareSystem",
  "container",
  "component",
  "code",
  "person",
  "externalSystem",
  "dataStore",
  "queue",
] as const;

export const EXTRACTION_TOOL_NAME = "submit_architecture_extraction";

const SOURCE_REF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["path"],
  properties: {
    path: { type: "string" },
    symbol: { type: "string" },
    startLine: { type: "integer" },
    endLine: { type: "integer" },
  },
} as const;

const ENTITY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "kind", "name", "sourceRefs"],
  properties: {
    id: { type: "string" },
    kind: { enum: [...ENTITY_KIND_ENUM] },
    parentId: { type: "string" },
    name: { type: "string" },
    responsibility: { type: "string" },
    technology: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } },
    untestedBehaviours: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["startLine", "endLine", "behaviour"],
        properties: {
          startLine: { type: "integer" },
          endLine: { type: "integer" },
          behaviour: { type: "string" },
        },
      },
    },
    sourceRefs: {
      type: "array",
      description: "Always an array of {path, symbol?, startLine?, endLine?} objects, never a string.",
      items: SOURCE_REF_SCHEMA,
    },
  },
} as const;

const RELATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["id", "from", "to", "kind", "evidence"],
  properties: {
    id: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    kind: { enum: ["uses", "calls", "reads", "writes", "publishes", "subscribes", "dependsOn"] },
    label: { type: "string" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["source"],
        properties: { source: SOURCE_REF_SCHEMA, reason: { type: "string" } },
      },
    },
  },
} as const;

type EnvelopeEntity = {
  id: string;
  kind: typeof ENTITY_KIND_ENUM[number];
  name: string;
  parentId?: string;
  sourceRefs: Array<{ path: string; symbol?: string; startLine?: number; endLine?: number }>;
};

export type ExtractionEnvelopeSkeleton = {
  schemaVersion: 1;
  entities: EnvelopeEntity[];
  relations: [];
};

function isSystemPacket(packet: EnrichmentPacket | SystemPacket): packet is SystemPacket {
  return (packet as SystemPacket).scope === "system";
}

/**
 * Packet-derived gate envelope with ids / kinds / names / sourceRefs already filled.
 * `responsibility` is omitted so the model must write it. Copied from the packet —
 * never minted. Not applied to a nested dump: the model still has to return this shape.
 */
export function extractionEnvelopeSkeleton(
  kind: PacketKind,
  systemId: string,
  packet: EnrichmentPacket | SystemPacket,
): ExtractionEnvelopeSkeleton {
  if (kind === "system" || isSystemPacket(packet)) {
    const scope = packet as SystemPacket;
    return {
      schemaVersion: 1,
      entities: [
        { id: scope.systemId, kind: "softwareSystem", name: scope.systemName, sourceRefs: [] },
        ...scope.containers.map(container => ({
          id: container.id,
          kind: "container" as const,
          name: container.name,
          parentId: scope.systemId,
          sourceRefs: [],
        })),
      ],
      relations: [],
    };
  }
  const scope = packet as EnrichmentPacket;
  return {
    schemaVersion: 1,
    entities: [
      { id: systemId, kind: "softwareSystem", name: systemId, sourceRefs: [] },
      {
        id: scope.containerId,
        kind: "container",
        name: scope.containerName,
        parentId: systemId,
        sourceRefs: [],
      },
      ...scope.components.map(component => ({
        id: component.id,
        kind: "component" as const,
        name: component.name,
        parentId: scope.containerId,
        sourceRefs: [],
      })),
    ],
    relations: [],
  };
}

function allowedEntityIds(kind: PacketKind, systemId: string, packet: EnrichmentPacket | SystemPacket): string[] {
  const ids = extractionEnvelopeSkeleton(kind, systemId, packet).entities.map(entity => entity.id);
  if (kind === "container" && !isSystemPacket(packet) && packet.promptVersion === ENRICHMENT_PROMPT_VERSION_V3) {
    for (const code of packet.code) {
      if (code.untestedRanges?.length && !ids.includes(code.id)) ids.push(code.id);
    }
  }
  return ids;
}

function extractionDocSchemaForPacket(
  kind: PacketKind,
  systemId: string,
  packet: EnrichmentPacket | SystemPacket,
): Record<string, unknown> {
  const ids = allowedEntityIds(kind, systemId, packet);
  return {
    type: "object",
    additionalProperties: false,
    required: ["schemaVersion", "entities", "relations"],
    properties: {
      schemaVersion: { type: "integer", enum: [1], description: "Must be the integer 1." },
      entities: {
        type: "array",
        description: "Flat array of entity objects. Do not nest softwareSystems, containers, components, or codeEntities.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "kind", "name", "sourceRefs"],
          properties: {
            ...ENTITY_SCHEMA.properties,
            id: { type: "string", enum: ids },
          },
        },
      },
      relations: { type: "array", items: RELATION_SCHEMA },
    },
  };
}

function envelopeRetryUserMessage(skeleton: ExtractionEnvelopeSkeleton): string {
  return `That reply was not the required JSON envelope. Call ${EXTRACTION_TOOL_NAME} with this document, filling each entity's responsibility. Copy id, kind, name, parentId, and sourceRefs unchanged. sourceRefs must stay arrays of {path} objects, never a string. Do not nest softwareSystems, containers, components, or codeEntities.\n\nEnvelope to fill:\n${JSON.stringify(skeleton)}`;
}

const CONTAINER_SYSTEM_PROMPT = `You are an architecture curator for a C4 atlas built from a deterministic repository scan.
Write a short summary of THIS packet's scope only. Do not reason about any other container, file, or repository.

You receive one JSON "enrichment packet" for a single container: its scanner-scoped file-components, its code entities, the import relations that touch it, and capped file headers. Return ONE JSON ArchitectureExtraction document — a section summary, not a free-form dump. Documents violating any rule are rejected whole:

1. Restate exactly one softwareSystem entity: the id given as the packet's system anchor (see user message), name unchanged, no parentId.
2. Restate exactly one container entity: the packet's containerId, parented to the system id, name unchanged. Give it a one-sentence "responsibility" summarizing this container.
3. Restate the packet's existing components by exact id (kind "component", parentId = the containerId). Do not invent ids and do not regroup files. Give each a one-sentence "responsibility". sourceRefs may be [].
4. Optionally restate ONE in-scope code entity with a one-sentence "responsibility". Copy id, kind, name, parentId, and sourceRefs byte-for-byte from the packet. Do not re-parent it.
5. relations must be [] — relations are deterministic and not yours to propose.

Emit only {"schemaVersion":1,"entities":[...],"relations":[]}. entities is a flat array of entity objects. sourceRefs is always an array of {path, symbol?, startLine?, endLine?} objects, never a string. Do not nest softwareSystems, containers, components, or codeEntities objects.

Cite only scopePaths. Hallucinated ids or out-of-scope entities reject the whole document. Keep summaries short (one or two sentences). Do not dump the packet.`;

const CONTAINER_SYSTEM_PROMPT_V3 = `${CONTAINER_SYSTEM_PROMPT}

v3 addendum (okie-enrichment/v3): code entries may carry observed untestedRanges, fileHitRate, and nearbyTests from an optional lcov sidecar. When those ranges are present, you MAY name untested behaviours in untestedBehaviours on that code entity or its file-component: {startLine, endLine, behaviour} where the range equals or sits inside an observed untestedRanges entry and behaviour is one short phrase grounded in those lines plus nearbyTests. Without untestedRanges on that entity, omit untestedBehaviours and do not invent coverage, hit rates, or untested-behaviour prose. Do not author coverageFileHitRate, coverageUntestedRanges, or a CRAP score. Hallucinated ranges reject the document.`;

const SYSTEM_SCOPE_PROMPT = `You are an architecture curator for a C4 atlas built from a deterministic repository scan.
Write a short summary of THIS packet's scope only. Do not reason about files outside the system packet.

You receive one JSON "system packet": the software system, its scanner-scoped containers, its external dependencies, and short README excerpts. Return ONE JSON ArchitectureExtraction document — section summaries of this system and its containers, not a free-form dump. Documents violating any rule are rejected whole:

1. Restate exactly one softwareSystem entity with the packet's systemId (name unchanged, no parentId). Give it a one-sentence "responsibility" summarizing this system.
2. Restate each container from the packet with its exact id, parented to the system, name unchanged, sourceRefs [] — and give each a one-sentence "responsibility" saying what it is for. This matters MOST for containers with no visible code (native/Rust crates, generated packages). Never invent containers not in the packet.
3. Do not add persons, components, or code. relations must be [].
4. Cite only scopePaths.

Emit only {"schemaVersion":1,"entities":[...],"relations":[]}. entities is a flat array of entity objects. sourceRefs is always an array of {path, symbol?, startLine?, endLine?} objects, never a string. Do not nest softwareSystems, containers, components, or codeEntities objects.

Ground summaries in what the README teasers actually say. Hallucinated ids reject the whole document. Keep summaries short (one or two sentences).`;

function packetSystemPrompt(kind: PacketKind, packet?: EnrichmentPacket | SystemPacket): string {
  if (kind === "system") return SYSTEM_SCOPE_PROMPT;
  if (packet && "promptVersion" in packet && packet.promptVersion === ENRICHMENT_PROMPT_VERSION_V3) {
    return CONTAINER_SYSTEM_PROMPT_V3;
  }
  return CONTAINER_SYSTEM_PROMPT;
}

/** User-message body: one bounded, token-scrubbed packet (or system packet), never the whole repo. */
export function packetUserMessage(
  kind: PacketKind,
  systemId: string,
  packet: EnrichmentPacket | SystemPacket,
): string {
  const serialized = scrubGithubTokens(JSON.stringify(packet, null, 2));
  const skeleton = scrubGithubTokens(JSON.stringify(extractionEnvelopeSkeleton(kind, systemId, packet), null, 2));
  const fill = packet.promptVersion === ENRICHMENT_PROMPT_VERSION_V3
    ? `Fill each entity's "responsibility" on this ArchitectureExtraction envelope and return the filled document via ${EXTRACTION_TOOL_NAME}. Copy id, kind, name, parentId, and sourceRefs unchanged. sourceRefs is already an array of {path} objects. When a restated code or file-component has observed untestedRanges, you may add grounded untestedBehaviours. Do not nest softwareSystems, containers, components, or codeEntities, and do not split this envelope across agents.\n\nEnvelope to fill:\n${skeleton}`
    : `Fill each entity's "responsibility" on this ArchitectureExtraction envelope and return the filled document via ${EXTRACTION_TOOL_NAME}. Copy id, kind, name, parentId, and sourceRefs unchanged. sourceRefs is already an array of {path} objects. Do not nest softwareSystems, containers, components, or codeEntities, and do not split this envelope across agents.\n\nEnvelope to fill:\n${skeleton}`;
  return kind === "container"
    ? `Summarize THIS packet's scope only. The softwareSystem anchor id your document must restate: ${systemId}\n\n${fill}\n\nEnrichment packet:\n${serialized}`
    : `Summarize THIS packet's scope only.\n\n${fill}\n\nSystem packet:\n${serialized}`;
}

function cappedOutputTokens(maxOutputTokens: number): number {
  return Math.max(1, Math.min(MAX_OUTPUT_TOKENS, Math.floor(maxOutputTokens)));
}

/**
 * Anthropic Messages fields for one scope (the `anthropic` provider).
 * The model id is the configured string — not a lookup table.
 */
export function enrichmentStreamParams(
  modelId: string,
  kind: PacketKind,
  systemId: string,
  packet: EnrichmentPacket | SystemPacket,
  maxOutputTokens: number = MAX_OUTPUT_TOKENS,
) {
  const maxTokens = cappedOutputTokens(maxOutputTokens);
  return {
    model: requireUsableModelId(modelId),
    max_tokens: maxTokens,
    thinking: { type: "adaptive" as const },
    system: packetSystemPrompt(kind, packet),
    output_config: { format: { type: "json_schema" as const, schema: extractionDocSchemaForPacket(kind, systemId, packet) } },
    messages: [{
      role: "user" as const,
      content: packetUserMessage(kind, systemId, packet),
    }],
  };
}

/**
 * OpenAI-compatible `chat/completions` body for one scope (CLA-23).
 * Same packet + prompts as the Anthropic path; no Anthropic-only fields.
 */
export function enrichmentChatCompletionsBody(
  modelId: string,
  kind: PacketKind,
  systemId: string,
  packet: EnrichmentPacket | SystemPacket,
  maxOutputTokens: number = MAX_OUTPUT_TOKENS,
): Record<string, unknown> {
  const schema = extractionDocSchemaForPacket(kind, systemId, packet);
  return {
    model: requireUsableModelId(modelId),
    max_tokens: cappedOutputTokens(maxOutputTokens),
    messages: [
      { role: "system", content: packetSystemPrompt(kind, packet) },
      { role: "user", content: packetUserMessage(kind, systemId, packet) },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "architecture_extraction",
        strict: true,
        schema,
      },
    },
    tools: [{
      type: "function",
      function: {
        name: EXTRACTION_TOOL_NAME,
        description: "Submit the filled ArchitectureExtraction envelope for THIS packet only. Copy the Envelope to fill from the user message; add responsibility strings. schemaVersion must be 1. entities is a flat array. sourceRefs is always an array of {path} objects. relations must be [].",
        parameters: schema,
        strict: true,
      },
    }],
    tool_choice: { type: "function", function: { name: EXTRACTION_TOOL_NAME } },
  };
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(part => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    }).join("");
  }
  return undefined;
}

function unwrapJsonPayload(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  return trimmed;
}

function parseJsonOrThrow(text: string): unknown {
  try {
    return JSON.parse(unwrapJsonPayload(text)) as unknown;
  } catch {
    throw new Error("llm gateway response content is not JSON");
  }
}

function payloadFromToolCalls(message: Record<string, unknown>): unknown | undefined {
  const calls = message.tool_calls;
  if (!Array.isArray(calls) || calls.length === 0) return undefined;
  const named = calls.find(call => {
    if (!call || typeof call !== "object" || Array.isArray(call)) return false;
    const fn = (call as Record<string, unknown>).function;
    return Boolean(fn && typeof fn === "object" && !Array.isArray(fn)
      && (fn as Record<string, unknown>).name === EXTRACTION_TOOL_NAME);
  }) ?? calls[0];
  if (!named || typeof named !== "object" || Array.isArray(named)) return undefined;
  const record = named as Record<string, unknown>;
  const fn = record.function && typeof record.function === "object" && !Array.isArray(record.function)
    ? record.function as Record<string, unknown>
    : undefined;
  const args = fn?.arguments ?? record.input ?? record.arguments;
  if (typeof args === "string") return parseJsonOrThrow(args);
  if (args && typeof args === "object") return args;
  return undefined;
}

function payloadFromChatMessage(message: Record<string, unknown> | undefined): unknown {
  if (!message) return undefined;
  const fromTools = payloadFromToolCalls(message);
  if (fromTools !== undefined) return fromTools;
  const content = message.content;
  if (content && typeof content === "object" && !Array.isArray(content)) return content;
  const text = textFromContent(content);
  if (!text?.trim()) return undefined;
  return parseJsonOrThrow(text);
}

/**
 * True when the parsed JSON is already the gate envelope. Nested C4 dumps and
 * string `sourceRefs` fail this check so the live hop can re-ask once. Invented
 * ids still look like an envelope — the merge gate rejects those.
 */
export function looksLikeExtractionEnvelope(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  if (doc.schemaVersion !== 1) return false;
  if (!Array.isArray(doc.entities) || !Array.isArray(doc.relations)) return false;
  for (const row of doc.entities) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return false;
    const entity = row as Record<string, unknown>;
    if (typeof entity.id !== "string" || typeof entity.name !== "string") return false;
    if (typeof entity.kind !== "string" || !ENTITY_KIND_ENUM.includes(entity.kind as typeof ENTITY_KIND_ENUM[number])) {
      return false;
    }
    if (!Array.isArray(entity.sourceRefs)) return false;
  }
  return true;
}

/**
 * Pull the JSON document out of an OpenAI-compatible chat-completions payload.
 * Prefers a forced-tool call, else fence unwrap + JSON.parse. Nested C4 dumps
 * are not reshaped. Wrong shape still reaches `mergeEnrichment` after one retry.
 */
export function parseChatCompletionDocument(json: unknown): unknown {
  const record = typeof json === "object" && json !== null ? json as Record<string, unknown> : undefined;
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const first = choices[0];
  const message = first && typeof first === "object" && first !== null
    ? (first as Record<string, unknown>).message
    : undefined;
  const messageRecord = message && typeof message === "object" && message !== null && !Array.isArray(message)
    ? message as Record<string, unknown>
    : undefined;
  const payload = payloadFromChatMessage(messageRecord);
  if (payload === undefined) {
    throw new Error("llm gateway response missing message content");
  }
  return payload;
}

function gatewayCanChat(
  gateway: EnrichmentGateway | undefined,
): gateway is EnrichmentGateway & { chatCompletions: NonNullable<EnrichmentGateway["chatCompletions"]> } {
  return typeof gateway?.chatCompletions === "function";
}

function usageFromAnthropic(message: Anthropic.Message): GatewayUsage | undefined {
  const promptTokens = message.usage?.input_tokens;
  const completionTokens = message.usage?.output_tokens;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  const prompt = promptTokens ?? 0;
  const completion = completionTokens ?? 0;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    totalTokens: prompt + completion,
  };
}

function attachUsage(error: unknown, usage?: GatewayUsage): unknown {
  if (usage && error && typeof error === "object") {
    thrownUsage.set(error, usage);
  }
  return error;
}

function usageFromThrown(error: unknown): GatewayUsage | undefined {
  if (error && typeof error === "object") return thrownUsage.get(error);
  return undefined;
}

const thrownUsage = new WeakMap<object, GatewayUsage>();

function anthropicGenerator(
  client: Anthropic,
  modelId: string,
  options: { timeoutMs: number; remainingTokens: () => number },
): EnrichmentGenerator {
  return async (packet, kind, systemId) => {
    const signal = AbortSignal.timeout(options.timeoutMs);
    const stream = client.messages.stream(
      enrichmentStreamParams(modelId, kind, systemId, packet, options.remainingTokens()),
      { signal },
    );
    const message = await stream.finalMessage();
    const usage = usageFromAnthropic(message);
    try {
      if (message.stop_reason === "refusal") throw new Error("model refused the enrichment request");
      const text = message.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map(block => block.text)
        .join("");
      const document = JSON.parse(unwrapJsonPayload(text)) as unknown;
      return usage ? { document, usage } : { document };
    } catch (error) {
      throw attachUsage(error, usage);
    }
  };
}

function mergeGatewayUsage(left?: GatewayUsage, right?: GatewayUsage): GatewayUsage | undefined {
  if (!left) return right;
  if (!right) return left;
  const prompt = (left.promptTokens ?? 0) + (right.promptTokens ?? 0);
  const completion = (left.completionTokens ?? 0) + (right.completionTokens ?? 0);
  const cost = left.costUsd !== undefined || right.costUsd !== undefined
    ? addDollars(left.costUsd ?? 0, right.costUsd ?? 0)
    : undefined;
  return {
    ...(left.promptTokens !== undefined || right.promptTokens !== undefined ? { promptTokens: prompt } : {}),
    ...(left.completionTokens !== undefined || right.completionTokens !== undefined ? { completionTokens: completion } : {}),
    totalTokens: (left.totalTokens ?? 0) + (right.totalTokens ?? 0),
    ...(cost !== undefined ? { costUsd: cost } : {}),
  };
}

function gatewayGenerator(
  client: { chatCompletions: (body: Record<string, unknown>) => Promise<LlmChatCompletionResult> },
  modelId: string,
  remainingTokens: () => number,
): EnrichmentGenerator {
  return async (packet, kind, systemId) => {
    const body = enrichmentChatCompletionsBody(modelId, kind, systemId, packet, remainingTokens());
    const first = await client.chatCompletions(body);
    let usage = first.usage;
    let document: unknown | undefined;
    let parsed = false;
    try {
      document = parseChatCompletionDocument(first.json);
      parsed = true;
    } catch {
      parsed = false;
    }
    if (!parsed || !looksLikeExtractionEnvelope(document)) {
      const skeleton = extractionEnvelopeSkeleton(kind, systemId, packet);
      const retryBody: Record<string, unknown> = {
        ...body,
        messages: [
          ...((body.messages as unknown[]) ?? []),
          { role: "user", content: envelopeRetryUserMessage(skeleton) },
        ],
      };
      const second = await client.chatCompletions(retryBody);
      usage = mergeGatewayUsage(usage, second.usage);
      try {
        document = parseChatCompletionDocument(second.json);
      } catch (error) {
        throw attachUsage(error, usage);
      }
    }
    return usage ? { document, usage } : { document };
  };
}

function defaultGenerator(
  options: EnricherOptions,
  passModelId: string | undefined,
  remainingTokens: () => number,
  timeoutMs: number,
): EnrichmentGenerator {
  if (passModelId && gatewayCanChat(options.gateway)) {
    return gatewayGenerator(options.gateway, passModelId, remainingTokens);
  }
  if (passModelId && options.anthropic) {
    // authToken: null so the SDK cannot add ANTHROPIC_AUTH_TOKEN from the environment.
    const client = new Anthropic({ apiKey: options.anthropic.apiKey, authToken: null, baseURL: options.anthropic.baseUrl });
    return anthropicGenerator(client, passModelId, { timeoutMs, remainingTokens });
  }
  const reason = passModelId ? "no LLM provider configured" : "empty model id";
  return async () => {
    throw new Error(reason);
  };
}

/**
 * Groups remainder-packet documents onto the same container id, matching OSS
 * `--enrich-from`. A single accepted doc stays a bare object; two or more
 * remainder chunks become an array that `mergeEnrichment` unions. Walks
 * `accepted` in packet order so concurrent completion cannot reverse chunks.
 */
function collectDocsByContainer(
  accepted: ReadonlyArray<{ id: string; document: unknown } | undefined>,
): Map<string, unknown> {
  const docs = new Map<string, unknown>();
  for (const item of accepted) {
    if (!item) continue;
    const existing = docs.get(item.id);
    if (existing === undefined) {
      docs.set(item.id, item.document);
    } else if (Array.isArray(existing)) {
      existing.push(item.document);
    } else {
      docs.set(item.id, [existing, item.document]);
    }
  }
  return docs;
}

/**
 * Builds the `enrichWithPackets` hook for GithubScanOptions.
 * Called only while the ephemeral checkout exists (scan.ts). Per-scope failures
 * omit that scope. Remainder packets for one container union instead of
 * last-write-wins. Rate-limit / 5xx skip remaining scopes and throw so the job
 * records enrichment failed; the deterministic atlas stays live. Scan-level
 * budget skips remaining without throwing.
 */
export function createEnricher(options: EnricherOptions = {}): (packets: EmittedPackets) => Promise<ReadonlyMap<string, unknown>> {
  const progress = options.onProgress ?? (() => {});
  const passModelId = resolveEnrichmentPassModelId(options);
  const usingInjectedGenerate = options.generate !== undefined;
  const budget = resolveBudget(options.budget);
  const spent = { tokens: 0, dollars: 0 };
  const remainingTokens = (): number => Math.max(1, budget.maxTokens - spent.tokens);
  const generate = options.generate ?? defaultGenerator(options, passModelId, remainingTokens, budget.requestTimeoutMs);
  // Global spend accounting must not race two in-flight scopes against the same remainder.
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? (options.onUsage ? 1 : 2));
  const gateway = options.gateway;

  const accountUsage = (usage?: GatewayUsage): void => {
    if (!usage) return;
    const used = usage.totalTokens ?? 0;
    if (used > 0) spent.tokens += used;
    if (usage.costUsd !== undefined) {
      spent.dollars = addDollars(spent.dollars, usage.costUsd);
    }
    options.onUsage?.(usage);
  };

  return async ({ packets, systemPacket }) => {
    if (!passModelId && !usingInjectedGenerate) {
      throw new Error("empty model id");
    }
    if (passModelId && gateway) {
      const provider = safeGatewayProvider(gateway.baseUrl) ?? "configured";
      progress(`enrich: llm gateway ${provider} model ${passModelId}`);
    } else if (passModelId) {
      progress(`enrich: model ${passModelId}`);
    }
    progress(`enrich: budget ${budget.maxScopes} scopes / ${budget.maxTokens} tokens / $${budget.maxDollars} / timeout ${budget.requestTimeoutMs}ms`);
    if (!systemPacket) {
      // No system root means no gate anchor for container docs — nothing to enrich.
      progress("enrich: no system packet in this scan; staying deterministic");
      return new Map();
    }
    const systemId = systemPacket.systemId;
    // System scope first so a scan-level token cap cannot starve it after
    // three container proposals (CLA-71). Oversized *packets* skip; remainder
    // chunks for the same container still enqueue when they fit the cap.
    const work: Array<{ id: string; packet: EnrichmentPacket | SystemPacket; kind: PacketKind }> = [
      { id: systemId, packet: systemPacket, kind: "system" },
    ];
    for (const packet of packets) {
      if (packet.code.length > MAX_ENRICHABLE_CODE_ENTITIES) {
        const chunk = packet.chunkIndex !== undefined ? ` chunk ${packet.chunkIndex}` : "";
        progress(`enrich ${packet.containerId}${chunk}: skipped (${packet.code.length} code entities > ${MAX_ENRICHABLE_CODE_ENTITIES} cap; stays deterministic)`);
        continue;
      }
      work.push({ id: packet.containerId, packet, kind: "container" });
    }

    const acceptedByIndex: Array<{ id: string; document: unknown } | undefined> = new Array(work.length);
    let index = 0;
    let scopesAttempted = 0;
    let firstFailure: string | undefined;
    let abortRemaining: string | undefined;
    const skipRest = (reason: string): void => {
      const leftover = work.length - index;
      index = work.length;
      if (leftover > 0) {
        progress(`enrich: ${reason}; skipping ${leftover} remaining scope(s); stays deterministic`);
      }
    };
    const runNext = async (): Promise<void> => {
      while (index < work.length && abortRemaining === undefined) {
        if (scopesAttempted >= budget.maxScopes) {
          skipRest(`scan budget max scopes ${budget.maxScopes} reached`);
          break;
        }
        if (spent.tokens >= budget.maxTokens) {
          skipRest(`scan budget max tokens ${budget.maxTokens} reached (${spent.tokens})`);
          break;
        }
        if (spent.dollars >= budget.maxDollars) {
          skipRest(`scan budget max dollars $${budget.maxDollars} reached ($${spent.dollars})`);
          break;
        }
        if (options.budgetExhausted?.()) {
          skipRest("global enrichment budget reached");
          break;
        }
        const itemIndex = index;
        const item = work[index]!;
        index += 1;
        scopesAttempted += 1;
        try {
          progress(`enrich ${item.id}: requesting proposal`);
          const proposal = await withDeadline(generate(item.packet, item.kind, systemId), budget.requestTimeoutMs);
          acceptedByIndex[itemIndex] = { id: item.id, document: proposal.document };
          accountUsage(proposal.usage);
          progress(`enrich ${item.id}: proposal received`);
        } catch (error) {
          accountUsage(usageFromThrown(error));
          const message = error instanceof Error ? error.message : String(error);
          firstFailure ??= message;
          if (shouldSkipRemainingScopes(error)) {
            abortRemaining = message;
            const leftover = work.length - index;
            index = work.length;
            progress(`enrich ${item.id}: ${message}; skipping ${leftover} remaining scope(s); stays deterministic`);
            break;
          }
          progress(`enrich ${item.id}: failed (${message}); stays deterministic`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(maxConcurrent, work.length) }, runNext));
    // Rate-limit / 5xx: do not keep spending. The job records enrichment failed;
    // the deterministic atlas is already live.
    if (abortRemaining !== undefined) {
      throw new Error(`enrichment failed (${abortRemaining}); remaining scopes skipped`);
    }
    const docs = collectDocsByContainer(acceptedByIndex);
    // Partial success republishes what the gate accepts; TOTAL failure (typically
    // bad credentials) is surfaced as a throw so the job records an honest
    // "enrichment failed" instead of "complete, 0 containers".
    if (work.length > 0 && docs.size === 0 && firstFailure !== undefined) {
      throw new Error(`all ${work.length} enrichment scope(s) failed — first error: ${firstFailure}`);
    }
    return docs;
  };
}
