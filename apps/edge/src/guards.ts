import type { AtlasBudget, BudgetBucket } from './budget';
import type { EdgeEnv } from './env';
import { jsonResponse } from './http';

/**
 * Pre-proxy guard chain for the paid routes, `POST /api/ask` and `POST /api/block-plan` (CLA-266).
 * Guards run in order before the container is touched; the first Response wins. Default chain:
 *
 *   1. Turnstile  — OFF unless `TURNSTILE_ENABLED=1` (token from the `cf-turnstile-response` header).
 *   2. Rate limit — Workers Rate Limiting binding `ASK_RATE_LIMITER`, keyed by bucket + CF-Connecting-IP
 *                   (IPv6 collapsed to its /64, IPv4-mapped IPv6 to the IPv4 address).
 *   3. Daily cap  — `AtlasBudget` Durable Object: requests per bucket per UTC day, plus the Ask dollar ledger.
 *
 * Refusals keep each route's existing client contract: Ask → 429/403 `{ error }` (+ retry-after);
 * block-plan → 200 `{ state: "unavailable", reason: "rate-limited" }` (apps/server/src/blockPlans.ts).
 */

export type GuardContext = {
  bucket: BudgetBucket;
  /** CF-Connecting-IP ('unknown' when absent, e.g. local dev). */
  clientIp: string;
  now: Date;
  accountId?: string;
  /** Set by the budget guard when an Ask dollar reservation was taken; settled after the proxy. */
  reservationId?: string;
};

export type Guard = (request: Request, env: EdgeEnv, context: GuardContext) => Promise<Response | undefined> | Response | undefined;

export const ASK_LIMIT_ERROR = 'Ask has reached its limit for now; try again later.';
export const ASK_VERIFICATION_ERROR = 'Ask needs a quick verification; reload the page and try again.';
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const TURNSTILE_TOKEN_HEADER = 'cf-turnstile-response';
export const BUDGET_INSTANCE_NAME = 'global';

/**
 * Global safety caps; override per environment with the vars of the same name in wrangler.jsonc.
 * The per-account five/day cap is hardcoded in the durable budget.
 */
export const BUDGET_DEFAULTS = {
  ASK_DAILY_MAX_REQUESTS: 500,
  BLOCK_PLAN_DAILY_MAX_REQUESTS: 200,
  ASK_DAILY_MAX_DOLLARS: 5,
  ASK_ESTIMATED_DOLLARS_PER_REQUEST: 0.006,
} as const;

/** A configured number `>= min`; unset, blank or invalid → the fallback. */
function configuredNumber(raw: string | undefined, fallback: number, min: 'zero' | 'positive'): number {
  const value = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return (min === 'zero' ? value >= 0 : value > 0) ? value : fallback;
}

/** Caps accept 0 (= refuse everything); the per-request estimate must stay positive. */
export function budgetConfig(env: EdgeEnv) {
  return {
    askMaxRequests: Math.floor(configuredNumber(env.ASK_DAILY_MAX_REQUESTS, BUDGET_DEFAULTS.ASK_DAILY_MAX_REQUESTS, 'zero')),
    blockPlanMaxRequests: Math.floor(configuredNumber(env.BLOCK_PLAN_DAILY_MAX_REQUESTS, BUDGET_DEFAULTS.BLOCK_PLAN_DAILY_MAX_REQUESTS, 'zero')),
    askMaxDollars: configuredNumber(env.ASK_DAILY_MAX_DOLLARS, BUDGET_DEFAULTS.ASK_DAILY_MAX_DOLLARS, 'zero'),
    askEstimateDollars: configuredNumber(env.ASK_ESTIMATED_DOLLARS_PER_REQUEST, BUDGET_DEFAULTS.ASK_ESTIMATED_DOLLARS_PER_REQUEST, 'positive'),
  };
}

function ipv4Octets(text: string): number[] | undefined {
  const parts = text.split('.');
  if (parts.length !== 4 || !parts.every(part => /^\d{1,3}$/.test(part))) return undefined;
  const octets = parts.map(Number);
  return octets.every(octet => octet <= 255) ? octets : undefined;
}

/** Eight 16-bit groups of an IPv6 address (embedded IPv4 tail allowed), or undefined when malformed. */
function ipv6Groups(text: string): number[] | undefined {
  let address = text;
  const tail: number[] = [];
  const lastColon = address.lastIndexOf(':');
  if (address.slice(lastColon + 1).includes('.')) {
    const octets = ipv4Octets(address.slice(lastColon + 1));
    if (!octets) return undefined;
    tail.push((octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!);
    // Keep a trailing "::" ("::1.2.3.4"); drop a single separator colon ("::ffff:1.2.3.4" → "::ffff").
    address = address.slice(0, lastColon + 1);
    if (!address.endsWith('::')) address = address.slice(0, -1);
  }
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const parse = (half: string) => (half === '' ? [] : half.split(':'));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  if (![...head, ...rest].every(group => /^[0-9a-f]{1,4}$/i.test(group))) return undefined;
  const known = head.length + rest.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return undefined;
  const zeros = new Array<number>(8 - known).fill(0);
  return [...head.map(g => parseInt(g, 16)), ...zeros, ...rest.map(g => parseInt(g, 16)), ...tail];
}

/**
 * Rate-limit identity for a client address: IPv4 as is; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) as the
 * IPv4 address; any other IPv6 collapsed to its /64 (one subscriber usually holds a whole /64, so
 * per-address keys would let a single client rotate freely). Anything unparsable is used verbatim.
 */
export function clientRateLimitKey(clientIp: string): string {
  const raw = clientIp.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '').toLowerCase();
  if (ipv4Octets(raw)) return raw;
  if (!raw.includes(':')) return raw || 'unknown';
  const groups = ipv6Groups(raw);
  if (!groups) return raw;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
  }
  return `${groups.slice(0, 4).map(group => group.toString(16)).join(':')}::/64`;
}

/**
 * One Workers Rate Limiting call for `bucket` + the client's rate-limit key. True = allowed. A missing
 * binding (local dev) or a binding error allows (the daily cap / other layers decide).
 */
export async function allowedByRateLimit(env: Pick<EdgeEnv, 'ASK_RATE_LIMITER'>, bucket: string, clientIp: string): Promise<boolean> {
  const limiter = env.ASK_RATE_LIMITER;
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key: `${bucket}:${clientRateLimitKey(clientIp)}` });
    return success;
  } catch {
    return true;
  }
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function secondsUntilNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/** The route-shaped refusal for a guard. */
export function refusal(bucket: BudgetBucket, options: { status?: number; error?: string; retryAfterSeconds?: number } = {}): Response {
  const retry: Record<string, string> = options.retryAfterSeconds ? { 'retry-after': String(options.retryAfterSeconds) } : {};
  if (bucket === 'block-plan') return jsonResponse(200, { state: 'unavailable', reason: 'rate-limited' }, retry);
  return jsonResponse(options.status ?? 429, { error: options.error ?? ASK_LIMIT_ERROR }, retry);
}

/** Turnstile siteverify (fail closed once enabled: missing secret/token, network error or `success: false`). */
export function turnstileGuard(fetchImpl: typeof fetch = (input, init) => fetch(input, init)): Guard {
  return async (request, env, context) => {
    if (env.TURNSTILE_ENABLED !== '1') return undefined;
    const refuse = () => refusal(context.bucket, { status: 403, error: ASK_VERIFICATION_ERROR });
    const token = request.headers.get(TURNSTILE_TOKEN_HEADER)?.trim();
    const secret = env.TURNSTILE_SECRET_KEY;
    if (!token || token.length > 2048 || !secret) return refuse();
    const form = new FormData();
    form.set('secret', secret);
    form.set('response', token);
    if (context.clientIp !== 'unknown') form.set('remoteip', context.clientIp);
    try {
      const response = await fetchImpl(TURNSTILE_SITEVERIFY_URL, { method: 'POST', body: form });
      const outcome = await response.json<{ success?: unknown }>();
      return outcome.success === true ? undefined : refuse();
    } catch {
      return refuse();
    }
  };
}

/** Per-IP burst limit. A missing binding (local dev) or a binding error lets the daily cap decide. */
export const rateLimitGuard: Guard = async (_request, env, context) => (
  (await allowedByRateLimit(env, context.bucket, context.clientIp)) ? undefined : refusal(context.bucket, { retryAfterSeconds: 60 })
);

export function budgetStub(env: EdgeEnv): DurableObjectStub<AtlasBudget> | undefined {
  return env.ATLAS_BUDGET?.getByName(BUDGET_INSTANCE_NAME);
}

/** Durable daily cap: requests per bucket, and for Ask the dollar ledger (reserve now, settle later). */
export const budgetGuard: Guard = async (_request, env, context) => {
  const unavailable = () => refusal(context.bucket, { status: 503, error: 'Ask limits are unavailable right now. Try again shortly.' });
  let stub: ReturnType<typeof budgetStub>;
  try { stub = budgetStub(env); } catch { return unavailable(); }
  if (!stub) return unavailable();
  const config = budgetConfig(env);
  const ask = context.bucket === 'ask';
  let result;
  try { result = await stub.admit({
    bucket: context.bucket,
    day: utcDay(context.now),
    maxRequests: ask ? config.askMaxRequests : config.blockPlanMaxRequests,
    ...(ask ? { accountId: context.accountId, dollars: { estimate: config.askEstimateDollars, max: config.askMaxDollars } } : {}),
  }); } catch { return unavailable(); }
  if (!result.ok && result.reason === 'identity') return unavailable();
  if (!result.ok) return refusal(context.bucket, { ...(result.reason === 'user' ? { error: 'You have used your five Asks for today. Your allowance resets at midnight UTC.' } : {}), retryAfterSeconds: secondsUntilNextUtcDay(context.now) });
  if (result.reservationId) context.reservationId = result.reservationId;
  return undefined;
};

export function defaultGuards(options: { fetch?: typeof fetch } = {}): Guard[] {
  return [turnstileGuard(options.fetch), rateLimitGuard, budgetGuard];
}

export async function runGuards(guards: readonly Guard[], request: Request, env: EdgeEnv, context: GuardContext): Promise<Response | undefined> {
  for (const guard of guards) {
    const refused = await guard(request, env, context);
    if (refused) return refused;
  }
  return undefined;
}

/**
 * CLA-472: the reply gave the caller no answer — the container marked it `x-okie-ask-outcome: unanswered`, or it
 * failed with a 5xx — so the account's daily Ask is returned.
 */
export function askUnanswered(response: Response): boolean {
  return response.status >= 500 || response.headers.get('x-okie-ask-outcome')?.trim().toLowerCase() === 'unanswered';
}

/** The container's reported Ask cost in dollars, if it sent a sane one. */
export function reportedAskCost(response: Response): number | undefined {
  const raw = response.headers.get('x-okie-ask-cost-usd');
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}
