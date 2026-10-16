import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLlmGatewayClient, loadOperatorDotenv, resolveLlmGatewayConfig } from "./llmGateway.js";
import { createDefaultEnricherFactory } from "./scanService.js";

// CLA-606: LLM egress is an explicit opt-in. Generic provider keys in a developer's shell never send code anywhere.

const FAKE_KEY = "okie-test-cla606-fake-key";
const GENERIC = ["OPENROUTER_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

test("a generic provider key alone configures no gateway and no enricher", () => {
  for (const name of GENERIC) {
    const env = { [name]: FAKE_KEY };
    const config = resolveLlmGatewayConfig(env);
    assert.equal(config.keySource, "none", name);
    assert.equal(config.apiKey, undefined, name);
    assert.equal(createLlmGatewayClient(config), undefined, name);
    assert.equal(createDefaultEnricherFactory("auto", env)(() => {}), undefined, name);
    assert.equal(createDefaultEnricherFactory("force", env)(() => {}), undefined, `${name} with OKIE_SCAN_ENRICH=1`);
  }
});

test("OKIE_SCAN_ENRICH=1 alone (profile auth) never builds an enricher", () => {
  assert.equal(createDefaultEnricherFactory("force", {})(() => {}), undefined);
  assert.equal(createDefaultEnricherFactory("force", { OKIE_LLM_PROVIDER: "anthropic" })(() => {}), undefined);
});

test("OKIE_LLM_API_KEY without a provider opt-in stays off", () => {
  const config = resolveLlmGatewayConfig({ OKIE_LLM_API_KEY: FAKE_KEY });
  assert.equal(config.keySource, "none");
  assert.equal(createLlmGatewayClient(config), undefined);
});

test("opt-in + OKIE_LLM_API_KEY configures the gateway at the provider's base URL", () => {
  const openrouter = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_KEY });
  assert.equal(openrouter.keySource, "gateway");
  assert.equal(createLlmGatewayClient(openrouter)?.baseUrl, "https://openrouter.ai/api/v1");

  const compatible = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_BASE_URL: "https://llm.example.test/v1", OKIE_LLM_API_KEY: FAKE_KEY });
  assert.equal(createLlmGatewayClient(compatible)?.baseUrl, "https://llm.example.test/v1");

  // Generic names never override the OKIE_LLM_* ones (nor fill in for them).
  const generic = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OPENROUTER_API_KEY: FAKE_KEY, OPENROUTER_MODEL: "x/y" });
  assert.equal(generic.keySource, "none");
  const model = resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_KEY, OPENAI_MODEL: "x/y", OPENROUTER_MODEL: "x/z" });
  assert.notEqual(model.modelId, "x/y");
  assert.notEqual(model.modelId, "x/z");
});

test("provider misconfiguration fails loudly", () => {
  assert.throws(() => resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "bogus", OKIE_LLM_API_KEY: FAKE_KEY }), /bogus/);
  assert.throws(() => resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_BASE_URL: "https://elsewhere.test/v1", OKIE_LLM_API_KEY: FAKE_KEY }), /openai-compatible/);
  assert.throws(() => resolveLlmGatewayConfig({ OKIE_LLM_PROVIDER: "openai-compatible", OKIE_LLM_API_KEY: FAKE_KEY }), /OKIE_LLM_BASE_URL/);
});

test("repo-root .env is not read by default; it is read with --dotenv or OKIE_DOTENV=1", () => {
  const root = mkdtempSync(join(tmpdir(), "okie-cla606-dotenv-"));
  const probe = "OKIE_CLA606_DOTENV_PROBE";
  writeFileSync(join(root, ".env"), `${probe}=${FAKE_KEY}\n`);
  // The flag-taking signature is CLA-606's; the cast lets this file compile against the pre-change one.
  const load = loadOperatorDotenv as unknown as (repoRoot: string, argv?: string[], env?: NodeJS.Dict<string>) => unknown;
  try {
    load(root, [], {});
    assert.equal(process.env[probe], undefined, ".env loaded without being asked");
    load(root, ["--dotenv"], {});
    assert.equal(process.env[probe], FAKE_KEY);
    delete process.env[probe];
    load(root, [], { OKIE_DOTENV: "1" });
    assert.equal(process.env[probe], FAKE_KEY);
  } finally {
    delete process.env[probe];
    rmSync(root, { recursive: true, force: true });
  }
});

/** Starts dist/main.js with a scrubbed env, returns its stdout up to the first LLM line (or a timeout). */
async function startupOutput(env: Record<string, string>, args: string[] = []): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const work = mkdtempSync(join(tmpdir(), "okie-cla606-main-"));
  const localConfig = join(work, "okie.local.json");
  writeFileSync(localConfig, "{}");
  const child = spawn(process.execPath, [fileURLToPath(new URL("./main.js", import.meta.url)), ...args], {
    env: { PATH: process.env.PATH ?? "", HOME: work, OKIE_SERVER_PORT: "0", OKIE_SCAN_ROOT: join(work, "scan"), OKIE_LLM_CONFIG: localConfig, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const code = await new Promise<number | null>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 8_000);
    const poll = setInterval(() => { if (/LLM enrichment: .*\n/.test(stdout) && /listening on/.test(stdout)) child.kill("SIGTERM"); }, 25);
    child.on("exit", exitCode => { clearTimeout(timer); clearInterval(poll); resolve(exitCode); });
  });
  rmSync(work, { recursive: true, force: true });
  return { stdout, stderr, code };
}

for (const mode of ["default", "public-readonly"] as const) {
  const modeEnv = mode === "public-readonly" ? { OKIE_SERVER_MODE: "public-readonly" } : {};

  test(`${mode}: generic key alone → "LLM enrichment: off", one notice naming the ignored variable, no value`, async () => {
    const { stdout } = await startupOutput({ ...modeEnv, OPENROUTER_API_KEY: FAKE_KEY, OPENAI_MODEL: "x/y" });
    assert.match(stdout, /LLM enrichment: off \(no --llm-provider/);
    const notices = stdout.split("\n").filter(line => /ignor/i.test(line));
    assert.equal(notices.length, 1, stdout);
    assert.match(notices[0]!, /OPENROUTER_API_KEY/);
    assert.match(notices[0]!, /OPENAI_MODEL/);
    assert.match(notices[0]!, /--llm-provider|OKIE_LLM_PROVIDER/);
    assert.ok(!stdout.includes(FAKE_KEY));
  });

  test(`${mode}: OKIE_LLM_API_KEY without opt-in → off, says how to opt in`, async () => {
    const { stdout } = await startupOutput({ ...modeEnv, OKIE_LLM_API_KEY: FAKE_KEY });
    assert.match(stdout, /LLM enrichment: off \(.*(--llm-provider|OKIE_LLM_PROVIDER)/);
    assert.ok(!/ignor/i.test(stdout), "no notice without generic names");
    assert.ok(!stdout.includes(FAKE_KEY));
  });

  test(`${mode}: opt-in without OKIE_LLM_API_KEY → off, says why`, async () => {
    const { stdout } = await startupOutput({ ...modeEnv }, ["--llm-provider", "openrouter"]);
    assert.match(stdout, /LLM enrichment: off \(.*OKIE_LLM_API_KEY/);
  });

  test(`${mode}: opt-in + key → "LLM enrichment: on → openrouter.ai", host only, never the key`, async () => {
    const { stdout } = await startupOutput({ ...modeEnv, OKIE_LLM_PROVIDER: "openrouter", OKIE_LLM_API_KEY: FAKE_KEY, OKIE_LLM_MODEL: "test/model" });
    assert.match(stdout, /LLM enrichment: on → openrouter\.ai \(model test\/model\)/);
    assert.ok(!stdout.includes("https://"), "host only");
    assert.ok(!stdout.includes(FAKE_KEY));
    assert.equal(stdout.split("\n").filter(line => /^\[okie-server\] (ask gateway|enrichment):/.test(line)).length, 0, "the old competing lines are gone");
  });
}

test("an unknown provider stops the server at startup", async () => {
  const { stdout, stderr, code } = await startupOutput({ OKIE_LLM_API_KEY: FAKE_KEY }, ["--llm-provider=bogus"]);
  assert.notEqual(code, 0);
  assert.match(stderr, /bogus/);
  assert.ok(!/listening on/.test(stdout));
  assert.ok(!stderr.includes(FAKE_KEY));
});
