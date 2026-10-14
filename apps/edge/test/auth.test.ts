import { beforeEach, describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../web/src/securityHeaders';
import { PRIVACY_POLICY_VERSION } from '../../web/src/siteMeta';
import { SESSION_TTL_SECONDS, signSession, verifySession, type UserRow } from '../src/auth';
import type { EdgeEnv } from '../src/env';
import { jsonText } from '../src/http';
import { edgeEnv, edgeFetch, tamperSignature, type EdgeFetchOptions } from './helpers';

const KEY = 'test-signing-key-0123456789abcdef-0123456789';
const OTHER_KEY = 'another-signing-key-0123456789abcdef-xyz';
const TOKEN = 'gho_superSecretAccessTokenNeverLeaks123';
const HTTPS = 'https://sourcefor.dev';
const NOW = new Date('2026-09-30T12:00:00Z');
const now = () => NOW;

/** OAuth configured on the production origin (https: __Host- cookies). */
const OAUTH: Partial<EdgeEnv> = {
  OKIE_PUBLIC_ORIGIN: HTTPS,
  GITHUB_CLIENT_ID: 'Iv1.testclientid',
  GITHUB_CLIENT_SECRET: 'test-client-secret-value',
  SESSION_SIGNING_KEY: KEY,
};
/** Local test-login mode (loopback request origin, no OAuth app). */
const TEST_LOGIN: Partial<EdgeEnv> = { DEV_AUTH_TEST_LOGIN: '1', SESSION_SIGNING_KEY: KEY };

type GithubUser = { id: number; login: string };
type FakeGithub = { fetch: typeof fetch; seen: Request[] };

function fakeGithub(user: GithubUser = { id: 4242, login: 'octo-cat' }, emails: unknown = [
  { email: 'secondary@example.com', primary: false, verified: true },
  { email: 'octo@example.com', primary: true, verified: true },
], options: { failToken?: boolean; failUser?: boolean } = {}): FakeGithub {
  const seen: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    seen.push(request.clone());
    const url = new URL(request.url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.href === 'https://github.com/login/oauth/access_token') {
      return options.failToken ? json({ error: 'bad_verification_code', error_description: `code rejected ${TOKEN}` }) : json({ access_token: TOKEN, token_type: 'bearer' });
    }
    if (request.headers.get('authorization') !== `Bearer ${TOKEN}`) return json({ message: 'Bad credentials' }, 401);
    if (url.href === 'https://api.github.com/user') return options.failUser ? json({ message: `boom ${TOKEN}` }, 500) : json(user);
    if (url.href === 'https://api.github.com/user/emails') return json(emails);
    return new Response('unexpected', { status: 599 });
  }) as typeof fetch;
  return { fetch: fetchImpl, seen };
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieValue(response: Response, name: string): string | undefined {
  for (const header of setCookies(response)) {
    const [pair] = header.split(';');
    const at = pair!.indexOf('=');
    if (pair!.slice(0, at) === name) return pair!.slice(at + 1);
  }
  return undefined;
}

async function fetchAt(path: string, env: Partial<EdgeEnv>, options: EdgeFetchOptions & { cookie?: string; origin?: string } = {}): Promise<Response> {
  const base = env.OKIE_PUBLIC_ORIGIN ?? 'http://127.0.0.1:4196';
  const headers = new Headers(options.init?.headers);
  if (options.cookie) headers.set('cookie', options.cookie);
  const request = new Request(new URL(path, base), { redirect: 'manual', ...options.init, headers });
  return edgeFetch(request, { now, ...options, env: { ...env, ...options.env } });
}

async function readUserRow(githubId: number): Promise<UserRow | null> {
  return edgeEnv.USERS_DB!.prepare('SELECT * FROM users WHERE github_id = ?1').bind(githubId).first<UserRow>();
}

/** Starts sign-in, then runs the callback with the state GitHub would send back. */
async function signInWithGithub(github: FakeGithub, returnTo = '/r/acme/app', env: Partial<EdgeEnv> = OAUTH) {
  const start = await fetchAt(`/api/auth/github?return=${encodeURIComponent(returnTo)}`, env);
  const authorize = new URL(start.headers.get('location')!);
  const state = authorize.searchParams.get('state')!;
  const name = env.OKIE_PUBLIC_ORIGIN?.startsWith('https') ? '__Host-sf_oauth_state' : 'sf_oauth_state';
  const stateCookie = cookieValue(start, name)!;
  const callback = await fetchAt(`/api/auth/github/callback?code=abc123&state=${encodeURIComponent(state)}`, env, { cookie: `${name}=${stateCookie}`, fetch: github.fetch });
  return { start, authorize, state, stateCookie, callback };
}

async function sessionCookieFor(githubId: number, login: string, options: { key?: string; exp?: number; iat?: number } = {}): Promise<string> {
  const iat = options.iat ?? Math.floor(NOW.getTime() / 1000);
  return signSession({ sub: String(githubId), login, iat, exp: options.exp ?? iat + SESSION_TTL_SECONDS }, options.key ?? KEY);
}

async function insertUser(githubId: number, login: string, extra: Partial<UserRow> = {}): Promise<void> {
  const row = { email: 'someone@example.com', email_verified: 1, product_updates_opt_in: 0, product_updates_changed_at: null, ...extra };
  await edgeEnv.USERS_DB!.prepare(
    'INSERT INTO users (github_id, github_login, email, email_verified, created_at, last_sign_in_at, privacy_version, product_updates_opt_in, product_updates_changed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, ?7, ?8)',
  ).bind(githubId, login, row.email, row.email_verified, '2026-09-01T00:00:00.000Z', PRIVACY_POLICY_VERSION, row.product_updates_opt_in, row.product_updates_changed_at).run();
}

const SESSION = '__Host-sf_session';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** atob-style lenient decode: ignores the unused low bits of the last character. */
function lenientDecode(text: string): string {
  return atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
}

/** The same bytes spelled differently: flips the lowest bit of the last character, always an unused bit when length % 4 is 2 or 3. */
function lastCharVariant(part: string): string {
  return part.slice(0, -1) + B64URL[B64URL.indexOf(part.at(-1)!) ^ 1]!;
}

beforeEach(async () => {
  // This file's ids only (test/users.test.ts uses >= 900000 in the same database).
  await edgeEnv.USERS_DB!.exec('DELETE FROM users WHERE github_id < 900000');
});

describe('accounts off (CLA-316): nothing changes without the secrets', () => {
  const PUBLIC_TEXT = jsonText({ authenticated: false, mode: 'public', oauthConfigured: false, ask: false });

  it('answers /api/auth/me with exactly the public bytes and 404s every other auth route, for every partial config', async () => {
    const partials: Array<Partial<EdgeEnv>> = [
      {},
      { GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret' },
      { ...OAUTH, SESSION_SIGNING_KEY: 'too-short' },
      { ...OAUTH, USERS_DB: undefined },
      { ...OAUTH, GITHUB_CLIENT_SECRET: '' },
      // Test login is never honoured on a non-loopback origin.
      { ...TEST_LOGIN, OKIE_PUBLIC_ORIGIN: HTTPS },
    ];
    for (const env of partials) {
      const me = await fetchAt('/api/auth/me', env);
      expect(me.status).toBe(200);
      expect(await me.text(), JSON.stringify(env)).toBe(PUBLIC_TEXT);
      expect(me.headers.get('cache-control')).toBe('no-store');
      expect(setCookies(me)).toEqual([]);
      for (const [method, path] of [['GET', '/api/auth/github'], ['GET', '/api/auth/github/callback?code=x&state=y'], ['GET', '/api/auth/github/test-login'], ['GET', '/api/auth/logout'], ['POST', '/api/auth/logout'], ['POST', '/api/account/preferences'], ['POST', '/api/account/delete']] as const) {
        const response = await fetchAt(path, env, { init: { method } });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.json()).toEqual({ error: 'not found' });
      }
      // /account is not intercepted: it answers exactly like any unknown path (GET: the 404 page).
      for (const method of ['GET', 'POST', 'PUT']) {
        const account = await fetchAt('/account', env, { init: { method } });
        const unknown = await fetchAt('/no-such-page', env, { init: { method } });
        expect(account.status, method).toBe(unknown.status);
        expect(await account.text(), method).toBe(await unknown.text());
      }
      expect((await fetchAt('/account', env)).status).toBe(404);
      expect((await fetchAt('/api/operator/session', env)).status).toBe(404);
    }
  });

  it('never answers accounts on a non-loopback request without OKIE_PUBLIC_ORIGIN (redirect_uri never comes from Host)', async () => {
    const env = { ...OAUTH, OKIE_PUBLIC_ORIGIN: undefined };
    const response = await edgeFetch(new Request('https://evil.example/api/auth/github', { redirect: 'manual' }), { now, env });
    expect(response.status).toBe(404);
    expect(await (await edgeFetch('https://evil.example/api/auth/me', { now, env })).text()).toBe(PUBLIC_TEXT);
  });
});

describe('GitHub sign-in (CLA-316)', () => {
  it('reports the accounts shape on /api/auth/me', async () => {
    const response = await fetchAt('/api/auth/me', OAUTH);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      authenticated: false, mode: 'accounts', oauthConfigured: true, loginPath: '/api/auth/github', logoutPath: '/api/auth/logout', accountPath: '/account', ask: false,
    });
    expect(await (await fetchAt('/api/auth/me', { ...OAUTH, ASK_ENABLED: '1' })).json()).toMatchObject({ ask: true });
  });

  it('redirects to GitHub with the configured redirect_uri, user:email scope and a signed, HttpOnly __Host- state cookie', async () => {
    const response = await fetchAt('/api/auth/github?return=/r/acme/app', OAUTH);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe('Iv1.testclientid');
    expect(location.searchParams.get('redirect_uri')).toBe('https://sourcefor.dev/api/auth/github/callback');
    expect(location.searchParams.get('scope')).toBe('user:email');
    expect(location.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.href).not.toContain('test-client-secret-value');
    const [state] = setCookies(response);
    expect(state).toMatch(/^__Host-sf_oauth_state=v1\.[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/);
    // The state cookie is signed, not the bare nonce.
    expect(state).not.toContain(location.searchParams.get('state')!);
  });

  it('signs in a new user: row stored with opt-in 0 and the primary verified email, session cookie set, welcome redirect', async () => {
    const github = fakeGithub();
    const { callback } = await signInWithGithub(github, '/r/acme/app');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/account?welcome=1&return=%2Fr%2Facme%2Fapp');
    const cookies = setCookies(callback);
    expect(cookies[0]).toMatch(new RegExp(`^${SESSION}=v1\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}; Secure$`));
    expect(cookies[1]).toBe('__Host-sf_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure');
    expect(await readUserRow(4242)).toEqual({
      github_id: 4242, github_login: 'octo-cat', email: 'octo@example.com', email_verified: 1,
      created_at: NOW.toISOString(), last_sign_in_at: NOW.toISOString(), privacy_version: PRIVACY_POLICY_VERSION,
      product_updates_opt_in: 0, product_updates_changed_at: null,
    });
    // GitHub saw the code exchange (JSON, with the configured redirect_uri) and User-Agent on every call.
    const [exchange, user, emails] = github.seen;
    expect(await exchange!.json()).toEqual({ client_id: 'Iv1.testclientid', client_secret: 'test-client-secret-value', code: 'abc123', redirect_uri: 'https://sourcefor.dev/api/auth/github/callback' });
    for (const request of github.seen) expect(request.headers.get('user-agent')).toBeTruthy();
    expect(user!.url).toBe('https://api.github.com/user');
    expect(emails!.url).toBe('https://api.github.com/user/emails');

    const session = cookieValue(callback, SESSION)!;
    const me = await fetchAt('/api/auth/me', OAUTH, { cookie: `${SESSION}=${session}` });
    expect(await me.json()).toMatchObject({ authenticated: true, login: 'octo-cat', mode: 'accounts' });
  });

  it('signs a returning user straight back to returnTo, refreshing login/email but never the opt-in', async () => {
    await insertUser(4242, 'old-name', { email: 'old@example.com', product_updates_opt_in: 1, product_updates_changed_at: '2026-09-02T00:00:00.000Z' });
    const { callback } = await signInWithGithub(fakeGithub({ id: 4242, login: 'octo-cat' }), '/r/acme/app');
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/r/acme/app');
    expect(await readUserRow(4242)).toMatchObject({
      github_login: 'octo-cat', email: 'octo@example.com', created_at: '2026-09-01T00:00:00.000Z', last_sign_in_at: NOW.toISOString(),
      product_updates_opt_in: 1, product_updates_changed_at: '2026-09-02T00:00:00.000Z',
    });
  });

  it('stores a null email when GitHub has no primary verified address (sign-in still succeeds)', async () => {
    const { callback } = await signInWithGithub(fakeGithub({ id: 7, login: 'no-mail' }, [
      { email: 'unverified@example.com', primary: true, verified: false },
      { email: 'other@example.com', primary: false, verified: true },
    ]));
    expect(callback.status).toBe(302);
    expect(await readUserRow(7)).toMatchObject({ email: null, email_verified: 0, product_updates_opt_in: 0 });
  });

  it('sends a GitHub-side denial back to returnTo, signed out', async () => {
    const start = await fetchAt('/api/auth/github?return=/r/acme/app', OAUTH);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const response = await fetchAt(`/api/auth/github/callback?error=access_denied&state=${state}`, OAUTH, { cookie: `__Host-sf_oauth_state=${cookieValue(start, '__Host-sf_oauth_state')}` });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/r/acme/app');
    expect(cookieValue(response, SESSION)).toBeUndefined();
  });

  it('rejects a missing, mismatched, tampered, wrong-key or expired state with 400', async () => {
    const start = await fetchAt('/api/auth/github?return=/', OAUTH);
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const good = cookieValue(start, '__Host-sf_oauth_state')!;
    const [v, , signature] = good.split('.');
    const tamperedPayload = btoa(JSON.stringify({ nonce: state, returnTo: '/', exp: 9999999999 })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const cases: Array<[string, string | undefined, EdgeFetchOptions?]> = [
      ['no cookie', undefined],
      ['wrong state param', good],
      ['tampered payload', `${v}.${tamperedPayload}.${signature}`],
      ['tampered signature', tamperSignature(good)],
      ['non-canonical signature', `${v}.${good.split('.')[1]}.${lastCharVariant(signature!)}`],
      ['garbage', 'not-a-token'],
      ['expired', good, { now: () => new Date(NOW.getTime() + 11 * 60 * 1000) }],
    ];
    const github = fakeGithub();
    for (const [label, cookie, extra] of cases) {
      const stateParam = label === 'wrong state param' ? 'x'.repeat(43) : state;
      const response = await fetchAt(`/api/auth/github/callback?code=abc&state=${stateParam}`, OAUTH, { ...(cookie ? { cookie: `__Host-sf_oauth_state=${cookie}` } : {}), fetch: github.fetch, ...extra });
      expect(response.status, label).toBe(400);
      expect(cookieValue(response, SESSION), label).toBeUndefined();
    }
    const wrongKey = await fetchAt(`/api/auth/github/callback?code=abc&state=${state}`, { ...OAUTH, SESSION_SIGNING_KEY: OTHER_KEY }, { cookie: `__Host-sf_oauth_state=${good}`, fetch: github.fetch });
    expect(wrongKey.status).toBe(400);
    // GitHub was never called for a bad state.
    expect(github.seen).toHaveLength(0);
  });

  it('answers a generic 502 when GitHub fails, and the token never appears in any response body or header', async () => {
    for (const options of [{ failToken: true }, { failUser: true }]) {
      const { callback } = await signInWithGithub(fakeGithub(undefined, undefined, options));
      expect(callback.status).toBe(502);
      const text = await callback.text();
      expect(JSON.parse(text)).toEqual({ error: 'GitHub sign-in failed. Try again.' });
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('boom');
      expect(text).not.toContain('bad_verification_code');
      expect(cookieValue(callback, SESSION)).toBeUndefined();
    }
    const { start, callback } = await signInWithGithub(fakeGithub());
    const me = await fetchAt('/api/auth/me', OAUTH, { cookie: `${SESSION}=${cookieValue(callback, SESSION)}` });
    for (const response of [start, callback, me]) {
      const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join('\n');
      expect(headers).not.toContain(TOKEN);
      expect(await response.clone().text()).not.toContain(TOKEN);
    }
    // Nor in the session cookie payload.
    const payload = cookieValue(callback, SESSION)!.split('.')[1]!;
    expect(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('gho_');
  });

  it('sanitizes return paths: //evil, https://evil, backslashes and control characters fall back to /', async () => {
    for (const bad of ['//evil.example', 'https://evil.example/', '/\\evil.example', '/ok\\..\\evil', 'evil', '/a\r\nset-cookie: x=1', '/中', '/ ', '/a b']) {
      const response = await fetchAt(`/api/auth/github?return=${encodeURIComponent(bad)}`, { ...OAUTH, GITHUB_CLIENT_ID: undefined, GITHUB_CLIENT_SECRET: undefined, OKIE_PUBLIC_ORIGIN: undefined, DEV_AUTH_TEST_LOGIN: '1' });
      expect(response.headers.get('location'), bad).toBe('/api/auth/github/test-login?return=%2F');
      const logout = await fetchAt(`/api/auth/logout?return=${encodeURIComponent(bad)}`, OAUTH);
      expect(logout.headers.get('location'), bad).toBe('/');
    }
    const { callback } = await signInWithGithub(fakeGithub({ id: 9, login: 'returning' }), '//evil.example');
    expect(callback.headers.get('location')).toBe('/account?welcome=1&return=%2F');
    // Non-ASCII (a Location header must be a ByteString): a returning user lands on / rather than a 502.
    const again = await signInWithGithub(fakeGithub({ id: 9, login: 'returning' }), '/中');
    expect(again.callback.status).toBe(302);
    expect(again.callback.headers.get('location')).toBe('/');
    const cookie = `${SESSION}=${cookieValue(again.callback, SESSION)}`;
    const welcome = await (await fetchAt('/account?welcome=1&return=%2F%E4%B8%AD', OAUTH, { cookie })).text();
    expect(welcome).toContain('<input type="hidden" name="return" value="/" />');
    const saved = await fetchAt('/api/account/preferences', OAUTH, { init: { method: 'POST', body: new URLSearchParams({ return: '/中' }).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: HTTPS, cookie } } });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/');
  });

  it('accepts GitHub EMU logins with underscores', async () => {
    const { callback } = await signInWithGithub(fakeGithub({ id: 31, login: 'name_shortcode' }));
    expect(callback.status).toBe(302);
    expect(await readUserRow(31)).toMatchObject({ github_login: 'name_shortcode' });
  });

  it('answers GET /api/operator/session with operator: false while accounts are on (the SPA account menu probes it)', async () => {
    const response = await fetchAt('/api/operator/session', OAUTH);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ operator: false });
    expect((await fetchAt('/api/operator/session', OAUTH, { init: { method: 'POST' } })).status).toBe(404);
  });

  it('treats a tampered, expired or wrong-key session, or a deleted account, as signed out (clearing the cookie)', async () => {
    await insertUser(55, 'alice');
    const good = await sessionCookieFor(55, 'alice');
    expect(await (await fetchAt('/api/auth/me', OAUTH, { cookie: `${SESSION}=${good}` })).json()).toMatchObject({ authenticated: true, login: 'alice' });
    const [v, , signature] = good.split('.');
    const forged = btoa(JSON.stringify({ sub: '1', login: 'admin', iat: 0, exp: 9999999999 })).replace(/=+$/, '');
    const bad = [
      `${v}.${forged}.${signature}`,
      tamperSignature(good),
      await sessionCookieFor(55, 'alice', { key: OTHER_KEY }),
      await sessionCookieFor(55, 'alice', { iat: 1_000_000, exp: Math.floor(NOW.getTime() / 1000) - 1 }),
      'v1.garbage',
    ];
    for (const token of bad) {
      const me = await fetchAt('/api/auth/me', OAUTH, { cookie: `${SESSION}=${token}` });
      expect(await me.json(), token).toMatchObject({ authenticated: false, mode: 'accounts' });
      expect(setCookies(me), token).toEqual([`${SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`]);
    }
    await edgeEnv.USERS_DB!.prepare('DELETE FROM users WHERE github_id = 55').run();
    const deleted = await fetchAt('/api/auth/me', OAUTH, { cookie: `${SESSION}=${good}` });
    expect(await deleted.json()).toMatchObject({ authenticated: false });
    expect(setCookies(deleted)).toEqual([`${SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`]);
  });

  it('logs out: GET clears both cookies and redirects to the safe return, POST answers JSON', async () => {
    const get = await fetchAt('/api/auth/logout?return=/r/acme/app', OAUTH);
    expect(get.status).toBe(302);
    expect(get.headers.get('location')).toBe('/r/acme/app');
    expect(setCookies(get)).toEqual([
      `${SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`,
      '__Host-sf_oauth_state=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure',
    ]);
    const post = await fetchAt('/api/auth/logout', OAUTH, { init: { method: 'POST' } });
    expect(post.status).toBe(200);
    expect(await post.json()).toEqual({ authenticated: false, loginPath: '/api/auth/github' });
    expect(setCookies(post)).toHaveLength(2);
  });
});

describe('test login (local only)', () => {
  it('signs in the fixed test user on loopback with plain (non-__Host-) cookies, and advertises testLoginPath', async () => {
    const me = await fetchAt('/api/auth/me', TEST_LOGIN);
    expect(await me.json()).toMatchObject({ mode: 'accounts', oauthConfigured: true, testLoginPath: '/api/auth/github/test-login' });
    const response = await fetchAt('/api/auth/github/test-login?return=/r/acme/app', TEST_LOGIN);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/account?welcome=1&return=%2Fr%2Facme%2Fapp');
    const [session] = setCookies(response);
    expect(session).toMatch(/^sf_session=v1\.[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/);
    expect(await readUserRow(0)).toMatchObject({ github_login: 'okie-test-user', email: 'test@example.invalid', product_updates_opt_in: 0 });
    const signedIn = await fetchAt('/api/auth/me', TEST_LOGIN, { cookie: `sf_session=${cookieValue(response, 'sf_session')}` });
    expect(await signedIn.json()).toMatchObject({ authenticated: true, login: 'okie-test-user' });
  });

  it('is a 404 unless test-login mode is on (OAuth-only config, or a non-loopback public origin)', async () => {
    expect((await fetchAt('/api/auth/github/test-login', OAUTH)).status).toBe(404);
    expect((await fetchAt('/api/auth/github/test-login', { ...OAUTH, DEV_AUTH_TEST_LOGIN: '1' })).status).toBe(404);
    expect((await fetchAt('/api/auth/github/test-login', { ...TEST_LOGIN, DEV_AUTH_TEST_LOGIN: '0' })).status).toBe(404);
    // A loopback public origin keeps it on.
    expect((await fetchAt('/api/auth/github/test-login', { ...TEST_LOGIN, OKIE_PUBLIC_ORIGIN: 'http://localhost:4196' })).status).toBe(302);
  });
});

describe('/account (CLA-316)', () => {
  async function signedIn(login = 'alice', extra: Partial<UserRow> = {}) {
    await insertUser(55, login, extra);
    return `${SESSION}=${await sessionCookieFor(55, login)}`;
  }

  /** `origin: null` sends no Origin header. */
  const form = (fields: Record<string, string>, origin: string | null = HTTPS, cookie?: string): RequestInit => ({
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
  });

  it('sends a signed-out visitor to GitHub sign-in and back', async () => {
    const response = await fetchAt('/account', OAUTH);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/api/auth/github?return=%2Faccount');
  });

  it('shows login and email, escaped, private and uncached, with the CSP and no script', async () => {
    const cookie = await signedIn('<b>mallory</b>', { email: 'a"<x>@example.com' });
    const response = await fetchAt('/account', OAUTH, { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-security-policy')).toBe(contentSecurityPolicy({ framable: false }));
    const html = await response.text();
    expect(html).toContain('@&lt;b&gt;mallory&lt;/b&gt;');
    expect(html).not.toContain('<b>mallory</b>');
    expect(html).toContain('a&quot;&lt;x&gt;@example.com');
    expect(html).not.toMatch(/<script/i);
    // No external resources (outbound links in the footer are fine).
    expect(html).not.toMatch(/\ssrc="/);
    expect(html).not.toMatch(/<link[^>]*href="https?:/);
    // Unticked unless opted in.
    expect(html).toContain('<input type="checkbox" name="product_updates" value="1" />');
    expect(html).toContain('action="/api/account/delete"');
    expect(html).toContain('mailto:hello@sourcefor.dev');
    // CLA-316 increment 2: the help line links the privacy page.
    expect(html).toContain('<a href="/privacy">Privacy</a>');
  });

  it('never carries the Web Analytics beacon, and its CSP does not allow it (CLA-316)', async () => {
    const cookie = await signedIn();
    const env = { ...OAUTH, WEB_ANALYTICS_TOKEN: '0123456789abcdef0123456789ABCDEF' };
    for (const path of ['/account', '/account?welcome=1&return=/']) {
      const response = await fetchAt(path, env, { cookie });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain('cloudflareinsights');
      expect(response.headers.get('content-security-policy')).toBe(contentSecurityPolicy({ framable: false }));
    }
    const ended = await fetchAt('/api/account/preferences', env, { init: form({}) });
    expect(ended.status).toBe(401);
    expect(await ended.text()).not.toContain('cloudflareinsights');
    expect(ended.headers.get('content-security-policy')).not.toContain('cloudflareinsights');
    // The home still gets it.
    expect(await (await fetchAt('/', env)).text()).toContain('cloudflareinsights.com/beacon');
  });

  it('shows the no-email copy and a ticked box when opted in; the welcome variant returns on Continue', async () => {
    const cookie = await signedIn('bob', { email: null, email_verified: 0, product_updates_opt_in: 1 });
    const html = await (await fetchAt('/account', OAUTH, { cookie })).text();
    expect(html).toContain('no verified primary email, so we don’t have one on file');
    expect(html).toContain('name="product_updates" value="1" checked />');
    const welcome = await (await fetchAt('/account?welcome=1&return=%2F%2Fevil.example', OAUTH, { cookie })).text();
    expect(welcome).toContain('You’re signed in');
    expect(welcome).toContain('<input type="hidden" name="return" value="/" />');
    expect(welcome).toContain('>Continue</button>');
  });

  it('preferences: 403 without a same-origin Origin, sign-in redirect without a session, sets and clears the opt-in', async () => {
    const cookie = await signedIn();
    for (const origin of [null, 'https://evil.example', 'null', 'http://sourcefor.dev']) {
      const response = await fetchAt('/api/account/preferences', OAUTH, { init: form({ product_updates: '1' }, origin, cookie) });
      expect(response.status, String(origin)).toBe(403);
    }
    expect(await readUserRow(55)).toMatchObject({ product_updates_opt_in: 0 });
    // No session: a page with a sign-in link, not a redirect into OAuth (form-action 'self' would block github.com).
    for (const path of ['/api/account/preferences', '/api/account/delete']) {
      const anonymous = await fetchAt(path, OAUTH, { init: form({ product_updates: '1', confirm: '1' }) });
      expect(anonymous.status, path).toBe(401);
      expect(anonymous.headers.get('location')).toBeNull();
      expect(anonymous.headers.get('cache-control')).toBe('no-store');
      expect(anonymous.headers.get('content-type')).toBe('text/html; charset=utf-8');
      const page = await anonymous.text();
      expect(page).toContain('Your session has ended');
      expect(page).toContain('href="/api/auth/github?return=%2Faccount">Sign in again</a>');
      expect(page).not.toMatch(/<script/i);
    }
    const expired = await fetchAt('/api/account/preferences', OAUTH, { init: form({}, HTTPS, `${SESSION}=${await sessionCookieFor(55, 'alice', { key: OTHER_KEY })}`) });
    expect(expired.status).toBe(401);
    expect(setCookies(expired)).toEqual([`${SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`]);

    const on = await fetchAt('/api/account/preferences', OAUTH, { init: form({ product_updates: '1' }, HTTPS, cookie) });
    expect(on.status).toBe(303);
    expect(on.headers.get('location')).toBe('/account?saved=1');
    expect(await readUserRow(55)).toMatchObject({ product_updates_opt_in: 1, product_updates_changed_at: NOW.toISOString() });
    // Saving again without a change keeps the change time.
    const later = () => new Date('2026-10-01T00:00:00Z');
    await fetchAt('/api/account/preferences', OAUTH, { init: form({ product_updates: '1' }, HTTPS, cookie), now: later });
    expect(await readUserRow(55)).toMatchObject({ product_updates_changed_at: NOW.toISOString() });
    const off = await fetchAt('/api/account/preferences', OAUTH, { init: form({}, HTTPS, cookie), now: later });
    expect(off.status).toBe(303);
    expect(await readUserRow(55)).toMatchObject({ product_updates_opt_in: 0, product_updates_changed_at: '2026-10-01T00:00:00.000Z' });
    // The welcome form returns to its (sanitized) return path.
    const welcome = await fetchAt('/api/account/preferences', OAUTH, { init: form({ return: '/r/acme/app' }, HTTPS, cookie) });
    expect(welcome.headers.get('location')).toBe('/r/acme/app');
    const evil = await fetchAt('/api/account/preferences', OAUTH, { init: form({ return: '//evil.example' }, HTTPS, cookie) });
    expect(evil.headers.get('location')).toBe('/');
    expect((await fetchAt('/account?saved=1', OAUTH, { cookie }).then(r => r.text()))).toContain('data-account-saved');
  });

  it('delete requires the confirm box and a same-origin Origin, then removes the row and signs out', async () => {
    const cookie = await signedIn();
    expect((await fetchAt('/api/account/delete', OAUTH, { init: form({ confirm: '1' }, 'https://evil.example', cookie) })).status).toBe(403);
    const unconfirmed = await fetchAt('/api/account/delete', OAUTH, { init: form({}, HTTPS, cookie) });
    expect(unconfirmed.status).toBe(303);
    expect(unconfirmed.headers.get('location')).toBe('/account?delete=confirm');
    expect(await readUserRow(55)).not.toBeNull();
    const deleted = await fetchAt('/api/account/delete', OAUTH, { init: form({ confirm: '1' }, HTTPS, cookie) });
    expect(deleted.status).toBe(303);
    expect(deleted.headers.get('location')).toBe('/');
    expect(setCookies(deleted)).toEqual([`${SESSION}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`]);
    expect(await readUserRow(55)).toBeNull();
    // The old cookie no longer signs anyone in.
    expect((await fetchAt('/account', OAUTH, { cookie })).status).toBe(302);
  });
});

describe('D1 failures (CLA-316)', () => {
  const failing = (message: string) => { throw new Error(message); };
  /** Every query throws. */
  const downDb = { prepare: () => failing('D1 unavailable') } as unknown as D1Database;
  /** Reads work; every INSERT/UPDATE/DELETE throws. */
  const readOnlyDb = {
    prepare(sql: string) {
      const real = edgeEnv.USERS_DB!.prepare(sql);
      if (!/^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) return real;
      const statement = { bind: () => statement, run: async () => failing('D1 write failed'), first: async () => failing('D1 write failed'), all: async () => failing('D1 write failed') };
      return statement;
    },
  } as unknown as D1Database;

  const form = (fields: Record<string, string>, cookie: string): RequestInit => ({
    method: 'POST',
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: HTTPS, cookie },
  });

  it('D1 down: /api/auth/me is signed out but keeps the cookie; /account and both POSTs answer 503 JSON', async () => {
    const cookie = `${SESSION}=${await sessionCookieFor(55, 'alice')}`;
    const env = { ...OAUTH, USERS_DB: downDb };
    const me = await fetchAt('/api/auth/me', env, { cookie });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ authenticated: false, mode: 'accounts' });
    expect(setCookies(me)).toEqual([]);
    const account = await fetchAt('/account', env, { cookie });
    expect(account.status).toBe(503);
    expect(await account.json()).toEqual({ error: 'Accounts are unavailable right now. Try again shortly.' });
    for (const path of ['/api/account/preferences', '/api/account/delete']) {
      const response = await fetchAt(path, env, { init: form({ product_updates: '1', confirm: '1' }, cookie) });
      expect(response.status, path).toBe(503);
      expect(await response.json()).toEqual({ error: 'Accounts are unavailable right now. Try again shortly.' });
    }
  });

  it('D1 writes failing: preferences, delete and test-login answer 503 JSON and change nothing', async () => {
    await insertUser(55, 'alice');
    const cookie = `${SESSION}=${await sessionCookieFor(55, 'alice')}`;
    const env = { ...OAUTH, USERS_DB: readOnlyDb };
    for (const [path, fields] of [['/api/account/preferences', { product_updates: '1' }], ['/api/account/delete', { confirm: '1' }]] as const) {
      const response = await fetchAt(path, env, { init: form(fields, cookie) });
      expect(response.status, path).toBe(503);
      expect(await response.json()).toEqual({ error: 'Accounts are unavailable right now. Try again shortly.' });
      expect(setCookies(response)).toEqual([]);
    }
    expect(await readUserRow(55)).toMatchObject({ product_updates_opt_in: 0 });
    const testLogin = await fetchAt('/api/auth/github/test-login?return=/', { ...TEST_LOGIN, USERS_DB: readOnlyDb });
    expect(testLogin.status).toBe(503);
    expect(cookieValue(testLogin, 'sf_session')).toBeUndefined();
    expect(await readUserRow(0)).toBeNull();
  });
});

describe('canonical base64url tokens (CLA-585)', () => {
  const claims = (login: string) => ({ sub: '55', login, iat: Math.floor(NOW.getTime() / 1000), exp: Math.floor(NOW.getTime() / 1000) + SESSION_TTL_SECONDS });

  it('rejects a session whose signature has a second spelling of the same bytes', async () => {
    await insertUser(55, 'alice');
    const good = await sessionCookieFor(55, 'alice');
    const [v, payload, signature] = good.split('.');
    // 32-byte HMAC = 43 characters, the last carrying 2 unused bits.
    expect(signature).toHaveLength(43);
    const variant = lastCharVariant(signature!);
    expect(variant).not.toBe(signature);
    expect(lenientDecode(variant)).toBe(lenientDecode(signature!));
    expect(await verifySession(good, KEY, NOW)).toMatchObject({ sub: '55', login: 'alice' });
    expect(await verifySession(`${v}.${payload}.${variant}`, KEY, NOW)).toBeUndefined();
    const me = await fetchAt('/api/auth/me', OAUTH, { cookie: `${SESSION}=${v}.${payload}.${variant}` });
    expect(await me.json()).toMatchObject({ authenticated: false, mode: 'accounts' });
  });

  it('rejects a session whose payload has a second spelling of the same bytes', async () => {
    // Pick the first login whose JSON payload leaves unused bits in the last character.
    const login = ['alice', 'alice1', 'alice12'].find((name) => new TextEncoder().encode(JSON.stringify(claims(name))).length % 3 !== 0)!;
    const good = await signSession(claims(login), KEY);
    const [v, payload] = good.split('.');
    const variant = lastCharVariant(payload!);
    expect(variant).not.toBe(payload);
    expect(lenientDecode(variant)).toBe(lenientDecode(payload!));
    expect(await verifySession(good, KEY, NOW)).toMatchObject({ login });
    // A valid, canonical signature over the variant text, so only canonical payload decoding can reject it.
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`session:${v}.${variant}`)));
    const signature = btoa(String.fromCharCode(...mac)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(await verifySession(`${v}.${variant}.${signature}`, KEY, NOW)).toBeUndefined();
  });

  it('rejects padding, whitespace and out-of-alphabet characters in the signature', async () => {
    const good = await signSession(claims('alice'), KEY);
    const [v, payload, signature] = good.split('.');
    const spellings = [
      `${signature}=`,
      `${signature}==`,
      `${signature!.slice(0, 20)} ${signature!.slice(20)}`,
      `${signature!.slice(0, 20)}\n${signature!.slice(20)}`,
      `${signature!.slice(0, 20)}\t${signature!.slice(20)}`,
      `+${signature!.slice(1)}`,
      `/${signature!.slice(1)}`,
      signature!.replace(/-/g, '+').replace(/_/g, '/') + (/[-_]/.test(signature!) ? '' : '+'),
      `${signature!.slice(0, -1)}.`,
      `${signature!.slice(0, -1)}*`,
      `${signature}A`,
    ];
    for (const spelling of spellings) {
      expect(spelling).not.toBe(signature);
      expect(await verifySession(`${v}.${payload}.${spelling}`, KEY, NOW), JSON.stringify(spelling)).toBeUndefined();
    }
  });

  it('still verifies every session it signs, across payload lengths', async () => {
    for (let length = 1; length <= 64; length += 1) {
      const login = 'a'.repeat(length);
      const token = await signSession(claims(login), KEY);
      expect(await verifySession(token, KEY, NOW), login).toMatchObject({ login });
    }
  });
});
