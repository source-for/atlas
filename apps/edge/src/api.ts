import { backendUnavailable, devBackendOrigin, proxiedRequest, publicBackendResponse, type Backend } from './backend';
import type { BudgetBucket } from './budget';
import { accountsEnabled, currentUser, handleAuthRoute, resolveAuthSetup } from './auth';
import { askEnabled, type EdgeEnv } from './env';
import { askUnanswered, budgetStub, reportedAskCost, runGuards, type Guard, type GuardContext } from './guards';
import { jsonResponse, notFoundJson } from './http';

/**
 * `/api/*` at the edge (CLA-266). `/api/auth/*` and `/api/account/*` are GitHub sign-in (auth.ts, CLA-316):
 * without its secrets and D1 binding `/api/auth/me` answers the public shape and the rest 404. Ask status and the (always empty) Ask thread are answered here too.
 * Signed-in `POST /api/ask` reaches the container behind durable quotas with `ASK_ENABLED=1`.
 * The optional planner additionally requires `BLOCK_PLAN_ENABLED=1`; disabled routes 404. Every other `/api/*`
 * (operator, scans) is a 404.
 */

type ApiRoute = 'ask-status' | 'ask-thread' | { bucket: BudgetBucket };

function apiRoute(method: string, pathname: string): ApiRoute | undefined {
  const read = method === 'GET' || method === 'HEAD';
  if (read && pathname === '/api/ask') return 'ask-status';
  if (read && pathname === '/api/ask/thread') return 'ask-thread';
  if (method === 'POST' && pathname === '/api/ask') return { bucket: 'ask' };
  if (method === 'POST' && pathname === '/api/block-plan') return { bucket: 'block-plan' };
  return undefined;
}

export type ApiRouteContext = {
  /** undefined = no container / dev backend bound (the browse-only deploy). */
  backend: Backend | undefined;
  guards: readonly Guard[];
  now: () => Date;
  waitUntil(promise: Promise<unknown>): void;
  /** Upstream fetch (GitHub OAuth in auth.ts); defaults to the global fetch. */
  fetch?: typeof fetch;
};

/**
 * `GET /api/ask` without a container probe: connected only when Ask is enabled, a backend exists and
 * the gateway key is configured (the key lives in the container env; a dev backend holds its own).
 */
export function askConnected(env: EdgeEnv, backend: Backend | undefined): boolean {
  if (!askEnabled(env) || !backend) return false;
  return Boolean(env.OKIE_LLM_API_KEY?.trim()) || devBackendOrigin(env) !== undefined;
}

// Same rules as apps/server askThreads.ts `sanitizeAskAtlasIdentity`.
const GITHUB_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const COMMIT_SHA = /^[A-Za-z0-9._-]{1,80}$/;

function askThreadIdentity(search: URLSearchParams): { owner: string; repo: string; commitSha: string } | undefined {
  const name = (value: string | null) => {
    const trimmed = (value ?? '').trim();
    return GITHUB_NAME.test(trimmed) && trimmed !== '.' && trimmed !== '..' ? trimmed : undefined;
  };
  const owner = name(search.get('owner'));
  const repo = name(search.get('repo'));
  const commitSha = (search.get('commitSha') ?? '').trim();
  return owner && repo && COMMIT_SHA.test(commitSha) ? { owner, repo, commitSha } : undefined;
}

/** Bound request memory and reject malformed questions before consuming a daily allowance. */
async function validatedAskRequest(request: Request): Promise<Request | Response> {
  const maxBytes = 48 * 1024; // same ceiling as the Node Ask endpoint
  const declared = Number(request.headers.get('content-length'));
  if (declared > maxBytes) return jsonResponse(413, { error: 'Ask request is too large.' });
  const reader = request.body?.getReader();
  if (!reader) return jsonResponse(400, { error: 'Ask needs a JSON question and atlas.' });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return jsonResponse(413, { error: 'Ask request is too large.' });
      }
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const atlas = record.atlas && typeof record.atlas === 'object' ? record.atlas as Record<string, unknown> : {};
    const search = new URLSearchParams();
    for (const key of ['owner', 'repo', 'commitSha']) if (typeof atlas[key] === 'string') search.set(key, atlas[key]);
    if (typeof record.question !== 'string' || !record.question.trim() || !askThreadIdentity(search)) {
      return jsonResponse(400, { error: 'Ask needs a question and atlas identity {owner, repo, commitSha}.' });
    }
    return new Request(request, { body: bytes });
  } catch {
    return jsonResponse(400, { error: 'Ask needs a valid JSON question and atlas.' });
  }
}

export async function handleApiRoute(request: Request, env: EdgeEnv, context: ApiRouteContext): Promise<Response> {
  const url = new URL(request.url);
  const auth = await handleAuthRoute(request, env, { now: context.now(), ...(context.fetch ? { fetch: context.fetch } : {}) });
  if (auth) return auth;
  // With accounts on, the signed-in SPA's account menu asks whether this user is an operator
  // (OperatorMenuLink). The hosted deployment has no operators; without accounts it stays a 404 as before.
  if (request.method.toUpperCase() === 'GET' && url.pathname === '/api/operator/session' && accountsEnabled(env, url)) {
    return jsonResponse(200, { operator: false });
  }
  const route = apiRoute(request.method.toUpperCase(), url.pathname);
  if (!route) return notFoundJson();
  if (route === 'ask-status' && !askEnabled(env)) return jsonResponse(200, { connected: false });
  if (!askEnabled(env)) return notFoundJson();
  if (typeof route === 'object' && route.bucket === 'block-plan' && env.BLOCK_PLAN_ENABLED !== '1') return notFoundJson();
  const setup = resolveAuthSetup(env, url);
  if (!setup) return jsonResponse(503, { error: 'Ask sign-in is unavailable right now.' });
  const user = await currentUser(request, setup, context.now());
  if (user.unavailable) return jsonResponse(503, { error: 'Ask sign-in is unavailable right now.' });
  if (!user.signedIn) {
    const response = jsonResponse(401, { error: 'Sign in to ask about this atlas.' });
    for (const cookie of user.clear) response.headers.append('set-cookie', cookie);
    return response;
  }
  if (route === 'ask-status') {
    const connected = askConnected(env, context.backend);
    let warmingUp = false;
    if (connected && context.backend?.warmingUp) {
      try { warmingUp = await Promise.race([context.backend.warmingUp(), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000))]); } catch { /* unknown readiness */ }
    }
    return jsonResponse(200, { connected, ...(context.backend?.warmingUp ? { warmingUp } : {}) });
  }
  if (route === 'ask-thread') {
    // Threads are account-partitioned in browser IndexedDB, never stored in D1 or this container.
    const atlas = askThreadIdentity(url.searchParams);
    if (!atlas) return jsonResponse(400, { error: 'Ask thread needs atlas identity {owner, repo, commitSha}.' });
    return jsonResponse(200, { thread: { ...atlas, turns: [] } });
  }
  if (request.headers.get('origin') !== setup.origin) return jsonResponse(403, { error: 'Ask requests must come from this site.' });
  if (request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return jsonResponse(415, { error: 'Ask requests require JSON.' });
  if (!context.backend) return backendUnavailable();
  if (route.bucket === 'ask') {
    const validated = await validatedAskRequest(request);
    if (validated instanceof Response) return validated;
    request = validated;
  }

  const guardContext: GuardContext = {
    bucket: route.bucket,
    accountId: String(user.signedIn.user.github_id),
    clientIp: request.headers.get('cf-connecting-ip')?.trim() || 'unknown',
    now: context.now(),
  };
  const refused = await runGuards(context.guards, request, env, guardContext);
  if (refused) return refused;

  const reservationId = guardContext.reservationId;
  const settle = (dollars: number | undefined, unanswered: boolean) => {
    const stub = reservationId ? budgetStub(env) : undefined;
    if (stub && reservationId) context.waitUntil(Promise.resolve(stub.settle(reservationId, dollars, unanswered)).catch(() => undefined));
  };
  let response: Response;
  try {
    response = await context.backend.fetch(proxiedRequest(request, context.backend.origin, url.pathname, url.search));
  } catch {
    settle(undefined, true); // A lost response does not prove the model incurred no cost; the caller got no answer.
    return backendUnavailable();
  }
  settle(reportedAskCost(response), askUnanswered(response));
  return publicBackendResponse(response);
}
