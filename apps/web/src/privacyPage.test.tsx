import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { accountPageHtml, sessionEndedPageHtml } from './accountPage';
import { homePageHtml } from './homePage';
import { notFoundPageHtml, siteFooterHtml } from './notFoundPage';
import privacySource from './privacyPage.ts?raw';
import { formatLifetime, PRIVACY_COPY_PENDING, formatPolicyDate, PRIVACY_COPY, privacyHttpOutput, privacyInlineHtml, privacyPageHtml, SITE_OPERATOR } from './privacyPage';
import { SiteFooter } from './siteFooter';
import { termsPageHtml } from './termsPage';
import { LEGAL_CONTACT_EMAIL as CONTACT_EMAIL, PRIVACY_POLICY_VERSION } from './siteMeta';

const COOKIES = {
  oauthState: { name: '__Host-sf_oauth_state', maxAgeSeconds: 600 },
  session: { name: '__Host-sf_session', maxAgeSeconds: 2_592_000 },
};

describe('CLA-316 privacy page', () => {
  const html = privacyPageHtml({ cookies: COOKIES });

  it('renders the copy: last-updated date from PRIVACY_POLICY_VERSION, every section, mailto links, no script', () => {
    expect(PRIVACY_POLICY_VERSION).toBe('2026-10-10');
    expect(html).toContain('Last updated <time datetime="2026-10-10">10 October 2026</time>');
    for (const section of PRIVACY_COPY.sections) expect(html).toContain(`>${section.heading}</h2>`);
    expect(html).toContain(`<a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> from the address on your account`);
    expect(html).not.toContain('[CONTACT_EMAIL]');
    expect(html).toContain('<strong>Cloudflare</strong> hosts the site');
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\ssrc="/);
    expect(html).toContain('<link rel="canonical" href="https://sourcefor.dev/privacy" />');
    const at = (requestOrigin: string, allowedOrigins: string[]) => privacyPageHtml({ cookies: COOKIES, requestOrigin, allowedOrigins });
    expect(at('https://staging.sourcefor.dev', ['https://staging.sourcefor.dev'])).toContain('<link rel="canonical" href="https://staging.sourcefor.dev/privacy" />');
    expect(at('https://evil.example', ['https://staging.sourcefor.dev'])).toContain('<link rel="canonical" href="https://sourcefor.dev/privacy" />');
    expect(at('http://localhost:8787', [])).toContain('<link rel="canonical" href="http://localhost:8787/privacy" />');
    expect(html).not.toContain('noindex');
  });

  it('puts "Who runs this site" right after the intro, naming the data controller (the owner’s legal details, as on clabrate.com)', () => {
    expect(PRIVACY_COPY.sections[0]!.heading).toBe('Who runs this site');
    expect(SITE_OPERATOR).toBe('Clabrate (clabrate.com), Queensland, Australia');
    expect(SITE_OPERATOR).not.toContain(PRIVACY_COPY_PENDING);
    expect(html).toContain(`<p>Source For Atlas is run by ${SITE_OPERATOR}, the data controller for the personal data described on this page.</p>`);
    expect(html.indexOf('Who runs this site')).toBeLessThan(html.indexOf('If you just browse'));
  });

  it('the deploy check (a text search of this file for the marker) agrees with the rendered copy', () => {
    expect(PRIVACY_COPY_PENDING).toBe('[pending owner');
    // The file contains the marker literally exactly as often as the rendered page does (the constant itself is split).
    const count = (text: string) => text.split(PRIVACY_COPY_PENDING).length - 1;
    expect(count(privacySource)).toBe(count(html));
    expect(count(html)).toBe(0);
    expect(privacySource).not.toMatch(/PRIVACY_COPY_PENDING = '\[pending owner/);
  });

  it('says what is stored, what it is used for, and how long backups keep it', () => {
    expect(html).toContain('<li>which version of this privacy policy was in force when you signed up</li>');
    expect(html).toContain('and when you last changed that setting</li>');
    expect(html).toContain('<p>We use this to run your account, and to contact you about it if we need to.</p>');
    expect(html).not.toContain('fair-use');
    expect(html).toContain('Ask requires sign-in.');
    expect(html).toContain('this browser’s IndexedDB');
    expect(html).toContain('five-Ask allowance');
    expect(html).toContain('OpenRouter and its selected model provider');
    // The owner dropped inactivity deletion: kept until you delete the account or ask us to.
    expect(html).toContain('<p>We keep your account data until you delete your account, or ask us to.</p>');
    expect(html).not.toContain('24 months');
    expect(html).not.toContain('confirm or drop');
    expect(html).toContain('Our host keeps short-lived request logs (up to 7 days) and database backups (up to 30 days), so a deleted record can remain in backups for up to 30 days before it is gone for good.');
    expect(html).toContain('This removes your record immediately (and from backups within 30 days) and signs you out.');
  });

  it('builds the cookie table from the names and lifetimes it is given, as a real table', () => {
    expect(html).toContain('<table class="cookies" data-privacy-cookies>');
    expect(html).toContain('<th scope="col">Cookie</th><th scope="col">Purpose</th><th scope="col">Lasts</th>');
    expect(html).toContain('<tr><td><code>__Host-sf_oauth_state</code></td><td>Protects the GitHub sign-in step from forgery</td><td>10 minutes</td></tr>');
    expect(html).toContain('<tr><td><code>__Host-sf_session</code></td><td>Keeps you signed in</td><td>30 days, or until you sign out</td></tr>');
    const other = privacyPageHtml({ cookies: { oauthState: { name: 'x_state', maxAgeSeconds: 3600 }, session: { name: 'x<s>', maxAgeSeconds: 86400 } } });
    expect(other).toContain('<code>x_state</code></td><td>Protects the GitHub sign-in step from forgery</td><td>1 hour</td>');
    expect(other).toContain('<code>x&lt;s&gt;</code></td><td>Keeps you signed in</td><td>1 day, or until you sign out</td>');
    // No sideways scroll at 375px: fixed layout at full width, long names wrap.
    expect(html).toContain('table.cookies{width:100%;table-layout:fixed');
    expect(html).toContain('overflow-wrap:anywhere');
  });

  it('links to the terms of use', () => {
    expect(html).toContain('<p>Using the site is also covered by our <a href="/terms">Terms of use</a>.</p>');
  });

  it('formats dates, lifetimes and inline markup, escaping everything else', () => {
    expect(formatPolicyDate('2027-01-05')).toBe('5 January 2027');
    expect(formatLifetime(600)).toBe('10 minutes');
    expect(formatLifetime(2_592_000)).toBe('30 days');
    expect(formatLifetime(45)).toBe('45 seconds');
    expect(privacyInlineHtml('a `<b>` **c** <i>')).toBe('a <code>&lt;b&gt;</code> <strong>c</strong> &lt;i&gt;');
    // Links go to paths on this site only: never another host, a scheme or a protocol-relative URL.
    expect(privacyInlineHtml('see [Terms](/terms) and [Privacy](/privacy#cookies)')).toBe('see <a href="/terms">Terms</a> and <a href="/privacy#cookies">Privacy</a>');
    for (const text of ['[x](https://evil.example)', '[x](//evil.example)', '[x](/\\evil.example)', '[x](javascript:alert(1))']) {
      expect(privacyInlineHtml(text)).not.toContain('<a');
    }
    expect(privacyInlineHtml('[x](/a" onmouseover="b)')).not.toContain('onmouseover="');
  });

  it('is shared-cacheable for 5 minutes; HEAD has no body', () => {
    const head = privacyHttpOutput('HEAD', { cookies: COOKIES });
    expect(head.body).toBe('');
    expect(head.headers).toEqual({ 'cache-control': 'public, max-age=300', 'content-type': 'text/html; charset=utf-8' });
    expect(privacyHttpOutput('GET', { cookies: COOKIES }).body).toBe(html);
  });

  it('has no cookie notice (it is the notice’s own target)', () => {
    expect(html).not.toContain('data-cookie-notice');
  });
});

describe('CLA-316 footer links to /privacy and /terms', () => {
  it('every static footer, the 404, the home, /account, the session-ended page and both legal pages link them, Terms next to Privacy', () => {
    const links = '<a href="/privacy">Privacy</a> · <a href="/terms">Terms</a>';
    expect(siteFooterHtml()).toContain(links);
    for (const page of [notFoundPageHtml(), homePageHtml({ index: undefined }), accountPageHtml({ login: 'a', email: null, productUpdatesOptIn: false }), sessionEndedPageHtml(), privacyPageHtml({ cookies: COOKIES }), termsPageHtml()]) {
      expect(page).toContain(links);
    }
    // The account page's help line too, not just its footer.
    expect(accountPageHtml({ login: 'a', email: null, productUpdatesOptIn: false })).toMatch(/<p class="help">[^\n]*<a href="\/privacy">Privacy<\/a> · <a href="\/terms">Terms<\/a>/);
  });

  it('the SPA footer links them', () => {
    const html = renderToStaticMarkup(<SiteFooter/>);
    expect(html).toMatch(/href="\/privacy"[^>]*>Privacy<\/a> · <a[^>]*href="\/terms"[^>]*>Terms<\/a>/);
  });
});
