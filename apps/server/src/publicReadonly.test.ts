import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGithubAuthService } from "./githubOAuth.js";
import { createScanJobQueue, createSubmitLimiter } from "./jobs.js";
import { resolveLlmGatewayConfig } from "./llmGateway.js";
import { healthzBody } from "./localDefaults.js";
import { OperatorPublicationService } from "./operatorPublication.js";
import { OperatorStore } from "./operatorStore.js";
import { createPublishedOperatorFixture, FIXTURE_COMMIT, FIXTURE_LICENSE, FIXTURE_SLUG, memoryStoreClient } from "./publishedAtlas.fixture.js";
import { buildPublishedVersion, publishBuiltVersion } from "./publishAtlas.js";
import { createPublicReadonlyRuntime } from "./publicReadonly.js";
import { resetPublishedTrioCache } from "./scanNeighborhood.js";
import { ASK_COST_HEADER, ASK_OUTCOME_HEADER, ASK_TOKENS_HEADER, createPublicReadonlyHttpHandler, createScanHttpHandler, resolveServerMode, type ScanHttpHandler } from "./scanServer.js";

const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla266-fake";

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}
async function withHandler(handler: ScanHttpHandler, run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer((request, response) => { void handler(request, response); });
  const origin = await listen(server);
  try { await run(origin); } finally { await close(server); }
}

/** A fake OpenAI-compatible gateway; `usage` is what it reports for each completion. */
async function fakeGateway(usage: Record<string, unknown> | undefined): Promise<{ baseUrl: string; calls: () => number; server: Server }> {
  let calls = 0;
  const server = createServer((_request, response) => {
    calls += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "The web shell renders it.", citations: ["container:web"] }) } }], ...(usage ? { usage } : {}) }));
  });
  return { baseUrl: `${await listen(server)}/v1`, calls: () => calls, server };
}

function publicHandler(scanRoot: string, baseUrl: string, extra: Partial<Parameters<typeof createPublicReadonlyHttpHandler>[0]> = {}): ScanHttpHandler {
  const store = new OperatorStore(scanRoot);
  return createPublicReadonlyHttpHandler({
    mode: "public-readonly",
    published: { store, publications: new OperatorPublicationService(store) },
    scanRoot,
    llm: resolveLlmGatewayConfig({ OPENAI_BASE_URL: baseUrl, OPENROUTER_API_KEY: FAKE_GATEWAY_KEY, OPENROUTER_MODEL: "acme/fast" }),
    enrich: "off",
    bind: "0.0.0.0",
    ...extra,
  });
}

const atlas = { owner: "acme", repo: "demo", commitSha: FIXTURE_COMMIT, slug: FIXTURE_SLUG };
const askInit = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("CLA-266 OKIE_SERVER_MODE: default unless public-readonly; unknown values fail closed", () => {
  assert.equal(resolveServerMode({}), "default");
  assert.equal(resolveServerMode({ OKIE_SERVER_MODE: "default" }), "default");
  assert.equal(resolveServerMode({ OKIE_SERVER_MODE: "public-readonly" }), "public-readonly");
  assert.throws(() => resolveServerMode({ OKIE_SERVER_MODE: "public" }), /OKIE_SERVER_MODE/);
});

test("CLA-266 public-readonly: only Ask, block-plan, /scan/* and /healthz; OAuth, operator, automation and scan routes are 404", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-public-routes-"));
  try {
    const handler = publicHandler(scanRoot, "http://127.0.0.1:9/v1", { llm: resolveLlmGatewayConfig({}) });
    await withHandler(handler, async origin => {
      const status = async (path: string, init?: RequestInit) => (await fetch(`${origin}${path}`, { redirect: "manual", ...init })).status;
      for (const path of ["/api/auth/github", "/api/auth/github/callback?code=x&state=y", "/api/auth/github/test-login", "/api/auth/me", "/api/operator/session", "/api/operator/runs", "/api/scans", "/api/scans/job-1", "/", "/api/unknown"]) {
        assert.equal(await status(path), 404, `GET ${path}`);
      }
      for (const path of ["/api/scans", "/api/operator/runs", "/api/operator/cron/incremental", "/api/operator/webhooks/github", "/api/auth/logout"]) {
        assert.equal(await status(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://github.com/lukeed/clsx" }) }), 404, `POST ${path}`);
      }
      const health = await fetch(`${origin}/healthz`);
      assert.equal(health.status, 200);
      const text = await health.text();
      assert.deepEqual(JSON.parse(text), healthzBody({ enrich: "off", bind: "0.0.0.0" }));
      assert.equal(text.includes(scanRoot), false, "healthz never includes the scan root");
      assert.equal((await status("/scan/acme__demo/neighborhood.json")), 404, "nothing published → closed 404");
      assert.deepEqual(await (await fetch(`${origin}/api/ask`)).json(), { connected: false });
    });
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("CLA-266 public-readonly Ask: anonymous, no persisted thread, cost headers when the gateway reports them", async () => {
  const operatorRoot = mkdtempSync(join(tmpdir(), "okie-public-ask-op-"));
  const mirrorRoot = mkdtempSync(join(tmpdir(), "okie-public-ask-"));
  const withCost = await fakeGateway({ prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280, cost: 0.00042 });
  const tokensOnly = await fakeGateway({ prompt_tokens: 10, completion_tokens: 5 });
  const noUsage = await fakeGateway(undefined);
  try {
    createPublishedOperatorFixture(operatorRoot);
    const client = memoryStoreClient();
    await publishBuiltVersion(buildPublishedVersion({ scanRoot: operatorRoot, repo: "acme/demo", license: FIXTURE_LICENSE }), client);
    const r2 = createServer((request, response) => { const body = client.objects.get((request.url ?? "/").slice(1)); response.writeHead(body ? 200 : 404); response.end(body); });
    const storeUrl = await listen(r2);
    try {
      const runtime = createPublicReadonlyRuntime({ env: { OKIE_SCAN_ROOT: mirrorRoot, OKIE_PUBLISHED_STORE_URL: storeUrl, OKIE_PUBLISHED_REFRESH_MS: "0" }, llm: resolveLlmGatewayConfig({ OPENAI_BASE_URL: withCost.baseUrl, OPENROUTER_API_KEY: FAKE_GATEWAY_KEY, OPENROUTER_MODEL: "acme/fast" }), bind: "127.0.0.1", log: () => undefined });
      const origin = await listen(runtime.server);
      try {
        // Nothing synced yet: the Ask names the slug, so the mirror installs it on demand.
        const answered = await fetch(`${origin}/api/ask`, askInit({ question: "What renders the atlas?", packets: [], atlas }));
        assert.equal(answered.status, 200);
        const body = await answered.json() as Record<string, unknown> & { retrieval: { mode: string } };
        assert.equal(body.answer, "The web shell renders it.");
        assert.equal(body.retrieval.mode, "atlas", "the whole-atlas corpus came from the mirrored publication");
        assert.equal("thread" in body, false, "no identity → no persisted thread");
        assert.equal(answered.headers.get(ASK_COST_HEADER), "0.00042");
        assert.equal(answered.headers.get(ASK_TOKENS_HEADER), "1280");
        assert.equal(JSON.stringify(body).includes(FAKE_GATEWAY_KEY), false);
        const thread = await fetch(`${origin}/api/ask/thread?owner=acme&repo=demo&commitSha=${FIXTURE_COMMIT}`);
        assert.equal(thread.status, 200);
        assert.deepEqual(await thread.json(), { thread: { owner: "acme", repo: "demo", commitSha: FIXTURE_COMMIT, turns: [] } });
        assert.equal((await fetch(`${origin}/api/ask/thread?owner=acme`)).status, 400);
        // The 48 KB body cap holds.
        assert.equal((await fetch(`${origin}/api/ask`, askInit({ question: "x", packets: [], atlas, padding: "x".repeat(49 * 1024) }))).status, 400);
        const neighborhood = await fetch(`${origin}/scan/${FIXTURE_SLUG}/neighborhood.json`);
        assert.equal(neighborhood.status, 200);
      } finally { await close(runtime.server); rmSync(runtime.runtimeRoot, { recursive: true, force: true }); }

      // Tokens without a reported cost: only the tokens header. No usage: neither.
      for (const [gateway, cost, tokens] of [[tokensOnly, null, "15"], [noUsage, null, null]] as const) {
        const handler = publicHandler(mirrorRoot, gateway.baseUrl);
        await withHandler(handler, async origin => {
          const response = await fetch(`${origin}/api/ask`, askInit({ question: "What renders the atlas?", packets: [{ id: "container:web", name: "Web", kind: "container" }], atlas }));
          assert.equal(response.status, 200);
          assert.equal(response.headers.get(ASK_COST_HEADER), cost);
          assert.equal(response.headers.get(ASK_TOKENS_HEADER), tokens);
        });
      }
    } finally { await close(r2); }

    // Default mode is unchanged: no cost headers, sign-in required.
    const handler = createScanHttpHandler({
      queue: createScanJobQueue(async () => {}),
      allowSubmit: createSubmitLimiter(),
      auth: createGithubAuthService({ bind: "127.0.0.1", env: { OKIE_GITHUB_TEST_DOUBLE: "0", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" } }),
      scanRoot: mirrorRoot,
      llm: resolveLlmGatewayConfig({ OPENAI_BASE_URL: withCost.baseUrl, OPENROUTER_API_KEY: FAKE_GATEWAY_KEY, OPENROUTER_MODEL: "acme/fast" }),
      enrich: "off",
      bind: "127.0.0.1",
    });
    await withHandler(handler, async origin => {
      const response = await fetch(`${origin}/api/ask`, askInit({ question: "Where?", packets: [], atlas }));
      assert.equal(response.status, 401);
      assert.equal(response.headers.get(ASK_COST_HEADER), null);
    });
  } finally {
    resetPublishedTrioCache();
    await Promise.all([close(withCost.server), close(tokensOnly.server), close(noUsage.server)]);
    rmSync(operatorRoot, { recursive: true, force: true });
    rmSync(mirrorRoot, { recursive: true, force: true });
  }
});

test("CLA-266 public-readonly Ask: every answer without a gateway call reports cost 0 so the edge releases its estimate", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-public-ask-zero-"));
  const gateway = await fakeGateway({ total_tokens: 10, cost: 0.001 });
  try {
    const scoped = { question: "Where?", packets: [{ id: "container:web", name: "Web", kind: "container" }], atlas };
    const cases: Array<{ name: string; handler: ScanHttpHandler; init: RequestInit; status: number }> = [
      { name: "connected:false (no gateway key)", handler: publicHandler(scanRoot, gateway.baseUrl, { llm: resolveLlmGatewayConfig({}) }), init: askInit(scoped), status: 200 },
      { name: "empty question", handler: publicHandler(scanRoot, gateway.baseUrl), init: askInit({ ...scoped, question: "  " }), status: 200 },
      { name: "no scope and no published corpus", handler: publicHandler(scanRoot, gateway.baseUrl), init: askInit({ question: "Where?", packets: [], atlas }), status: 200 },
      { name: "malformed JSON", handler: publicHandler(scanRoot, gateway.baseUrl), init: { method: "POST", headers: { "content-type": "application/json" }, body: "{" }, status: 400 },
      { name: "missing atlas identity", handler: publicHandler(scanRoot, gateway.baseUrl), init: askInit({ question: "Where?" }), status: 400 },
      { name: "per-IP refusal", handler: publicHandler(scanRoot, gateway.baseUrl, { trustedProxy: "cloudflare", allowAskIp: () => false }), init: askInit(scoped), status: 429 },
    ];
    for (const item of cases) {
      await withHandler(item.handler, async origin => {
        const response = await fetch(`${origin}/api/ask`, item.init);
        assert.equal(response.status, item.status, item.name);
        assert.equal(response.headers.get(ASK_COST_HEADER), "0", item.name);
        assert.equal(response.headers.get(ASK_OUTCOME_HEADER), "unanswered", item.name);
        await response.body?.cancel();
      });
    }
    assert.equal(gateway.calls(), 0, "none of these reached the gateway");
    // A real call reports the gateway's cost, not 0.
    await withHandler(publicHandler(scanRoot, gateway.baseUrl), async origin => {
      const response = await fetch(`${origin}/api/ask`, askInit(scoped));
      assert.equal(response.headers.get(ASK_COST_HEADER), "0.001");
      assert.equal(response.headers.get(ASK_OUTCOME_HEADER), null, "an answer keeps the account's Ask");
    });
    assert.equal(gateway.calls(), 1);
  } finally {
    await close(gateway.server);
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("CLA-472 public-readonly Ask: a gateway failure is marked unanswered; a reply with reported usage is not", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-public-ask-unanswered-"));
  let status = 401;
  let usage: Record<string, unknown> | undefined;
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "", citations: [] }) } }], ...(usage ? { usage } : {}) }) : JSON.stringify({ error: { message: "API key expired" } }));
  });
  const baseUrl = `${await listen(server)}/v1`;
  try {
    const scoped = { question: "Where?", packets: [{ id: "container:web", name: "Web", kind: "container" }], atlas };
    await withHandler(publicHandler(scanRoot, baseUrl), async origin => {
      const failed = await fetch(`${origin}/api/ask`, askInit(scoped));
      assert.equal(failed.status, 200);
      assert.equal("answer" in (await failed.json() as Record<string, unknown>), false);
      assert.equal(failed.headers.get(ASK_OUTCOME_HEADER), "unanswered");
      assert.equal(failed.headers.get(ASK_COST_HEADER), null, "the edge keeps its dollar estimate");

      status = 200;
      usage = { total_tokens: 40, cost: 0.0002 };
      const billed = await fetch(`${origin}/api/ask`, askInit(scoped));
      assert.equal("answer" in (await billed.json() as Record<string, unknown>), false);
      assert.equal(billed.headers.get(ASK_COST_HEADER), "0.0002");
      assert.equal(billed.headers.get(ASK_OUTCOME_HEADER), null, "the model did the work");
    });
  } finally {
    await close(server);
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("CLA-266 public-readonly block plan: anonymous (no 401), per-IP admission with no account", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-public-plan-"));
  try {
    const admitted: Array<[string, string | undefined]> = [];
    const blockPlans = {
      config: { enabled: true },
      admit: (ip: string, account?: string) => { admitted.push([ip, account]); return undefined; },
      handleAdmitted: async () => ({ status: 404, body: { error: "Not the current publication of a published scan." } }),
    };
    const handler = publicHandler(scanRoot, "http://127.0.0.1:9/v1", { blockPlans: blockPlans as never });
    await withHandler(handler, async origin => {
      const response = await fetch(`${origin}/api/block-plan`, askInit({ scan: { slug: FIXTURE_SLUG, versionId: "v" }, nodeId: "n" }));
      assert.equal(response.status, 404);
      assert.deepEqual(admitted, [["127.0.0.1", undefined]]);
    });
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});
