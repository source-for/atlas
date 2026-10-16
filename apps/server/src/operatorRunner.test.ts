import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePortableAtlas } from "@okie/architecture";
import { scanRepository } from "@okie/scan";
import { OperatorPublicationService } from "./operatorPublication.js";
import { createOperatorBudgetLedger } from "./operatorBudget.js";
import { createOperatorRunner } from "./operatorRunner.js";
import { OperatorStore } from "./operatorStore.js";
import { OperatorWorkflow } from "./operatorWorkflow.js";
import { LlmGatewayError, resolveLlmGatewayConfig } from "./llmGateway.js";
import { runOperatorEnrichment } from "./operatorEnrichment.js";
import { LlmRateLimiter } from "./llmRateLimiter.js";

test("runner writes parseable deterministic and immutable enriched drafts", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-"));
  try {
    const store = new OperatorStore(root);
    const run = store.createRun({ idempotencyKey: "x", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
    const runner = createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions(body) {
      const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope?: { scopeId: string; allowedEvidence: unknown[] } };
      return { json: { choices: [{ message: { content: JSON.stringify({ keyPoints: ["Start at the entry point.", "Watch the cache."], summary: `Summary ${message.scope!.scopeId}`, evidence: message.scope!.allowedEvidence.slice(0, 1) }) } }] }, usage: { totalTokens: 2 } };
    } } });
    await runner.enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    const drafts = store.snapshot().drafts;
    assert.equal(drafts.length, 2);
    const deterministic = store.readArtifactFile(drafts[0]!.artifactRevisionId, "atlas.okie.json")!;
    parsePortableAtlas(deterministic.toString());
    const sidecar = JSON.parse(store.readArtifactFile(drafts[1]!.artifactRevisionId, "operator-explanations.json")!.toString()) as { explanations: Array<{ content: { summary: string } }> };
    assert.match(sidecar.explanations[0]!.content.summary, /^Summary/);
    assert.deepEqual(deterministic, store.readArtifactFile(drafts[0]!.artifactRevisionId, "atlas.okie.json"));
    assert.equal(store.snapshot().publications.length, 0);
    const enriched = JSON.parse(store.readArtifactFile(drafts[1]!.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ kind: string; state: string }> };
    assert.ok(enriched.scopes.filter(scope => scope.kind === "code").every(scope => scope.state === "below cap"), "code symbols are below the default depth cap");
    assert.ok(enriched.scopes.filter(scope => scope.kind !== "code").every(scope => scope.state === "accepted"));
    assert.equal(drafts[1]!.coverage.accepted + drafts[1]!.coverage.failed + drafts[1]!.coverage.notRun + drafts[1]!.coverage.belowCap!, drafts[1]!.coverage.total);
    assert.equal(drafts[1]!.coverage.notRun, 0, "nothing in scope was left unrun");
    assert.equal(drafts[1]!.coverage.belowCap, enriched.scopes.filter(scope => scope.kind === "code").length);
    assert.equal(drafts[1]!.coverage.accepted, drafts[1]!.coverage.total - drafts[1]!.coverage.belowCap!, "every in-scope scope accepted");
    assert.ok(store.snapshot().attempts.every(attempt => attempt.state === "accepted"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner retries only the selected scope into a new immutable draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-retry-"));
  try {
    const store = new OperatorStore(root);
    const run = store.createRun({ idempotencyKey: "retry", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r", commitSha: "abc" } }).run;
    const scopes = [
      { scopeId: "system", name: "System", kind: "softwareSystem", sourceRefs: [{ path: "system.ts" }] },
      { scopeId: "component", parentScopeId: "system", name: "Component", kind: "component", sourceRefs: [{ path: "component.ts" }] },
      { scopeId: "target", parentScopeId: "component", name: "Target", kind: "code", sourceRefs: [{ path: "target.ts", startLine: 1, endLine: 2 }] },
      { scopeId: "sibling", parentScopeId: "component", name: "Sibling", kind: "code", sourceRefs: [{ path: "sibling.ts" }] },
    ];
    const oldSidecar = JSON.stringify({ schemaVersion: 1, scopes, explanations: [
      { scopeId: "system", explanationVersionId: "system-original", content: { summary: "old system", evidence: [{ entityId: "system", path: "system.ts" }] } },
      { scopeId: "component", explanationVersionId: "component-original", content: { summary: "old component", evidence: [{ entityId: "component", path: "component.ts" }] } },
      { scopeId: "target", explanationVersionId: "target-original", content: { summary: "old target", evidence: [{ entityId: "target", path: "target.ts", startLine: 1, endLine: 2 }] } },
      { scopeId: "sibling", explanationVersionId: "sibling-original", content: { summary: "old sibling", evidence: [{ entityId: "sibling", path: "sibling.ts" }] } },
    ] });
    const snapshot = JSON.stringify({ schemaVersion: 1, id: "snapshot", repositoryId: "o/r", commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", entities: scopes.map(scope => ({ id: scope.scopeId, ...(scope.parentScopeId ? { parentId: scope.parentScopeId } : {}), name: scope.name, kind: scope.kind, sourceRefs: scope.sourceRefs.map(ref => ({ ...ref, commitSha: "abc" })) })), relations: [] });
    const artifact = store.writeArtifactRevision({ repositoryId: "o/r", sourceCommitSha: "abc", files: { "snapshot.json": snapshot, "operator-explanations.json": oldSidecar, "atlas.okie.json": "old atlas" } });
    const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: 4, accepted: 4, failed: 0, notRun: 0, stale: 0 } });
    for (const scopeId of ["system", "component", "target", "sibling"]) store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId, kind: "enrichment", state: "accepted" });
    store.updateRun(run.runId, { state: "failed", error: "previous enrichment failure" });
    const calls: string[] = [];
    const runner = createOperatorRunner({
      store,
      publication: new OperatorPublicationService(store),
      scan: async () => { throw new Error("retry must not rescan"); },
      gateway: { modelId: "fake/model", async chatCompletions(body) {
        const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string; allowedEvidence: unknown[] } };
        calls.push(message.scope.scopeId);
        return { json: { choices: [{ message: { content: JSON.stringify({ keyPoints: ["Start at the entry point.", "Watch the cache."], summary: "new target", evidence: message.scope.allowedEvidence }) } }] } };
      } },
    });
    const oldBytes = store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!;
    await runner.enqueue({ kind: "retry", runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["target"], githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });

    assert.deepEqual(calls, ["target"]);
    assert.equal(store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!.compare(oldBytes), 0);
    const active = store.snapshot().runs.find(value => value.runId === run.runId)!;
    assert.notEqual(active.draftRevisionId, draft.draftRevisionId);
    assert.equal(active.error, undefined);
    const nextDraft = store.snapshot().drafts.find(value => value.draftRevisionId === active.draftRevisionId)!;
    assert.notEqual(nextDraft.artifactRevisionId, artifact.artifactRevisionId);
    const next = JSON.parse(store.readArtifactFile(nextDraft.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; stale?: boolean }>; explanations: Array<{ scopeId: string; explanationVersionId: string; content: { summary: string } }> };
    assert.deepEqual(next.explanations.find(value => value.scopeId === "sibling"), { scopeId: "sibling", explanationVersionId: "sibling-original", content: { summary: "old sibling", evidence: [{ entityId: "sibling", path: "sibling.ts" }] } });
    assert.equal(next.explanations.find(value => value.scopeId === "target")?.content.summary, "new target");
    assert.notEqual(next.explanations.find(value => value.scopeId === "target")?.explanationVersionId, "target-original");
    assert.deepEqual(next.scopes.filter(scope => scope.stale).map(scope => scope.scopeId), ["system", "component"]);
    assert.equal(nextDraft.coverage.stale, 2);
    for (const scopeId of ["system", "component"]) assert.ok(store.listAttempts(draft.draftRevisionId, scopeId).every(attempt => !attempt.stale));

    const refreshed: string[] = []; const childStates = new Map<string, Array<{ scopeId: string; state?: string; summary?: string }>>();
    const refresher = createOperatorRunner({ store, publication: new OperatorPublicationService(store), gateway: { modelId: "fake/model", async chatCompletions(body) {
      const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string; allowedEvidence: unknown[] }; children: Array<{ scopeId: string; state: string }> };
      refreshed.push(message.scope.scopeId);
      childStates.set(message.scope.scopeId, message.children);
      return { json: { choices: [{ message: { content: message.scope.scopeId === "component" ? "{}" : JSON.stringify({ keyPoints: ["Start at the entry point.", "Watch the cache."], summary: `refreshed ${message.scope.scopeId}`, evidence: message.scope.allowedEvidence }) } }] } };
    } } });
    await refresher.enqueue({ kind: "refresh", runId: run.runId, draftRevisionId: nextDraft.draftRevisionId, scopeIds: ["system", "component"], githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    assert.deepEqual(refreshed, ["component", "system"]);
    assert.deepEqual(childStates.get("component")?.map(child => ({ scopeId: child.scopeId, state: child.state })), [{ scopeId: "sibling", state: undefined }, { scopeId: "target", state: undefined }], "no enrichment state reaches the prompt");
    assert.deepEqual(childStates.get("system")?.map(child => ({ scopeId: child.scopeId, summary: child.summary })), [{ scopeId: "component", summary: "old component" }], "the failed refresh keeps component's pinned, still-stale explanation, sent without its state");
    assert.deepEqual(store.snapshot().attempts.filter(attempt => attempt.kind === "refresh").map(attempt => attempt.scopeId), ["component", "system"], "one owner attempt per refreshed scope; no coordinator planning attempts");
    const refreshedDraft = store.snapshot().drafts.find(value => value.draftRevisionId === store.snapshot().runs.find(value => value.runId === run.runId)?.draftRevisionId)!;
    const refreshedSidecar = JSON.parse(store.readArtifactFile(refreshedDraft.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; stale?: boolean }>; explanations: Array<{ scopeId: string; content: { summary: string } }> };
    assert.deepEqual(refreshedSidecar.scopes.filter(scope => scope.stale).map(scope => scope.scopeId), ["system", "component"]);
    assert.equal(refreshedDraft.coverage.stale, 2);
    assert.equal(refreshedSidecar.explanations.find(value => value.scopeId === "system")?.content.summary, "refreshed system");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner rejects pinned and concurrent retries once a newer draft exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-retry-cas-"));
  try {
    const store = new OperatorStore(root);
    const run = store.createRun({ idempotencyKey: "retry-cas", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r", commitSha: "abc" } }).run;
    const scopes = ["a", "b"].map(scopeId => ({ scopeId, name: scopeId, kind: "component" as const, sourceRefs: [{ path: `${scopeId}.ts` }] }));
    const snapshot = JSON.stringify({ schemaVersion: 1, id: "snapshot", repositoryId: "o/r", commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", entities: scopes.map(scope => ({ id: scope.scopeId, name: scope.name, kind: scope.kind, sourceRefs: [{ path: `${scope.scopeId}.ts`, commitSha: "abc" }] })), relations: [] });
    const sidecar = JSON.stringify({ schemaVersion: 1, scopes, explanations: scopes.map(scope => ({ scopeId: scope.scopeId, content: { summary: `old ${scope.scopeId}`, evidence: [{ entityId: scope.scopeId, path: `${scope.scopeId}.ts` }] } })) });
    const artifact = store.writeArtifactRevision({ repositoryId: "o/r", sourceCommitSha: "abc", files: { "snapshot.json": snapshot, "operator-explanations.json": sidecar, "atlas.okie.json": "old atlas" } });
    const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId });
    for (const scope of scopes) store.createAttempt({ draftRevisionId: draft.draftRevisionId, scopeId: scope.scopeId, kind: "enrichment", state: "accepted" });
    const runner = createOperatorRunner({ store, publication: new OperatorPublicationService(store), gateway: { modelId: "fake/model", async chatCompletions(body) {
      const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string; allowedEvidence: unknown[] } };
      return { json: { choices: [{ message: { content: JSON.stringify({ keyPoints: ["Start at the entry point.", "Watch the cache."], summary: `new ${message.scope.scopeId}`, evidence: message.scope.allowedEvidence }) } }] } };
    } } });
    const job = (scopeId: string) => runner.enqueue({ kind: "retry", runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: [scopeId], githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    await Promise.all([job("a"), job("b")]);
    const active = store.snapshot().runs.find(value => value.runId === run.runId)!;
    const next = store.snapshot().drafts.find(value => value.draftRevisionId === active.draftRevisionId)!;
    const explanations = JSON.parse(store.readArtifactFile(next.artifactRevisionId, "operator-explanations.json")!.toString()) as { explanations: Array<{ scopeId: string; content: { summary: string } }> };
    assert.equal(store.snapshot().drafts.length, 2);
    assert.equal(explanations.explanations.filter(value => value.content.summary.startsWith("new ")).length, 1);
    assert.equal(store.snapshot().events.filter(event => event.type === "draft.conflict" && event.detail?.reason === "retry_compare_and_swap").length, 1);

    await job("a");
    assert.equal(store.snapshot().drafts.length, 2);
    assert.equal(store.snapshot().events.filter(event => event.type === "draft.conflict" && event.detail?.reason === "stale_retry_base").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const operatorEnvKeys = ["OKIE_LLM_OPERATOR_MAX_REQUESTS", "OKIE_LLM_MAX_CONCURRENT", "OKIE_LLM_ENRICH_DEPTH", "OKIE_LLM_REASONING_LEAVES"] as const;
async function withEnv(values: Partial<Record<(typeof operatorEnvKeys)[number], string>>, work: () => Promise<void>): Promise<void> {
  const old = Object.fromEntries(operatorEnvKeys.map(key => [key, process.env[key]]));
  try { for (const key of operatorEnvKeys) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; } await work(); }
  finally { for (const key of operatorEnvKeys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } }
}
const access = { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } as const;
const summaryReply = (body: Record<string, unknown>) => { const message = JSON.parse(String((body.messages as Array<{ content: string }>)[1]!.content)) as { scope: { scopeId: string; allowedEvidence: unknown[] } }; return { json: { choices: [{ message: { content: JSON.stringify({ keyPoints: ["Start at the entry point.", "Watch the cache."], summary: `Summary ${message.scope.scopeId}`, evidence: message.scope.allowedEvidence.slice(0, 1) }) } }] }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }; };

test("runner reserves its durable budget before gateway calls and a refusal creates no attempt row", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-budget-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "1" }, async () => {
      const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "budget", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
      const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" }); let calls = 0;
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions() { calls += 1; return { json: { choices: [{ message: { content: "{}" } }] }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }; } } }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
      assert.equal(calls, 1);
      assert.equal(store.snapshot().events.filter(event => event.type === "budget.reserved").length, 1);
      assert.equal(store.snapshot().events.filter(event => event.type === "budget.settled").length, 1);
      assert.equal(store.snapshot().attempts.length, 1, "the ledger refusal does not leave a failed attempt row");
      const draft = store.snapshot().drafts.at(-1)!;
      assert.deepEqual({ accepted: draft.coverage.accepted, failed: draft.coverage.failed, notRun: draft.coverage.notRun }, { accepted: 0, failed: 1, notRun: draft.coverage.total - draft.coverage.belowCap! - 1 });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner keeps finished explanations when the budget stops the run", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-partial-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "3", OKIE_LLM_MAX_CONCURRENT: "2" }, async () => {
      const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "partial", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
      const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions(body) { return summaryReply(body); } } }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
      const state = store.snapshot(); const draft = state.drafts.at(-1)!;
      assert.equal(state.drafts.length, 2); assert.equal(state.runs[0]?.state, "awaiting_review"); assert.equal(state.runs[0]?.draftRevisionId, draft.draftRevisionId);
      assert.equal(state.explanations.length, 3);
      assert.ok(state.attempts.every(attempt => attempt.state === "accepted"), "no failed rows for budget-skipped scopes");
      assert.deepEqual(state.events.filter(event => event.type === "enrichment.budget_reached").map(event => event.detail), [{ accepted: 3, attempted: 3, ledger: "run" }], "the stop reason is visible in run activity");
      const sidecar = JSON.parse(store.readArtifactFile(draft.artifactRevisionId, "operator-explanations.json")!.toString()) as { scopes: Array<{ scopeId: string; state: string }>; explanations: Array<{ scopeId: string }> };
      assert.equal(sidecar.explanations.length, 3);
      assert.deepEqual(sidecar.scopes.filter(scope => scope.state === "accepted").map(scope => scope.scopeId).sort(), sidecar.explanations.map(value => value.scopeId).sort());
      const belowCap = sidecar.scopes.filter(scope => scope.state === "below cap").length; assert.ok(belowCap > 0);
      assert.equal(sidecar.scopes.filter(scope => scope.state === "not run").length, sidecar.scopes.length - belowCap - 3, "in-scope scopes left by the budget stop are not run; code scopes are below cap");
      assert.deepEqual(draft.coverage, { total: sidecar.scopes.length, accepted: 3, failed: 0, notRun: sidecar.scopes.length - belowCap - 3, stale: 0, belowCap });
      const detail = new OperatorWorkflow({ store, publications: new OperatorPublicationService(store), enqueue() {} }).draftDetail(draft.draftRevisionId)!;
      assert.equal(detail.scopes.filter(scope => scope.state === "accepted").length, draft.coverage.accepted);
      assert.equal(detail.scopes.filter(scope => scope.state === "not run").length, draft.coverage.notRun);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner rate-limit retries do not consume the durable request budget", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-429-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "2" }, async () => {
      const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "rate", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
      const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" }); let calls = 0;
      const rateLimiter = new LlmRateLimiter({ maxConcurrent: 4, retries: 2, backoffMs: 1, sleep: async () => undefined, now: (() => { let clock = 0; return () => (clock += 10); })() });
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), rateLimiter, githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions(body) { calls += 1; if (calls === 1) throw new LlmGatewayError("llm gateway 429: slow", { kind: "rate_limit", status: 429 }); return summaryReply(body); } } }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
      assert.equal(calls, 3, "one retried 429 plus two admitted requests");
      assert.equal(store.snapshot().events.filter(event => event.type === "budget.reserved").length, 2);
      assert.equal(store.snapshot().explanations.length, 2);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const scanned = () => scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
const publicClient = () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never;

test("a global-ledger refusal creates no attempt row, leaves scopes not run, and releases nothing onto the run ledger", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-global-"));
  try {
    await withEnv({}, async () => {
      const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "global", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
      const globalLedger = createOperatorBudgetLedger({ maxRequests: 0, maxTokens: 1_000_000, maxDollars: 1 }, { store, runId: "global-operator-enrichment" }); let calls = 0;
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), globalLedger, githubClient: publicClient, scan: async () => ({ commitSha: "abc", artifacts: scanned() }), gateway: { modelId: "fake/model", async chatCompletions(body) { calls += 1; return summaryReply(body); } } }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
      const state = store.snapshot(); const draft = state.drafts.at(-1)!;
      assert.equal(calls, 0); assert.equal(state.attempts.length, 0);
      assert.equal(state.events.filter(event => event.runId === run.runId && event.type.startsWith("budget.")).length, 0);
      assert.deepEqual(state.events.filter(event => event.type === "enrichment.budget_reached").map(event => event.detail?.ledger), ["global"], "the stop names the ledger that refused");
      assert.equal(state.runs.find(value => value.runId === run.runId)?.state, "awaiting_review");
      assert.deepEqual({ accepted: draft.coverage.accepted, failed: draft.coverage.failed, notRun: draft.coverage.notRun }, { accepted: 0, failed: 0, notRun: draft.coverage.total - draft.coverage.belowCap! });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("429 retries hold a single global and run reservation per admitted request", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-global-429-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "2" }, async () => {
      const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "global-429", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
      const globalLedger = createOperatorBudgetLedger({ maxRequests: 1_000, maxTokens: 100_000_000, maxDollars: 100 }, { store, runId: "global-operator-enrichment" }); let calls = 0;
      const rateLimiter = new LlmRateLimiter({ maxConcurrent: 1, retries: 3, backoffMs: 1, sleep: async () => undefined, now: (() => { let clock = 0; return () => (clock += 10); })() });
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), globalLedger, rateLimiter, githubClient: publicClient, scan: async () => ({ commitSha: "abc", artifacts: scanned() }), gateway: { modelId: "fake/model", async chatCompletions(body) { calls += 1; if (calls <= 2) throw new LlmGatewayError("llm gateway 429: slow", { kind: "rate_limit", status: 429 }); return summaryReply(body); } } }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
      const events = store.snapshot().events; const global = events.filter(event => event.runId === "global-operator-enrichment");
      assert.equal(calls, 4, "two 429s retried below admission plus two admitted requests");
      assert.equal(global.filter(event => event.type === "budget.reserved").length, 2, "retries never re-reserve the global ledger");
      assert.equal(global.filter(event => event.type === "budget.settled").length, 2);
      assert.equal(globalLedger.snapshot().requests, 2); assert.equal(globalLedger.snapshot().reservedTokens, 0, "settled with real usage");
      assert.equal(events.filter(event => event.runId === run.runId && event.type === "budget.reserved").length, 2);
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the durable run ledger can refuse while the run-level cap would still admit; the global reservation is released", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-seeded-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "3" }, async () => {
      const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "seeded", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
      const seeded = createOperatorBudgetLedger({ maxRequests: 3, maxTokens: 4_000_000, maxDollars: 5 }, { store, runId: run.runId });
      for (let index = 0; index < 2; index += 1) seeded.settle(seeded.reserve(10)!, { inputTokens: 1, outputTokens: 1 });
      let calls = 0; const globalLedger = createOperatorBudgetLedger({ maxRequests: 1_000, maxTokens: 100_000_000, maxDollars: 100 }, { store, runId: "global-operator-enrichment" });
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), globalLedger, githubClient: publicClient, scan: async () => ({ commitSha: "abc", artifacts: scanned() }), gateway: { modelId: "fake/model", async chatCompletions(body) { calls += 1; return summaryReply(body); } } }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
      const state = store.snapshot(); const draft = state.drafts.at(-1)!;
      assert.equal(calls, 1, "the run-level cap (3) allowed more, but the durable ledger had one request left");
      const global = state.events.filter(event => event.runId === "global-operator-enrichment");
      assert.ok(global.filter(event => event.type === "budget.released").length >= 1);
      assert.equal(global.filter(event => event.type === "budget.reserved").length - global.filter(event => event.type === "budget.released").length, 1);
      assert.equal(globalLedger.snapshot().requests, 1); assert.equal(global.filter(event => event.type === "budget.settled").length, 1);
      assert.equal(state.attempts.length, 1); assert.equal(state.explanations.length, 1);
      assert.deepEqual({ accepted: draft.coverage.accepted, failed: draft.coverage.failed, notRun: draft.coverage.notRun }, { accepted: 1, failed: 0, notRun: draft.coverage.total - draft.coverage.belowCap! - 1 });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("without a gateway the run records an unavailable event, no attempt rows, and every scope not run", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-unavailable-"));
  try {
    const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "unavailable", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    await createOperatorRunner({ store, publication: new OperatorPublicationService(store), gatewayConfig: { baseUrl: "https://gateway.invalid/v1", modelId: "m", keySource: "none" }, githubClient: publicClient, scan: async () => ({ commitSha: "abc", artifacts: scanned() }) }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
    const state = store.snapshot(); const draft = state.drafts.at(-1)!;
    assert.equal(state.attempts.length, 0); assert.equal(draft.coverage.notRun, draft.coverage.total - draft.coverage.belowCap!, "every in-scope scope is not run; code scopes stay below cap");
    assert.equal(state.events.filter(event => event.type === "enrichment.unavailable").length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("CLA-606 review: CLI --llm-provider off with a conflicting env still runs deterministically (no env re-resolution)", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-cli-off-"));
  // The env alone would fail loudly (openrouter + a foreign base URL); main.ts resolved it with the CLI value "off".
  const conflicting = { OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_BASE_URL: "https://custom.example.test/v1", OKIE_LLM_API_KEY: "okie-test-cla606-fake", OKIE_LLM_MODEL: "env/model" };
  const saved = Object.fromEntries(Object.keys(conflicting).map(name => [name, process.env[name]]));
  Object.assign(process.env, conflicting);
  try {
    const gatewayConfig = resolveLlmGatewayConfig(process.env, {}, "off");
    assert.equal(gatewayConfig.keySource, "none");
    const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "cli-off", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    await createOperatorRunner({ store, publication: new OperatorPublicationService(store), gatewayConfig, githubClient: publicClient, scan: async () => ({ commitSha: "abc", artifacts: scanned() }) }).enqueue({ kind: "run", runId: run.runId, githubAccess: access });
    const state = store.snapshot();
    assert.notEqual(state.runs.find(value => value.runId === run.runId)?.state, "failed");
    assert.equal(state.events.filter(event => event.type === "enrichment.unavailable").length, 1);
    assert.equal(state.attempts.length, 0);
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    rmSync(root, { recursive: true, force: true });
  }
});

test("CLA-606 review: runOperatorEnrichment without a gateway never re-resolves the provider from env", async () => {
  const saved = { OKIE_LLM_PROVIDER: process.env.OKIE_LLM_PROVIDER, OKIE_LLM_BASE_URL: process.env.OKIE_LLM_BASE_URL };
  Object.assign(process.env, { OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_BASE_URL: "https://custom.example.test/v1" });
  try {
    const result = await runOperatorEnrichment({ draftRevisionId: "d", scopes: [], store: { async createAttempt() {}, async updateAttempt() {} } as never });
    assert.equal(result.stopped, "unavailable");
  } finally {
    for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

test("a retry refused by an exhausted budget mints no draft, persists no stale marks, and explains why", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-retry-refused-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "1" }, async () => {
      const store = new OperatorStore(root);
      const run = store.createRun({ idempotencyKey: "refused", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r", commitSha: "abc" } }).run;
      const scopes = [{ scopeId: "system", name: "System", kind: "softwareSystem", state: "accepted", sourceRefs: [{ path: "s.ts" }] }, { scopeId: "leaf", parentScopeId: "system", name: "Leaf", kind: "component", state: "failed", sourceRefs: [{ path: "l.ts" }] }];
      const snapshot = JSON.stringify({ schemaVersion: 1, id: "snapshot", repositoryId: "o/r", commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", entities: scopes.map(scope => ({ id: scope.scopeId, ...(scope.parentScopeId ? { parentId: scope.parentScopeId } : {}), name: scope.name, kind: scope.kind, sourceRefs: scope.sourceRefs.map(ref => ({ ...ref, commitSha: "abc" })) })), relations: [] });
      const artifact = store.writeArtifactRevision({ repositoryId: "o/r", sourceCommitSha: "abc", files: { "snapshot.json": snapshot, "operator-explanations.json": JSON.stringify({ schemaVersion: 1, scopes, explanations: [{ scopeId: "system", content: { summary: "old", evidence: [{ entityId: "system", path: "s.ts" }] } }] }), "atlas.okie.json": "atlas" } });
      const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: 2, accepted: 1, failed: 1, notRun: 0, stale: 0 } });
      store.updateRun(run.runId, { state: "awaiting_review" });
      const exhausted = createOperatorBudgetLedger({ maxRequests: 1, maxTokens: 4_000_000, maxDollars: 5 }, { store, runId: run.runId }); exhausted.settle(exhausted.reserve(10)!, { inputTokens: 1, outputTokens: 1 });
      let calls = 0;
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), gateway: { modelId: "fake/model", async chatCompletions(body) { calls += 1; return summaryReply(body); } } }).enqueue({ kind: "retry", runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["leaf"], githubAccess: access });
      const state = store.snapshot(); const current = state.runs.find(value => value.runId === run.runId)!;
      assert.equal(calls, 0); assert.equal(state.drafts.length, 1); assert.equal(state.attempts.length, 0);
      assert.equal(current.state, "awaiting_review"); assert.equal(current.draftRevisionId, draft.draftRevisionId); assert.match(current.error ?? "", /was not run: this run's enrichment budget is exhausted/);
      assert.deepEqual(state.events.filter(event => event.type === "enrichment.budget_refused").map(event => event.detail?.ledger), ["run"]);
      assert.ok(!store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!.toString().includes("stale"));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a retry refused by the global ledger names the global limits, not the run budget; (variant of) a retry refused by an exhausted budget mints no draft, persists no stale marks, and explains why", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-retry-refused-"));
  try {
    await withEnv({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "1" }, async () => {
      const store = new OperatorStore(root);
      const run = store.createRun({ idempotencyKey: "refused", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r", commitSha: "abc" } }).run;
      const scopes = [{ scopeId: "system", name: "System", kind: "softwareSystem", state: "accepted", sourceRefs: [{ path: "s.ts" }] }, { scopeId: "leaf", parentScopeId: "system", name: "Leaf", kind: "component", state: "failed", sourceRefs: [{ path: "l.ts" }] }];
      const snapshot = JSON.stringify({ schemaVersion: 1, id: "snapshot", repositoryId: "o/r", commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", entities: scopes.map(scope => ({ id: scope.scopeId, ...(scope.parentScopeId ? { parentId: scope.parentScopeId } : {}), name: scope.name, kind: scope.kind, sourceRefs: scope.sourceRefs.map(ref => ({ ...ref, commitSha: "abc" })) })), relations: [] });
      const artifact = store.writeArtifactRevision({ repositoryId: "o/r", sourceCommitSha: "abc", files: { "snapshot.json": snapshot, "operator-explanations.json": JSON.stringify({ schemaVersion: 1, scopes, explanations: [{ scopeId: "system", content: { summary: "old", evidence: [{ entityId: "system", path: "s.ts" }] } }] }), "atlas.okie.json": "atlas" } });
      const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: 2, accepted: 1, failed: 1, notRun: 0, stale: 0 } });
      store.updateRun(run.runId, { state: "awaiting_review" });
      const globalLedger = createOperatorBudgetLedger({ maxRequests: 0, maxTokens: 1_000_000, maxDollars: 1 }, { store, runId: "global-operator-enrichment" });
      let calls = 0;
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), globalLedger, gateway: { modelId: "fake/model", async chatCompletions(body) { calls += 1; return summaryReply(body); } } }).enqueue({ kind: "retry", runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["leaf"], githubAccess: access });
      const state = store.snapshot(); const current = state.runs.find(value => value.runId === run.runId)!;
      assert.equal(calls, 0); assert.equal(state.drafts.length, 1); assert.equal(state.attempts.length, 0);
      assert.equal(current.state, "awaiting_review"); assert.equal(current.draftRevisionId, draft.draftRevisionId); assert.match(current.error ?? "", /was not run: the process-wide operator budget is exhausted\. Raise the global operator limits \(OKIE_LLM_GLOBAL_MAX_DOLLARS/);
      assert.deepEqual(state.events.filter(event => event.type === "enrichment.budget_refused").map(event => event.detail?.ledger), ["global"]);
      assert.ok(!store.readArtifactFile(artifact.artifactRevisionId, "operator-explanations.json")!.toString().includes("stale"));
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a retry leaves a not-run ancestor not run and unstale, and coverage matches the scope labels", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-notrun-ancestor-"));
  try {
    await withEnv({}, async () => {
      const store = new OperatorStore(root);
      const run = store.createRun({ idempotencyKey: "notrun", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r", commitSha: "abc" } }).run;
      const scopes = [{ scopeId: "system", name: "System", kind: "softwareSystem", state: "not run", sourceRefs: [{ path: "s.ts" }] }, { scopeId: "container", parentScopeId: "system", name: "Container", kind: "container", state: "accepted", sourceRefs: [{ path: "c.ts" }] }, { scopeId: "leaf", parentScopeId: "container", name: "Leaf", kind: "component", state: "failed", sourceRefs: [{ path: "l.ts" }] }];
      const snapshot = JSON.stringify({ schemaVersion: 1, id: "snapshot", repositoryId: "o/r", commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", entities: scopes.map(scope => ({ id: scope.scopeId, ...(scope.parentScopeId ? { parentId: scope.parentScopeId } : {}), name: scope.name, kind: scope.kind, sourceRefs: scope.sourceRefs.map(ref => ({ ...ref, commitSha: "abc" })) })), relations: [] });
      const artifact = store.writeArtifactRevision({ repositoryId: "o/r", sourceCommitSha: "abc", files: { "snapshot.json": snapshot, "operator-explanations.json": JSON.stringify({ schemaVersion: 1, scopes, explanations: [{ scopeId: "container", content: { summary: "old", evidence: [{ entityId: "container", path: "c.ts" }] } }] }), "atlas.okie.json": "atlas" } });
      const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: 3, accepted: 1, failed: 1, notRun: 1, stale: 0 } });
      await createOperatorRunner({ store, publication: new OperatorPublicationService(store), gateway: { modelId: "fake/model", async chatCompletions(body) { return summaryReply(body); } } }).enqueue({ kind: "retry", runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: ["leaf"], githubAccess: access });
      const next = store.snapshot().drafts.at(-1)!; assert.notEqual(next.draftRevisionId, draft.draftRevisionId);
      const detail = new OperatorWorkflow({ store, publications: new OperatorPublicationService(store), enqueue() {} }).draftDetail(next.draftRevisionId)!;
      assert.deepEqual(detail.scopes.map(scope => [scope.scopeId, scope.state, scope.stale]), [["system", "not run", false], ["container", "accepted", true], ["leaf", "accepted", false]]);
      assert.deepEqual(next.coverage, { total: 3, accepted: 2, failed: 0, notRun: 1, stale: 1, belowCap: 0 });
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner leaves cancelled scans and late gateway replies cancelled", async () => {
  const root = mkdtempSync(join(tmpdir(), "okie-runner-cancel-"));
  try {
    const store = new OperatorStore(root); const run = store.createRun({ idempotencyKey: "cancel-scan", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const artifacts = scanRepository(process.cwd(), { systemName: "Okie", repositorySlug: "okie" });
    const cancelledDuringScan = createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => { store.updateRun(run.runId, { state: "cancelled" }); return { commitSha: "abc", artifacts }; } });
    await cancelledDuringScan.enqueue({ kind: "run", runId: run.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    assert.equal(store.snapshot().runs.find(value => value.runId === run.runId)?.state, "cancelled"); assert.equal(store.snapshot().drafts.length, 0);

    const late = store.createRun({ idempotencyKey: "cancel-gateway", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r" } }).run;
    const cancelledDuringGateway = createOperatorRunner({ store, publication: new OperatorPublicationService(store), githubClient: () => ({ getJson: async () => ({ ok: true, json: { private: false } }) }) as never, scan: async () => ({ commitSha: "abc", artifacts }), gateway: { modelId: "fake/model", async chatCompletions() { store.updateRun(late.runId, { state: "cancelled" }); return { json: { choices: [{ message: { content: "{}" } }] }, usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } }; } } });
    await cancelledDuringGateway.enqueue({ kind: "run", runId: late.runId, githubAccess: { kind: "github", source: "test-double", token: "secret", login: "x", userId: "1" } });
    assert.equal(store.snapshot().runs.find(value => value.runId === late.runId)?.state, "cancelled");
    assert.equal(store.snapshot().explanations.filter(value => value.draftRevisionId === store.snapshot().drafts.at(-1)?.draftRevisionId).length, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("leaf reasoning control: only OpenRouter leaf requests get reasoning.enabled=false, and only when OKIE_LLM_REASONING_LEAVES=off", async () => {
  const bodyFor = async (setting: "on" | "off", baseUrl: string, role: "leaf" | "parent"): Promise<Record<string, unknown>> => {
    const root = mkdtempSync(join(tmpdir(), "okie-runner-reasoning-"));
    try {
      let captured: Record<string, unknown> | undefined;
      await withEnv({ OKIE_LLM_REASONING_LEAVES: setting }, async () => {
        const store = new OperatorStore(root);
        const run = store.createRun({ idempotencyKey: "reasoning", source: { repositoryId: "o/r", owner: "o", repo: "r", slug: "o-r", commitSha: "abc" } }).run;
        const scopes = [{ scopeId: "system", name: "System", kind: "softwareSystem", state: "accepted", sourceRefs: [{ path: "s.ts" }] }, { scopeId: "leaf", parentScopeId: "system", name: "Leaf", kind: "component", state: "accepted", sourceRefs: [{ path: "l.ts" }] }];
        const snapshot = JSON.stringify({ schemaVersion: 1, id: "snapshot", repositoryId: "o/r", commitSha: "abc", generatedAt: "2026-01-01T00:00:00.000Z", entities: scopes.map(scope => ({ id: scope.scopeId, ...(scope.parentScopeId ? { parentId: scope.parentScopeId } : {}), name: scope.name, kind: scope.kind, sourceRefs: scope.sourceRefs.map(ref => ({ ...ref, commitSha: "abc" })) })), relations: [] });
        const explanations = scopes.map(scope => ({ scopeId: scope.scopeId, content: { summary: "old", evidence: [{ entityId: scope.scopeId, path: scope.sourceRefs[0]!.path }] } }));
        const artifact = store.writeArtifactRevision({ repositoryId: "o/r", sourceCommitSha: "abc", files: { "snapshot.json": snapshot, "operator-explanations.json": JSON.stringify({ schemaVersion: 1, scopes, explanations }), "atlas.okie.json": "atlas" } });
        const draft = store.createDraftRevision({ runId: run.runId, artifactRevisionId: artifact.artifactRevisionId, coverage: { total: 2, accepted: 2, failed: 0, notRun: 0, stale: 0 } });
        await createOperatorRunner({ store, publication: new OperatorPublicationService(store), gateway: { baseUrl, modelId: "fake/model", async chatCompletions(body: Record<string, unknown>) { captured = body; return summaryReply(body); } } as never }).enqueue({ kind: "retry", runId: run.runId, draftRevisionId: draft.draftRevisionId, scopeIds: [role === "leaf" ? "leaf" : "system"], githubAccess: access });
      });
      return captured!;
    } finally { rmSync(root, { recursive: true, force: true }); }
  };
  for (const setting of ["on", "off"] as const) for (const baseUrl of ["https://openrouter.ai/api/v1", "https://api.example.test/v1"]) for (const role of ["leaf", "parent"] as const) {
    const body = await bodyFor(setting, baseUrl, role);
    const expected = setting === "off" && baseUrl.includes("openrouter.ai") && role === "leaf";
    assert.deepEqual(body.reasoning, expected ? { enabled: false } : undefined, `${setting} × ${baseUrl} × ${role}`);
  }
});
