import type { EdgeEnv } from './env';
import { budgetStub, utcDay } from './guards';
import { jsonResponse, notFoundJson } from './http';

/**
 * `POST /api/operator/ask-usage` (CLA-539): show or reset one account's Ask count for today (UTC) in the budget
 * Durable Object, for `scripts/asks.mjs`.
 *
 * The credential is a one-time grant: the script writes `operator_grants(token_hash, action, account_id,
 * expires_at)` into USERS_DB through `wrangler d1 execute` (the operator's `wrangler login` session), then sends
 * the token as `Authorization: Bearer <64 hex>` with a JSON body `{ action, accountId }`. The grant is deleted as
 * it is read, so it works once, and the body must name the grant's own action and account.
 *
 * Everyone else gets the generic `/api/*` miss ({@link notFoundJson}): another method, a missing or malformed
 * token, an unknown, expired or used grant, a body that does not match the grant (the grant is spent anyway),
 * USERS_DB unbound, a D1 error. Cookies are never read. Only a caller whose grant was accepted sees anything
 * else: the numbers, `unknown-account` when the id is not in `users`, or a 503 when the budget cannot be reached.
 */

export const OPERATOR_ASK_USAGE_PATH = '/api/operator/ask-usage';

const BEARER = /^Bearer ([0-9a-f]{64})$/;
const ACCOUNT_ID = /^(?:0|[1-9][0-9]*)$/;
const MAX_BODY_CHARS = 1024;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function requested(request: Request): Promise<{ action: unknown; accountId: unknown } | undefined> {
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_CHARS) return undefined;
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') return undefined;
    const { action, accountId } = value as Record<string, unknown>;
    return { action, accountId };
  } catch {
    return undefined;
  }
}

export async function handleOperatorAskUsage(request: Request, env: EdgeEnv, now: Date): Promise<Response> {
  if (request.method.toUpperCase() !== 'POST') return notFoundJson();
  const token = BEARER.exec(request.headers.get('authorization') ?? '')?.[1];
  const db = env.USERS_DB;
  if (!token || !db) return notFoundJson();

  let grant: { action: string; account_id: string } | undefined;
  let known: unknown;
  try {
    const at = now.toISOString();
    // One batch: take the grant (once, and only while it is live), then drop every expired one.
    const [taken] = await db.batch<{ action: string; account_id: string }>([
      db.prepare('DELETE FROM operator_grants WHERE token_hash = ?1 AND expires_at > ?2 RETURNING action, account_id').bind(await sha256Hex(token), at),
      db.prepare('DELETE FROM operator_grants WHERE expires_at <= ?1').bind(at),
    ]);
    grant = taken?.results[0];
    if (!grant) return notFoundJson();
    const asked = await requested(request);
    if (!asked || asked.action !== grant.action || asked.accountId !== grant.account_id) return notFoundJson();
    if (grant.action !== 'ask-show' && grant.action !== 'ask-reset') return notFoundJson();
    if (!ACCOUNT_ID.test(grant.account_id) || !Number.isSafeInteger(Number(grant.account_id))) return notFoundJson();
    known = await db.prepare('SELECT github_id FROM users WHERE github_id = ?1').bind(Number(grant.account_id)).first();
  } catch {
    return notFoundJson();
  }

  const subject = { action: grant.action, accountId: grant.account_id };
  if (!known) return jsonResponse(200, { result: 'unknown-account', ...subject });
  // The day is the Worker's, never the caller's.
  const day = utcDay(now);
  try {
    const stub = budgetStub(env);
    if (stub) {
      const usage = grant.action === 'ask-reset' ? await stub.resetAccount(day, grant.account_id) : await stub.accountUsage(day, grant.account_id);
      return jsonResponse(200, { result: 'ok', ...subject, ...usage });
    }
  } catch { /* answered below */ }
  return jsonResponse(503, { error: 'The Ask budget is unavailable right now.' });
}
