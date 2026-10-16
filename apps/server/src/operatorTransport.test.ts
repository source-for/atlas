import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyLlmGatewayFailure, createLlmGatewayClient, LlmGatewayError, resolveLlmGatewayConfig, transportCauseCode } from "./llmGateway.js";
import { runOperatorEnrichment, type OperatorEnrichmentAttempt, type OperatorEnrichmentScope, type OperatorEnrichmentStore, type OperatorExplanation } from "./operatorEnrichment.js";
import { OperatorStore } from "./operatorStore.js";

/** CLA-264: a dropped connection keeps its root cause and is retried once (after a short delay) through budget admission. */
const config = resolveLlmGatewayConfig({ OKIE_LLM_BASE_URL: "https://example.gateway/v1", OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: "test-gateway-cla264-not-a-real-credential", OKIE_LLM_MODEL: "acme/fast" });
const socketDrop = () => new TypeError("fetch failed", { cause: { code: "UND_ERR_SOCKET" } });
const okBody = (allowed: unknown) => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: "Handles x.", keyPoints: ["Start at `a.ts`.", "Watch the cache."], evidence: allowed }) } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5, cost: 0.001 } });
const scope: OperatorEnrichmentScope = { scopeId: "component:a", name: "a.ts", kind: "component", facts: {}, allowedEvidence: [{ entityId: "component:a", path: "a.ts" }] };

class MemoryStore implements OperatorEnrichmentStore {
  readonly attempts = new Map<string, OperatorEnrichmentAttempt>(); readonly current = new Map<string, OperatorExplanation>();
  async createAttempt(attempt: OperatorEnrichmentAttempt) { this.attempts.set(attempt.attemptId, { ...attempt }); }
  async updateAttempt(id: string, patch: Partial<Pick<OperatorEnrichmentAttempt, "state" | "updatedAt" | "usage" | "error">>) { Object.assign(this.attempts.get(id)!, patch); }
  async latestAttempt(scopeId: string) { return [...this.attempts.values()].filter(attempt => attempt.scopeId === scopeId).at(-1); }
  async putAcceptedExplanation(scopeId: string, explanation: OperatorExplanation) { this.current.set(scopeId, explanation); return { explanationVersionId: `v:${scopeId}` }; }
  async getAcceptedExplanation(scopeId: string) { return this.current.get(scopeId); }
  async markStale() {}
}

test("gateway: a fetch failure becomes a transport LlmGatewayError naming the undici cause code (not a bare `fetch failed`)", async () => {
  const client = createLlmGatewayClient(config, { fetch: async () => { throw socketDrop(); } })!;
  await assert.rejects(() => client.chatCompletions({ messages: [] }), (error: unknown) => {
    assert.ok(error instanceof LlmGatewayError); assert.equal(error.kind, "transport");
    assert.equal(error.message, "llm gateway transport error (UND_ERR_SOCKET)");
    assert.equal((error.cause as Error).message, "fetch failed", "the original error is kept as the cause");
    return true;
  });
});

test("gateway: a body that drops mid-read (`terminated`) is a transport error too; a timeout stays a timeout", async () => {
  const dropped = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { name: "SocketError", code: "UND_ERR_SOCKET" }) })); } }), { status: 200 });
  const client = createLlmGatewayClient(config, { fetch: async () => dropped() })!;
  await assert.rejects(() => client.chatCompletions({ messages: [] }), (error: unknown) => error instanceof LlmGatewayError && error.kind === "transport" && error.message === "llm gateway transport error (UND_ERR_SOCKET)");
  const abort = createLlmGatewayClient(config, { fetch: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); } })!;
  await assert.rejects(() => abort.chatCompletions({ messages: [] }), (error: unknown) => error instanceof LlmGatewayError && error.kind === "timeout");
});

test("transport cause names are scrub-safe codes only, and legacy stored messages classify as transport", () => {
  assert.equal(transportCauseCode(new TypeError("fetch failed", { cause: { code: "ECONNRESET", address: "10.0.0.1" } })), "ECONNRESET");
  assert.equal(transportCauseCode(new TypeError("fetch failed", { cause: Object.assign(new Error("connect to user@host failed"), { name: "SocketError" }) })), "SocketError", "a message is never used");
  assert.equal(transportCauseCode(new TypeError("fetch failed", { cause: { code: "not a code; secret=x" } })), "TypeError");
  assert.equal(transportCauseCode("weird"), "unknown cause");
  for (const legacy of [new TypeError("fetch failed"), new TypeError("terminated"), "TypeError: fetch failed", "llm gateway transport error (UND_ERR_SOCKET)"]) assert.equal(classifyLlmGatewayFailure(legacy), "transport", String(legacy));
  assert.equal(classifyLlmGatewayFailure(new Error("rejected explanation: terminated early")), undefined);
  for (const other of [new TypeError("terminated early by user"), new Error("terminated"), "terminated early by user", "fetch failed: something", new TypeError("fetch failed to parse")]) assert.equal(classifyLlmGatewayFailure(other), undefined, String(other));
});

test("enrichment: a transport failure is retried once after the delay, through admission, and succeeds", async () => {
  let calls = 0; const admitted: number[] = []; const started = Date.now();
  const client = createLlmGatewayClient(config, { fetch: async () => { calls += 1; if (calls === 1) throw socketDrop(); return new Response(okBody(scope.allowedEvidence), { status: 200 }); } })!;
  const store = new MemoryStore();
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope], store, gateway: client, transportRetryDelayMs: 40, admitRequest: () => { admitted.push(Date.now() - started); return true; } });
  assert.equal(calls, 2); assert.equal(admitted.length, 2, "the retry is admitted like any request");
  assert.ok(admitted[1]! - admitted[0]! >= 35, `the retry waits for the delay before admission (${admitted[1]! - admitted[0]!}ms)`);
  assert.equal(result.attempts.length, 1, "one attempt row"); assert.equal(result.attempts[0]!.state, "accepted");
  assert.equal(store.current.get("component:a")?.summary, "Handles x.");
});

test("enrichment: when both calls drop, the stored error names UND_ERR_SOCKET and survives the store's error rules", async () => {
  let calls = 0; const client = createLlmGatewayClient(config, { fetch: async () => { calls += 1; throw socketDrop(); } })!;
  const store = new MemoryStore();
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope], store, gateway: client, transportRetryDelayMs: 0 });
  assert.equal(calls, 2, "exactly one retry");
  const attempt = result.attempts[0]!; assert.equal(attempt.state, "failed"); assert.equal(attempt.error, "llm gateway transport error (UND_ERR_SOCKET)");
  const root = mkdtempSync(join(tmpdir(), "okie-transport-"));
  try {
    const operator = new OperatorStore(root); const run = operator.createRun({ idempotencyKey: "transport", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    operator.updateRun(run.runId, { error: attempt.error! });
    assert.equal(operator.snapshot().runs[0]!.error, "llm gateway transport error (UND_ERR_SOCKET)", "not withheld or mangled by the CLA-261 scrubbers");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enrichment: a refused retry admission fails the attempt with the transport error and stops at the limit", async () => {
  let calls = 0; let admissions = 0;
  const client = createLlmGatewayClient(config, { fetch: async () => { calls += 1; throw socketDrop(); } })!;
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope], store: new MemoryStore(), gateway: client, transportRetryDelayMs: 0, admitRequest: () => (admissions += 1) === 1 });
  assert.equal(calls, 1); assert.equal(result.stopped, "limit"); assert.match(result.attempts[0]!.error ?? "", /UND_ERR_SOCKET/);
});

test("enrichment: a call whose body dropped after the response started is settled with an estimated cost; a failed connect is not (CLA-264)", async () => {
  const dropped = () => new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("terminated", { cause: { code: "UND_ERR_SOCKET" } })); } }), { status: 200 });
  const settled: Array<{ estimatedCostUsd: number } | undefined> = [];
  const admit = () => ({ settle: (_usage?: unknown, estimate?: { estimatedCostUsd: number }) => { settled.push(estimate); } });
  const body = createLlmGatewayClient(config, { fetch: async () => dropped() })!;
  const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope], store: new MemoryStore(), gateway: body, transportRetryDelayMs: 0, admitRequest: admit, estimateDroppedCostUsd: () => 0.02 });
  assert.equal(result.attempts[0]!.state, "failed");
  assert.deepEqual(settled, [{ estimatedCostUsd: 0.02 }, { estimatedCostUsd: 0.02 }], "both dropped calls count against the dollar cap");
  settled.length = 0;
  const connect = createLlmGatewayClient(config, { fetch: async () => { throw socketDrop(); } })!;
  await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope], store: new MemoryStore(), gateway: connect, transportRetryDelayMs: 0, admitRequest: admit, estimateDroppedCostUsd: () => 0.02 });
  assert.deepEqual(settled, [undefined, undefined], "nothing was received: no estimate");
  settled.length = 0;
  await runOperatorEnrichment({ draftRevisionId: "d", scopes: [scope], store: new MemoryStore(), gateway: body, transportRetryDelayMs: 0, admitRequest: admit });
  assert.deepEqual(settled, [undefined, undefined], "no reported cost yet in this pass and no run average: nothing to estimate from");
});
