import { parentPort, workerData } from "node:worker_threads";
import { createAskIndexCache } from "./askRetrieval.js";
import { handleAskWorkerRequest, type AskWorkerRequest, type AskWorkerSettings } from "./askWorker.js";

// Test-only Ask worker for askWorker.test: the real handler, except a question "busy:<ms>" first blocks this thread for
// <ms> (a pathological retrieval on a warm index), "slowbuild:<ms>" blocks for <ms> inside a build (after announcing it),
// "slowafter:<ms>" blocks for <ms> right after a build finished (a slow retrieval on a fresh index), and "crash" exits.
const block = (ms: number) => { const until = performance.now() + ms; while (performance.now() < until) { /* busy */ } };
const cache = createAskIndexCache(workerData as AskWorkerSettings);
const failedBuilds = new Set<string>();
parentPort!.on("message", (request: AskWorkerRequest) => {
  const busy = /^busy:(\d+)/.exec(request.question);
  const slowBuild = /^slowbuild:(\d+)/.exec(request.question);
  const slowAfter = /^slowafter:(\d+)/.exec(request.question);
  if (busy) block(Number(busy[1]));
  if (request.question === "crash") process.exit(3);
  parentPort!.postMessage(handleAskWorkerRequest(cache, request, {
    failedBuilds,
    onBuilding: key => {
      parentPort!.postMessage({ type: "building", id: request.id, key });
      if (slowBuild) block(Number(slowBuild[1]));
    },
    onBuilt: (key, ok) => {
      parentPort!.postMessage({ type: "built", id: request.id, key, ok });
      if (slowAfter) block(Number(slowAfter[1]));
    },
  }));
});
