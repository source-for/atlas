import { beforeEach, describe, expect, it } from 'vitest';
import { PRIVACY_POLICY_VERSION } from '../../web/src/siteMeta';
import { SESSION_TTL_SECONDS, signSession } from '../src/auth';
import type { EdgeEnv } from '../src/env';
import { MAX_OPEN_SCAN_REQUESTS, MAX_SCAN_REQUEST_NOTE, cleanScanRequestNote, parseScanRequestRepo } from '../src/scanRequests';
import { edgeEnv, edgeFetch } from './helpers';

const KEY = 'test-signing-key-0123456789abcdef-0123456789';
const HTTPS = 'https://sourcefor.dev';
const NOW = new Date('2026-10-10T12:00:00Z');
const OAUTH: Partial<EdgeEnv> = { OKIE_PUBLIC_ORIGIN: HTTPS, GITHUB_CLIENT_ID: 'Iv1.testclientid', GITHUB_CLIENT_SECRET: 'test-client-secret-value', SESSION_SIGNING_KEY: KEY };
const SESSION = '__Host-sf_session';
// This file's ids (auth.test.ts uses < 900000 and clears them; users.test.ts uses >= 900000).
const ALICE = 800_001;
const BOB = 800_002;

async function signedIn(githubId: number, login: string): Promise<string> {
  await edgeEnv.USERS_DB!.prepare(
    'INSERT INTO users (github_id, github_login, email, email_verified, created_at, last_sign_in_at, privacy_version) VALUES (?1, ?2, ?3, 1, ?4, ?4, ?5)',
  ).bind(githubId, login, `${login}@example.com`, '2026-10-01T00:00:00.000Z', PRIVACY_POLICY_VERSION).run();
  const iat = Math.floor(NOW.getTime() / 1000);
  return `${SESSION}=${await signSession({ sub: String(githubId), login, iat, exp: iat + SESSION_TTL_SECONDS }, KEY)}`;
}

function post(fields: Record<string, string>, cookie?: string, origin: string | null = HTTPS): Request {
  return new Request(`${HTTPS}/api/account/scan-requests`, {
    method: 'POST',
    redirect: 'manual',
    body: new URLSearchParams(fields).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin ? { origin } : {}), ...(cookie ? { cookie } : {}) },
  });
}

const send = (request: Request, env: Partial<EdgeEnv> = OAUTH) => edgeFetch(request, { now: () => NOW, env });
const account = (cookie: string, query = '') => send(new Request(`${HTTPS}/account${query}`, { redirect: 'manual', headers: { cookie } }));

async function rows(githubId: number) {
  return (await edgeEnv.USERS_DB!.prepare('SELECT owner, repo, repo_key, note, status FROM scan_requests WHERE github_id = ?1 ORDER BY id').bind(githubId).all()).results;
}

beforeEach(async () => {
  await edgeEnv.USERS_DB!.exec(`DELETE FROM scan_requests WHERE github_id IN (${ALICE}, ${BOB}); DELETE FROM users WHERE github_id IN (${ALICE}, ${BOB})`);
});

describe('parseScanRequestRepo (CLA-455)', () => {
  it('accepts owner/repo and github.com links to the repo or a page inside it', () => {
    for (const input of ['acme/app', ' acme/app ', 'https://github.com/acme/app', 'http://www.github.com/acme/app/', 'github.com/acme/app.git', 'https://github.com/acme/app/tree/main/src?x=1#L2', 'GitHub.com/acme/app']) {
      expect(parseScanRequestRepo(input), input).toEqual({ owner: 'acme', repo: 'app' });
    }
    expect(parseScanRequestRepo('Some-Org/repo.name_2')).toEqual({ owner: 'Some-Org', repo: 'repo.name_2' });
  });

  it('refuses anything that is not a GitHub repository', () => {
    for (const input of ['', 'acme', 'acme/', '/app', 'acme/app/extra', 'https://gitlab.com/acme/app', 'https://github.com/acme', 'acme/..', '-acme/app', 'acme--x/app', 'ac me/app', 'git@github.com:acme/app.git', `a/${'x'.repeat(101)}`, 'acme/app<script>']) {
      expect(parseScanRequestRepo(input), input).toBeUndefined();
    }
  });

  it('trims the note, drops control characters and caps its length', () => {
    expect(cleanScanRequestNote('  hello\u0000 there \n')).toBe('hello there');
    expect(cleanScanRequestNote('   ')).toBeNull();
    expect(cleanScanRequestNote(undefined)).toBeNull();
    expect([...cleanScanRequestNote('é'.repeat(MAX_SCAN_REQUEST_NOTE + 20))!]).toHaveLength(MAX_SCAN_REQUEST_NOTE);
  });
});

describe('scan requests (CLA-455)', () => {
  it('stores a request and lists it on the account page', async () => {
    const cookie = await signedIn(ALICE, 'alice');
    const response = await send(post({ repo: 'https://github.com/Acme/App', note: 'We use it at work' }, cookie));
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/account?request=requested#request-scan');
    expect(await rows(ALICE)).toEqual([{ owner: 'Acme', repo: 'App', repo_key: 'acme/app', note: 'We use it at work', status: 'requested' }]);
    const page = await (await account(cookie, '?request=requested')).text();
    expect(page).toContain('data-scan-request-outcome="requested"');
    expect(page).toContain('<li data-scan-request-status="requested"><span>Acme/App</span> <span class="status">Waiting</span></li>');
    expect(page).not.toMatch(/<script/i);
  });

  it('refuses an invalid repo, a duplicate (any case) and more than the open limit', async () => {
    const cookie = await signedIn(ALICE, 'alice');
    expect((await send(post({ repo: 'not a repo' }, cookie))).headers.get('location')).toBe('/account?request=invalid#request-scan');
    expect((await send(post({}, cookie))).headers.get('location')).toBe('/account?request=invalid#request-scan');
    await send(post({ repo: 'acme/app' }, cookie));
    expect((await send(post({ repo: 'ACME/APP' }, cookie))).headers.get('location')).toBe('/account?request=duplicate#request-scan');
    for (let index = 1; index < MAX_OPEN_SCAN_REQUESTS; index++) await send(post({ repo: `acme/app-${index}` }, cookie));
    expect(await rows(ALICE)).toHaveLength(MAX_OPEN_SCAN_REQUESTS);
    expect((await send(post({ repo: 'acme/one-more' }, cookie))).headers.get('location')).toBe('/account?request=limit#request-scan');
    // A finished request no longer counts against the limit.
    await edgeEnv.USERS_DB!.prepare("UPDATE scan_requests SET status = 'published' WHERE github_id = ?1 AND repo_key = 'acme/app'").bind(ALICE).run();
    expect((await send(post({ repo: 'acme/one-more' }, cookie))).headers.get('location')).toBe('/account?request=requested#request-scan');
    const page = await (await account(cookie)).text();
    expect(page).toContain('<a href="/r/acme/app">acme/app</a>');
    expect(page).toContain('<span class="status">Published</span>');
  });

  it('keeps each user’s requests to themselves', async () => {
    const alice = await signedIn(ALICE, 'alice');
    const bob = await signedIn(BOB, 'bob');
    await send(post({ repo: 'acme/app' }, alice));
    expect((await send(post({ repo: 'acme/app' }, bob))).headers.get('location')).toBe('/account?request=requested#request-scan');
    await send(post({ repo: 'bob/private-idea' }, bob));
    const alicePage = await (await account(alice)).text();
    expect(alicePage).toContain('acme/app');
    expect(alicePage).not.toContain('bob/private-idea');
    expect(await rows(BOB)).toHaveLength(2);
  });

  it('needs a same-origin form post and a session', async () => {
    const cookie = await signedIn(ALICE, 'alice');
    for (const origin of [null, 'https://evil.example', 'null']) {
      expect((await send(post({ repo: 'acme/app' }, cookie, origin))).status, String(origin)).toBe(403);
    }
    const anonymous = await send(post({ repo: 'acme/app' }));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.text()).toContain('Your session has ended');
    expect(await rows(ALICE)).toEqual([]);
    // Accounts off: the route does not exist.
    expect((await send(post({ repo: 'acme/app' }, cookie), { SESSION_SIGNING_KEY: '' })).status).toBe(404);
  });

  it('deletes a user’s requests with their account', async () => {
    const alice = await signedIn(ALICE, 'alice');
    const bob = await signedIn(BOB, 'bob');
    await send(post({ repo: 'acme/app' }, alice));
    await send(post({ repo: 'acme/app' }, bob));
    const deleted = await send(new Request(`${HTTPS}/api/account/delete`, { method: 'POST', redirect: 'manual', body: 'confirm=1', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: HTTPS, cookie: alice } }));
    expect(deleted.status).toBe(303);
    expect(await rows(ALICE)).toEqual([]);
    expect(await rows(BOB)).toHaveLength(1);
  });

  it('answers 503 when the requests cannot be stored or read', async () => {
    const cookie = await signedIn(ALICE, 'alice');
    const failing = {
      prepare(sql: string) {
        const real = edgeEnv.USERS_DB!.prepare(sql);
        if (!/scan_requests/.test(sql)) return real;
        const fail = async () => { throw new Error('D1 down'); };
        const statement = { bind: () => statement, run: fail, first: fail, all: fail };
        return statement;
      },
    } as unknown as D1Database;
    expect((await send(post({ repo: 'acme/app' }, cookie), { ...OAUTH, USERS_DB: failing })).status).toBe(503);
    expect((await send(new Request(`${HTTPS}/account`, { redirect: 'manual', headers: { cookie } }), { ...OAUTH, USERS_DB: failing })).status).toBe(503);
  });
});
