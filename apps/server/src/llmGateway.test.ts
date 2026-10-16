import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import {
  classifyLlmGatewayFailure,
  createLlmGatewayClient,
  DEFAULT_GATEWAY_MODEL_ID,
  DEFAULT_MAX_ENRICHMENT_DOLLARS,
  DEFAULT_MAX_ENRICHMENT_SCOPES,
  DEFAULT_MAX_ENRICHMENT_TOKENS,
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_REQUEST_TIMEOUT_MS,
  describeLlmStartup,
  ignoredGenericLlmEnvNotice,
  llmProviderArg,
  enrichmentModelId,
  enrichmentProviderLabel,
  hasLlmCredentials,
  isUsableModelId,
  LlmGatewayError,
  publicGatewayBaseUrl,
  publicLlmGatewayView,
  readGatewayUsage,
  readLlmGatewayLocalConfigFile,
  redactGatewayText,
  redactLlmSecret,
  redactTokenizedUrls,
  requireUsableModelId,
  resolveEnrichmentBudget,
  resolveLlmGatewayConfig,
  resolveLlmRateLimitConfig,
  resolveOperatorEnrichmentBudget,
  resolveOperatorEnrichmentDepth,
  resolveOperatorLeafReasoning,
  isOpenRouterProvider,
  resolveLlmGatewayLocalConfig,
  safeGatewayProvider,
  shouldSkipRemainingScopes,
} from "./llmGateway.js";

/** Distinctive fake — never a real key. Must not appear in healthz/logs/inspect. */
const FAKE_GATEWAY_KEY = "okie-test-llm-key-cla20-fake";
const FAKE_ANTHROPIC_KEY = "okie-test-anthropic-key-cla20-fake";
/** Obviously fake GitHub-shaped token for planted-secret tests (existing `gho_` scrub). */
const PLANTED_SOURCE_SECRET = "gho_okieTestPlantedSecretCla25xxxx";
/** Obviously fake URL userinfo/query tokens — never a live credential. */
const FAKE_URL_USERINFO = "okie-test-url-token-cla29-fake";
const FAKE_URL_QUERY = "okie-test-query-token-cla29-fake";
const TOKENIZED_GATEWAY_URL =
  `https://okietest:${FAKE_URL_USERINFO}@example.invalid/v1?api_key=${FAKE_URL_QUERY}`;

test("defaults suit OpenRouter: base URL and documented model id", () => {
  const config = resolveLlmGatewayConfig({});
  assert.equal(config.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(config.baseUrl, DEFAULT_OPENROUTER_BASE_URL);
  assert.equal(config.modelId, DEFAULT_GATEWAY_MODEL_ID);
  assert.equal(config.keySource, "none");
  assert.equal("apiKey" in config, false);
  assert.equal(hasLlmCredentials(config), false);
});

test("env maps onto base URL, model id, and gateway key", () => {
  const config = resolveLlmGatewayConfig({
    OKIE_LLM_BASE_URL: " https://example.gateway/v1 ",
    OKIE_LLM_MODEL: " acme/fast ",
    OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: ` ${FAKE_GATEWAY_KEY} `,
  });
  assert.equal(config.baseUrl, "https://example.gateway/v1");
  assert.equal(config.modelId, "acme/fast");
  assert.equal(config.keySource, "gateway");
  assert.equal(config.apiKey, FAKE_GATEWAY_KEY);
});

test("CLA-606: OPENROUTER_* / OPENAI_* / ANTHROPIC_* names are never read, even with a provider chosen", () => {
  const generic = {
    OPENROUTER_API_KEY: FAKE_GATEWAY_KEY,
    OPENAI_API_KEY: FAKE_GATEWAY_KEY,
    ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
    ANTHROPIC_AUTH_TOKEN: FAKE_ANTHROPIC_KEY,
    OPENROUTER_MODEL: "anthropic/claude-sonnet-4",
    OPENAI_MODEL: "openai/gpt-4o-mini",
  };
  for (const provider of [undefined, "openrouter", "anthropic"]) {
    const config = resolveLlmGatewayConfig(provider ? { ...generic, OKIE_LLM_PROVIDER: provider } : generic);
    assert.equal(config.keySource, "none", String(provider));
    assert.equal("apiKey" in config, false);
    assert.equal(config.modelId, DEFAULT_GATEWAY_MODEL_ID);
  }
  // OPENAI_BASE_URL is ignored too: openai-compatible still needs OKIE_LLM_BASE_URL.
  assert.throws(() => resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openai-compatible", OPENAI_BASE_URL: "https://api.openai.com/v1", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }), /OKIE_LLM_BASE_URL/);
  assert.match(ignoredGenericLlmEnvNotice({ ...generic, OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }) ?? "", /^LLM notice: ignoring OPENROUTER_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, OPENROUTER_MODEL, OPENAI_MODEL \(/);
  assert.doesNotMatch(ignoredGenericLlmEnvNotice(generic) ?? "", new RegExp(`${FAKE_GATEWAY_KEY}|${FAKE_ANTHROPIC_KEY}`));
  assert.equal(ignoredGenericLlmEnvNotice({ OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY, OPENAI_API_KEY: " " }), undefined);
});

test("CLA-606 review: ANTHROPIC_CUSTOM_HEADERS is named in the ignored-variables notice", () => {
  assert.match(ignoredGenericLlmEnvNotice({ ANTHROPIC_CUSTOM_HEADERS: "x-api-key: okie-test-header-fake" }) ?? "", /ignoring ANTHROPIC_CUSTOM_HEADERS \(/);
  assert.doesNotMatch(ignoredGenericLlmEnvNotice({ ANTHROPIC_CUSTOM_HEADERS: "x-api-key: okie-test-header-fake" }) ?? "", /okie-test-header-fake/);
});

test("CLA-606 review: the anthropic startup line and label show the real destination host", () => {
  const custom = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "anthropic", OKIE_LLM_BASE_URL: "https://custom-gateway.example.test", OKIE_LLM_API_KEY: FAKE_ANTHROPIC_KEY, OKIE_LLM_MODEL: "claude-x" });
  assert.equal(enrichmentProviderLabel(custom), "custom-gateway.example.test");
  assert.match(describeLlmStartup(custom, { serverMode: "default" }), /^LLM enrichment: on → custom-gateway\.example\.test \(model claude-x\)/);
  const tokenized = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "anthropic", OKIE_LLM_BASE_URL: TOKENIZED_GATEWAY_URL, OKIE_LLM_API_KEY: FAKE_ANTHROPIC_KEY });
  const line = describeLlmStartup(tokenized, { serverMode: "default" });
  assert.match(line, /^LLM enrichment: on → example\.invalid /);
  for (const secret of [FAKE_URL_USERINFO, FAKE_URL_QUERY, FAKE_ANTHROPIC_KEY, "https://"]) assert.ok(!line.includes(secret), secret);
  const standard = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "anthropic", OKIE_LLM_API_KEY: FAKE_ANTHROPIC_KEY });
  assert.match(describeLlmStartup(standard, { serverMode: "default" }), /^LLM enrichment: on → api\.anthropic\.com /);
});

test("CLA-606: provider values, CLI precedence, and off reasons", () => {
  assert.equal(llmProviderArg(["--llm-provider", "openrouter"]), "openrouter");
  assert.equal(llmProviderArg(["--llm-provider=anthropic", "--dotenv"]), "anthropic");
  assert.equal(llmProviderArg(["--dotenv"]), undefined);
  // The CLI value beats OKIE_LLM_PROVIDER.
  assert.equal(resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }, {}, "off").keySource, "none");
  assert.throws(() => resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter" }, {}, ""), /unknown LLM provider ""/);
  assert.equal(resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "OpenRouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }).provider, "openrouter");

  assert.match(resolveLlmGatewayConfig({}).offReason ?? "", /no --llm-provider/);
  assert.match(resolveLlmGatewayConfig({ OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }).offReason ?? "", /no provider is chosen; pass --llm-provider/);
  assert.match(resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "off", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }).offReason ?? "", /--llm-provider off/);
  assert.match(resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter" }).offReason ?? "", /openrouter is chosen but OKIE_LLM_API_KEY is unset/);
  for (const env of [{}, { OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }, { OKIE_LLM_PROVIDER: "openrouter" }]) {
    assert.doesNotMatch(resolveLlmGatewayConfig(env).offReason ?? "", new RegExp(FAKE_GATEWAY_KEY));
  }

  // openrouter is pinned to openrouter.ai: an override elsewhere (env or okie.local.json) fails loudly; the same URL is fine.
  assert.throws(() => resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }, { baseUrl: "https://elsewhere.test/v1" }), /openai-compatible/);
  assert.equal(resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_BASE_URL: "https://openrouter.ai/api/v1/", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }).baseUrl, DEFAULT_OPENROUTER_BASE_URL);
  assert.throws(() => resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }), /needs OKIE_LLM_BASE_URL/);
});

test("CLA-606: the anthropic provider reads OKIE_LLM_API_KEY, never builds a gateway client", () => {
  const config = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "anthropic", OKIE_LLM_API_KEY: FAKE_ANTHROPIC_KEY, ANTHROPIC_BASE_URL: "https://sniffed.test" });
  assert.equal(config.keySource, "anthropic");
  assert.equal(config.apiKey, FAKE_ANTHROPIC_KEY);
  assert.equal(config.baseUrl, "https://api.anthropic.com");
  assert.equal(createLlmGatewayClient(config), undefined, "Anthropic keys must not be sent to the OpenAI-compatible gateway");
  assert.equal(enrichmentProviderLabel(config), "api.anthropic.com");
  assert.equal(resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "anthropic", OKIE_LLM_BASE_URL: "https://proxy.test", OKIE_LLM_API_KEY: FAKE_ANTHROPIC_KEY }).baseUrl, "https://proxy.test");
});

test("CLA-606: one startup line per state, host only, never the key", () => {
  const on = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY, OKIE_LLM_MODEL: "acme/fast" });
  assert.equal(describeLlmStartup(on, { serverMode: "default", scanEnrich: "auto" }), "LLM enrichment: on → openrouter.ai (model acme/fast); scan enrichment, operator enrichment and Ask");
  assert.equal(describeLlmStartup(on, { serverMode: "public-readonly" }), "LLM enrichment: on → openrouter.ai (model acme/fast); Ask only; no scan enrichment in public-readonly");
  assert.match(describeLlmStartup(on, { serverMode: "default", scanEnrich: "off" }), /^LLM enrichment: on → openrouter\.ai .*scan enrichment off \(OKIE_SCAN_ENRICH=0\)/);
  assert.equal(describeLlmStartup(resolveLlmGatewayConfig({}), { serverMode: "default" }), "LLM enrichment: off (no --llm-provider / OKIE_LLM_PROVIDER)");
  const anthropic = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "anthropic", OKIE_LLM_API_KEY: FAKE_ANTHROPIC_KEY, OKIE_LLM_MODEL: "claude-x" });
  assert.match(describeLlmStartup(anthropic, { serverMode: "default" }), /^LLM enrichment: on → api\.anthropic\.com \(model claude-x\); scan enrichment only; Ask and operator enrichment need/);
  assert.match(describeLlmStartup(anthropic, { serverMode: "public-readonly" }), /^LLM enrichment: off \(anthropic serves scan enrichment only/);
  const compatible = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_BASE_URL: TOKENIZED_GATEWAY_URL, OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY });
  const line = describeLlmStartup(compatible, { serverMode: "default" });
  assert.match(line, /^LLM enrichment: on → example\.invalid /);
  for (const secret of [FAKE_GATEWAY_KEY, FAKE_ANTHROPIC_KEY, FAKE_URL_USERINFO, FAKE_URL_QUERY, "https://"]) {
    for (const text of [line, describeLlmStartup(on, { serverMode: "default" }), describeLlmStartup(anthropic, { serverMode: "default" })]) assert.ok(!text.includes(secret), secret);
  }
});

test("local config overlay wins for base URL and model id; keys stay env-only", () => {
  const config = resolveLlmGatewayConfig(
    {
      OKIE_LLM_BASE_URL: "https://from-env/v1",
      OKIE_LLM_MODEL: "env/model",
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    },
    { baseUrl: "https://from-local/v1", modelId: "local/model" },
  );
  assert.equal(config.baseUrl, "https://from-local/v1");
  assert.equal(config.modelId, "local/model");
  assert.equal(config.apiKey, FAKE_GATEWAY_KEY);
  assert.equal(config.keySource, "gateway");
});

test("gateway key wins over ANTHROPIC_* so Anthropic is not the only provider path", () => {
  const config = resolveLlmGatewayConfig({
    OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY,
  });
  assert.equal(config.keySource, "gateway");
  assert.equal(config.apiKey, FAKE_GATEWAY_KEY);
  const client = createLlmGatewayClient(config);
  assert.ok(client);
  assert.equal(client.baseUrl, DEFAULT_OPENROUTER_BASE_URL);
  assert.equal(client.modelId, DEFAULT_GATEWAY_MODEL_ID);
});

test("local config file maps baseUrl/modelId and ignores a misplaced apiKey", () => {
  const dir = mkdtempSync(join(tmpdir(), "okie-llm-local-"));
  try {
    const path = join(dir, "okie.local.json");
    writeFileSync(path, JSON.stringify({
      baseUrl: "https://file-gateway/v1/",
      modelId: "file/model",
      apiKey: FAKE_GATEWAY_KEY,
    }));
    const local = readLlmGatewayLocalConfigFile(path);
    assert.deepEqual(local, { baseUrl: "https://file-gateway/v1/", modelId: "file/model" });
    assert.equal("apiKey" in local, false);

    const resolved = resolveLlmGatewayLocalConfig(dir, {});
    assert.deepEqual(resolved, local);

    const viaEnv = resolveLlmGatewayLocalConfig("/unused", { OKIE_LLM_CONFIG: path });
    assert.deepEqual(viaEnv, local);

    assert.throws(
      () => resolveLlmGatewayLocalConfig(dir, { OKIE_LLM_CONFIG: join(dir, "missing.json") }),
      /OKIE_LLM_CONFIG file not found/,
    );

    const config = resolveLlmGatewayConfig({}, local);
    assert.equal(config.baseUrl, "https://file-gateway/v1/");
    assert.equal(config.modelId, "file/model");
    assert.equal(config.keySource, "none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public view, inspect, and JSON never contain the key", () => {
  const config = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY });
  const client = createLlmGatewayClient(config);
  assert.ok(client);

  const viewJson = JSON.stringify(publicLlmGatewayView(config));
  const configJson = JSON.stringify(config);
  const clientJson = JSON.stringify(client);
    const inspectedClient = inspect(client, { showHidden: true });
    const inspectedConfig = inspect(config, { showHidden: true });
  const described = describeLlmStartup(config, { serverMode: "default" });

  for (const blob of [viewJson, configJson, clientJson, inspectedClient, inspectedConfig, described]) {
    assert.doesNotMatch(blob, new RegExp(FAKE_GATEWAY_KEY));
  }
  assert.match(viewJson, /"keyConfigured":true/);
  assert.doesNotMatch(viewJson, /apiKey/);
  assert.equal(Object.keys(config).includes("apiKey"), false);
  assert.equal(client.hasApiKey, true);
  assert.equal(config.apiKey, FAKE_GATEWAY_KEY);
});

test("chatCompletions posts to the OpenAI-compatible path and redacts the key on errors", async () => {
  const config = resolveLlmGatewayConfig({
    OKIE_LLM_BASE_URL: "https://example.gateway/v1",
    OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    OKIE_LLM_MODEL: "acme/fast",
  });
  const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
  const client = createLlmGatewayClient(config, {
    fetch: async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        authorization: headers.get("authorization"),
        body: JSON.parse(String(init?.body)),
      });
      return new Response(`${FAKE_GATEWAY_KEY} leaked ${PLANTED_SOURCE_SECRET} in body`, { status: 401 });
    },
  });
  assert.ok(client);

  await assert.rejects(
    () => client.chatCompletions({ messages: [] }),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      assert.doesNotMatch(message, new RegExp(FAKE_GATEWAY_KEY));
      assert.equal(message.includes(PLANTED_SOURCE_SECRET), false);
      assert.match(message, /\[redacted-llm-key\]/);
      assert.match(message, /\[redacted-token\]/);
      assert.match(message, /401/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://example.gateway/v1/chat/completions");
  assert.equal(calls[0]!.authorization, `Bearer ${FAKE_GATEWAY_KEY}`);
  assert.equal((calls[0]!.body as { model: string }).model, "acme/fast");
});

test("chatCompletions scrubs a planted token out of the outbound JSON body", async () => {
  const config = resolveLlmGatewayConfig({
    OKIE_LLM_BASE_URL: "https://example.gateway/v1",
    OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    OKIE_LLM_MODEL: "acme/fast",
  });
  const bodies: string[] = [];
  const client = createLlmGatewayClient(config, {
    fetch: async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.ok(client);
  await client.chatCompletions({
    messages: [{ role: "user", content: `packet ${PLANTED_SOURCE_SECRET} ${FAKE_GATEWAY_KEY}` }],
  });
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0]!.includes(PLANTED_SOURCE_SECRET), false);
  assert.equal(bodies[0]!.includes(FAKE_GATEWAY_KEY), false);
  assert.match(bodies[0]!, /\[redacted-token\]/);
  assert.match(bodies[0]!, /\[redacted-llm-key\]/);
});

test("chatCompletions always sends the configured model id, even if body.model is set", async () => {
  const config = resolveLlmGatewayConfig({
    OKIE_LLM_BASE_URL: "https://example.gateway/v1",
    OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    OKIE_LLM_MODEL: "operator/chosen",
  });
  let posted: unknown;
  const client = createLlmGatewayClient(config, {
    fetch: async (_input, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.ok(client);
  await client.chatCompletions({ model: "injected/override", messages: [] });
  assert.equal((posted as { model: string }).model, "operator/chosen");
});

test("present-but-empty model id does not fall back to the documented default", () => {
  const fromEnv = resolveLlmGatewayConfig({
    OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    OKIE_LLM_MODEL: "  ",
  });
  assert.equal(fromEnv.modelId, "");
  assert.equal(isUsableModelId(fromEnv.modelId), false);

  const fromLocal = resolveLlmGatewayConfig(
    { OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY },
    { modelId: "" },
  );
  assert.equal(fromLocal.modelId, "");
  assert.throws(() => requireUsableModelId(fromLocal.modelId), /empty model id/);

  const unset = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY });
  assert.equal(unset.modelId, DEFAULT_GATEWAY_MODEL_ID);
  assert.equal(isUsableModelId(unset.modelId), true);
});

test("empty modelId in local config file is preserved as empty, not dropped", () => {
  const dir = mkdtempSync(join(tmpdir(), "okie-llm-empty-model-"));
  try {
    const path = join(dir, "okie.local.json");
    writeFileSync(path, JSON.stringify({ modelId: "   " }));
    const local = readLlmGatewayLocalConfigFile(path);
    assert.equal(local.modelId, "");
    const config = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY }, local);
    assert.equal(config.modelId, "");
    assert.match(describeLlmStartup(config, { serverMode: "default" }), /empty model id/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("redactLlmSecret is a no-op without a secret and never logs the key", () => {
  assert.equal(redactLlmSecret("ok", undefined), "ok");
  assert.equal(redactLlmSecret(`used ${FAKE_GATEWAY_KEY}`, FAKE_GATEWAY_KEY), "used [redacted-llm-key]");
});

test("redactGatewayText applies the existing GitHub token scrub and the operator key", () => {
  const mixed = `quota ${PLANTED_SOURCE_SECRET} key ${FAKE_GATEWAY_KEY}`;
  const redacted = redactGatewayText(mixed, FAKE_GATEWAY_KEY);
  assert.equal(redacted.includes(PLANTED_SOURCE_SECRET), false);
  assert.equal(redacted.includes(FAKE_GATEWAY_KEY), false);
  assert.match(redacted, /\[redacted-token\]/);
  assert.match(redacted, /\[redacted-llm-key\]/);
});

test("describeLlmStartup never includes the key", () => {
  const none = resolveLlmGatewayConfig({});
  assert.match(describeLlmStartup(none, { serverMode: "default" }), /^LLM enrichment: off \(/);
  assert.doesNotMatch(describeLlmStartup(none, { serverMode: "default", scanEnrich: "off" }), /openrouter\.ai/);

  const keyed = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY });
  const line = describeLlmStartup(keyed, { serverMode: "default" });
  assert.doesNotMatch(line, new RegExp(FAKE_GATEWAY_KEY));
  assert.match(line, /openrouter\.ai/);
  assert.match(line, /model xiaomi\/mimo-v2\.6-pro/);
  assert.doesNotMatch(line, /\/api\/v1/);
  assert.doesNotMatch(line, /https:\/\//);
});

test("describeLlmStartup and public views strip tokenized gateway URLs", () => {
  const config = resolveLlmGatewayConfig({
    OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    OKIE_LLM_BASE_URL: TOKENIZED_GATEWAY_URL,
  });
  const line = describeLlmStartup(config, { serverMode: "default" });
  assert.match(line, /example\.invalid/);
  assert.doesNotMatch(line, new RegExp(FAKE_URL_USERINFO));
  assert.doesNotMatch(line, new RegExp(FAKE_URL_QUERY));
  assert.doesNotMatch(line, /api_key=/);
  assert.doesNotMatch(line, /https:\/\//);
  assert.equal(enrichmentProviderLabel(config), "example.invalid");
  assert.equal(enrichmentModelId(config), DEFAULT_GATEWAY_MODEL_ID);

  const view = publicLlmGatewayView(config);
  assert.doesNotMatch(JSON.stringify(view), new RegExp(FAKE_URL_USERINFO));
  assert.doesNotMatch(JSON.stringify(view), new RegExp(FAKE_URL_QUERY));
  assert.equal(view.baseUrl.includes("example.invalid"), true);
  assert.equal(safeGatewayProvider(TOKENIZED_GATEWAY_URL), "example.invalid");
  assert.doesNotMatch(publicGatewayBaseUrl(TOKENIZED_GATEWAY_URL), new RegExp(FAKE_URL_USERINFO));
});

test("redactGatewayText strips tokenized gateway URLs and the operator key", () => {
  const mixed = `llm gateway 401: ${TOKENIZED_GATEWAY_URL} key ${FAKE_GATEWAY_KEY}`;
  const redacted = redactGatewayText(mixed, FAKE_GATEWAY_KEY);
  assert.equal(redacted.includes(FAKE_URL_USERINFO), false);
  assert.equal(redacted.includes(FAKE_URL_QUERY), false);
  assert.equal(redacted.includes(FAKE_GATEWAY_KEY), false);
  assert.match(redacted, /example\.invalid/);
  assert.match(redacted, /\[redacted-llm-key\]/);
  assert.equal(redactTokenizedUrls("plain https://openrouter.ai/api/v1 ok"), "plain https://openrouter.ai/api/v1 ok");
});

test("redactTokenizedUrls does not stop at a comma inside userinfo", () => {
  const password = "okie-test-secret-part-a,okie-test-secret-part-b";
  const query = "okie-test-query-token-cla29-fake";
  const url = `https://okietest:${password}@example.invalid/v1?api_key=${query}`;
  const redacted = redactTokenizedUrls(`llm gateway 401 from ${url}`);
  assert.equal(redacted.includes(password), false);
  assert.equal(redacted.includes(query), false);
  assert.match(redacted, /example\.invalid/);
  assert.doesNotMatch(redacted, /api_key=/);
});

test("redactTokenizedUrls does not stop at an apostrophe inside userinfo", () => {
  const password = "okie-test-part-a'okie-test-part-b";
  const query = "okie-test-query-token-cla29-fake";
  const url = `https://okietest:${password}@example.invalid/v1?api_key=${query}`;
  const redacted = redactTokenizedUrls(`llm gateway 401 from ${url}`);
  assert.equal(redacted.includes("okie-test-part-b"), false);
  assert.equal(redacted.includes(query), false);
  assert.match(redacted, /example\.invalid/);
});

test("inspect and public views redact a model id that equals the API key", () => {
  const config = resolveLlmGatewayConfig({
    OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    OKIE_LLM_MODEL: FAKE_GATEWAY_KEY,
  });
  const view = JSON.stringify(publicLlmGatewayView(config));
  const inspected = inspect(config, { showHidden: true });
  assert.doesNotMatch(view, new RegExp(FAKE_GATEWAY_KEY));
  assert.doesNotMatch(inspected, new RegExp(FAKE_GATEWAY_KEY));
  assert.match(view, /\[redacted\]/);
  const client = createLlmGatewayClient(config);
  assert.ok(client);
  assert.doesNotMatch(JSON.stringify(client), new RegExp(FAKE_GATEWAY_KEY));
  assert.doesNotMatch(inspect(client, { showHidden: true }), new RegExp(FAKE_GATEWAY_KEY));
});

test("enrichmentModelId omits a model field that is the API key or a tokenized URL", () => {
  const keyed = resolveLlmGatewayConfig({
    OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    OKIE_LLM_MODEL: FAKE_GATEWAY_KEY,
  });
  assert.equal(enrichmentModelId(keyed), undefined);
  const described = describeLlmStartup(keyed, { serverMode: "default" });
  assert.match(described, /model \[redacted\]/);
  assert.doesNotMatch(described, new RegExp(FAKE_GATEWAY_KEY));

  const tokenized = resolveLlmGatewayConfig({
    OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    OKIE_LLM_MODEL: TOKENIZED_GATEWAY_URL,
  });
  assert.equal(enrichmentModelId(tokenized), undefined);
  assert.doesNotMatch(describeLlmStartup(tokenized, { serverMode: "default" }), new RegExp(FAKE_URL_USERINFO));
});

test("CLA-606: without a key nothing is described as on, whatever OKIE_SCAN_ENRICH says", () => {
  const none = resolveLlmGatewayConfig({});
  for (const scanEnrich of ["auto", "force", "off"] as const) {
    assert.match(describeLlmStartup(none, { serverMode: "default", scanEnrich }), /^LLM enrichment: off \(/);
  }
});

test("resolveEnrichmentBudget reads env and keeps documented defaults", () => {
  assert.equal(DEFAULT_MAX_ENRICHMENT_TOKENS, 200_000);
  assert.deepEqual(resolveEnrichmentBudget({}), {
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    maxScopes: DEFAULT_MAX_ENRICHMENT_SCOPES,
    maxTokens: DEFAULT_MAX_ENRICHMENT_TOKENS,
    maxDollars: DEFAULT_MAX_ENRICHMENT_DOLLARS,
  });
  const custom = resolveEnrichmentBudget({
    OKIE_LLM_TIMEOUT_MS: "1500",
    OKIE_LLM_MAX_SCOPES: "3",
    OKIE_LLM_MAX_TOKENS: "9000",
    OKIE_LLM_MAX_DOLLARS: "0.25",
  });
  assert.deepEqual(custom, {
    requestTimeoutMs: 1500,
    maxScopes: 3,
    maxTokens: 9000,
    maxDollars: 0.25,
  });
  const invalid = resolveEnrichmentBudget({
    OKIE_LLM_TIMEOUT_MS: "nope",
    OKIE_LLM_MAX_SCOPES: "0",
    OKIE_LLM_MAX_TOKENS: "-4",
    OKIE_LLM_MAX_DOLLARS: "",
  });
  assert.deepEqual(invalid, resolveEnrichmentBudget({}));
});

test("operator enrichment env: budget, depth cap, and rate-limit keys with defaults", () => {
  assert.deepEqual(resolveOperatorEnrichmentBudget({}), { requestTimeoutMs: 120_000, maxScopes: 512, maxTokens: 4_000_000, maxDollars: 5 });
  assert.equal(resolveOperatorEnrichmentBudget({ OKIE_LLM_TIMEOUT_MS: "900" }).requestTimeoutMs, 120_000, "the public timeout key does not shorten operator requests");
  assert.equal(resolveEnrichmentBudget({ OKIE_LLM_OPERATOR_TIMEOUT_MS: "900" }).requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, "public scans keep OKIE_LLM_TIMEOUT_MS at 60s");
  assert.equal(DEFAULT_REQUEST_TIMEOUT_MS, 60_000);
  assert.deepEqual(resolveOperatorEnrichmentBudget({ OKIE_LLM_OPERATOR_TIMEOUT_MS: "900", OKIE_LLM_OPERATOR_MAX_REQUESTS: "12", OKIE_LLM_OPERATOR_MAX_TOKENS: "5000", OKIE_LLM_OPERATOR_MAX_DOLLARS: "0.5", OKIE_LLM_MAX_SCOPES: "1" }), { requestTimeoutMs: 900, maxScopes: 12, maxTokens: 5000, maxDollars: 0.5 });
  assert.deepEqual(resolveOperatorEnrichmentBudget({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "0", OKIE_LLM_OPERATOR_MAX_TOKENS: "x", OKIE_LLM_OPERATOR_MAX_DOLLARS: "-1", OKIE_LLM_OPERATOR_TIMEOUT_MS: "0" }), resolveOperatorEnrichmentBudget({}));
  assert.equal(resolveEnrichmentBudget({ OKIE_LLM_OPERATOR_MAX_REQUESTS: "99" }).maxScopes, DEFAULT_MAX_ENRICHMENT_SCOPES, "public scan budget ignores operator keys");
  assert.equal(resolveOperatorEnrichmentDepth({}), "component");
  assert.equal(resolveOperatorEnrichmentDepth({ OKIE_LLM_ENRICH_DEPTH: " Code " }), "code");
  assert.equal(resolveOperatorEnrichmentDepth({ OKIE_LLM_ENRICH_DEPTH: "everything" }), "component");
  assert.equal(resolveOperatorLeafReasoning({}), "on");
  assert.equal(resolveOperatorLeafReasoning({ OKIE_LLM_REASONING_LEAVES: " OFF " }), "off");
  assert.equal(resolveOperatorLeafReasoning({ OKIE_LLM_REASONING_LEAVES: "on" }), "on");
  assert.equal(resolveOperatorLeafReasoning({ OKIE_LLM_REASONING_LEAVES: "maybe" }), "on");
  assert.equal(isOpenRouterProvider(safeGatewayProvider("https://openrouter.ai/api/v1")), true);
  assert.equal(isOpenRouterProvider(safeGatewayProvider("https://api.openai.com/v1")), false);
  assert.equal(isOpenRouterProvider("openrouter.ai.evil.test"), false); assert.equal(isOpenRouterProvider(undefined), false);
  assert.deepEqual(resolveLlmRateLimitConfig({}), { maxConcurrent: 64, retries: 4, backoffMs: 1000 });
  assert.deepEqual(resolveLlmRateLimitConfig({ OKIE_LLM_MAX_CONCURRENT: "3", OKIE_LLM_RATE_LIMIT_RETRIES: "0", OKIE_LLM_RATE_LIMIT_BACKOFF_MS: "250" }), { maxConcurrent: 3, retries: 0, backoffMs: 250 });
  assert.deepEqual(resolveLlmRateLimitConfig({ OKIE_LLM_MAX_CONCURRENT: "0", OKIE_LLM_RATE_LIMIT_RETRIES: "-2", OKIE_LLM_RATE_LIMIT_BACKOFF_MS: "nope" }), { maxConcurrent: 64, retries: 4, backoffMs: 1000 });
});

test("readGatewayUsage parses OpenAI tokens and OpenRouter cost", () => {
  assert.deepEqual(readGatewayUsage({
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.02 },
  }), { promptTokens: 10, completionTokens: 5, totalTokens: 15, costUsd: 0.02 });
  assert.deepEqual(readGatewayUsage({ usage: { input_tokens: 3, output_tokens: 4 } }), {
    promptTokens: 3,
    completionTokens: 4,
    totalTokens: 7,
  });
  assert.deepEqual(readGatewayUsage({}, 1.5), { totalTokens: 0, costUsd: 1.5 });
  assert.equal(readGatewayUsage({ choices: [] }), undefined);
});

test("429 and 5xx abort remaining scopes; 4xx and timeout do not", () => {
  assert.equal(shouldSkipRemainingScopes(new LlmGatewayError("llm gateway 429: x", { kind: "rate_limit", status: 429 })), true);
  assert.equal(shouldSkipRemainingScopes(new Error("llm gateway 503: unavailable")), true);
  assert.equal(shouldSkipRemainingScopes(new Error("llm gateway 400: bad model")), false);
  assert.equal(classifyLlmGatewayFailure(new LlmGatewayError("timeout", { kind: "timeout" })), "timeout");
  assert.equal(shouldSkipRemainingScopes(new LlmGatewayError("timeout", { kind: "timeout" })), false);
});

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

test("chatCompletions times out against a hung fake HTTP gateway", async () => {
  const fake = await listenFakeGateway(() => {
    // Never respond — the client deadline must win.
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 80 });
    assert.ok(client);
    await assert.rejects(
      () => client.chatCompletions({ messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmGatewayError);
        assert.equal(error.kind, "timeout");
        assert.match(error.message, /timeout after 80ms/);
        assert.doesNotMatch(error.message, new RegExp(FAKE_GATEWAY_KEY));
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("chatCompletions parses usage from a fake HTTP gateway and redacts 429 bodies", async () => {
  let calls = 0;
  const fake = await listenFakeGateway((_request, response) => {
    calls += 1;
    if (calls === 1) {
      response.writeHead(200, {
        "content-type": "application/json",
        "x-openrouter-cost": "0.004",
      });
      response.end(JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      }));
      return;
    }
    response.writeHead(429, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: `quota ${FAKE_GATEWAY_KEY}` }));
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
      OKIE_LLM_MODEL: "acme/fast",
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    const ok = await client.chatCompletions({ messages: [] });
    assert.deepEqual(ok.usage, { promptTokens: 8, completionTokens: 2, totalTokens: 10, costUsd: 0.004 });
    await assert.rejects(
      () => client.chatCompletions({ messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmGatewayError);
        assert.equal(error.kind, "rate_limit");
        assert.equal(error.status, 429);
        assert.doesNotMatch(error.message, new RegExp(FAKE_GATEWAY_KEY));
        assert.match(error.message, /\[redacted-llm-key\]/);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test("chatCompletions maps 5xx from a fake HTTP gateway", async () => {
  const fake = await listenFakeGateway((_request, response) => {
    response.writeHead(503, { "content-type": "text/plain" });
    response.end(`upstream ${FAKE_GATEWAY_KEY}`);
  });
  try {
    const client = createLlmGatewayClient(resolveLlmGatewayConfig({
      OKIE_LLM_BASE_URL: fake.baseUrl,
      OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_GATEWAY_KEY,
    }), { timeoutMs: 2_000 });
    assert.ok(client);
    await assert.rejects(
      () => client.chatCompletions({ messages: [] }),
      (error: unknown) => {
        assert.ok(error instanceof LlmGatewayError);
        assert.equal(error.kind, "server");
        assert.equal(error.status, 503);
        assert.equal(shouldSkipRemainingScopes(error), true);
        assert.doesNotMatch(error.message, new RegExp(FAKE_GATEWAY_KEY));
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});
