import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { citationsNamedInAnswer, parseAskCompletion } from "./ask.js";
import {
  afterAskChatCompletionsBody,
  askRequestSha256,
  ASK_EVAL_DIR,
  buildAskEvalIndex,
  citedFiles,
  fileRecall,
  legacyAskChatCompletionsBody,
  loadAskEvalFixture,
  runAskEvalQuestion,
  saysNotInEvidence,
} from "./askEval.js";
import {
  createLlmGatewayClient,
  ignoredGenericLlmEnvNotice,
  llmProviderArg,
  loadOperatorDotenv,
  redactGatewayErrorText,
  resolveLlmGatewayConfig,
  resolveLlmGatewayLocalConfig,
  type GatewayUsage,
} from "./llmGateway.js";

/**
 * CLA-265 live Ask eval: runs every question in `fixtures/ask-eval/questions.json` BEFORE (old
 * prompt + web scope packets) and AFTER (whole-atlas retrieval) against the configured gateway,
 * records raw completions + usage to `fixtures/ask-eval/replay.json`, and prints a table.
 * Never runs in CI (`askEval.test.ts` replays the file instead).
 *
 *   node apps/server/dist/askEvalLive.js --llm-provider openrouter [--dotenv] [--max-dollars 0.5]   # needs OKIE_LLM_API_KEY
 *   node apps/server/dist/askEvalLive.js --score-only   # re-score replay.json, no spend
 *   node apps/server/dist/askEvalLive.js --only id1,id2 --max-dollars 0.1   # (re)record just these; keeps the other runs
 */

export interface AskEvalReplayCall {
  allowedIds: string[];
  /** sha256 of the exact request body (before the live-only `usage` flag); CI recomputes it. */
  requestSha256: string;
  /** Minimal chat-completions JSON so `parseAskCompletion` can replay it. */
  completion: { choices: Array<{ message: { content: string } }> };
  usage?: GatewayUsage;
}

export interface AskEvalReplay {
  schema: "ask-eval-replay/v1";
  modelId: string;
  corpusCommitSha: string;
  generatedAt: string;
  totalCostUsd: number;
  runs: Array<{ id: string; before: AskEvalReplayCall; after: AskEvalReplayCall }>;
}

function contentOf(json: unknown): string {
  const choice = (json as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === "string" ? content : JSON.stringify(content ?? "");
}

/** `--score-only`: re-print the table from the recorded replay.json (no gateway calls, no spend). */
function scoreOnly(): void {
  const fixture = loadAskEvalFixture();
  const index = buildAskEvalIndex(fixture);
  const replay = JSON.parse(readFileSync(join(ASK_EVAL_DIR, "replay.json"), "utf8")) as AskEvalReplay;
  console.log("| question | evidence recall before | evidence recall after | cited recall before | not-in-evidence before | cited recall after | not-in-evidence after |\n|---|---|---|---|---|---|---|");
  for (const question of fixture.questions) {
    const recorded = replay.runs.find(row => row.id === question.id);
    if (!recorded) continue;
    const run = runAskEvalQuestion(fixture, index, question);
    const score = (call: AskEvalReplayCall, sections: typeof run.after.sections) => {
      const parsed = parseAskCompletion(call.completion, new Set(call.allowedIds));
      const citations = parsed ? citationsNamedInAnswer(parsed.answer, parsed.citations, sections) : [];
      return [fileRecall(question.expectedFiles, citedFiles(citations, index, run.before.packets)).toFixed(2), parsed && saysNotInEvidence(parsed.answer) ? "yes" : "no"];
    };
    console.log(`| ${question.id}${question.heldOut ? " (held-out)" : ""} | ${run.before.recall.toFixed(2)} | ${run.after.recall.toFixed(2)} | ${[...score(recorded.before, []), ...score(recorded.after, run.after.sections)].join(" | ")} |`);
  }
  console.log(`\nmodel ${replay.modelId}; recorded live spend $${replay.totalCostUsd.toFixed(4)}`);
}

/** The key the run used, for redacting a failure message. */
let usedKey: string | undefined;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--score-only")) { scoreOnly(); return; }
  const capIndex = argv.indexOf("--max-dollars");
  const maxDollars = capIndex >= 0 ? Number.parseFloat(argv[capIndex + 1] ?? "") : 0.5;
  if (!Number.isFinite(maxDollars) || maxDollars <= 0) throw new Error("--max-dollars must be positive");
  const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
  // CLA-606: .env only with --dotenv / OKIE_DOTENV=1; egress only with --llm-provider (or OKIE_LLM_PROVIDER) + OKIE_LLM_API_KEY.
  loadOperatorDotenv(repoRoot, argv);
  const notice = ignoredGenericLlmEnvNotice(process.env);
  if (notice) console.error(notice);
  const config = resolveLlmGatewayConfig(process.env, resolveLlmGatewayLocalConfig(repoRoot), llmProviderArg(argv));
  usedKey = config.apiKey;
  const client = createLlmGatewayClient(config, { timeoutMs: 120_000 });
  if (!client) throw new Error(`No OpenAI-compatible gateway configured: ${config.offReason ?? `--llm-provider ${config.provider ?? ""} has no gateway`} (needs --llm-provider openrouter|openai-compatible and OKIE_LLM_API_KEY).`);

  const fixture = loadAskEvalFixture();
  const index = buildAskEvalIndex(fixture);
  const onlyIndex = argv.indexOf("--only");
  const only = onlyIndex >= 0 ? new Set((argv[onlyIndex + 1] ?? "").split(",").filter(Boolean)) : undefined;
  if (only && [...only].some(id => !fixture.questions.some(question => question.id === id))) throw new Error("--only names an unknown question id");
  // --only keeps the other recorded runs (same model + corpus) and replaces/adds the named ones.
  const prior = only ? JSON.parse(readFileSync(join(ASK_EVAL_DIR, "replay.json"), "utf8")) as AskEvalReplay : undefined;
  if (prior && (prior.modelId !== config.modelId || prior.corpusCommitSha !== fixture.snapshot.commitSha)) throw new Error("--only needs replay.json recorded with the same model and corpus");
  const priorCostUsd = prior?.totalCostUsd ?? 0;
  const replay: AskEvalReplay = {
    schema: "ask-eval-replay/v1",
    modelId: config.modelId,
    corpusCommitSha: fixture.snapshot.commitSha,
    generatedAt: new Date().toISOString(),
    totalCostUsd: priorCostUsd,
    runs: prior ? prior.runs.filter(run => !only!.has(run.id)) : [],
  };
  const rows: string[][] = [];
  // Worst observed pair ≈ $0.02; stop before a question could cross the cap and keep what ran.
  const pairReserveUsd = 0.02;
  const call = async (body: Record<string, unknown>, allowedIds: string[]): Promise<AskEvalReplayCall> => {
    const result = await client.chatCompletions({ ...body, usage: { include: true } });
    replay.totalCostUsd += result.usage?.costUsd ?? 0;
    return { allowedIds, requestSha256: askRequestSha256(body), completion: { choices: [{ message: { content: contentOf(result.json) } }] }, ...(result.usage ? { usage: result.usage } : {}) };
  };
  for (const question of fixture.questions) {
    if (only && !only.has(question.id)) continue;
    if (replay.totalCostUsd - priorCostUsd + pairReserveUsd > maxDollars) {
      console.error(`stopping before ${question.id}: spend $${replay.totalCostUsd.toFixed(4)} is within $${pairReserveUsd} of the $${maxDollars} cap`);
      break;
    }
    const run = runAskEvalQuestion(fixture, index, question);
    const before = await call(legacyAskChatCompletionsBody(config.modelId, question.question, run.before.packets, run.before.relations), run.before.allowedIds);
    const after = await call(afterAskChatCompletionsBody(config.modelId, index, run), run.after.allowedIds);
    replay.runs.push({ id: question.id, before, after });
    replay.runs.sort((left, right) => fixture.questions.findIndex(item => item.id === left.id) - fixture.questions.findIndex(item => item.id === right.id));
    // Written after every question so an interrupted run still records what it spent.
    writeFileSync(join(ASK_EVAL_DIR, "replay.json"), `${JSON.stringify(replay, null, 2)}\n`);
    const score = (replayed: AskEvalReplayCall, sections: typeof run.after.sections) => {
      const parsed = parseAskCompletion(replayed.completion, new Set(replayed.allowedIds));
      const citations = parsed ? citationsNamedInAnswer(parsed.answer, parsed.citations, sections) : [];
      const files = citedFiles(citations, index, run.before.packets);
      return [fileRecall(question.expectedFiles, files).toFixed(2), parsed && saysNotInEvidence(parsed.answer) ? "yes" : "no"];
    };
    rows.push([`${question.id}${question.heldOut ? " (held-out)" : ""}`, run.before.recall.toFixed(2), run.after.recall.toFixed(2), ...score(before, []), ...score(after, run.after.sections), `$${((before.usage?.costUsd ?? 0) + (after.usage?.costUsd ?? 0)).toFixed(4)}`]);
  }
  writeFileSync(join(ASK_EVAL_DIR, "replay.json"), `${JSON.stringify(replay, null, 2)}\n`);
  const header = ["question", "evidence recall before", "evidence recall after", "cited recall before", "not-in-evidence before", "cited recall after", "not-in-evidence after", "cost"];
  console.log(`| ${header.join(" | ")} |\n|${header.map(() => "---").join("|")}|`);
  for (const row of rows) console.log(`| ${row.join(" | ")} |`);
  console.log(`\nmodel ${config.modelId}; this run $${(replay.totalCostUsd - priorCostUsd).toFixed(4)} (cap $${maxDollars}); recorded total $${replay.totalCostUsd.toFixed(4)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    // The key actually used, plus the generic names in case one held the same value.
    const secrets = [usedKey, process.env.OKIE_LLM_API_KEY, process.env.OPENROUTER_API_KEY, process.env.OPENAI_API_KEY];
    console.error(secrets.reduce<string>((text, secret) => redactGatewayErrorText(text, secret), raw));
    process.exit(1);
  });
}
