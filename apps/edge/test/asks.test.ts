import { env as testEnv, runInDurableObject, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  ASK_ACTIONS, ASK_ORIGINS, askUsageRequest, DAILY_ASKS, DEFAULT_LOCAL_PORT, GRANT_TTL_MS, grantSql, newGrantToken,
  OPERATOR_ASK_USAGE_PATH as SCRIPT_PATH, operatorOrigin, parseAsksArgs, readAskUsageResult, sha256Hex, wranglerD1Args,
} from '../scripts/asksCore.mjs';
import asksScriptSource from '../scripts/asks.mjs?raw';
import { signSession } from '../src/auth';
import { USER_DAILY_ASKS } from '../src/budget';
import type { EdgeEnv } from '../src/env';
import { budgetGuard } from '../src/guards';
import { jsonText } from '../src/http';
import { MAX_GRANT_LIFETIME_MS, OPERATOR_ASK_USAGE_PATH } from '../src/operator';
import { edgeEnv, edgeFetch } from './helpers';

const KEY = 'asks-test-signing-key-0123456789abcdef-01234';
const ASK_ENV = { ASK_ENABLED: '1', DEV_AUTH_TEST_LOGIN: '1', SESSION_SIGNING_KEY: KEY } as const;
const ASK_BODY = JSON.stringify({ question: 'What is this?', atlas: { owner: 'acme', repo: 'app', commitSha: 'abc' } });
const ORIGIN = 'http://127.0.0.1:4196';

const db = () => edgeEnv.USERS_DB!;
const budget = () => edgeEnv.ATLAS_BUDGET!.getByName('global');
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/** Other test files share the users table and clear their own id ranges, so add the row right before it is needed. */
async function addUser(id: string): Promise<void> {
  await db().prepare(`INSERT OR IGNORE INTO users (github_id, github_login, created_at, last_sign_in_at, privacy_version, product_updates_opt_in) VALUES (?1, 'asks-test', 't', 't', 'test', 0)`).bind(Number(id)).run();
}

type Action = 'ask-show' | 'ask-reset';

/** Writes a grant with the SQL the script builds; returns its token. */
async function grant(action: Action, accountId: string, at: Date, ttlMs = GRANT_TTL_MS): Promise<string> {
  const token = newGrantToken();
  await db().exec(grantSql({ tokenHash: await sha256Hex(token), action, accountId, createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + ttlMs).toISOString() }));
  return token;
}

type CallOptions = { method?: string; env?: Partial<EdgeEnv>; headers?: Record<string, string>; authorization?: string; rawBody?: string };

function call(token: string | undefined, body: unknown, at: Date, options: CallOptions = {}): Promise<Response> {
  const method = options.method ?? 'POST';
  const authorization = options.authorization ?? (token === undefined ? undefined : `Bearer ${token}`);
  return edgeFetch(OPERATOR_ASK_USAGE_PATH, {
    now: () => at,
    ...(options.env ? { env: options.env } : {}),
    init: {
      method,
      headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }), ...options.headers },
      ...(method === 'POST' ? { body: options.rawBody ?? JSON.stringify(body) } : {}),
    },
  });
}

/** `response` is, byte for byte and header for header, what an unknown `/api/*` path answers. */
async function expectMiss(response: Response, label: string): Promise<void> {
  const miss = await edgeFetch('/api/operator/nothing-here', { init: { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } } });
  const missText = await miss.text();
  expect(miss.status).toBe(404);
  expect(missText).toBe(jsonText({ error: 'not found' }));
  expect(response.status, label).toBe(404);
  expect(await response.text(), label).toBe(missText);
  expect([...response.headers].sort(), label).toEqual([...miss.headers].sort());
  expect(response.headers.get('cache-control'), label).toBe('no-store');
  expect(response.headers.get('access-control-allow-origin'), label).toBeNull();
  expect(response.headers.getSetCookie(), label).toEqual([]);
}

async function session(id: string, at: Date): Promise<string> {
  await addUser(id);
  const seconds = Math.floor(at.getTime() / 1000);
  return signSession({ sub: id, login: 'asks-test', iat: seconds - 100, exp: seconds + 3600 }, KEY);
}

function askAs(token: string, at: Date, reply: () => Response): Promise<Response> {
  return edgeFetch('/api/ask', {
    backend: { origin: 'http://backend.test', fetch: async () => reply() },
    env: ASK_ENV,
    now: () => at,
    guards: [budgetGuard],
    init: { method: 'POST', body: ASK_BODY, headers: { 'content-type': 'application/json', origin: ORIGIN, cookie: `sf_session=${token}` } },
  });
}

const admitFor = (accountId: string, day: string) => budget().admit({ bucket: 'ask', accountId, day, maxRequests: 1000, dollars: { estimate: 0.01, max: 100 } }) as Promise<{ ok: true; reservationId: string }>;

describe('operator Ask usage route (CLA-539)', () => {
  it('shows today\'s count, refunds and open admissions for the account, on the Worker\'s own UTC day', async () => {
    const at = new Date('2037-01-01T23:59:30Z');
    const day = dayOf(at);
    const id = '539001';
    await addUser(id);
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await admitFor(id, day)).reservationId);
    await budget().settle(ids[0]!, 0.002);
    await budget().settle(ids[1]!, 0, true);
    // Another day and another account must not show up.
    await admitFor(id, '2037-01-02');
    await admitFor('539002', day);

    const response = await call(await grant('ask-show', id, at), { action: 'ask-show', accountId: id, day: '2037-01-02' }, at);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.json()).toEqual({ result: 'ok', action: 'ask-show', accountId: id, day, requests: 2, refunds: 1, openAdmissions: 1 });
    // Showing changes nothing.
    expect(await budget().accountUsage(day, id)).toEqual({ day, requests: 2, refunds: 1, openAdmissions: 1 });
  });

  it('reset gives the five Asks back and leaves refunds, the ask bucket and the dollar ledger as they were', async () => {
    const at = new Date('2037-01-03T12:00:00Z');
    const day = dayOf(at);
    const id = '539010';
    const other = '539011';
    const token = await session(id, at);
    const answered = () => new Response('{"connected":true,"answer":"ok"}', { headers: { 'x-okie-ask-cost-usd': '0.001' } });
    const unanswered = () => new Response('{"connected":true,"error":"no answer"}', { headers: { 'x-okie-ask-outcome': 'unanswered' } });

    expect((await askAs(token, at, unanswered)).status).toBe(200); // refunded: the count stays at 0
    for (let i = 0; i < 5; i += 1) expect((await askAs(token, at, answered)).status).toBe(200);
    expect((await askAs(await session(other, at), at, answered)).status).toBe(200);
    expect((await askAs(token, at, answered)).status).toBe(429);

    const ledger = await budget().usage(day);
    expect(ledger.requests.ask).toBe(7);
    expect(ledger.openReservations).toBe(0);
    expect(await budget().accountUsage(day, id)).toEqual({ day, requests: 5, refunds: 1, openAdmissions: 0 });

    const response = await call(await grant('ask-reset', id, at), { action: 'ask-reset', accountId: id }, at);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: 'ok', action: 'ask-reset', accountId: id, day, requests: 0, refunds: 1, openAdmissions: 0, requestsBefore: 5 });
    expect(await budget().usage(day)).toEqual(ledger);
    expect(await budget().accountUsage(day, other)).toEqual({ day, requests: 1, refunds: 0, openAdmissions: 0 });

    for (let i = 0; i < 5; i += 1) expect((await askAs(token, at, answered)).status, `ask ${i + 1} after the reset`).toBe(200);
    expect((await askAs(token, at, answered)).status).toBe(429);
    expect((await budget().usage(day)).requests.ask).toBe(12);
  }, 20_000);

  it('answers every unauthorised caller exactly like an unknown /api path', async () => {
    const at = new Date('2037-01-05T12:00:00Z');
    const day = dayOf(at);
    const a = '539020';
    const b = '539021';
    await addUser(a);
    await addUser(b);
    for (let i = 0; i < 2; i += 1) await admitFor(a, day);
    await admitFor(b, day);
    const show = (accountId: string) => ({ action: 'ask-show', accountId });
    const reset = (accountId: string) => ({ action: 'ask-reset', accountId });
    const counts = async () => [(await budget().accountUsage(day, a)).requests, (await budget().accountUsage(day, b)).requests];

    // No token, and tokens that are not exactly `Bearer <64 lowercase hex>`: refused before D1 is touched.
    const live = await grant('ask-reset', a, at);
    let touched = 0;
    const watched = { prepare() { touched += 1; throw new Error('D1 must not be reached'); }, batch() { touched += 1; throw new Error('D1 must not be reached'); } } as unknown as D1Database;
    const malformed: Array<[string, string | undefined]> = [
      ['no authorization header', undefined],
      ['empty bearer', 'Bearer '],
      ['63 hex', `Bearer ${live.slice(1)}`],
      ['65 hex', `Bearer ${live}0`],
      ['uppercase hex', `Bearer ${live.toUpperCase()}`],
      ['non-hex', `Bearer ${'g'.repeat(64)}`],
      ['lowercase scheme', `bearer ${live}`],
      ['basic scheme', `Basic ${live}`],
      ['bare token', live],
      ['two tokens', `Bearer ${live} ${live}`],
    ];
    for (const [label, authorization] of malformed) {
      await expectMiss(await edgeFetch(OPERATOR_ASK_USAGE_PATH, {
        now: () => at,
        env: { USERS_DB: watched },
        init: { method: 'POST', body: JSON.stringify(reset(a)), headers: { 'content-type': 'application/json', ...(authorization === undefined ? {} : { authorization }) } },
      }), label);
    }
    expect(touched).toBe(0);
    // A D1 failure with a well-formed token is the same miss (and the database was asked this time).
    await expectMiss(await call(live, reset(a), at, { env: { USERS_DB: watched } }), 'D1 error');
    expect(touched).toBe(1);
    await expectMiss(await call(live, reset(a), at, { env: { USERS_DB: undefined } }), 'USERS_DB unbound');
    // Other methods, even with a live grant; the grant is not spent by them.
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
      const response = await call(live, reset(a), at, { method });
      if (method === 'HEAD') expect(response.status).toBe(404);
      else await expectMiss(response, method);
    }
    await expectMiss(await call(newGrantToken(), reset(a), at), 'unknown token');
    expect(await counts()).toEqual([2, 1]);

    // A valid signed-in session is no credential: with no grant, and next to a token that is not a grant.
    const cookie = `sf_session=${await session(a, at)}`;
    for (const env of [ASK_ENV, { ...ASK_ENV, OKIE_PUBLIC_ORIGIN: undefined }, {}]) {
      await expectMiss(await call(undefined, reset(a), at, { env, headers: { cookie, origin: ORIGIN } }), 'session cookie, no grant');
      await expectMiss(await call(newGrantToken(), reset(a), at, { env, headers: { cookie, origin: ORIGIN } }), 'session cookie, unknown token');
    }
    expect(await counts()).toEqual([2, 1]);

    // Expired: live until the instant before expires_at, gone at it.
    const short = await grant('ask-show', a, at, 1000);
    await expectMiss(await call(short, show(a), new Date(at.getTime() + 1000)), 'expired grant');
    const edge = await grant('ask-show', a, at, 1000);
    expect((await call(edge, show(a), new Date(at.getTime() + 999))).status).toBe(200);

    // A show grant used for a reset, then again as itself: spent by the mismatch.
    const showOnly = await grant('ask-show', a, at);
    await expectMiss(await call(showOnly, reset(a), at), 'show grant used for reset');
    await expectMiss(await call(showOnly, show(a), at), 'show grant after the mismatch');
    // A grant for account A used for account B, then again for A.
    const forA = await grant('ask-reset', a, at);
    await expectMiss(await call(forA, reset(b), at), 'grant for A used for B');
    await expectMiss(await call(forA, reset(a), at), 'grant for A after the mismatch');
    // A body that is not the JSON the route wants spends the grant too.
    for (const rawBody of ['', 'not json', '[]', 'null', JSON.stringify({ action: 'ask-reset', accountId: Number(a) }), JSON.stringify({ action: 'ask-reset', accountId: a, pad: 'x'.repeat(2000) })]) {
      const garbled = await grant('ask-reset', a, at);
      await expectMiss(await call(garbled, undefined, at, { rawBody }), `body ${rawBody.slice(0, 20)}`);
      await expectMiss(await call(garbled, reset(a), at), `grant after body ${rawBody.slice(0, 20)}`);
    }
    // A stored grant whose action is not one of the two is refused (and spent).
    const odd = newGrantToken();
    await db().prepare(`INSERT INTO operator_grants (token_hash, action, account_id, expires_at, created_at) VALUES (?1, 'ask-wipe', ?2, ?3, ?4)`).bind(await sha256Hex(odd), a, new Date(at.getTime() + 1000).toISOString(), at.toISOString()).run();
    await expectMiss(await call(odd, { action: 'ask-wipe', accountId: a }, at), 'unknown action');
    expect(await counts()).toEqual([2, 1]);

    // The live grant from the top was never spent by any of the refusals: it works once, then never again.
    const first = await call(live, reset(a), at);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ result: 'ok', requestsBefore: 2, requests: 0 });
    await expectMiss(await call(live, reset(a), at), 'grant used twice');
    expect(await counts()).toEqual([0, 1]);
    // Expired rows are swept when a grant is accepted, never by a refused request.
    const later = new Date(at.getTime() + 10 * 60 * 1000);
    const left = async () => (await db().prepare('SELECT COUNT(*) AS count FROM operator_grants WHERE created_at = ?1').bind(at.toISOString()).first<{ count: number }>())?.count;
    await expectMiss(await call(newGrantToken(), reset(a), later), 'unknown token, later');
    await expectMiss(await call(short, show(a), later), 'expired token, later');
    expect(await left()).toBeGreaterThan(0);
    expect((await call(await grant('ask-show', a, later), show(a), later)).status).toBe(200);
    expect(await left()).toBe(0);
  }, 20_000);

  it('says so when the account does not exist, changes nothing, and still spends the grant', async () => {
    const at = new Date('2037-01-07T12:00:00Z');
    const day = dayOf(at);
    const id = '539030';
    await db().prepare('DELETE FROM users WHERE github_id = ?1').bind(Number(id)).run();
    await admitFor(id, day);
    for (const action of ['ask-show', 'ask-reset'] as const) {
      const token = await grant(action, id, at);
      const response = await call(token, { action, accountId: id }, at);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ result: 'unknown-account', action, accountId: id });
      await expectMiss(await call(token, { action, accountId: id }, at), `${action} grant after unknown account`);
    }
    expect((await budget().accountUsage(day, id)).requests).toBe(1);
  });

  it('answers a grant holder 503 when the budget is unbound or failing', async () => {
    const at = new Date('2037-01-08T12:00:00Z');
    const id = '539040';
    await addUser(id);
    const failing = { getByName: () => ({ accountUsage: async () => { throw new Error('offline'); } }) } as unknown as EdgeEnv['ATLAS_BUDGET'];
    for (const ATLAS_BUDGET of [undefined, failing]) {
      const response = await call(await grant('ask-show', id, at), { action: 'ask-show', accountId: id }, at, { env: { ATLAS_BUDGET } });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('a token that is no live grant costs one primary-key read and no write', async () => {
    const at = new Date('2037-01-11T12:00:00Z');
    const id = '539060';
    await addUser(id);
    const real = db();
    const seen: string[] = [];
    const watched = {
      prepare(sql: string) { seen.push(sql); return real.prepare(sql); },
      batch(statements: D1PreparedStatement[]) { seen.push('batch'); return real.batch(statements); },
      exec(sql: string) { seen.push(`exec ${sql}`); return real.exec(sql); },
    } as unknown as D1Database;
    const body = { action: 'ask-show', accountId: id };
    const expired = await grant('ask-show', id, at, 1000);
    const far = await grant('ask-show', id, at, MAX_GRANT_LIFETIME_MS + 1);
    const rows = async () => (await real.prepare('SELECT COUNT(*) AS count FROM operator_grants WHERE created_at = ?1').bind(at.toISOString()).first<{ count: number }>())?.count;
    const tokens: Array<[string, string, Date]> = [['unknown', newGrantToken(), at], ['expired', expired, new Date(at.getTime() + 1000)], ['too far ahead', far, at]];
    for (const [label, token, when] of tokens) {
      seen.length = 0;
      await expectMiss(await call(token, body, when, { env: { USERS_DB: watched } }), label);
      expect(seen, label).toEqual(['SELECT expires_at, created_at FROM operator_grants WHERE token_hash = ?1']);
    }
    // Neither refused grant was removed by being presented.
    expect(await rows()).toBe(2);
    // The read uses the primary key, not a scan.
    const plan = (await real.prepare('EXPLAIN QUERY PLAN SELECT expires_at, created_at FROM operator_grants WHERE token_hash = ?1').bind('x').all<{ detail: string }>()).results.map(row => row.detail).join(' ');
    expect(plan).toMatch(/SEARCH operator_grants USING (?:COVERING )?INDEX sqlite_autoindex_operator_grants_1 \(token_hash=\?\)/);
    // An accepted grant: the read, the taking delete, the sweep, then the account lookup.
    seen.length = 0;
    expect((await call(await grant('ask-show', id, at), body, at, { env: { USERS_DB: watched } })).status).toBe(200);
    expect(seen.map(sql => sql.split(' ')[0])).toEqual(['SELECT', 'DELETE', 'DELETE', 'SELECT']);
  });

  it('two requests racing with one token: exactly one is answered', async () => {
    const at = new Date('2037-01-12T12:00:00Z');
    const day = dayOf(at);
    const id = '539070';
    await addUser(id);
    for (let i = 0; i < 3; i += 1) await admitFor(id, day);
    for (let round = 0; round < 5; round += 1) {
      const token = await grant('ask-show', id, at);
      const responses = await Promise.all([0, 1, 2].map(() => call(token, { action: 'ask-show', accountId: id }, at)));
      expect(responses.map(response => response.status).sort(), `round ${round}`).toEqual([200, 404, 404]);
      for (const response of responses) if (response.status === 404) await expectMiss(response, `round ${round} loser`);
    }
  }, 20_000);

  it('accepts a grant only while it expires within five minutes of the Worker\'s clock, in the script\'s exact timestamp shape', async () => {
    const at = new Date('2037-01-13T12:00:00Z');
    const id = '539080';
    await addUser(id);
    const body = { action: 'ask-show', accountId: id };
    expect(MAX_GRANT_LIFETIME_MS).toBe(5 * 60 * 1000);
    expect(GRANT_TTL_MS).toBeLessThan(MAX_GRANT_LIFETIME_MS);
    // Exactly five minutes ahead is the last accepted expiry.
    expect((await call(await grant('ask-show', id, at, MAX_GRANT_LIFETIME_MS), body, at)).status).toBe(200);
    // Further out is refused, twice (it is left in place, not taken), and stays refused in its own last five
    // minutes: it was written to live longer than a grant may.
    for (const ttl of [MAX_GRANT_LIFETIME_MS + 1, 60 * 60 * 1000, 10 * 365 * 24 * 60 * 60 * 1000]) {
      const far = await grant('ask-show', id, at, ttl);
      await expectMiss(await call(far, body, at), `expires ${ttl} ms ahead`);
      await expectMiss(await call(far, body, at), `expires ${ttl} ms ahead, again`);
      await expectMiss(await call(far, body, new Date(at.getTime() + ttl - MAX_GRANT_LIFETIME_MS - 1)), `expires ${ttl} ms ahead, just outside the window`);
      await expectMiss(await call(far, body, new Date(at.getTime() + ttl - 1000)), `expires ${ttl} ms ahead, in its last second`);
      await expectMiss(await call(far, body, new Date(at.getTime() + ttl)), `expires ${ttl} ms ahead, at expiry`);
    }
    // An expires_at in any other shape is never live, whatever it would compare as.
    const insert = db().prepare(`INSERT INTO operator_grants (token_hash, action, account_id, expires_at, created_at) VALUES (?1, 'ask-show', ?2, ?3, ?4)`);
    for (const expiresAt of ['2037-01-13T12:01:00Z', '2037-01-13 12:01:00.000', '2037-01-13T12:01:00.000+00:00', '2037-01-13T12:01:00.000Z ', '2037-01-13T12:01:00.000Zz', '2037-01-13T12:01', '9', '']) {
      const token = newGrantToken();
      await insert.bind(await sha256Hex(token), id, expiresAt, at.toISOString()).run();
      await expectMiss(await call(token, body, at), `expires_at ${JSON.stringify(expiresAt)}`);
    }
  }, 20_000);

  it('accepts a grant only when both its timestamps are real UTC instants and it was written to live at most five minutes', async () => {
    const id = '539090';
    await addUser(id);
    const body = { action: 'ask-show', accountId: id };
    const insert = db().prepare(`INSERT INTO operator_grants (token_hash, action, account_id, expires_at, created_at) VALUES (?1, 'ask-show', ?2, ?3, ?4)`);
    const written = async (expiresAt: string, createdAt: string) => {
      const token = newGrantToken();
      await insert.bind(await sha256Hex(token), id, expiresAt, createdAt).run();
      return token;
    };
    // The reviewer's case: February 30 sorts between now and five minutes ahead, but is no date.
    const feb = new Date('2039-02-28T23:58:00.000Z');
    await expectMiss(await call(await written('2039-02-30T12:00:00.000Z', feb.toISOString()), body, feb), 'expires_at February 30');
    for (const bad of ['2039-02-29T00:00:30.000Z', '2039-02-28T24:00:00.000Z', '2039-02-28T23:59:60.000Z', '2039-13-01T00:00:00.000Z']) {
      await expectMiss(await call(await written(bad, feb.toISOString()), body, feb), `expires_at ${bad}`);
    }
    // The control: the same moment written properly is accepted.
    expect((await call(await written('2039-03-01T00:00:00.000Z', feb.toISOString()), body, feb)).status).toBe(200);

    // A non-canonical created_at refuses an otherwise live grant.
    const at = new Date('2037-01-14T12:00:00.000Z');
    const expiresAt = new Date(at.getTime() + GRANT_TTL_MS).toISOString();
    for (const createdAt of ['2037-02-30T12:00:00.000Z', '2037-01-14T11:59:60.000Z', '2037-01-14T12:00:00Z', '2037-01-14 12:00:00.000', 'now', '']) {
      await expectMiss(await call(await written(expiresAt, createdAt), body, at), `created_at ${JSON.stringify(createdAt)}`);
    }
    // created_at must be before expires_at, by at most five minutes.
    await expectMiss(await call(await written(expiresAt, expiresAt), body, at), 'created at its expiry');
    await expectMiss(await call(await written(expiresAt, new Date(at.getTime() + GRANT_TTL_MS + 1000).toISOString()), body, at), 'created after its expiry');
    await expectMiss(await call(await written(expiresAt, new Date(at.getTime() + GRANT_TTL_MS - MAX_GRANT_LIFETIME_MS - 1).toISOString()), body, at), 'written to live 5 min + 1 ms');
    expect((await call(await written(expiresAt, new Date(at.getTime() + GRANT_TTL_MS - MAX_GRANT_LIFETIME_MS).toISOString()), body, at)).status).toBe(200);

    // Written today with tomorrow's expiry: refused today, and refused tomorrow in its last five minutes too.
    const tomorrow = new Date(at.getTime() + 24 * 60 * 60 * 1000);
    const late = await written(tomorrow.toISOString(), at.toISOString());
    await expectMiss(await call(late, body, at), 'tomorrow\'s grant today');
    for (const before of [MAX_GRANT_LIFETIME_MS, GRANT_TTL_MS, 1000, 1]) {
      await expectMiss(await call(late, body, new Date(tomorrow.getTime() - before)), `tomorrow's grant ${before} ms before it expires`);
    }
    // Still there (refused, never taken), so nothing else could have used it.
    expect(await db().prepare('SELECT COUNT(*) AS count FROM operator_grants WHERE expires_at = ?1').bind(tomorrow.toISOString()).first('count')).toBe(1);
  }, 20_000);

  const clearedMarks = (day: string) => runInDurableObject(budget(), (_budget, state) => state.storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM ask_reset_cleared WHERE day = ?', day).one().count);
  const resetVia = async (id: string, at: Date) => (await call(await grant('ask-reset', id, at), { action: 'ask-reset', accountId: id }, at)).json();

  it('an Ask in flight at a reset settles afterwards without giving an Ask back', async () => {
    const at = new Date('2037-01-09T12:00:00Z');
    const day = dayOf(at);
    const id = '539050';
    await addUser(id);
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push((await admitFor(id, day)).reservationId);
    await budget().settle(ids[2]!, 0.002);

    // Show still counts the two in flight after the reset.
    expect(await resetVia(id, at)).toEqual({ result: 'ok', action: 'ask-reset', accountId: id, day, requests: 0, refunds: 0, openAdmissions: 2, requestsBefore: 3 });
    const afterReset = await budget().usage(day);
    expect(afterReset).toMatchObject({ requests: { ask: 3 }, openReservations: 2 });
    expect(afterReset.reservedDollars).toBeCloseTo(0.02, 9);
    expect(afterReset.spentDollars).toBeCloseTo(0.002, 9);
    expect(await clearedMarks(day)).toBe(2);

    // Unanswered: admission closed, dollars settled at the kept estimate, no Ask returned and no refund recorded.
    await budget().settle(ids[0]!, undefined, true);
    expect(await budget().accountUsage(day, id)).toEqual({ day, requests: 0, refunds: 0, openAdmissions: 1 });
    // Answered: closes as usual.
    await budget().settle(ids[1]!, 0.004);
    expect(await budget().accountUsage(day, id)).toEqual({ day, requests: 0, refunds: 0, openAdmissions: 0 });
    // Settling one again changes nothing.
    await budget().settle(ids[0]!, 0, true);

    const settled = await budget().usage(day);
    expect(settled.requests.ask).toBe(3);
    expect(settled.openReservations).toBe(0);
    expect(settled.reservedDollars).toBe(0);
    expect(settled.spentDollars).toBeCloseTo(0.002 + 0.01 + 0.004, 9);
    expect(await clearedMarks(day)).toBe(0);
  });

  it('an Ask in flight at a reset cannot refund an Ask counted after it', async () => {
    const at = new Date('2037-01-14T12:00:00Z');
    const day = dayOf(at);
    const id = '539051';
    await addUser(id);
    const a = (await admitFor(id, day)).reservationId;
    expect(await resetVia(id, at)).toMatchObject({ requestsBefore: 1, requests: 0, openAdmissions: 1 });
    const b = (await admitFor(id, day)).reservationId;
    await budget().settle(b, 0.001);
    await budget().settle(a, 0, true);
    expect(await budget().accountUsage(day, id)).toEqual({ day, requests: 1, refunds: 0, openAdmissions: 0 });
    // B used one of the five: four more, not five.
    const more = [];
    for (let i = 0; i < 5; i += 1) more.push((await budget().admit({ bucket: 'ask', accountId: id, day, maxRequests: 1000, dollars: { estimate: 0.01, max: 100 } })).ok);
    expect(more).toEqual([true, true, true, true, false]);
    expect((await budget().usage(day)).requests.ask).toBe(6);
  });

  it('after a reset, new Asks and other accounts\' Asks in flight are still refunded as usual', async () => {
    const at = new Date('2037-01-15T12:00:00Z');
    const day = dayOf(at);
    const id = '539052';
    const other = '539053';
    await addUser(id);
    const before = (await admitFor(id, day)).reservationId;
    const theirs = (await admitFor(other, day)).reservationId;
    const otherDay = (await admitFor(id, '2037-01-16')).reservationId;
    await resetVia(id, at);
    // Only this account's admission for this day was marked.
    expect(await clearedMarks(day)).toBe(1);
    expect(await clearedMarks('2037-01-16')).toBe(0);

    const fresh = (await admitFor(id, day)).reservationId;
    const second = (await admitFor(id, day)).reservationId;
    await budget().settle(fresh, 0, true);
    expect(await budget().accountUsage(day, id)).toEqual({ day, requests: 1, refunds: 1, openAdmissions: 2 });
    await budget().settle(before, 0, true);
    expect(await budget().accountUsage(day, id)).toEqual({ day, requests: 1, refunds: 1, openAdmissions: 1 });
    await budget().settle(second, 0.001);

    await budget().settle(theirs, 0, true);
    expect(await budget().accountUsage(day, other)).toEqual({ day, requests: 0, refunds: 1, openAdmissions: 0 });
    await budget().settle(otherDay, 0, true);
    expect(await budget().accountUsage('2037-01-16', id)).toEqual({ day: '2037-01-16', requests: 0, refunds: 1, openAdmissions: 0 });
  });

  it('has its table from the migration applied to the test database', async () => {
    const migrations = (testEnv as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    expect(migrations.map(migration => migration.name)).toContain('0003_operator_grants.sql');
    const columns = (await db().prepare('PRAGMA table_info(operator_grants)').all<{ name: string; type: string; notnull: number; pk: number }>()).results;
    expect(columns.map(column => [column.name, column.type, column.notnull, column.pk])).toEqual([
      ['token_hash', 'TEXT', 0, 1],
      ['action', 'TEXT', 1, 0],
      ['account_id', 'TEXT', 1, 0],
      ['expires_at', 'TEXT', 1, 0],
      ['created_at', 'TEXT', 1, 0],
    ]);
  });
});

describe('operator asks script (CLA-539)', () => {
  const TOKEN = 'ab'.repeat(32);

  it('agrees with the Worker on the path and the daily allowance', () => {
    expect(SCRIPT_PATH).toBe(OPERATOR_ASK_USAGE_PATH);
    expect(DAILY_ASKS).toBe(USER_DAILY_ASKS);
    expect(GRANT_TTL_MS).toBe(120_000);
  });

  it('parses show and reset, refusing anything unexpected', () => {
    expect(parseAsksArgs(['show', 'production', '--github-id', '123'])).toEqual({ command: 'show', env: 'production', githubId: '123' });
    expect(parseAsksArgs(['reset', 'staging', '--github-id', '0'])).toEqual({ command: 'reset', env: 'staging', githubId: '0' });
    expect(parseAsksArgs(['show', 'local', '--github-id', '7'])).toEqual({ command: 'show', env: 'local', githubId: '7', port: DEFAULT_LOCAL_PORT });
    expect(parseAsksArgs(['reset', 'local', '--port', '4198', '--github-id', '7'])).toEqual({ command: 'reset', env: 'local', githubId: '7', port: 4198 });
    for (const argv of [
      [], ['show'], ['show', 'production'], ['wipe', 'production', '--github-id', '1'], ['show', 'prod', '--github-id', '1'],
      ['show', 'https://evil.example', '--github-id', '1'],
      ['show', 'production', '--github-id'], ['show', 'production', '--github-id', ''], ['show', 'production', '--github-id', '01'],
      ['show', 'production', '--github-id', '-1'], ['show', 'production', '--github-id', '1.5'], ['show', 'production', '--github-id', '0x10'],
      ['show', 'production', '--github-id', "1' OR '1'='1"], ['show', 'production', '--github-id', '99999999999999999999'],
      ['show', 'production', '--github-id', '1', '--github-id', '2'], ['show', 'production', '--github-id', '1', 'extra'],
      ['show', 'production', '--github-id', '1', '--origin', 'https://evil.example'], ['show', 'production', '--email', 'a@example.com'],
      ['reset', 'production', '--github-id', '1', '--port', '4198'], ['reset', 'staging', '--github-id', '1', '--port', '4198'],
      ['reset', 'local', '--github-id', '1', '--port', '0'], ['reset', 'local', '--github-id', '1', '--port', '65536'],
      ['reset', 'local', '--github-id', '1', '--port', '41x'], ['reset', 'local', '--github-id', '1', '--port'],
    ]) {
      expect(parseAsksArgs(argv), argv.join(' ')).toHaveProperty('error');
    }
  });

  it('sends the token only to the fixed origin for the target', () => {
    expect(ASK_ORIGINS).toEqual({ staging: 'https://staging.sourcefor.dev', production: 'https://sourcefor.dev' });
    expect(operatorOrigin('production')).toBe('https://sourcefor.dev');
    expect(operatorOrigin('staging')).toBe('https://staging.sourcefor.dev');
    expect(operatorOrigin('local')).toBe('http://127.0.0.1:4196');
    expect(operatorOrigin('local', 4198)).toBe('http://127.0.0.1:4198');
    expect(() => operatorOrigin('toString')).toThrow();
    expect(() => operatorOrigin('local', 0)).toThrow();
    expect(askUsageRequest({ token: TOKEN, action: 'ask-reset', accountId: '123' })).toEqual({
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: '{"action":"ask-reset","accountId":"123"}',
    });
    expect(() => askUsageRequest({ token: 'short', action: 'ask-reset', accountId: '123' })).toThrow();
    // The CLI sends through smokeRequester (redirect: 'manual') and has no other fetch.
    expect(asksScriptSource).toContain('const origin = operatorOrigin(args.env, args.port);');
    expect(asksScriptSource).toContain('smokeRequester({ origin, headers: access.headers })');
    expect(asksScriptSource).not.toMatch(/\bfetch\(/);
  });

  it('builds the grant SQL from the token\'s hash and the wrangler call for each target', async () => {
    const token = newGrantToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(newGrantToken()).not.toBe(token);
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    const tokenHash = await sha256Hex(token);
    const grantRow = { tokenHash, action: ASK_ACTIONS.reset, accountId: '123', createdAt: '2037-02-01T00:00:00.000Z', expiresAt: '2037-02-01T00:02:00.000Z' };
    const sql = grantSql(grantRow);
    expect(sql).toBe(`INSERT INTO operator_grants (token_hash, action, account_id, expires_at, created_at) VALUES ('${tokenHash}', 'ask-reset', '123', '2037-02-01T00:02:00.000Z', '2037-02-01T00:00:00.000Z');`);
    expect(sql).not.toContain(token);
    for (const bad of [
      { tokenHash: 'x' }, { tokenHash: tokenHash.toUpperCase() }, { action: 'ask-wipe' }, { action: "ask-show'; DROP TABLE users; --" },
      { accountId: "1' OR '1'='1" }, { accountId: '01' }, { accountId: 123 as unknown as string }, { expiresAt: "2037'" }, { createdAt: 'now' },
    ]) {
      expect(() => grantSql({ ...grantRow, ...bad }), JSON.stringify(bad)).toThrow();
    }
    // The statement runs against the real schema.
    await edgeEnv.USERS_DB!.exec(sql);
    expect(await edgeEnv.USERS_DB!.prepare('DELETE FROM operator_grants WHERE token_hash = ?1 RETURNING action, account_id, expires_at').bind(tokenHash).first()).toEqual({ action: 'ask-reset', account_id: '123', expires_at: '2037-02-01T00:02:00.000Z' });

    expect(wranglerD1Args('production', sql)).toEqual(['exec', 'wrangler', 'd1', 'execute', 'USERS_DB', '--env', 'production', '--remote', '--json', '--command', sql]);
    expect(wranglerD1Args('staging', sql)).toEqual(['exec', 'wrangler', 'd1', 'execute', 'USERS_DB', '--env', 'staging', '--remote', '--json', '--command', sql]);
    expect(wranglerD1Args('local', sql)).toEqual(['exec', 'wrangler', 'd1', 'execute', 'USERS_DB', '--env=', '--local', '--json', '--command', sql]);
    expect(() => wranglerD1Args('prod', sql)).toThrow();
  });

  it('formats the Worker\'s answer and never prints the token or the raw body', () => {
    const show = { command: 'show', env: 'production', githubId: '123' } as const;
    const reset = { command: 'reset', env: 'staging', githubId: '123' } as const;
    const body = (extra: Record<string, unknown>) => JSON.stringify({ result: 'ok', accountId: '123', day: '2037-02-01', requests: 3, refunds: 1, openAdmissions: 2, echo: TOKEN, ...extra });

    expect(readAskUsageResult(show, 200, body({ action: 'ask-show' }))).toEqual({ ok: true, lines: [
      'account 123 on production, UTC day 2037-02-01',
      '  Asks counted today: 3 of 5',
      '  Asks given back for unanswered replies: 1',
      '  Asks in flight (admitted, not settled): 2',
    ] });
    expect(readAskUsageResult(reset, 200, body({ action: 'ask-reset', requests: 0, requestsBefore: 5 }))).toEqual({ ok: true, lines: [
      'account 123 on staging, UTC day 2037-02-01',
      '  reset: Asks counted 5 -> 0',
      '  Asks counted today: 0 of 5',
      '  Asks given back for unanswered replies: 1',
      '  Asks in flight (admitted, not settled): 2',
    ] });
    expect(readAskUsageResult(show, 200, JSON.stringify({ result: 'unknown-account', action: 'ask-show', accountId: '123' }))).toEqual({ ok: false, message: 'no account with GitHub id 123 on production; nothing was changed' });
    expect(readAskUsageResult(show, 404, jsonText({ error: 'not found' }))).toMatchObject({ ok: false, message: expect.stringContaining('the grant was not accepted') });
    expect(readAskUsageResult(show, 503, '{}')).toMatchObject({ ok: false, message: expect.stringContaining('budget is unavailable') });
    const refused = [
      readAskUsageResult(show, 200, `<html>${TOKEN}</html>`),
      readAskUsageResult(show, 302, TOKEN),
      readAskUsageResult(show, 500, body({ action: 'ask-show' })),
      readAskUsageResult(show, 200, body({ action: 'ask-reset', requestsBefore: 5 })), // the other action's answer
      readAskUsageResult(show, 200, body({ action: 'ask-show', accountId: '124' })),
      readAskUsageResult(show, 200, body({ action: 'ask-show', requests: -1 })),
      readAskUsageResult(show, 200, body({ action: 'ask-show', day: TOKEN })),
      readAskUsageResult(reset, 200, body({ action: 'ask-reset' })), // no requestsBefore
      readAskUsageResult(show, 200, 'null'),
    ];
    for (const outcome of refused) expect(outcome).toMatchObject({ ok: false });
    for (const outcome of [...refused, readAskUsageResult(show, 200, body({ action: 'ask-show' })), readAskUsageResult(show, 404, TOKEN), readAskUsageResult(show, 503, TOKEN)]) {
      expect(JSON.stringify(outcome)).not.toContain(TOKEN);
    }
    // The CLI prints only what readAskUsageResult returns, redacted, and wrangler never sees the token.
    expect(asksScriptSource).not.toMatch(/console\.(?:log|error)\([^)]*\btoken\b(?!,)/);
    expect(asksScriptSource).toContain('const secrets = { ...access.headers, token };');
    expect(asksScriptSource).toContain('tokenHash: await sha256Hex(token),');
  });
});
