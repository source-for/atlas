import assert from "node:assert/strict";
import test from "node:test";
import { GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE } from "./globalSpend.js";
import { publishedEnrichmentStatus } from "./publishedEnrichmentStatus.js";

const GATEWAY_NOTE = "llm gateway 401 from https://okietest:okie-test-url-token-cla75-fake@example.invalid/v1";

test("CLA-75: complete + rejected results → why rejected, no notes", () => {
  const status = publishedEnrichmentStatus({
    state: "complete",
    note: "2 scope(s) rejected by the gate; they stay deterministic",
    report: {
      results: [
        { accepted: false },
        { accepted: false },
      ],
    },
  });
  assert.deepEqual(status, {
    state: "complete",
    acceptedContainers: 0,
    attemptedContainers: 2,
    why: "rejected",
  });
  assert.equal(JSON.stringify(status).includes("rejected by the gate"), false);
  assert.doesNotMatch(JSON.stringify(status), /okietest|example\.invalid|scanRoot/);
});

test("CLA-75: skipped no-key does not copy the operator note", () => {
  // The pre-CLA-606 note and the current one (scanService skipNote).
  for (const note of ["no LLM credentials visible (set OKIE_LLM_API_KEY / OPENROUTER_API_KEY)", "no LLM credentials configured (OKIE_LLM_API_KEY is set but no provider is chosen; pass --llm-provider <name> or set OKIE_LLM_PROVIDER)"]) {
    const status = publishedEnrichmentStatus({ state: "skipped", note });
    assert.deepEqual(status, {
      state: "skipped",
      acceptedContainers: 0,
      attemptedContainers: 0,
      why: "no-key",
    });
    assert.doesNotMatch(JSON.stringify(status), /OKIE_LLM|OPENROUTER|credentials|provider/);
  }
});

test("CLA-75: skipped budget uses the job note category only", () => {
  const status = publishedEnrichmentStatus({
    state: "skipped",
    note: GLOBAL_ENRICHMENT_BUDGET_SKIP_NOTE,
  });
  assert.equal(status?.why, "budget");
  assert.doesNotMatch(JSON.stringify(status), /\$|tokens|spend/);
});

test("CLA-75: enrichment disabled omits the sidecar (pure deterministic)", () => {
  assert.equal(publishedEnrichmentStatus({
    state: "skipped",
    note: "enrichment disabled",
  }), undefined);
});

test("CLA-75: failed maps to failed without echoing gateway text", () => {
  const status = publishedEnrichmentStatus({
    state: "failed",
    note: GATEWAY_NOTE,
  });
  assert.deepEqual(status, {
    state: "failed",
    acceptedContainers: 0,
    attemptedContainers: 0,
    why: "failed",
  });
  assert.doesNotMatch(JSON.stringify(status), /okietest|example\.invalid|401/);
});

test("CLA-75: pending/running omit the sidecar", () => {
  assert.equal(publishedEnrichmentStatus({ state: "pending" }), undefined);
  assert.equal(publishedEnrichmentStatus({ state: "running" }), undefined);
});
