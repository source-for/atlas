import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import type { GithubClient } from "@okie/scan";
import { createGithubAuthService, SESSION_COOKIE, TEST_LOGIN_PATH } from "./githubOAuth.js";
import { createScanJobQueue, createSubmitLimiter } from "./jobs.js";
import { ASK_REQUESTS_PER_WINDOW, createScanHttpHandler, resolveAskPerIpWindow } from "./scanServer.js";
import { createScanJobRunner } from "./scanService.js";
import { createAskRetrievalWorker, type AskRetrievalWorker } from "./askWorker.js";
import { resolveLlmGatewayConfig } from "./llmGateway.js";

const FAKE_TOKEN = "gho_okieTestOauthAccessTokenCla30xx";
const FAKE_SECRET = "okie-test-github-client-secret-cla30-fake";

function cookieFromSetCookie(setCookie: string[], name: string): string | undefined {
  for (const header of setCookie) {
    if (header.startsWith(`${name}=`)) return header.split(";")[0]!.slice(`${name}=`.length);
  }
  return undefined;
}

async function withServer(
  handler: ReturnType<typeof createScanHttpHandler>,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function mockGithubClient(): GithubClient {
  return {
    async getJson(apiPath) {
      if (apiPath === "/repos/lukeed/clsx") return { ok: true, json: { default_branch: "master" } };
      return { ok: false, status: 404, rateLimited: false, message: "Not Found" };
    },
    async downloadTarball() {
      throw new Error("download should not run in the auth-gate test");
    },
  };
}

test("unauthenticated POST /api/scans is denied and does not enqueue", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-auth-"));
  const submitted: string[] = [];
  const queue = createScanJobQueue(async job => {
    submitted.push(job.slug);
  });
  const auth = createGithubAuthService({
    bind: "127.0.0.1",
    env: { OKIE_GITHUB_TEST_DOUBLE: "0", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" },
  });
  const handler = createScanHttpHandler({
    queue,
    allowSubmit: createSubmitLimiter(),
    auth,
    scanRoot,
    llm: { baseUrl: "https://openrouter.ai/api/v1", modelId: "anthropic/claude-sonnet-4", keySource: "none" },
    enrich: "off",
    bind: "127.0.0.1",
  });
  try {
    await withServer(handler, async origin => {
      const denied = await fetch(`${origin}/api/scans`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${FAKE_TOKEN}` },
        body: JSON.stringify({ url: "https://github.com/lukeed/clsx" }),
      });
      assert.equal(denied.status, 401);
      const body = await denied.json() as { error: string; auth: { required: boolean; loginPath: string }; job?: unknown };
      assert.match(body.error, /Sign in with GitHub/);
      assert.equal(body.auth.required, true);
      assert.equal("job" in body, false);
      assert.equal(JSON.stringify(body).includes(FAKE_TOKEN), false);
      assert.deepEqual(submitted, []);

      const health = await fetch(`${origin}/healthz`);
      const healthBody = await health.json() as Record<string, unknown>;
      assert.equal(healthBody.ok, true);
      assert.equal("token" in healthBody, false);
      assert.equal("clientSecret" in healthBody, false);
      assert.equal(JSON.stringify(healthBody).includes(FAKE_TOKEN), false);
      assert.equal(JSON.stringify(healthBody).includes(FAKE_SECRET), false);

      const objects = await fetch(`${origin}/scan/index.json`);
      assert.equal(objects.status, 404);
    });
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("authenticated POST /api/scans enqueues and never puts the token on the job JSON", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-scan-auth-ok-"));
  const queue = createScanJobQueue(createScanJobRunner({
    scanRoot,
    enrich: "off",
    githubClient: mockGithubClient(),
  }));
  const auth = createGithubAuthService({
    bind: "127.0.0.1",
    env: {
      OKIE_GITHUB_TEST_DOUBLE: "1",
      OKIE_PUBLIC_ORIGIN: "http://localhost:4173",
    },
  });
  const handler = createScanHttpHandler({
    queue,
    allowSubmit: createSubmitLimiter(),
    auth,
    scanRoot,
    llm: { baseUrl: "https://openrouter.ai/api/v1", modelId: "anthropic/claude-sonnet-4", keySource: "none" },
    enrich: "off",
    bind: "127.0.0.1",
  });
  try {
    await withServer(handler, async origin => {
      const login = await fetch(`${origin}${TEST_LOGIN_PATH}`, { redirect: "manual" });
      const session = cookieFromSetCookie(login.headers.getSetCookie(), SESSION_COOKIE);
      assert.ok(session);

      const posted = await fetch(`${origin}/api/scans`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${SESSION_COOKIE}=${session}`,
        },
        body: JSON.stringify({ url: "https://github.com/lukeed/clsx" }),
      });
      assert.equal(posted.status, 202);
      const body = await posted.json() as { job: { slug: string; githubAccess?: unknown; token?: unknown } };
      assert.equal(body.job.slug, "lukeed__clsx");
      assert.equal("githubAccess" in body.job, false);
      assert.equal("token" in body.job, false);
      const json = JSON.stringify(body);
      assert.equal(json.includes("gho_"), false);
      await queue.idle();
    });
  } finally {
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// CLA-304: POST /api/ask hardening (per-IP window before the body, busy → 429, scrubbed citation details).

const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla304-fake";
const PLANTED_TOKEN = "ghp_okieTestPlantedTokenCla304xxxxxxxx";
const ASK_SHA = "0123456789abcdef0123456789abcdef01234567";

async function withFakeGateway(citations: string[], run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: "It tries WebGPU first.", citations }) } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected tcp address");
  try { await run(`http://127.0.0.1:${address.port}/v1`); } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

function askHandler(scanRoot: string, baseUrl: string, extra: Partial<Parameters<typeof createScanHttpHandler>[0]> = {}) {
  return createScanHttpHandler({
    queue: createScanJobQueue(async () => {}),
    allowSubmit: createSubmitLimiter(),
    auth: createGithubAuthService({ bind: "127.0.0.1", env: { OKIE_GITHUB_TEST_DOUBLE: "1", OKIE_PUBLIC_ORIGIN: "http://localhost:4173" } }),
    scanRoot,
    llm: resolveLlmGatewayConfig({ OKIE_LLM_BASE_URL: baseUrl, OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY, OKIE_LLM_MODEL: "acme/fast" }),
    enrich: "off",
    bind: "127.0.0.1",
    ...extra,
  });
}

async function signedIn(origin: string): Promise<string> {
  const login = await fetch(`${origin}${TEST_LOGIN_PATH}`, { redirect: "manual" });
  return `${SESSION_COOKIE}=${cookieFromSetCookie(login.headers.getSetCookie(), SESSION_COOKIE)}`;
}

const askBody = (question = "How is the renderer created?") => JSON.stringify({
  question,
  packets: [{ id: "container:web", name: "Web", kind: "container" }],
  atlas: { owner: "THISS", repo: "okie", commitSha: ASK_SHA, slug: "" },
});

/** Drives the handler directly with a fake socket address and session (no HTTP, no proxy). */
function fakeAskCall(handler: ReturnType<typeof createScanHttpHandler>, input: { remoteAddress: string; user: string; body: string }): Promise<{ status: number; body: string }> {
  const request = Object.assign(Readable.from([Buffer.from(input.body)]), {
    method: "POST", url: "/api/ask", headers: { "content-type": "application/json", "x-user": input.user, "x-forwarded-for": "198.51.100.99" }, socket: { remoteAddress: input.remoteAddress },
  });
  return new Promise(resolve => {
    let status = 0;
    const response = { writeHead: (code: number) => { status = code; return response; }, end: (text: string) => resolve({ status, body: text }) };
    void handler(request as never, response as never);
  });
}
const fakeAuth = { handle: async () => false, sessionFromRequest: (request: { headers: Record<string, string> }) => request.headers["x-user"] ? { userId: request.headers["x-user"] } : undefined };

test("POST /api/ask: account window first, then the per-IP window (non-loopback only), both before the body is read", async () => {
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-ask-ip-"));
  const ipKeys: string[] = []; const accountKeys: string[] = [];
  let accountAllowed = true; let ipAllowed = true;
  const handler = askHandler(scanRoot, "http://127.0.0.1:9/v1", {
    auth: fakeAuth as never,
    llm: resolveLlmGatewayConfig({}),
    allowAskIp: key => { ipKeys.push(key); return ipAllowed; },
    allowAsk: key => { accountKeys.push(key); return accountAllowed; },
  });
  try {
    const call = (remoteAddress: string, body = askBody()) => fakeAskCall(handler, { remoteAddress, user: "u1", body });
    // Admitted by both windows: a disconnected gateway answers { connected: false }.
    assert.deepEqual(await call("203.0.113.7"), { status: 200, body: `${JSON.stringify({ connected: false }, null, 2)}\n` });
    assert.deepEqual(ipKeys, ["ask-ip:203.0.113.7"], "keyed by the socket address, never X-Forwarded-For");
    // The account window refuses first: the IP window is not spent.
    accountAllowed = false;
    assert.equal((await call("203.0.113.7", "{ not json")).status, 429);
    assert.equal(ipKeys.length, 1);
    // The IP window refuses before the body is parsed: malformed JSON gets 429, not 400.
    accountAllowed = true; ipAllowed = false;
    const refused = await call("203.0.113.7", "{ not json");
    assert.equal(refused.status, 429);
    assert.match(refused.body, /address/);
    // Loopback (the dev / hosting proxy) is exempt from the IP window; IPv4-mapped and IPv6 /64 keys are normalised.
    for (const loopback of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) assert.equal((await call(loopback)).status, 200, loopback);
    assert.equal(ipKeys.length, 2, "loopback never touches the IP window");
    ipAllowed = true;
    await call("::ffff:203.0.113.8"); await call("2001:db8:1:2::5"); await call("2001:db8:1:2:aaaa::9");
    assert.deepEqual(ipKeys.slice(2), ["ask-ip:203.0.113.8", "ask-ip:2001:db8:1:2::/64", "ask-ip:2001:db8:1:2::/64"]);
    assert.ok(accountKeys.every(key => key === "ask:u1"));
  } finally { rmSync(scanRoot, { recursive: true, force: true }); }
});

test("POST /api/ask: one account's junk bodies behind the loopback proxy never lock Ask for other accounts (default limiters)", async () => {
  const previous = process.env.OKIE_ASK_PER_IP_WINDOW;
  process.env.OKIE_ASK_PER_IP_WINDOW = "5";
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-ask-lockout-"));
  try {
    assert.equal(resolveAskPerIpWindow({ OKIE_ASK_PER_IP_WINDOW: "7" }), 7);
    assert.equal(resolveAskPerIpWindow({ OKIE_ASK_PER_IP_WINDOW: "0" }), 60);
    assert.equal(resolveAskPerIpWindow({}), 60);
    const handler = askHandler(scanRoot, "http://127.0.0.1:9/v1", { auth: fakeAuth as never, llm: resolveLlmGatewayConfig({}) });
    const statuses: number[] = [];
    for (let count = 0; count < 60; count += 1) statuses.push((await fakeAskCall(handler, { remoteAddress: "127.0.0.1", user: "attacker", body: "{bad" })).status);
    assert.deepEqual([statuses.filter(code => code === 400).length, statuses.filter(code => code === 429).length], [ASK_REQUESTS_PER_WINDOW, 60 - ASK_REQUESTS_PER_WINDOW], "junk spends only the attacker's account window");
    assert.equal((await fakeAskCall(handler, { remoteAddress: "127.0.0.1", user: "someone-else", body: askBody() })).status, 200);
    // Off loopback the (configured) IP window applies to accounts the account window admits.
    const remote = await Promise.all(Array.from({ length: 6 }, (_, index) => fakeAskCall(handler, { remoteAddress: "203.0.113.50", user: `user-${index}`, body: askBody() })));
    assert.deepEqual(remote.map(result => result.status), [200, 200, 200, 200, 200, 429]);
  } finally {
    if (previous === undefined) delete process.env.OKIE_ASK_PER_IP_WINDOW; else process.env.OKIE_ASK_PER_IP_WINDOW = previous;
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("POST /api/ask retrieves only through the injected retrieval worker (no in-process corpus path)", async () => {
  await withFakeGateway(["component:only-from-worker"], async baseUrl => {
    const scanRoot = mkdtempSync(join(tmpdir(), "okie-ask-remote-only-"));
    // A real, parseable snapshot sits where the locator points: an in-process path would find it, but must never be taken.
    writeFileSync(join(scanRoot, "snapshot.json"), JSON.stringify({ commitSha: ASK_SHA, entities: [{ id: "system:okie", kind: "softwareSystem", name: "Okie", sourceRefs: [] }], relations: [] }));
    const calls: string[] = [];
    const worker: AskRetrievalWorker = {
      admit: (locations, commitSha) => {
        calls.push(`admit:${locations.map(location => location.source).join(",")}:${commitSha}`);
        return {
          run: async query => {
            calls.push(`run:${query.question}`);
            return { source: "scan", sections: [{ id: "component:only-from-worker", name: "src/worker.ts", kind: "component", path: "src/worker.ts", score: 1 }], bytes: 10, matchedTerms: ["worker"], systemOnly: false, containerNames: ["from-worker"], entityCount: 424_242, citationDetails: [] };
          },
          release: () => { calls.push("release"); },
        };
      },
      stats: () => ({ indexBuilds: 0, spawns: 0, timeouts: 0, crashes: 0, pending: 0, warmKeys: [], failedKeys: [] }),
      close: async () => undefined,
    };
    try {
      await withServer(askHandler(scanRoot, baseUrl, { askRetrieval: worker }), async origin => {
        const cookie = await signedIn(origin);
        const response = await fetch(`${origin}/api/ask`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: askBody() });
        const body = await response.json() as { retrieval: { mode: string; retrievedScopeIds: string[] }; citations: string[] };
        assert.equal(body.retrieval.mode, "atlas");
        assert.deepEqual(body.retrieval.retrievedScopeIds, ["component:only-from-worker"]);
        assert.deepEqual(body.citations, ["component:only-from-worker"]);
        assert.deepEqual(calls, [`admit:scan:${ASK_SHA}`, "run:How is the renderer created?", "release"]);
      });
    } finally { rmSync(scanRoot, { recursive: true, force: true }); }
  });
});

test("POST /api/ask: a busy retrieval worker answers 429 with retry-after before any gateway call", async () => {
  let gatewayCalls = 0;
  const server = createServer((_request, response) => { gatewayCalls += 1; response.end("{}"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const scanRoot = mkdtempSync(join(tmpdir(), "okie-ask-busy-"));
  let runs = 0;
  const busy: AskRetrievalWorker = { admit: () => "busy", stats: () => ({ indexBuilds: 0, spawns: 0, timeouts: 0, crashes: 0, pending: 8, warmKeys: [], failedKeys: [] }), close: async () => undefined };
  const handler = askHandler(scanRoot, `http://127.0.0.1:${address.port}/v1`, {
    askCorpus: { locate: () => [{ key: "file:x", source: "scan", snapshotPath: join(scanRoot, "snapshot.json"), size: 1 }] },
    askRetrieval: { ...busy, admit: (...args) => { runs += 1; return busy.admit(...args); } },
  });
  try {
    await withServer(handler, async origin => {
      const cookie = await signedIn(origin);
      const response = await fetch(`${origin}/api/ask`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: askBody() });
      assert.equal(response.status, 429);
      assert.equal(response.headers.get("retry-after"), "5");
      assert.deepEqual(await response.json(), { error: "Ask is busy; try again shortly." });
      assert.equal(runs, 1);
      assert.equal(gatewayCalls, 0);
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(scanRoot, { recursive: true, force: true });
  }
});

test("POST /api/ask: citation details in the response are scrubbed like the persisted thread (tokens, gateway key)", async () => {
  const snapshot = {
    commitSha: ASK_SHA,
    entities: [
      { id: "system:okie", kind: "softwareSystem", name: "Okie", sourceRefs: [] },
      { id: "container:web", kind: "container", parentId: "system:okie", name: "Web", sourceRefs: [] },
      { id: "component:create", kind: "component", parentId: "container:web", name: "src/renderer/createRenderer.ts", sourceRefs: [{ path: "apps/web/src/renderer/createRenderer.ts" }] },
      { id: "code:create", kind: "code", parentId: "component:create", name: `createRenderer ${PLANTED_TOKEN}`, sourceRefs: [{ path: `apps/web/src/${FAKE_GATEWAY_KEY}/createRenderer.ts`, symbol: "createRenderer", startLine: 3, endLine: 9 }], sourceExcerpts: [{ symbol: "createRenderer", startLine: 3, text: "export function createRenderer() {}" }] },
    ],
    relations: [],
  };
  await withFakeGateway(["code:create", "container:web"], async baseUrl => {
    const scanRoot = mkdtempSync(join(tmpdir(), "okie-ask-scrub-"));
    writeFileSync(join(scanRoot, "snapshot.json"), JSON.stringify(snapshot));
    const worker = createAskRetrievalWorker();
    try {
      await withServer(askHandler(scanRoot, baseUrl, { askRetrieval: worker }), async origin => {
        const cookie = await signedIn(origin);
        const response = await fetch(`${origin}/api/ask`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: askBody() });
        assert.equal(response.status, 200);
        const text = await response.text();
        const body = JSON.parse(text) as { retrieval: { mode: string }; citationDetails: Array<{ id: string; name: string; path?: string }>; thread: { turns: Array<{ citationDetails: unknown }> } };
        assert.equal(body.retrieval.mode, "atlas");
        const detail = body.citationDetails.find(row => row.id === "code:create");
        assert.ok(detail, text);
        assert.equal(detail.name, "createRenderer [redacted-token]");
        assert.doesNotMatch(detail.path ?? "", new RegExp(FAKE_GATEWAY_KEY));
        assert.equal(text.includes(PLANTED_TOKEN), false);
        assert.equal(text.includes(FAKE_GATEWAY_KEY), false);
        assert.deepEqual(body.citationDetails, body.thread.turns[0]!.citationDetails, "the response matches the persisted turn");
      });
    } finally { await worker.close(); rmSync(scanRoot, { recursive: true, force: true }); }
  });
});
