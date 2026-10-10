import type { EdgeEnv } from './env';
import { jsonResponse } from './http';

/**
 * The Ask / block-plan API behind the Worker: the `AtlasApiContainer` Durable Object (one named
 * instance) where the env binds it, or `DEV_BACKEND_ORIGIN` from `.dev.vars` for local QA without
 * Docker. Browsing never requires a backend. Routing code takes a Backend so tests inject one.
 */
export interface Backend {
  /** Origin proxied request URLs are built on (the container only reads path + query). */
  origin: string;
  fetch(request: Request): Promise<Response>;
  /** Inspect the container without starting it; absent for already-running dev backends. */
  warmingUp?(): Promise<boolean>;
}

/** The single v1 container instance every API request is routed to. */
export const CONTAINER_INSTANCE_NAME = 'atlas-api';

/** Request headers never forwarded to the container (credentials, spoofable client-address hints). */
const STRIPPED_REQUEST_HEADERS = [
  'cookie',
  'authorization',
  'cf-access-client-id',
  'cf-access-client-secret',
  'cf-access-jwt-assertion',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'forwarded',
  'true-client-ip',
  'cf-connecting-ip',
  'x-okie-client-ip',
  'x-okie-ask-cost-usd',
  'x-okie-ask-tokens',
  'x-okie-ask-outcome',
  'cf-turnstile-response',
  'host',
] as const;

/** Response headers the container may set that must never reach a browser. */
const STRIPPED_RESPONSE_HEADERS = ['set-cookie', 'x-okie-ask-cost-usd', 'x-okie-ask-tokens', 'x-okie-ask-outcome'] as const;

export function devBackendOrigin(env: Pick<EdgeEnv, 'DEV_BACKEND_ORIGIN'>): string | undefined {
  const raw = env.DEV_BACKEND_ORIGIN?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/** Private header carrying the edge-observed client address to the container (the server trusts it). */
export const CLIENT_IP_HEADER = 'x-okie-client-ip';

/**
 * Copy of `request` for the container: same method/body, path + `search`, credentials and forwarding
 * headers stripped (including any client-supplied `x-okie-client-ip`), then the edge's own
 * `CF-Connecting-IP` set as both `CF-Connecting-IP` and `x-okie-client-ip`. workerd may drop
 * `CF-Connecting-IP` on a subrequest (QA B1), so the server reads the private header first.
 */
export function proxiedRequest(request: Request, origin: string, pathname: string, search: string): Request {
  const headers = new Headers(request.headers);
  for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
  const clientIp = request.headers.get('cf-connecting-ip')?.trim();
  if (clientIp) {
    headers.set('CF-Connecting-IP', clientIp);
    headers.set(CLIENT_IP_HEADER, clientIp);
  }
  const method = request.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(`${origin}${pathname}${search}`, {
    method,
    headers,
    ...(hasBody ? { body: request.body } : {}),
    redirect: 'manual',
  });
}

/** Drop container-internal headers (cost ledger, cookies) before the response leaves the edge. */
export function publicBackendResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of STRIPPED_RESPONSE_HEADERS) headers.delete(name);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function backendUnavailable(): Response {
  return jsonResponse(503, { error: 'The atlas API is unavailable right now; try again later.' }, { 'retry-after': '30' });
}

/** Container-internal origin used for proxied URLs. */
export const CONTAINER_ORIGIN = 'http://atlas-api.internal';

/** The dev origin, else the container binding, else undefined (backend unavailable). */
export function selectBackend(env: EdgeEnv): Backend | undefined {
  const dev = devBackendOrigin(env);
  if (dev) return { origin: dev, fetch: request => fetch(request) };
  const namespace = env.ATLAS_API;
  if (!namespace) return undefined;
  return {
    origin: CONTAINER_ORIGIN,
    fetch: request => namespace.getByName(CONTAINER_INSTANCE_NAME).fetch(request),
    warmingUp: async () => {
      const state = await namespace.getByName(CONTAINER_INSTANCE_NAME).getState();
      // 'running' precedes port readiness; only 'healthy' means the API can answer.
      return state.status !== 'healthy';
    },
  };
}

/** Build the proxied request for `backend` and forward it (503 without a backend). */
export function proxyTo(backend: Backend | undefined, request: Request, pathname: string, search: string): Promise<Response> {
  if (!backend) return Promise.resolve(backendUnavailable());
  return forward(backend, proxiedRequest(request, backend.origin, pathname, search));
}

/**
 * Forward to the backend; no backend or a thrown fetch (container not provisioned, dev origin down) is a
 * 503. The answer always goes through `publicBackendResponse` (cost headers and cookies stripped).
 */
export async function forward(backend: Backend | undefined, request: Request): Promise<Response> {
  if (!backend) return backendUnavailable();
  try {
    return publicBackendResponse(await backend.fetch(request));
  } catch {
    return backendUnavailable();
  }
}
