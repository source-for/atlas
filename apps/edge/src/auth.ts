import { buildGithubAuthorizeUrl, parseCookieHeader, safeReturnPath } from '../../server/src/githubOAuthShared';
import { accountHttpOutput, sessionEndedPageHtml } from '../../web/src/accountPage';
import { PRIVACY_POLICY_VERSION } from '../../web/src/siteMeta';
import { askEnabled, type EdgeEnv } from './env';
import { jsonResponse, notFoundJson } from './http';
import { createScanRequest, deleteScanRequestsStatement, listScanRequests, type ScanRequest, type ScanRequestOutcome } from './scanRequests';

/**
 * GitHub sign-in + email capture at the edge (CLA-316).
 *
 * Accounts are on only when every piece is present ({@link resolveAuthSetup}): the GitHub OAuth app
 * (`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET`), a `SESSION_SIGNING_KEY` of at least 32 characters, the
 * `USERS_DB` D1 binding and a trustworthy site origin (`OKIE_PUBLIC_ORIGIN`, or a loopback request origin
 * in local dev). Locally, `DEV_AUTH_TEST_LOGIN=1` replaces the OAuth app with a fixed test user. Anything
 * missing = today's public deployment: `/api/auth/me` answers the public shape byte for byte, every other
 * auth route 404s and `/account` is the 404 page. So deploying without the secrets changes nothing.
 *
 * Sessions are stateless signed cookies (`v1.<payload>.<HMAC-SHA256>`, WebCrypto, 30 days); the D1 row is
 * the source of truth for "is this still an account" (a deleted row = signed out). The GitHub access
 * token lives only inside the callback: it is never stored, logged, or put in a response or error.
 *
 * Revocation limits of stateless sessions (documented in docs/deploy/cloudflare-runbook.md):
 *   - logout clears the cookie in that browser only; a copy of the cookie stays valid until it expires (30 days);
 *   - deleting the account signs every copy out (the D1 row is gone), but if the same GitHub user signs in again,
 *     old unexpired cookies for that github_id are valid again;
 *   - rotating SESSION_SIGNING_KEY revokes every session at once.
 */

export const ME_PATH = '/api/auth/me';
export const LOGIN_PATH = '/api/auth/github';
export const CALLBACK_PATH = '/api/auth/github/callback';
export const TEST_LOGIN_PATH = '/api/auth/github/test-login';
export const LOGOUT_PATH = '/api/auth/logout';
export const ACCOUNT_PATH = '/account';
export const PREFERENCES_PATH = '/api/account/preferences';
export const DELETE_ACCOUNT_PATH = '/api/account/delete';
export const SCAN_REQUESTS_PATH = '/api/account/scan-requests';

export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const STATE_TTL_SECONDS = 10 * 60;
export const MIN_SIGNING_KEY_LENGTH = 32;
export const GITHUB_SCOPE = 'user:email';
/** Where sign-in and sign-out land when `return` is missing or unsafe. */
const DEFAULT_RETURN = '/';

export const TEST_USER = { githubId: 0, login: 'okie-test-user', email: 'test@example.invalid' } as const;

const USER_AGENT = 'sourcefor-atlas';

/** The public deployment's `/api/auth/me` (no accounts). Kept byte-for-byte stable. */
export function publicAuthMe(env: Pick<EdgeEnv, 'ASK_ENABLED'>) {
  return { authenticated: false, mode: 'public', oauthConfigured: false, ask: askEnabled(env) } as const;
}

// ---------------------------------------------------------------------------------------------------
// Configuration

export type AuthSetup = {
  db: D1Database;
  signingKey: string;
  /** The site origin redirect_uri and cookies are built for (never the Host header off loopback). */
  origin: string;
  /** https origin: `Secure` + `__Host-` cookie names. */
  secure: boolean;
  oauth?: { clientId: string; clientSecret: string };
  /** DEV_AUTH_TEST_LOGIN=1 on a loopback origin: the fixed test user signs in without GitHub. */
  testLogin: boolean;
};

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

function configuredOrigin(raw: string | undefined): URL | undefined | null {
  const value = raw?.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}

/** Whether accounts are on for this request (config only, never the user: pages that vary on it stay shared-cacheable). */
export function accountsEnabled(env: EdgeEnv, requestUrl: URL): boolean {
  return resolveAuthSetup(env, requestUrl) !== undefined;
}

/** undefined = accounts are off for this request (see the module comment). */
export function resolveAuthSetup(env: EdgeEnv, requestUrl: URL): AuthSetup | undefined {
  const db = env.USERS_DB;
  const signingKey = env.SESSION_SIGNING_KEY?.trim() ?? '';
  if (!db || signingKey.length < MIN_SIGNING_KEY_LENGTH) return undefined;
  const publicOrigin = configuredOrigin(env.OKIE_PUBLIC_ORIGIN);
  if (publicOrigin === null) return undefined;
  let origin: string;
  if (publicOrigin) origin = publicOrigin.origin;
  else if (isLoopbackHostname(requestUrl.hostname)) origin = requestUrl.origin;
  else return undefined;
  const clientId = env.GITHUB_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_CLIENT_SECRET?.trim();
  const testLogin = env.DEV_AUTH_TEST_LOGIN?.trim() === '1' && (!publicOrigin || isLoopbackHostname(publicOrigin.hostname));
  if (!(clientId && clientSecret) && !testLogin) return undefined;
  return {
    db,
    signingKey,
    origin,
    secure: origin.startsWith('https://'),
    ...(clientId && clientSecret ? { oauth: { clientId, clientSecret } } : {}),
    testLogin,
  };
}

/**
 * The cookies sign-in sets on the production (https) origin, for the privacy page's table
 * (apps/web/src/privacyPage.ts): names and lifetimes straight from the constants used to set them.
 */
export function privacyCookies(): { oauthState: { name: string; maxAgeSeconds: number }; session: { name: string; maxAgeSeconds: number } } {
  return {
    oauthState: { name: stateCookieName(true), maxAgeSeconds: STATE_TTL_SECONDS },
    session: { name: sessionCookieName(true), maxAgeSeconds: SESSION_TTL_SECONDS },
  };
}

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-sf_session' : 'sf_session';
}

export function stateCookieName(secure: boolean): string {
  return secure ? '__Host-sf_oauth_state' : 'sf_oauth_state';
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`, ...(secure ? ['Secure'] : [])].join('; ');
}

function clearCookie(name: string, secure: boolean): string {
  return cookie(name, '', 0, secure);
}

// ---------------------------------------------------------------------------------------------------
// Signed tokens (session + OAuth state)

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

let cachedKey: { raw: string; key: Promise<CryptoKey> } | undefined;

function hmacKey(raw: string): Promise<CryptoKey> {
  if (cachedKey?.raw !== raw) {
    cachedKey = { raw, key: crypto.subtle.importKey('raw', encoder.encode(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']) };
  }
  return cachedKey.key;
}

/** What a signature covers: the purpose too, so a state token can never pass as a session (or back). */
type TokenPurpose = 'session' | 'oauth-state';

async function signToken(purpose: TokenPurpose, payload: object, signingKey: string): Promise<string> {
  const body = `v1.${base64UrlEncode(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(signingKey), encoder.encode(`${purpose}:${body}`));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function verifyToken(purpose: TokenPurpose, token: string | undefined, signingKey: string): Promise<Record<string, unknown> | undefined> {
  if (!token || token.length > 4096) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') return undefined;
  const signature = base64UrlDecode(parts[2]!);
  const payloadBytes = base64UrlDecode(parts[1]!);
  if (!signature || !payloadBytes) return undefined;
  // crypto.subtle.verify compares in constant time.
  const valid = await crypto.subtle.verify('HMAC', await hmacKey(signingKey), signature, encoder.encode(`${purpose}:${parts[0]}.${parts[1]}`));
  if (!valid) return undefined;
  try {
    const payload = JSON.parse(decoder.decode(payloadBytes)) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

export type SessionClaims = { sub: string; login: string; iat: number; exp: number };

export async function signSession(claims: SessionClaims, signingKey: string): Promise<string> {
  return signToken('session', claims, signingKey);
}

/** The claims of a validly signed, unexpired session cookie value, else undefined. */
export async function verifySession(token: string | undefined, signingKey: string, now: Date): Promise<SessionClaims | undefined> {
  const payload = await verifyToken('session', token, signingKey);
  if (!payload) return undefined;
  const { sub, login, iat, exp } = payload;
  if (typeof sub !== 'string' || !/^\d{1,20}$/.test(sub)) return undefined;
  if (typeof login !== 'string' || !login) return undefined;
  if (typeof iat !== 'number' || typeof exp !== 'number') return undefined;
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (exp <= nowSeconds || iat > nowSeconds + 300) return undefined;
  return { sub, login, iat, exp };
}

type StateClaims = { nonce: string; returnTo: string; exp: number };

async function verifyState(token: string | undefined, signingKey: string, now: Date): Promise<StateClaims | undefined> {
  const payload = await verifyToken('oauth-state', token, signingKey);
  if (!payload) return undefined;
  const { nonce, returnTo, exp } = payload;
  if (typeof nonce !== 'string' || typeof returnTo !== 'string' || typeof exp !== 'number') return undefined;
  if (exp <= Math.floor(now.getTime() / 1000)) return undefined;
  return { nonce, returnTo: safeReturnPath(returnTo, DEFAULT_RETURN), exp };
}

/** Constant-time string equality (length leaks only; nonces have a fixed length). */
function sameString(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function randomNonce(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

// ---------------------------------------------------------------------------------------------------
// Users (D1)

export type UserRow = {
  github_id: number;
  github_login: string;
  email: string | null;
  email_verified: number;
  created_at: string;
  last_sign_in_at: string;
  privacy_version: string;
  product_updates_opt_in: number;
  product_updates_changed_at: string | null;
};

export async function readUser(db: D1Database, githubId: string | number): Promise<UserRow | undefined> {
  const row = await db.prepare('SELECT * FROM users WHERE github_id = ?1').bind(Number(githubId)).first<UserRow>();
  return row ?? undefined;
}

/**
 * Insert a new user or refresh a returning one. A returning sign-in updates login, email (unless the
 * email lookup failed: `email === undefined` keeps what is stored) and last_sign_in_at; it never touches
 * the product-updates opt-in or the privacy version accepted at sign-up. Signing in is not consent.
 */
export async function upsertUser(db: D1Database, user: { githubId: number; login: string; email: string | null | undefined }, now: Date): Promise<{ isNew: boolean }> {
  const at = now.toISOString();
  const existing = await readUser(db, user.githubId);
  if (!existing) {
    await db.prepare(
      `INSERT INTO users (github_id, github_login, email, email_verified, created_at, last_sign_in_at, privacy_version, product_updates_opt_in)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, 0)
       ON CONFLICT(github_id) DO UPDATE SET github_login = excluded.github_login, last_sign_in_at = excluded.last_sign_in_at`,
    ).bind(user.githubId, user.login, user.email ?? null, user.email ? 1 : 0, at, PRIVACY_POLICY_VERSION).run();
    return { isNew: true };
  }
  if (user.email === undefined) {
    await db.prepare('UPDATE users SET github_login = ?2, last_sign_in_at = ?3 WHERE github_id = ?1').bind(user.githubId, user.login, at).run();
  } else {
    await db.prepare('UPDATE users SET github_login = ?2, email = ?3, email_verified = ?4, last_sign_in_at = ?5 WHERE github_id = ?1')
      .bind(user.githubId, user.login, user.email, user.email ? 1 : 0, at).run();
  }
  return { isNew: false };
}

/** Set the opt-in; `product_updates_changed_at` moves only when the value really changes. */
export async function setProductUpdates(db: D1Database, githubId: number, optIn: boolean, now: Date): Promise<void> {
  await db.prepare(
    `UPDATE users SET product_updates_changed_at = CASE WHEN product_updates_opt_in = ?2 THEN product_updates_changed_at ELSE ?3 END,
       product_updates_opt_in = ?2 WHERE github_id = ?1`,
  ).bind(githubId, optIn ? 1 : 0, now.toISOString()).run();
}

export async function deleteUser(db: D1Database, githubId: number): Promise<void> {
  // CLA-455: the user's scan requests go in the same batch.
  await db.batch([deleteScanRequestsStatement(db, githubId), db.prepare('DELETE FROM users WHERE github_id = ?1').bind(githubId)]);
}

// ---------------------------------------------------------------------------------------------------
// Request helpers

export type AuthContext = {
  now: Date;
  /** Upstream fetch for GitHub (tests fake it); defaults to the global fetch. */
  fetch?: typeof fetch;
};

function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status, headers });
}

function withCookies(response: Response, cookies: string[]): Response {
  for (const value of cookies) response.headers.append('set-cookie', value);
  return response;
}

export type SignedInUser = { claims: SessionClaims; user: UserRow };

/**
 * The signed-in user for a request: a valid session cookie whose D1 row still exists. `clear` lists the
 * Set-Cookie headers to send when a cookie was present but is no longer good (bad signature, expired,
 * or the account was deleted).
 */
export async function currentUser(request: Request, setup: AuthSetup, now: Date): Promise<{ signedIn?: SignedInUser; clear: string[]; unavailable?: boolean }> {
  const name = sessionCookieName(setup.secure);
  const token = parseCookieHeader(request.headers.get('cookie'))[name];
  if (!token) return { clear: [] };
  const claims = await verifySession(token, setup.signingKey, now);
  const clear = [clearCookie(name, setup.secure)];
  if (!claims) return { clear };
  let user: UserRow | undefined;
  try {
    user = await readUser(setup.db, claims.sub);
  } catch {
    console.warn('auth: users lookup failed');
    // Keep the cookie: the database blipped, the session is still good.
    return { clear: [], unavailable: true };
  }
  return user ? { signedIn: { claims, user }, clear: [] } : { clear };
}

function signInLocation(returnTo: string): string {
  return `${LOGIN_PATH}?return=${encodeURIComponent(returnTo)}`;
}

/** The session cookie + state-cookie clear for a user who just signed in, and where to send them. */
async function finishSignIn(setup: AuthSetup, user: { githubId: number; login: string; email: string | null | undefined }, returnTo: string, now: Date): Promise<Response> {
  const { isNew } = await upsertUser(setup.db, user, now);
  const iat = Math.floor(now.getTime() / 1000);
  const session = await signSession({ sub: String(user.githubId), login: user.login, iat, exp: iat + SESSION_TTL_SECONDS }, setup.signingKey);
  const location = isNew ? `${ACCOUNT_PATH}?welcome=1&return=${encodeURIComponent(returnTo)}` : returnTo;
  return redirect(location, [
    cookie(sessionCookieName(setup.secure), session, SESSION_TTL_SECONDS, setup.secure),
    clearCookie(stateCookieName(setup.secure), setup.secure),
  ]);
}

// ---------------------------------------------------------------------------------------------------
// GitHub

class GithubSignInError extends Error {}

async function githubJson(response: Response, stage: string): Promise<unknown> {
  if (!response.ok) throw new GithubSignInError(`${stage}: HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new GithubSignInError(`${stage}: not JSON`);
  }
}

/** The primary, verified address from GitHub's /user/emails answer; null when there is none. */
export function primaryVerifiedEmail(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null;
  for (const entry of emails) {
    if (!entry || typeof entry !== 'object') continue;
    const { email, primary, verified } = entry as { email?: unknown; primary?: unknown; verified?: unknown };
    if (primary === true && verified === true && typeof email === 'string' && email.includes('@') && email.length <= 320) return email;
  }
  return null;
}

async function githubIdentity(setup: AuthSetup, code: string, fetchImpl: typeof fetch): Promise<{ githubId: number; login: string; email: string | null | undefined }> {
  const oauth = setup.oauth!;
  const exchanged = await githubJson(await fetchImpl('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', 'user-agent': USER_AGENT },
    body: JSON.stringify({ client_id: oauth.clientId, client_secret: oauth.clientSecret, code, redirect_uri: `${setup.origin}${CALLBACK_PATH}` }),
  }), 'token exchange') as { access_token?: unknown };
  // The token stays in this function: never stored, logged or returned.
  const token = typeof exchanged?.access_token === 'string' ? exchanged.access_token.trim() : '';
  if (!token) throw new GithubSignInError('token exchange: no token');
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': USER_AGENT, 'x-github-api-version': '2022-11-28' };
  const profile = await githubJson(await fetchImpl('https://api.github.com/user', { headers }), 'user') as { id?: unknown; login?: unknown };
  const githubId = typeof profile?.id === 'number' && Number.isSafeInteger(profile.id) && profile.id >= 0 ? profile.id : undefined;
  const login = typeof profile?.login === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(profile.login) ? profile.login : undefined;
  if (githubId === undefined || !login) throw new GithubSignInError('user: malformed profile');
  let email: string | null | undefined;
  try {
    email = primaryVerifiedEmail(await githubJson(await fetchImpl('https://api.github.com/user/emails', { headers }), 'emails'));
  } catch {
    // Sign-in still succeeds; a returning user's stored email is left as it was.
    email = undefined;
  }
  return { githubId, login, email };
}

// ---------------------------------------------------------------------------------------------------
// Routes

function authMeBody(env: EdgeEnv, setup: AuthSetup, login: string | undefined, accountId?: string) {
  return {
    authenticated: login !== undefined,
    ...(login !== undefined ? { login, accountId } : {}),
    mode: 'accounts',
    oauthConfigured: true,
    loginPath: LOGIN_PATH,
    logoutPath: LOGOUT_PATH,
    accountPath: ACCOUNT_PATH,
    ask: askEnabled(env),
    ...(setup.testLogin ? { testLoginPath: TEST_LOGIN_PATH } : {}),
  };
}

const GENERIC_FAILURE = { error: 'GitHub sign-in failed. Try again.' };
const UNAVAILABLE = { error: 'Accounts are unavailable right now. Try again shortly.' };

function unavailable(): Response {
  return jsonResponse(503, UNAVAILABLE);
}

/** A D1 write; a failure is logged (no details) and answered with the 503 JSON. */
async function write(action: string, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch {
    console.warn(`auth: users ${action} failed`);
    return unavailable();
  }
}

function sessionEnded(clear: string[]): Response {
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  for (const value of clear) headers.append('set-cookie', value);
  return new Response(sessionEndedPageHtml(), { status: 401, headers });
}
const STATE_FAILURE = { error: 'Sign-in expired or was started elsewhere. Start sign-in again.' };

/** Same-origin check for state-changing POSTs (CSRF, in addition to SameSite=Lax). */
function sameOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get('origin');
  return origin !== null && origin === url.origin;
}

/**
 * `/api/auth/*` and `/api/account/*`. Returns undefined for any other path (the caller routes it).
 */
export async function handleAuthRoute(request: Request, env: EdgeEnv, context: AuthContext): Promise<Response | undefined> {
  const url = new URL(request.url);
  const { pathname } = url;
  if (!pathname.startsWith('/api/auth/') && !pathname.startsWith('/api/account/')) return undefined;
  const method = request.method.toUpperCase();
  const setup = resolveAuthSetup(env, url);
  if (!setup) return method === 'GET' && pathname === ME_PATH ? jsonResponse(200, publicAuthMe(env)) : notFoundJson();
  const { now } = context;

  if (method === 'GET' && pathname === ME_PATH) {
    const current = await currentUser(request, setup, now);
    return withCookies(jsonResponse(200, authMeBody(env, setup, current.signedIn?.user.github_login, current.signedIn ? String(current.signedIn.user.github_id) : undefined)), current.clear);
  }

  if ((method === 'GET' || method === 'POST') && pathname === LOGOUT_PATH) {
    const cookies = [clearCookie(sessionCookieName(setup.secure), setup.secure), clearCookie(stateCookieName(setup.secure), setup.secure)];
    if (method === 'GET') return redirect(safeReturnPath(url.searchParams.get('return'), DEFAULT_RETURN), cookies);
    return withCookies(jsonResponse(200, { authenticated: false, loginPath: LOGIN_PATH }), cookies);
  }

  if (method === 'GET' && pathname === TEST_LOGIN_PATH) {
    if (!setup.testLogin) return notFoundJson();
    const returnTo = safeReturnPath(url.searchParams.get('return'), DEFAULT_RETURN);
    return write('sign-in', () => finishSignIn(setup, { githubId: TEST_USER.githubId, login: TEST_USER.login, email: TEST_USER.email }, returnTo, now));
  }

  if (method === 'GET' && pathname === LOGIN_PATH) {
    const returnTo = safeReturnPath(url.searchParams.get('return'), DEFAULT_RETURN);
    if (!setup.oauth) return redirect(`${TEST_LOGIN_PATH}?return=${encodeURIComponent(returnTo)}`);
    const nonce = randomNonce();
    const state = await signToken('oauth-state', { nonce, returnTo, exp: Math.floor(now.getTime() / 1000) + STATE_TTL_SECONDS }, setup.signingKey);
    const location = buildGithubAuthorizeUrl({ clientId: setup.oauth.clientId, redirectUri: `${setup.origin}${CALLBACK_PATH}`, state: nonce, scope: GITHUB_SCOPE });
    return redirect(location, [cookie(stateCookieName(setup.secure), state, STATE_TTL_SECONDS, setup.secure)]);
  }

  if (method === 'GET' && pathname === CALLBACK_PATH) {
    if (!setup.oauth) return notFoundJson();
    const stateName = stateCookieName(setup.secure);
    const claims = await verifyState(parseCookieHeader(request.headers.get('cookie'))[stateName], setup.signingKey, now);
    const state = url.searchParams.get('state') ?? '';
    const clearState = [clearCookie(stateName, setup.secure)];
    if (!claims || !sameString(claims.nonce, state)) return withCookies(jsonResponse(400, STATE_FAILURE), clearState);
    // Declined on GitHub (or any GitHub-side error): back where they started, still signed out.
    if (url.searchParams.has('error')) return redirect(claims.returnTo, clearState);
    const code = url.searchParams.get('code')?.trim();
    if (!code || code.length > 512) return withCookies(jsonResponse(400, STATE_FAILURE), clearState);
    try {
      const identity = await githubIdentity(setup, code, context.fetch ?? fetch);
      return await finishSignIn(setup, identity, claims.returnTo, now);
    } catch (error) {
      // The stage and HTTP status only: never an upstream body, never the token.
      console.warn(`auth: GitHub sign-in failed (${error instanceof GithubSignInError ? error.message : 'unexpected error'})`);
      return withCookies(jsonResponse(502, GENERIC_FAILURE), clearState);
    }
  }

  if (method === 'POST' && (pathname === PREFERENCES_PATH || pathname === DELETE_ACCOUNT_PATH || pathname === SCAN_REQUESTS_PATH)) {
    if (!sameOrigin(request, url)) return jsonResponse(403, { error: 'Cross-origin request refused.' });
    const current = await currentUser(request, setup, now);
    if (current.unavailable) return unavailable();
    // A page with a link, not a redirect: form-action 'self' would block the hop on to github.com.
    if (!current.signedIn) return sessionEnded(current.clear);
    const githubId = current.signedIn.user.github_id;
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return jsonResponse(400, { error: 'Expected a form submission.' });
    }
    if (pathname === SCAN_REQUESTS_PATH) {
      return write('scan request', async () => {
        const outcome = await createScanRequest(setup.db, githubId, { repo: form.get('repo'), note: form.get('note') }, now);
        return redirect(`${ACCOUNT_PATH}?request=${outcome}#request-scan`, [], 303);
      });
    }
    if (pathname === PREFERENCES_PATH) {
      return write('preferences', async () => {
        await setProductUpdates(setup.db, githubId, form.get('product_updates') === '1', now);
        const back = form.get('return');
        return redirect(typeof back === 'string' ? safeReturnPath(back, DEFAULT_RETURN) : `${ACCOUNT_PATH}?saved=1`, [], 303);
      });
    }
    if (form.get('confirm') !== '1') return redirect(`${ACCOUNT_PATH}?delete=confirm`, [], 303);
    return write('delete', async () => {
      await deleteUser(setup.db, githubId);
      return redirect('/', [clearCookie(sessionCookieName(setup.secure), setup.secure)], 303);
    });
  }

  return notFoundJson();
}

/**
 * `/account` (GET/HEAD), routed here only while accounts are on (index.ts; otherwise `/account` falls
 * through like any other path). Signed out = off to GitHub sign-in and back; signed in = the account page
 * (apps/web/src/accountPage.ts), never cached.
 */
export async function handleAccountPage(request: Request, env: EdgeEnv, context: AuthContext): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const setup = resolveAuthSetup(env, url);
  if (!setup) return notFoundJson();
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' } });
  }
  const current = await currentUser(request, setup, context.now);
  if (current.unavailable) return unavailable();
  if (!current.signedIn) return redirect(signInLocation(ACCOUNT_PATH), current.clear);
  const { user } = current.signedIn;
  const welcome = url.searchParams.get('welcome') === '1';
  let scanRequests: ScanRequest[];
  try {
    scanRequests = welcome ? [] : await listScanRequests(setup.db, user.github_id);
  } catch {
    console.warn('auth: scan requests lookup failed');
    return unavailable();
  }
  const outcome = url.searchParams.get('request');
  const page = accountHttpOutput(method, {
    login: user.github_login,
    email: user.email,
    productUpdatesOptIn: user.product_updates_opt_in === 1,
    welcome,
    returnTo: safeReturnPath(url.searchParams.get('return'), DEFAULT_RETURN),
    saved: url.searchParams.get('saved') === '1',
    deleteNeedsConfirm: url.searchParams.get('delete') === 'confirm',
    scanRequests,
    ...(isScanRequestOutcome(outcome) ? { scanRequestOutcome: outcome } : {}),
  });
  return new Response(page.body === '' ? null : page.body, { status: page.status, headers: page.headers });
}

function isScanRequestOutcome(value: string | null): value is ScanRequestOutcome {
  return value === 'requested' || value === 'invalid' || value === 'duplicate' || value === 'limit';
}
