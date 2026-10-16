import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { inspect } from "node:util";
import { scrubGithubTokens, scrubProviderIdentifiers } from "@okie/scan";

/**
 * OpenAI-compatible LLM gateway config + client construction (CLA-20).
 *
 * CLA-606: egress is an explicit opt-in. A provider must be chosen (`--llm-provider <name>` or
 * `OKIE_LLM_PROVIDER`) and the key must be `OKIE_LLM_API_KEY`. Generic provider variables a developer
 * exports for other tools (OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_*, …) are never read, so
 * trying the server locally cannot send code anywhere by accident. Local config may set base URL and
 * model id but is never a key source. Repo-root `.env` is loaded only on request (`--dotenv` / OKIE_DOTENV=1).
 */

export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_ANTHROPIC_BASE_URL = "https://api.anthropic.com";

/** `--llm-provider` / `OKIE_LLM_PROVIDER` values. Anything else stops the process at startup. */
export const LLM_PROVIDERS = ["openrouter", "openai-compatible", "anthropic", "off"] as const;
export type LlmProvider = typeof LLM_PROVIDERS[number];

/**
 * Generic provider variables that are never read (CLA-606). Present ones are named, never valued, in one
 * startup notice. Redaction lists elsewhere may still mention them: scrubbing more is harmless.
 */
export const IGNORED_GENERIC_LLM_ENV = [
  "OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "OPENROUTER_MODEL", "OPENAI_MODEL",
] as const;

/** Documented default model id in OpenRouter's `provider/model` form. Not a table. */
export const DEFAULT_GATEWAY_MODEL_ID = "xiaomi/mimo-v2.6-pro";

export const LOCAL_LLM_CONFIG_FILENAME = "okie.local.json";

/** `gateway`: OpenAI-compatible chat completions. `anthropic`: the Anthropic SDK, scan enrichment only. */
export type LlmKeySource = "gateway" | "anthropic" | "none";

/** Non-secret overlay. Keys are not part of this type and are ignored if a file contains them. */
export interface LlmGatewayLocalConfig {
  baseUrl?: string;
  modelId?: string;
}

export interface LlmGatewayConfig {
  baseUrl: string;
  modelId: string;
  keySource: LlmKeySource;
  /** Present only when a key was resolved. Never serialize, log, or put on /healthz. */
  apiKey?: string;
  /** The opted-in provider, when one was chosen. */
  provider?: LlmProvider;
  /** Why egress is off (`keySource: "none"`): shown on the startup line. Never a value. */
  offReason?: string;
}

export interface LlmGatewayPublicView {
  /** Origin + path only. Userinfo and query (where tokens hide) are stripped. */
  baseUrl: string;
  modelId: string;
  keySource: LlmKeySource;
  keyConfigured: boolean;
}

export interface LlmGatewayClientOptions {
  fetch?: typeof fetch;
  /** Per-request deadline for `chatCompletions`. Default `DEFAULT_REQUEST_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/** Per-request HTTP deadline so a hung gateway cannot stall a paste-a-repo job. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Scan-level cap on gateway calls (container scopes + system). */
export const DEFAULT_MAX_ENRICHMENT_SCOPES = 16;
/** Scan-level cap on reported tokens (`usage.total_tokens` / prompt+completion).
 *  System packet is scheduled first (see createEnricher) so this cap cannot
 *  starve the system-scope summary after three container proposals. */
export const DEFAULT_MAX_ENRICHMENT_TOKENS = 200_000;
/** Scan-level dollar cap, applied only when the gateway reports cost. */
export const DEFAULT_MAX_ENRICHMENT_DOLLARS = 1;

/** `transport`: the connection failed or dropped before a full response arrived (undici `fetch failed` / `terminated`; CLA-264). */
export type LlmGatewayFailureKind = "timeout" | "rate_limit" | "server" | "http" | "transport";

export interface EnrichmentBudget {
  requestTimeoutMs: number;
  maxScopes: number;
  maxTokens: number;
  /** Enforced only when a response reports `usage.cost` (or equivalent). */
  maxDollars: number;
}

export interface GatewayUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens: number;
  costUsd?: number;
}

export class LlmGatewayError extends Error {
  readonly kind: LlmGatewayFailureKind;
  readonly status?: number;
  /** Provider error code from the response body (e.g. OpenRouter `error.code`), when it has one. */
  readonly providerCode?: string;

  constructor(message: string, options: { kind: LlmGatewayFailureKind; status?: number; providerCode?: string; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "LlmGatewayError";
    this.kind = options.kind;
    if (options.status !== undefined) this.status = options.status;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
  }
}

export function classifyLlmGatewayFailure(error: unknown): LlmGatewayFailureKind | undefined {
  if (error instanceof LlmGatewayError) return error.kind;
  const message = error instanceof Error ? error.message : String(error);
  const statusMatch = /llm gateway (\d{3})\b/.exec(message);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    if (status === 429) return "rate_limit";
    if (status >= 500 && status <= 599) return "server";
    return "http";
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  if (/llm gateway timeout/i.test(message) || /\btimeout after \d+ms\b/i.test(message)) {
    return "timeout";
  }
  // Legacy/raw undici failures (stored before CLA-264, or thrown by a non-gateway fetch): same meaning as `transport`.
  // Whole-message matches only: undici throws exactly `TypeError: fetch failed` / `TypeError: terminated`.
  const exact = /^(?:fetch failed|terminated)$/.test(message);
  if ((exact && (!(error instanceof Error) || error.name === "TypeError")) || /^(?:TypeError: )(?:fetch failed|terminated)$/.test(message) || /\bllm gateway transport error\b/.test(message)) return "transport";
  return undefined;
}

/**
 * A short, scrub-safe name for a transport failure's root cause: undici puts the socket error on `cause`
 * (`UND_ERR_SOCKET`, `ECONNRESET`, …). Only an upper-case code or a plain error name is kept, never a message,
 * address or host, so the text is safe to store (CLA-261).
 */
export function transportCauseCode(error: unknown): string {
  const seen = new Set<unknown>();
  for (let cursor: unknown = error; cursor && typeof cursor === "object" && !seen.has(cursor); cursor = (cursor as { cause?: unknown }).cause) {
    seen.add(cursor);
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,39}$/.test(code)) return code;
  }
  const inner = error && typeof error === "object" ? (error as { cause?: unknown }).cause : undefined;
  for (const candidate of [inner, error]) {
    const name = candidate instanceof Error ? candidate.name : undefined;
    if (name && /^[A-Za-z][A-Za-z0-9]{1,39}$/.test(name) && name !== "Error") return name;
  }
  return "unknown cause";
}
/** `status` is set when the response had started (the body dropped mid-read): the provider may already have billed the call. */
function transportError(error: unknown, status?: number): LlmGatewayError {
  return new LlmGatewayError(`llm gateway transport error (${transportCauseCode(error)})`, { kind: "transport", cause: error, ...(status !== undefined ? { status } : {}) });
}

/** Rate-limit and 5xx abort the rest of the scan's enrichment pass. */
export function shouldSkipRemainingScopes(error: unknown): boolean {
  const kind = classifyLlmGatewayFailure(error);
  return kind === "rate_limit" || kind === "server";
}

function optionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = optionalFiniteNumber(raw);
  if (parsed === undefined || parsed <= 0) return fallback;
  return parsed;
}

/** Operator env overlay. Missing / invalid values keep the documented defaults. */
export function resolveEnrichmentBudget(env: NodeJS.Dict<string> = process.env): EnrichmentBudget {
  return {
    requestTimeoutMs: Math.floor(parsePositiveNumber(env.OKIE_LLM_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)),
    maxScopes: Math.floor(parsePositiveNumber(env.OKIE_LLM_MAX_SCOPES, DEFAULT_MAX_ENRICHMENT_SCOPES)),
    maxTokens: Math.floor(parsePositiveNumber(env.OKIE_LLM_MAX_TOKENS, DEFAULT_MAX_ENRICHMENT_TOKENS)),
    maxDollars: parsePositiveNumber(env.OKIE_LLM_MAX_DOLLARS, DEFAULT_MAX_ENRICHMENT_DOLLARS),
  };
}

/** Operator-run request cap (CLA-254). Isolated so the product default can be swapped. */
export const DEFAULT_OPERATOR_MAX_REQUESTS = 512;
export const DEFAULT_OPERATOR_MAX_TOKENS = 4_000_000;
export const DEFAULT_OPERATOR_MAX_DOLLARS = 5;
/** Operator per-request deadline; long component/container prompts routinely exceed the public 60s. */
export const DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Operator enrichment budget: `OKIE_LLM_OPERATOR_MAX_{REQUESTS,TOKENS,DOLLARS}`
 * and `OKIE_LLM_OPERATOR_TIMEOUT_MS` (default 120s). Public scan enrichment keeps
 * {@link resolveEnrichmentBudget}; the two must not share defaults.
 */
export function resolveOperatorEnrichmentBudget(env: NodeJS.Dict<string> = process.env): EnrichmentBudget {
  return {
    requestTimeoutMs: Math.floor(parsePositiveNumber(env.OKIE_LLM_OPERATOR_TIMEOUT_MS, DEFAULT_OPERATOR_REQUEST_TIMEOUT_MS)),
    maxScopes: Math.floor(parsePositiveNumber(env.OKIE_LLM_OPERATOR_MAX_REQUESTS, DEFAULT_OPERATOR_MAX_REQUESTS)),
    maxTokens: Math.floor(parsePositiveNumber(env.OKIE_LLM_OPERATOR_MAX_TOKENS, DEFAULT_OPERATOR_MAX_TOKENS)),
    maxDollars: parsePositiveNumber(env.OKIE_LLM_OPERATOR_MAX_DOLLARS, DEFAULT_OPERATOR_MAX_DOLLARS),
  };
}

/**
 * CLA-145 Jev claim checks. Off unless `OKIE_JEV_CLAIM_CHECKS` is on/true/1. Per-run caps
 * `OKIE_JEV_MAX_{REQUESTS,TOKENS,DOLLARS}` and a per-request deadline `OKIE_JEV_TIMEOUT_MS`.
 *
 * Defaults are deliberately small. Each Jev request reserves the documented 64k context plus 16k
 * typed output (81,920 tokens) and $0.003 (65,536 input tokens × $0.042/1M, rounded up; Jev bills
 * input only and reports no cost, so the $0.003 reservation stays counted). 32 requests (at most 8
 * claims each, one scope per request) therefore cost at most 32 × $0.003 = $0.096 ≤ $0.10, and 32 ×
 * 81,920 = 2,621,440 reserved tokens. Real input is ≤24 KB of JSON (≈6-8k tokens), so the token cap
 * never binds before the request cap. 20 s: batches carry up to eight questions over ≤24 KB of
 * excerpts, twice the 10 s single-batch judgment default. Raising any limit is an operator action.
 */
export const DEFAULT_JEV_CLAIM_CHECK_MAX_REQUESTS = 32;
export const DEFAULT_JEV_CLAIM_CHECK_MAX_TOKENS = 32 * 81_920;
export const DEFAULT_JEV_CLAIM_CHECK_MAX_DOLLARS = 0.1;
export const DEFAULT_JEV_CLAIM_CHECK_TIMEOUT_MS = 20_000;
export interface ClaimCheckConfig { enabled: boolean; maxRequests: number; maxTokens: number; maxDollars: number; timeoutMs: number; }
export function resolveClaimCheckConfig(env: NodeJS.Dict<string> = process.env): ClaimCheckConfig {
  return {
    enabled: /^(?:1|on|true|yes)$/i.test(env.OKIE_JEV_CLAIM_CHECKS?.trim() ?? ""),
    maxRequests: Math.floor(parsePositiveNumber(env.OKIE_JEV_MAX_REQUESTS, DEFAULT_JEV_CLAIM_CHECK_MAX_REQUESTS)),
    maxTokens: Math.floor(parsePositiveNumber(env.OKIE_JEV_MAX_TOKENS, DEFAULT_JEV_CLAIM_CHECK_MAX_TOKENS)),
    maxDollars: parsePositiveNumber(env.OKIE_JEV_MAX_DOLLARS, DEFAULT_JEV_CLAIM_CHECK_MAX_DOLLARS),
    timeoutMs: Math.floor(parsePositiveNumber(env.OKIE_JEV_TIMEOUT_MS, DEFAULT_JEV_CLAIM_CHECK_TIMEOUT_MS)),
  };
}

/** Deepest C4 kind operator enrichment explains; `code` symbols are opt-in. */
export type OperatorEnrichmentDepth = "component" | "code";
export function resolveOperatorEnrichmentDepth(env: NodeJS.Dict<string> = process.env): OperatorEnrichmentDepth {
  return env.OKIE_LLM_ENRICH_DEPTH?.trim().toLowerCase() === "code" ? "code" : "component";
}

/** Leaf reasoning control: `on` (default) leaves request bodies untouched; `off` asks OpenRouter to skip reasoning on leaves. */
export type OperatorLeafReasoningSetting = "on" | "off";
export function resolveOperatorLeafReasoning(env: NodeJS.Dict<string> = process.env): OperatorLeafReasoningSetting {
  return env.OKIE_LLM_REASONING_LEAVES?.trim().toLowerCase() === "off" ? "off" : "on";
}
/** True for OpenRouter's API host (the only gateway that understands `reasoning: { enabled }`). */
export function isOpenRouterProvider(provider: string | undefined): boolean {
  return provider === "openrouter.ai" || Boolean(provider?.endsWith(".openrouter.ai"));
}

export const DEFAULT_LLM_MAX_CONCURRENT = 64;
export const DEFAULT_LLM_RATE_LIMIT_RETRIES = 4;
export const DEFAULT_LLM_RATE_LIMIT_BACKOFF_MS = 1000;
export interface LlmRateLimitConfig { maxConcurrent: number; retries: number; backoffMs: number; }
/** `OKIE_LLM_MAX_CONCURRENT` / `OKIE_LLM_RATE_LIMIT_RETRIES` / `OKIE_LLM_RATE_LIMIT_BACKOFF_MS`. */
export function resolveLlmRateLimitConfig(env: NodeJS.Dict<string> = process.env): LlmRateLimitConfig {
  const retries = optionalFiniteNumber(env.OKIE_LLM_RATE_LIMIT_RETRIES);
  return {
    maxConcurrent: Math.max(1, Math.floor(parsePositiveNumber(env.OKIE_LLM_MAX_CONCURRENT, DEFAULT_LLM_MAX_CONCURRENT))),
    retries: retries !== undefined && retries >= 0 ? Math.floor(retries) : DEFAULT_LLM_RATE_LIMIT_RETRIES,
    backoffMs: parsePositiveNumber(env.OKIE_LLM_RATE_LIMIT_BACKOFF_MS, DEFAULT_LLM_RATE_LIMIT_BACKOFF_MS),
  };
}

/** Longest provider message an error keeps; the rest of a provider body is never stored. */
export const GATEWAY_ERROR_MESSAGE_MAX_CHARS = 200;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** Scrub for error text headed to storage, logs, API responses, or the UI (CLA-261). */
export function redactGatewayErrorText(text: string, secret?: string): string {
  return scrubProviderIdentifiers(redactGatewayText(text, secret));
}

/** Provider error codes are numeric or a lowercase word (`rate_limit_exceeded`); anything else is dropped. */
function safeProviderCode(value: unknown): string | undefined {
  const raw = typeof value === "number" && Number.isInteger(value) ? String(value) : typeof value === "string" ? value.trim() : undefined;
  return raw && /^(?:\d{1,6}|[a-z][a-z0-9_]{0,39})$/.test(raw) && scrubProviderIdentifiers(raw) === raw ? raw : undefined;
}

/** Decode a captured JSON string body (`\u0040` → `@`) so the scrub sees the real characters; raw text if it does not decode. */
function decodeJsonString(captured: string): string {
  try { return JSON.parse(`"${captured}"`) as string; } catch { return captured; }
}

/** Raw provider text is cut to this before any scrub runs, so a huge body costs bounded work. */
const GATEWAY_ERROR_RAW_MAX_CHARS = 4000;

/** Pre-clip, scrub, then clip to the stored message length. */
function providerMessage(raw: string, secret: string | undefined): string {
  return clip(redactGatewayErrorText(raw.slice(0, GATEWAY_ERROR_RAW_MAX_CHARS), secret), GATEWAY_ERROR_MESSAGE_MAX_CHARS);
}

/**
 * CLA-261: reduce a provider error body to `{ code?, message }`. Only the
 * OpenAI/OpenRouter `error.message` / `error.code` (or `error.type`) fields
 * are read — `metadata`, `user_id`, and every other field are dropped. A
 * non-JSON body keeps a short scrubbed snippet (HTML keeps nothing).
 */
export function summarizeGatewayErrorBody(body: string, secret?: string): { code?: string; message: string } {
  let parsed: unknown;
  const trimmed = body.trim();
  try { parsed = JSON.parse(trimmed) as unknown; } catch {
    // A legacy stored body may have been cut mid-JSON: take the message/code fields by shape,
    // only from before `metadata` (whose nested fields must never supply a message or code).
    if (trimmed.startsWith("{")) {
      const metadataAt = trimmed.indexOf("\"metadata\"");
      const head = (metadataAt >= 0 ? trimmed.slice(0, metadataAt) : trimmed).slice(0, GATEWAY_ERROR_RAW_MAX_CHARS);
      const message = /"message"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(head)?.[1];
      const code = safeProviderCode(/"(?:code|type)"\s*:\s*"?([A-Za-z0-9._-]+)"?/.exec(head)?.[1]);
      return { ...(code ? { code } : {}), message: message !== undefined ? providerMessage(decodeJsonString(message), secret) : "provider error (details withheld)" };
    }
    if (!trimmed) return { message: "empty response" };
    if (/^<|<html|<!doctype/i.test(trimmed.slice(0, 512))) return { message: "non-JSON response" };
    return { message: providerMessage(trimmed, secret) };
  }
  const record = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const error = record.error;
  const errorRecord = typeof error === "object" && error !== null && !Array.isArray(error) ? error as Record<string, unknown> : undefined;
  const rawMessage = typeof errorRecord?.message === "string" ? errorRecord.message
    : typeof error === "string" ? error
      : typeof record.message === "string" ? record.message
        : undefined;
  const code = safeProviderCode(errorRecord?.code) ?? safeProviderCode(errorRecord?.type);
  const message = rawMessage?.trim() ? providerMessage(rawMessage, secret) : "provider error (no message)";
  return { ...(code ? { code } : {}), message };
}

/**
 * `llm gateway <status>[ (<provider code>)]: <short message>` — the prefix {@link classifyLlmGatewayFailure} parses.
 * A message that itself starts with `{` is marked so the stored text can never be mistaken for a raw body later.
 */
function gatewayErrorMessage(status: number, summary: { code?: string; message: string }): string {
  const code = summary.code && summary.code !== String(status) ? ` (${summary.code})` : "";
  const message = summary.message.startsWith("{") ? `provider message ${summary.message}` : summary.message;
  return `llm gateway ${status}${code}: ${message}`;
}

/** A raw provider body: an object with an `error` key (or, cut mid-JSON, text that starts like one). */
function looksLikeRawBody(tail: string): boolean {
  try { const parsed = JSON.parse(tail) as unknown; return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "error" in parsed; } catch { return /^\{\s*"error"\s*:/.test(tail); }
}

/**
 * A stored/logged `llm gateway NNN: {raw body}` (pre-CLA-261) → the normalized shape; other text is scrubbed only.
 * Applying it to its own output is a no-op: normalized messages carry no raw body (see {@link gatewayErrorMessage}).
 */
export function normalizeGatewayErrorText(text: string, secret?: string): string {
  const bounded = text.slice(0, GATEWAY_ERROR_RAW_MAX_CHARS);
  const match = /llm gateway (\d{3}): (\{[\s\S]*)$/.exec(bounded);
  if (!match || !looksLikeRawBody(match[2]!)) return redactGatewayErrorText(bounded, secret);
  const head = redactGatewayErrorText(bounded.slice(0, match.index), secret);
  return `${head}${gatewayErrorMessage(Number(match[1]), summarizeGatewayErrorBody(match[2]!, secret))}`;
}

export function llmGatewayErrorFromHttp(status: number, body: string, apiKey?: string): LlmGatewayError {
  const kind: LlmGatewayFailureKind = status === 429
    ? "rate_limit"
    : status >= 500 && status <= 599
      ? "server"
      : "http";
  const summary = summarizeGatewayErrorBody(body, apiKey);
  return new LlmGatewayError(gatewayErrorMessage(status, summary), { kind, status, ...(summary.code ? { providerCode: summary.code } : {}) });
}

/**
 * OpenAI-compatible `usage` plus OpenRouter `cost` / `x-openrouter-cost`.
 * Returns `undefined` when the payload has neither token counts nor a cost.
 */
export function readGatewayUsage(json: unknown, headerCostUsd?: number): GatewayUsage | undefined {
  const record = typeof json === "object" && json !== null ? json as Record<string, unknown> : undefined;
  const usage = record && typeof record.usage === "object" && record.usage !== null
    ? record.usage as Record<string, unknown>
    : undefined;
  const promptTokens = optionalFiniteNumber(usage?.prompt_tokens) ?? optionalFiniteNumber(usage?.input_tokens);
  const completionTokens = optionalFiniteNumber(usage?.completion_tokens) ?? optionalFiniteNumber(usage?.output_tokens);
  const reportedTotal = optionalFiniteNumber(usage?.total_tokens);
  const totalTokens = reportedTotal
    ?? ((promptTokens ?? 0) + (completionTokens ?? 0) || undefined);
  const costUsd = optionalFiniteNumber(usage?.cost)
    ?? optionalFiniteNumber(usage?.total_cost)
    ?? optionalFiniteNumber(usage?.cost_usd)
    ?? headerCostUsd;
  if (totalTokens === undefined && costUsd === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    totalTokens: totalTokens ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function headerCostUsd(headers: Headers): number | undefined {
  return optionalFiniteNumber(headers.get("x-openrouter-cost"))
    ?? optionalFiniteNumber(headers.get("x-openai-cost"));
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}

/** Rejects with `LlmGatewayError` (`timeout`) when `work` does not settle in time. */
export async function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return work;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new LlmGatewayError(`llm gateway timeout after ${timeoutMs}ms`, { kind: "timeout" }));
      }, timeoutMs);
      work.then(resolve, reject);
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface LlmChatCompletionResult {
  json: unknown;
  usage?: GatewayUsage;
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = trimToUndefined(value);
    if (trimmed) return trimmed;
  }
  return undefined;
}

function envHasKey(env: NodeJS.Dict<string>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(env, key);
}

/**
 * Model id is an opaque gateway string. Unset → documented default.
 * A present-but-empty source (env or local) wins as empty so the enrichment
 * pass can fail closed instead of silently substituting the default (CLA-21).
 */
function resolveModelId(env: NodeJS.Dict<string>, local: LlmGatewayLocalConfig): string {
  const sources: Array<{ present: boolean; raw: string | undefined }> = [
    { present: local.modelId !== undefined, raw: local.modelId },
    { present: envHasKey(env, "OKIE_LLM_MODEL"), raw: env.OKIE_LLM_MODEL },
  ];
  for (const source of sources) {
    if (!source.present) continue;
    return source.raw?.trim() ?? "";
  }
  return DEFAULT_GATEWAY_MODEL_ID;
}

/** Non-empty after trim. Okie does not validate against a model table. */
export function isUsableModelId(modelId: string | undefined): boolean {
  return Boolean(trimToUndefined(modelId));
}

/**
 * Throws when the operator configured an empty model id. Callers map this to
 * an enrichment-pass failure, not a failed job.
 */
export function requireUsableModelId(modelId: string | undefined): string {
  const trimmed = trimToUndefined(modelId);
  if (!trimmed) {
    throw new Error("empty model id");
  }
  return trimmed;
}

function withApiKey(base: Omit<LlmGatewayConfig, "apiKey">, apiKey: string): LlmGatewayConfig {
  const config: LlmGatewayConfig = { ...base };
  Object.defineProperty(config, "apiKey", {
    value: apiKey,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(config, inspect.custom, {
    value: () => publicLlmGatewayView(config),
    enumerable: false,
  });
  return config;
}

/** The `--llm-provider <name>` / `--llm-provider=<name>` argument, if any (last one wins). */
export function llmProviderArg(argv: readonly string[]): string | undefined {
  let value: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--llm-provider") value = argv[++index] ?? "";
    else if (arg.startsWith("--llm-provider=")) value = arg.slice("--llm-provider=".length);
  }
  return value;
}

function parseLlmProvider(raw: string): LlmProvider {
  const value = raw.trim().toLowerCase();
  if ((LLM_PROVIDERS as readonly string[]).includes(value)) return value as LlmProvider;
  const shown = JSON.stringify(raw.trim().slice(0, 40));
  throw new Error(`unknown LLM provider ${shown} (--llm-provider / OKIE_LLM_PROVIDER): use ${LLM_PROVIDERS.join(", ")}`);
}

/** Generic provider variables set in `env` (names only), which CLA-606 ignores. */
export function ignoredGenericLlmEnv(env: NodeJS.Dict<string>): string[] {
  return IGNORED_GENERIC_LLM_ENV.filter(name => trimToUndefined(env[name]) !== undefined);
}

/** One startup notice naming the ignored generic variables (never their values), or `undefined` when none is set. */
export function ignoredGenericLlmEnvNotice(env: NodeJS.Dict<string>): string | undefined {
  const names = ignoredGenericLlmEnv(env);
  if (!names.length) return undefined;
  return `LLM notice: ignoring ${names.join(", ")} (only OKIE_LLM_API_KEY / OKIE_LLM_BASE_URL / OKIE_LLM_MODEL are read; `
    + `opt in with --llm-provider <${LLM_PROVIDERS.filter(name => name !== "off").join("|")}> or OKIE_LLM_PROVIDER)`;
}

function sameUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** Origin + pathname, with userinfo/query/hash stripped. Never throws. */
export function publicGatewayBaseUrl(baseUrl: string): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[redacted-url]";
  }
}

/** Safe snapshot for logs / inspect / health-adjacent views. Never includes the key. */
export function publicLlmGatewayView(config: LlmGatewayConfig): LlmGatewayPublicView {
  const modelId = enrichmentModelId(config)
    ?? (isUsableModelId(config.modelId) ? "[redacted]" : config.modelId);
  return {
    baseUrl: publicGatewayBaseUrl(config.baseUrl),
    modelId,
    keySource: config.keySource,
    keyConfigured: Boolean(config.apiKey),
  };
}

/**
 * Replace every occurrence of `secret` in `text`. No-op when the secret is
 * empty. Used before logs and job notes so a provider error cannot echo a key.
 */
export function redactLlmSecret(text: string, secret: string | undefined): string {
  const value = trimToUndefined(secret);
  if (!value) return text;
  return text.split(value).join("[redacted-llm-key]");
}

/**
 * Hostname of a gateway URL, never userinfo or query. `undefined` when the
 * string is not a usable URL — callers must not fall back to the raw value.
 */
export function safeGatewayProvider(baseUrl: string): string | undefined {
  try {
    const parsed = new URL(baseUrl);
    const host = parsed.hostname.trim().toLowerCase();
    return host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Provider label for job/UI. The Anthropic provider is named "anthropic"; a gateway uses the
 * hostname only; nothing when egress is off. Never a URL, never a key.
 */
export function enrichmentProviderLabel(config: LlmGatewayConfig): string | undefined {
  if (config.keySource === "none") return undefined;
  const raw = config.keySource === "anthropic" ? "anthropic" : safeGatewayProvider(config.baseUrl);
  if (!raw) return undefined;
  if (/https?:\/\//i.test(raw) || raw.includes("@") || raw.includes("/")) return undefined;
  const redacted = redactGatewayText(raw, config.apiKey);
  return redacted === raw ? raw : undefined;
}

/**
 * Configured model id when non-empty and not a secret. If the operator pasted
 * a key or tokenized URL into the model field, omit it rather than publish it.
 */
export function enrichmentModelId(config: LlmGatewayConfig): string | undefined {
  if (!isUsableModelId(config.modelId)) return undefined;
  const trimmed = config.modelId.trim();
  const redacted = redactGatewayText(trimmed, config.apiKey);
  return redacted === trimmed ? trimmed : undefined;
}

/**
 * Strip userinfo, query, and fragment from http(s) URLs in `text`. Tokens in
 * `https://user:token@host/path?api_key=` must not reach logs, job.error, or UI.
 * The match is whitespace-delimited (commas/quotes inside userinfo stay in the
 * URL so they can be stripped), then trailing sentence punctuation is peeled
 * only when `new URL` requires it.
 */
export function redactTokenizedUrls(text: string): string {
  return text.replace(/https?:\/\/\S+/gi, raw => {
    let candidate = raw;
    while (candidate.length >= 8) {
      try {
        const parsed = new URL(candidate);
        const suffix = raw.slice(candidate.length);
        if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash) {
          return raw;
        }
        parsed.username = "";
        parsed.password = "";
        parsed.search = "";
        parsed.hash = "";
        return `${parsed.toString()}${suffix}`;
      } catch {
        candidate = candidate.slice(0, -1);
      }
    }
    return "[redacted-url]";
  });
}

/**
 * Last-mile scrub for anything that leaves toward the gateway, logs, or job.error:
 * existing GitHub token patterns, tokenized gateway URLs, plus the operator's exact API key.
 */
export function redactGatewayText(text: string, secret?: string): string {
  return redactLlmSecret(redactTokenizedUrls(scrubGithubTokens(text)), secret);
}

export function hasLlmCredentials(config: LlmGatewayConfig): boolean {
  return config.keySource !== "none";
}

/**
 * Resolves the LLM settings (CLA-606). Egress needs a provider opt-in (`provider`, i.e. the
 * `--llm-provider` value, else `OKIE_LLM_PROVIDER`) AND `OKIE_LLM_API_KEY`; otherwise the config is
 * off (`keySource: "none"`) with an `offReason`. Local overlay wins for base URL / model id.
 * Throws on an unknown provider, on `openrouter` with a base URL override, and on `openai-compatible`
 * without a base URL, so a misconfigured server stops at startup instead of sending somewhere unexpected.
 */
export function resolveLlmGatewayConfig(
  env: NodeJS.Dict<string> = process.env,
  local: LlmGatewayLocalConfig = {},
  provider?: string,
): LlmGatewayConfig {
  // The CLI value (`llmProviderArg`) beats the env var; an empty `--llm-provider=` is an unknown provider.
  const choice = provider ?? trimToUndefined(env.OKIE_LLM_PROVIDER);
  const baseOverride = firstNonEmpty([local.baseUrl, env.OKIE_LLM_BASE_URL]);
  const modelId = resolveModelId(env, local);
  const apiKey = trimToUndefined(env.OKIE_LLM_API_KEY);
  const off = (offReason: string, baseUrl = baseOverride ?? DEFAULT_OPENROUTER_BASE_URL, chosen?: LlmProvider): LlmGatewayConfig =>
    ({ baseUrl, modelId, keySource: "none", offReason, ...(chosen ? { provider: chosen } : {}) });

  if (choice === undefined) {
    return off(apiKey
      ? "OKIE_LLM_API_KEY is set but no provider is chosen; pass --llm-provider <name> or set OKIE_LLM_PROVIDER"
      : "no --llm-provider / OKIE_LLM_PROVIDER");
  }
  const chosen = parseLlmProvider(choice);
  if (chosen === "off") return off("--llm-provider off", undefined, chosen);

  let baseUrl: string;
  if (chosen === "openrouter") {
    if (baseOverride && !sameUrl(baseOverride, DEFAULT_OPENROUTER_BASE_URL)) {
      throw new Error("--llm-provider openrouter always sends to openrouter.ai, but a base URL override is set "
        + "(OKIE_LLM_BASE_URL or okie.local.json baseUrl); use --llm-provider openai-compatible to send elsewhere");
    }
    baseUrl = DEFAULT_OPENROUTER_BASE_URL;
  } else if (chosen === "openai-compatible") {
    if (!baseOverride) throw new Error("--llm-provider openai-compatible needs OKIE_LLM_BASE_URL (or okie.local.json baseUrl)");
    baseUrl = baseOverride;
  } else {
    baseUrl = baseOverride ?? DEFAULT_ANTHROPIC_BASE_URL;
  }
  if (!apiKey) return off(`--llm-provider ${chosen} is chosen but OKIE_LLM_API_KEY is unset`, baseUrl, chosen);
  return withApiKey({ baseUrl, modelId, keySource: chosen === "anthropic" ? "anthropic" : "gateway", provider: chosen }, apiKey);
}

/**
 * Reads a local overlay JSON. Only `baseUrl` and `modelId` are accepted.
 * An `apiKey` (or any other secret-looking field) is ignored so a misplaced
 * key in a config file cannot become the live credential.
 */
export function readLlmGatewayLocalConfigFile(path: string): LlmGatewayLocalConfig {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`LLM local config must be a JSON object: ${path}`);
  }
  const record = raw as Record<string, unknown>;
  const local: LlmGatewayLocalConfig = {};
  if (typeof record.baseUrl === "string") {
    const baseUrl = trimToUndefined(record.baseUrl);
    if (baseUrl) local.baseUrl = baseUrl;
  }
  if (typeof record.modelId === "string") {
    // Preserve present-but-empty so CLA-21 can fail the enrichment pass.
    local.modelId = record.modelId.trim();
  }
  return local;
}

/** `OKIE_LLM_CONFIG` if set, else `<repoRoot>/okie.local.json` when that file exists. */
export function resolveLlmGatewayLocalConfig(
  repoRoot: string,
  env: NodeJS.Dict<string> = process.env,
): LlmGatewayLocalConfig {
  const explicit = trimToUndefined(env.OKIE_LLM_CONFIG);
  const path = explicit
    ? (isAbsolute(explicit) ? explicit : resolve(repoRoot, explicit))
    : join(repoRoot, LOCAL_LLM_CONFIG_FILENAME);
  if (explicit && !existsSync(path)) {
    throw new Error(`OKIE_LLM_CONFIG file not found: ${path}`);
  }
  if (!existsSync(path)) return {};
  return readLlmGatewayLocalConfigFile(path);
}

/** `--dotenv` on the command line, or `OKIE_DOTENV=1`. */
export function dotenvRequested(argv: readonly string[] = process.argv.slice(2), env: NodeJS.Dict<string> = process.env): boolean {
  return argv.includes("--dotenv") || /^(?:1|on|true|yes)$/i.test(env.OKIE_DOTENV?.trim() ?? "");
}

/**
 * Load repo-root `.env` into `process.env` without overriding existing vars, ONLY when asked
 * (`--dotenv` / `OKIE_DOTENV=1`; CLA-606). Returns whether it was loaded.
 */
export function loadOperatorDotenv(
  repoRoot: string,
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.Dict<string> = process.env,
): boolean {
  if (!dotenvRequested(argv, env)) return false;
  const envPath = join(repoRoot, ".env");
  if (!existsSync(envPath)) return false;
  process.loadEnvFile(envPath);
  return true;
}

/**
 * OpenAI-compatible client. The API key is a private field: JSON, inspect, and
 * error messages never include it. Not constructed for the `anthropic` provider
 * (that key stays on the Anthropic SDK so it is not sent to a gateway).
 */
export class LlmGatewayClient {
  readonly baseUrl: string;
  readonly modelId: string;
  readonly keySource: "gateway";
  readonly hasApiKey = true;
  readonly timeoutMs: number;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(config: LlmGatewayConfig, options: LlmGatewayClientOptions = {}) {
    const apiKey = trimToUndefined(config.apiKey);
    if (!apiKey || config.keySource !== "gateway") {
      throw new Error("LlmGatewayClient requires a gateway API key");
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.modelId = config.modelId;
    this.keySource = "gateway";
    this.#apiKey = apiKey;
    this.#fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs !== undefined && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? options.timeoutMs
      : DEFAULT_REQUEST_TIMEOUT_MS;
  }

  toJSON(): LlmGatewayPublicView {
    return publicLlmGatewayView({
      baseUrl: this.baseUrl,
      modelId: this.modelId,
      keySource: this.keySource,
      apiKey: this.#apiKey,
    });
  }

  [inspect.custom](): LlmGatewayPublicView {
    return this.toJSON();
  }

  /**
   * POST `{baseUrl}/chat/completions` with a per-request timeout.
   * Packet enrichment drives this (CLA-23). The JSON body is token-scrubbed
   * before it leaves the machine (CLA-25). The deadline and usage parse
   * keep a paste-a-repo job from hanging or running unbounded (CLA-22).
   */
  async chatCompletions(body: Record<string, unknown>): Promise<LlmChatCompletionResult> {
    // Configured model id always wins — body must not override it (CLA-21).
    const payload = { ...body, model: this.modelId };
    const serialized = redactGatewayText(JSON.stringify(payload), this.#apiKey);
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.#apiKey}`,
        },
        body: serialized,
        signal,
      });
    } catch (error) {
      if (signal.aborted || isAbortLike(error)) {
        throw new LlmGatewayError(`llm gateway timeout after ${this.timeoutMs}ms`, {
          kind: "timeout",
          cause: error,
        });
      }
      // CLA-264: keep the root cause (`TypeError: fetch failed` hides UND_ERR_SOCKET/ECONNRESET on `cause`).
      throw transportError(error);
    }
    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      // The body stream can also time out or drop mid-read (`TypeError: terminated`).
      if (signal.aborted || isAbortLike(error)) {
        throw new LlmGatewayError(`llm gateway timeout after ${this.timeoutMs}ms`, { kind: "timeout", cause: error });
      }
      throw transportError(error, response.status);
    }
    if (!response.ok) {
      throw llmGatewayErrorFromHttp(response.status, text, this.#apiKey);
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error("llm gateway returned non-JSON");
    }
    const usage = readGatewayUsage(json, headerCostUsd(response.headers));
    return usage ? { json, usage } : { json };
  }
}

/** `undefined` when there is no gateway key (including the `anthropic` provider). */
export function createLlmGatewayClient(
  config: LlmGatewayConfig,
  options: LlmGatewayClientOptions = {},
): LlmGatewayClient | undefined {
  if (config.keySource !== "gateway" || !trimToUndefined(config.apiKey)) return undefined;
  return new LlmGatewayClient(config, options);
}

function modelNote(config: LlmGatewayConfig): string {
  const modelId = enrichmentModelId(config);
  if (modelId) return `model ${modelId}`;
  return isUsableModelId(config.modelId) ? "model [redacted]" : "empty model id; enrichment pass will fail, atlas still publishes";
}

/**
 * The single startup line for every LLM state (CLA-606): `LLM enrichment: off (<reason>)` or
 * `LLM enrichment: on → <host> (model <id>)` plus what runs. Host only: never a URL, never a key.
 */
export function describeLlmStartup(
  config: LlmGatewayConfig,
  options: { serverMode: "default" | "public-readonly"; scanEnrich?: "off" | "force" | "auto" },
): string {
  if (!hasLlmCredentials(config)) return `LLM enrichment: off (${config.offReason ?? "no provider"})`;
  const scanEnrich = options.serverMode === "public-readonly" ? "off" : options.scanEnrich ?? "auto";
  if (config.keySource === "anthropic") {
    if (options.serverMode === "public-readonly") return "LLM enrichment: off (anthropic serves scan enrichment only; public-readonly runs Ask only)";
    if (scanEnrich === "off") return "LLM enrichment: off (OKIE_SCAN_ENRICH=0, and anthropic serves scan enrichment only)";
  }
  const host = enrichmentProviderLabel(config) ?? "configured";
  const scope = config.keySource === "anthropic"
    ? "scan enrichment only; Ask and operator enrichment need openrouter or openai-compatible"
    : options.serverMode === "public-readonly"
      ? "Ask only; no scan enrichment in public-readonly"
      : scanEnrich === "off"
        ? "Ask and operator enrichment; scan enrichment off (OKIE_SCAN_ENRICH=0)"
        : "scan enrichment, operator enrichment and Ask";
  return `LLM enrichment: on → ${host} (${modelNote(config)}); ${scope}`;
}
