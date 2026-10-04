import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildAskIndex, retrieveAskSections, type AskCorpusLocation } from "./askRetrieval.js";
import { ASK_RETRIEVAL_COLD_TIMEOUT_MS, createAskRetrievalWorker, type AskRetrievalTicket, type AskRetrievalWorker } from "./askWorker.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SNAPSHOT = {
  commitSha: SHA,
  entities: [
    { id: "system:okie", kind: "softwareSystem", name: "Okie", sourceRefs: [] },
    { id: "container:web", kind: "container", parentId: "system:okie", name: "@okie/web", sourceRefs: [{ path: "apps/web/package.json" }] },
    { id: "component:create", kind: "component", parentId: "container:web", name: "src/renderer/createRenderer.ts", sourceRefs: [{ path: "apps/web/src/renderer/createRenderer.ts" }] },
    { id: "code:create", kind: "code", parentId: "component:create", name: "createRenderer", sourceRefs: [{ path: "apps/web/src/renderer/createRenderer.ts", symbol: "createRenderer", startLine: 27, endLine: 60 }], sourceExcerpts: [{ symbol: "createRenderer", startLine: 27, text: "export async function createRenderer() {\n  // Try WebGPU first, then WebGL2.\n}" }] },
  ],
  relations: [],
};
const SLOW = new URL("./askWorkerSlow.fixture.js", import.meta.url);
const query = (question: string) => ({ question, selectedIds: ["container:web"], byteBudget: 24_000 });

function corpusDir(): { dir: string; location: (name?: string) => AskCorpusLocation } {
  const dir = mkdtempSync(join(tmpdir(), "okie-ask-worker-"));
  return {
    dir,
    location: (name = "snapshot.json") => {
      const snapshotPath = join(dir, name);
      writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT));
      return { key: `file:${snapshotPath}`, source: "scan", snapshotPath, size: 1 };
    },
  };
}
function ticketOf(admitted: ReturnType<AskRetrievalWorker["admit"]>): AskRetrievalTicket {
  if (!admitted || admitted === "busy") throw new Error(`expected an admission, got ${String(admitted)}`);
  return admitted;
}

test("ask worker: retrieval runs in the worker and matches in-process retrieval; the index stays warm", async () => {
  const { dir, location } = corpusDir();
  const worker = createAskRetrievalWorker();
  try {
    const at = location();
    const evidence = await ticketOf(worker.admit([at], SHA)).run(query("How is the renderer created?"));
    const local = retrieveAskSections(buildAskIndex(SNAPSHOT), "How is the renderer created?", { selectedIds: ["container:web"], byteBudget: 24_000 });
    assert.deepEqual(evidence?.sections, local.sections);
    assert.equal(evidence?.bytes, local.bytes);
    assert.equal(evidence?.entityCount, SNAPSHOT.entities.length);
    assert.deepEqual(evidence?.containerNames, ["@okie/web"]);
    // Index details for the section's folded symbol and the selected id (what askCitationDetails needs).
    assert.deepEqual(evidence?.citationDetails.map(detail => detail.id).sort(), ["code:create", "container:web"]);
    assert.deepEqual(worker.stats().warmKeys, [at.key]);
    // A second request for the warm key does not rebuild; a commit the snapshot does not match finds nothing.
    await ticketOf(worker.admit([at], SHA)).run(query("WebGPU"));
    assert.equal(await ticketOf(worker.admit([at], "fffffffffff")).run(query("WebGPU")), undefined);
    assert.equal(worker.stats().indexBuilds, 1);
    assert.equal(worker.stats().spawns, 1);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ask worker: the main thread stays responsive while the worker is busy", async () => {
  const { dir, location } = corpusDir();
  const worker = createAskRetrievalWorker({ workerUrl: SLOW, timeoutMs: 10_000, coldTimeoutMs: 10_000 });
  try {
    const at = location();
    // Spawn the worker and build the index first, so only the busy request is measured.
    await ticketOf(worker.admit([at], SHA)).run(query("renderer"));
    let last = performance.now(); let worst = 0;
    const tick = setInterval(() => { const now = performance.now(); worst = Math.max(worst, now - last); last = now; }, 10);
    const started = performance.now();
    const evidence = await ticketOf(worker.admit([at], SHA)).run(query("busy:1200 renderer"));
    clearInterval(tick);
    assert.equal(worker.stats().spawns, 1);
    assert.ok(performance.now() - started >= 1_200, "the worker really was busy");
    assert.ok(evidence && evidence.sections.length > 0);
    assert.ok(worst < 50, `event-loop gap ${Math.round(worst)} ms while the worker was busy`);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ask worker: a timeout terminates the worker, fails every waiting request, and the next request respawns it", async () => {
  const { dir, location } = corpusDir();
  const worker = createAskRetrievalWorker({ workerUrl: SLOW, timeoutMs: 300, coldTimeoutMs: 10_000 });
  try {
    const at = location();
    await ticketOf(worker.admit([at], SHA)).run(query("warm up"));
    const slow = ticketOf(worker.admit([at], SHA)).run(query("busy:3000"));
    const queued = ticketOf(worker.admit([at], SHA)).run(query("renderer"));
    const started = performance.now();
    await assert.rejects(slow, /timed out/);
    await assert.rejects(queued, /timed out/);
    assert.ok(performance.now() - started < 2_000, "the deadline, not the busy loop, ended the request");
    assert.equal(worker.stats().timeouts, 1);
    assert.deepEqual(worker.stats().warmKeys, [], "the warm cache is lost with the worker");
    assert.deepEqual(worker.stats().failedKeys, [], "a warm request that timed out does not poison its snapshot");
    const again = await ticketOf(worker.admit([at], SHA)).run(query("renderer"));
    assert.ok(again && again.sections.length > 0);
    assert.equal(worker.stats().spawns, 2);
    // A crashed worker is replaced the same way.
    await assert.rejects(ticketOf(worker.admit([at], SHA)).run(query("crash")), /exited/);
    assert.ok(await ticketOf(worker.admit([at], SHA)).run(query("renderer")));
    assert.equal(worker.stats().spawns, 3);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ask worker: a cold build that overruns its deadline is negatively cached; corrupt snapshots are not re-parsed", async () => {
  const { dir, location } = corpusDir();
  let clock = 0;
  // The cold budget covers a worker spawn + build, so it must stay generous even on a loaded CI box.
  const worker = createAskRetrievalWorker({ workerUrl: SLOW, timeoutMs: 5_000, coldTimeoutMs: 5_000, failedKeyTtlMs: 1_000, now: () => clock });
  try {
    const at = location();
    // A retrieval stall before any build does not blame the snapshot...
    await assert.rejects(ticketOf(worker.admit([at], SHA)).run(query("busy:8000")), /timed out/);
    assert.deepEqual(worker.stats().failedKeys, []);
    // ...a build still in progress when the deadline hits does.
    await assert.rejects(ticketOf(worker.admit([at], SHA)).run(query("slowbuild:8000")), /timed out/);
    assert.deepEqual(worker.stats().failedKeys, [at.key]);
    assert.equal(worker.admit([at], SHA), undefined, "a recently failed snapshot is not retried: Ask answers scope-only");
    clock = 1_001;
    assert.ok(await ticketOf(worker.admit([at], SHA)).run(query("renderer")), "retried after the TTL");
    const corrupt = location("corrupt.json");
    writeFileSync(corrupt.snapshotPath, "{ not json");
    assert.equal(await ticketOf(worker.admit([corrupt], SHA)).run(query("renderer")), undefined);
    assert.equal(worker.admit([corrupt], SHA), undefined);
    assert.equal(worker.stats().indexBuilds, 1);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ask worker: a full queue and a second concurrent cold build are refused (busy); the same key joins its build", async () => {
  const { dir, location } = corpusDir();
  const worker = createAskRetrievalWorker({ workerUrl: SLOW, maxPending: 3 });
  try {
    const first = location("a.json"); const second = location("b.json");
    const building = ticketOf(worker.admit([first], SHA));
    assert.equal(worker.admit([second], SHA), "busy", "one cold build at a time");
    const joined = ticketOf(worker.admit([first], SHA));
    const third = ticketOf(worker.admit([first], SHA));
    assert.equal(worker.admit([first], SHA), "busy", "the queue is bounded");
    third.release();
    const results = await Promise.all([building.run(query("busy:200 renderer")), joined.run(query("renderer"))]);
    assert.ok(results.every(result => result && result.sections.length > 0));
    assert.equal(worker.stats().indexBuilds, 1, "the joined request found the key warm");
    assert.equal(worker.stats().pending, 0);
    // Once warm, the other snapshot may build.
    assert.ok(await ticketOf(worker.admit([second], SHA)).run(query("renderer")));
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ask worker: the worker builds only keys it was admitted to build; a stale warm mirror degrades instead of building", async () => {
  const { dir, location } = corpusDir();
  const worker = createAskRetrievalWorker();
  try {
    const [a, b, c, d, e] = ["a", "b", "c", "d", "e"].map(name => location(`${name}.json`)) as [AskCorpusLocation, AskCorpusLocation, AskCorpusLocation, AskCorpusLocation, AskCorpusLocation];
    for (const key of [a, b, c, d]) await ticketOf(worker.admit([key], SHA)).run(query("renderer"));
    assert.equal(worker.stats().indexBuilds, 4);
    // e is the one admitted cold build; a..d look warm to the coordinator, but building e evicts a.
    const tickets = [e, a, b, c, d].map(key => ticketOf(worker.admit([key], SHA)));
    const results = await Promise.allSettled(tickets.map(ticket => ticket.run(query("renderer"))));
    assert.deepEqual(results.map(result => result.status), ["fulfilled", "rejected", "fulfilled", "fulfilled", "fulfilled"]);
    assert.match(String((results[1] as PromiseRejectedResult).reason), /not warm/);
    assert.equal(worker.stats().indexBuilds, 5, "exactly the one admitted build");
    assert.deepEqual(worker.stats().failedKeys, [], "a not-warm key is not a failed key");
    // The next request for a is admitted as a cold build again.
    assert.ok(await ticketOf(worker.admit([a], SHA)).run(query("renderer")));
    assert.equal(worker.stats().indexBuilds, 6);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ask worker: a slow retrieval after a finished build does not blame the key", async () => {
  const { dir, location } = corpusDir();
  // This request starts cold, so its deadline remains the cold budget even
  // after the "built" notification. Give fresh worker startup the production
  // budget; a short cold deadline can fail the ordinary retry under CI load.
  const coldTimeoutMs = ASK_RETRIEVAL_COLD_TIMEOUT_MS;
  const worker = createAskRetrievalWorker({ workerUrl: SLOW, timeoutMs: 5_000, coldTimeoutMs });
  try {
    const at = location();
    // The build finishes ("built" clears the blamed key), then the retrieval stalls past the deadline.
    await assert.rejects(ticketOf(worker.admit([at], SHA)).run(query(`slowafter:${coldTimeoutMs + 5_000}`)), /timed out/);
    assert.equal(worker.stats().timeouts, 1);
    assert.deepEqual(worker.stats().failedKeys, [], "the key built fine: it is not negatively cached");
    assert.ok(await ticketOf(worker.admit([at], SHA)).run(query("renderer")), "the next request rebuilds it on a fresh worker");
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("ask worker: a joiner still builds when the builder's ticket is released unrun, without exceeding the cold-build cap", async () => {
  const { dir, location } = corpusDir();
  const worker = createAskRetrievalWorker({ workerUrl: SLOW });
  try {
    const first = location("a.json"); const second = location("b.json");
    const builder = ticketOf(worker.admit([first], SHA));
    const joiner = ticketOf(worker.admit([first], SHA));
    builder.release();
    // The joiner now holds the key under build: a second cold key is still refused.
    assert.equal(worker.admit([second], SHA), "busy", "the one-cold-build cap holds after the builder released");
    const evidence = await joiner.run(query("renderer"));
    assert.ok(evidence && evidence.sections.length > 0, "the joiner built the key instead of answering not warm");
    assert.equal(worker.stats().indexBuilds, 1);
    // Joiner runs first, builder second: one build, both answered.
    const builder2 = ticketOf(worker.admit([second], SHA));
    const joiner2 = ticketOf(worker.admit([second], SHA));
    const results = await Promise.all([joiner2.run(query("renderer")), builder2.run(query("renderer"))]);
    assert.ok(results.every(result => result && result.sections.length > 0));
    assert.equal(worker.stats().indexBuilds, 2, "single flight: the first to arrive built, the other hit the cache");
    assert.equal(worker.stats().pending, 0);
  } finally { await worker.close(); rmSync(dir, { recursive: true, force: true }); }
});
