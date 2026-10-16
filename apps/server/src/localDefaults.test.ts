import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_LISTEN_HOST, healthzBody, resolveListenHost } from "./localDefaults.js";
import { publicLlmGatewayView, resolveLlmGatewayConfig } from "./llmGateway.js";

const srcDir = fileURLToPath(new URL(".", import.meta.url));

test("listen host defaults to loopback, not all interfaces", () => {
  assert.equal(DEFAULT_LISTEN_HOST, "127.0.0.1");
  assert.equal(resolveListenHost({}), "127.0.0.1");
  assert.equal(resolveListenHost({ OKIE_SERVER_HOST: "  " }), "127.0.0.1");
  assert.notEqual(resolveListenHost({}), "0.0.0.0");
});

test("OKIE_SERVER_HOST is an explicit operator override, not the published default", () => {
  assert.equal(resolveListenHost({ OKIE_SERVER_HOST: "0.0.0.0" }), "0.0.0.0");
  assert.equal(resolveListenHost({ OKIE_SERVER_HOST: " localhost " }), "localhost");
});

test("healthz reports service status without scanRoot or filesystem paths", () => {
  const body = healthzBody({ enrich: "auto", bind: "127.0.0.1" });
  const json = JSON.stringify(body);

  assert.equal(body.service, "okie-scan-server");
  assert.equal(body.ok, true);
  assert.equal(body.public, false);
  assert.equal(body.bind, "127.0.0.1");
  assert.equal(body.enrich, "auto");
  assert.deepEqual(Object.keys(body).sort(), ["bind", "enrich", "ok", "public", "service"]);

  assert.equal("scanRoot" in body, false);
  assert.equal("modelId" in body, false);
  assert.equal("apiKey" in body, false);
  assert.doesNotMatch(json, /scanRoot/);
  assert.doesNotMatch(json, /modelId/);
  assert.doesNotMatch(json, /apiKey/);
  assert.doesNotMatch(json, /"\/[^"]+"/);
  assert.doesNotMatch(json, /[A-Za-z]:\\/);
});

test("scanServer serves healthzBody and main.ts listens on loopback without scanRoot on the wire", () => {
  const main = readFileSync(join(srcDir, "../src/main.ts"), "utf8");
  const server = readFileSync(join(srcDir, "../src/scanServer.ts"), "utf8");
  assert.match(server, /healthzBody\(\{\s*enrich,\s*bind\s*\}\)/);
  assert.match(main, /server\.listen\(port,\s*bind/);
  assert.doesNotMatch(main, /sendJson\([^;]*scanRoot/);
  assert.doesNotMatch(server, /sendJson\([^;]*scanRoot/);
});

test("healthz and scan HTTP never put an LLM API key on the wire", () => {
  const fakeKey = "okie-test-llm-key-cla20-fake";
  const config = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: fakeKey });
  const body = healthzBody({ enrich: "auto", bind: "127.0.0.1" });
  const json = JSON.stringify(body);
  const view = JSON.stringify(publicLlmGatewayView(config));

  assert.doesNotMatch(json, new RegExp(fakeKey));
  assert.doesNotMatch(view, new RegExp(fakeKey));
  assert.equal("apiKey" in body, false);

  const main = readFileSync(join(srcDir, "../src/main.ts"), "utf8");
  const server = readFileSync(join(srcDir, "../src/scanServer.ts"), "utf8");
  assert.match(server, /healthzBody\(\{\s*enrich,\s*bind\s*\}\)/);
  assert.doesNotMatch(server, /healthzBody\([^)]*apiKey/);
  assert.doesNotMatch(server, /healthzBody\([^)]*llm/);
  assert.match(main, /describeLlmStartup\(llm, \{ serverMode: "default", scanEnrich: enrich \}\)/);
  // CLA-261: job errors go through the error scrub (redactGatewayText + provider identifiers).
  assert.match(server, /toPublicJob\(job,\s*text => redactGatewayErrorText\(text,\s*llm\.apiKey\)\)/);
});

test("scan HTTP wires GitHub session identity and never the operator gh client", () => {
  const main = readFileSync(join(srcDir, "../src/main.ts"), "utf8");
  const server = readFileSync(join(srcDir, "../src/scanServer.ts"), "utf8");
  const oauth = readFileSync(join(srcDir, "../src/githubOAuth.ts"), "utf8");
  assert.match(server, /resolveScanGithubAccess\(/);
  assert.match(main, /createGithubAuthService/);
  assert.doesNotMatch(main, /createDefaultGithubClient/);
  assert.doesNotMatch(server, /createDefaultGithubClient/);
  assert.doesNotMatch(main, /GITHUB_TOKEN|GH_TOKEN/);
  assert.doesNotMatch(server, /GITHUB_TOKEN|GH_TOKEN/);
  assert.doesNotMatch(oauth, /GITHUB_TOKEN|GH_TOKEN/);
});
