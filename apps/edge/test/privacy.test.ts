import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy } from '../../web/src/securityHeaders';
import { SESSION_TTL_SECONDS, STATE_TTL_SECONDS, sessionCookieName, stateCookieName } from '../src/auth';
import { edgeFetch } from './helpers';

const ACCOUNTS = { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev', GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'secret', SESSION_SIGNING_KEY: 'k'.repeat(32) };

describe('/privacy at the edge (CLA-316)', () => {
  it('serves the privacy page with or without accounts: shared-cacheable, CSP, no script, no cookie notice', async () => {
    for (const env of [{}, ACCOUNTS]) {
      const response = await edgeFetch('https://sourcefor.dev/privacy', { env });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('public, max-age=300');
      expect(response.headers.get('content-security-policy')).toBe(contentSecurityPolicy({ framable: false }));
      expect(response.headers.get('set-cookie')).toBeNull();
      const html = await response.text();
      expect(html).toContain('<h1>Privacy</h1>');
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toContain('data-cookie-notice');
    }
    expect((await edgeFetch('/privacy/')).status).toBe(200);
  });

  it('names the cookies the Worker really sets, with their real lifetimes (from auth.ts)', async () => {
    const html = await (await edgeFetch('/privacy')).text();
    expect(stateCookieName(true)).toBe('__Host-sf_oauth_state');
    expect(sessionCookieName(true)).toBe('__Host-sf_session');
    expect(html).toContain(`<code>${stateCookieName(true)}</code>`);
    expect(html).toContain(`<code>${sessionCookieName(true)}</code>`);
    expect(STATE_TTL_SECONDS).toBe(600);
    expect(SESSION_TTL_SECONDS).toBe(30 * 86400);
    expect(html).toContain('<td>10 minutes</td>');
    expect(html).toContain('<td>30 days, or until you sign out</td>');
  });

  it('canonicalizes to the deployment\'s public origin (OKIE_PUBLIC_ORIGIN), else to production', async () => {
    const canonical = async (url: string, env: Record<string, string> = {}) =>
      /<link rel="canonical" href="([^"]*)" \/>/.exec(await (await edgeFetch(url, { env })).text())?.[1];
    expect(await canonical('https://sourcefor.dev/privacy', { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' })).toBe('https://sourcefor.dev/privacy');
    expect(await canonical('https://staging.sourcefor.dev/privacy', { OKIE_PUBLIC_ORIGIN: 'https://staging.sourcefor.dev' })).toBe('https://staging.sourcefor.dev/privacy');
    // A host the deployment does not own (workers.dev, a spoofed Host) never becomes the canonical.
    expect(await canonical('https://sourcefor-atlas.example.workers.dev/privacy', { OKIE_PUBLIC_ORIGIN: 'https://staging.sourcefor.dev' })).toBe('https://sourcefor.dev/privacy');
    expect(await canonical('https://evil.example/privacy/', { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' })).toBe('https://sourcefor.dev/privacy');
  });

  it('HEAD has no body; other methods fall through like any unknown path', async () => {
    const head = await edgeFetch('/privacy', { init: { method: 'HEAD' } });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const post = await edgeFetch('/privacy', { init: { method: 'POST' } });
    const unknown = await edgeFetch('/no-such-page', { init: { method: 'POST' } });
    expect(post.status).toBe(unknown.status);
  });

  it('is in the sitemap, and the 404 page footer links it', async () => {
    expect(await (await edgeFetch('/sitemap.xml', { env: { OKIE_PUBLIC_ORIGIN: 'https://sourcefor.dev' } })).text()).toContain('<loc>https://sourcefor.dev/privacy</loc>\n    <lastmod>2026-10-10</lastmod>');
    const notFound = await edgeFetch('/no-such-page');
    expect(notFound.status).toBe(404);
    expect(await notFound.text()).toContain('<a href="/privacy">Privacy</a>');
  });
});
