import { ACCOUNT_PAGE_STYLE } from './accountPage';
import { escapeHtml } from './homePage';
import { siteBrandLinkHtml, siteFooterHtml } from './notFoundPage';
import { trustedPageOrigin } from './openGraph';
import { CANONICAL_ORIGIN, LEGAL_CONTACT_EMAIL, PRIVACY_PATH, PRIVACY_POLICY_VERSION, SITE_NAME, TERMS_PATH } from './siteMeta';

/**
 * The privacy page's words (CLA-316), kept together so the owner can edit them in one place.
 *
 * Inline markup in any string: `code`, **bold**, [text](/site-path) (a link to a path on this site), and the
 * token [CONTACT_EMAIL] (becomes a mailto link to CONTACT_EMAIL). Everything else is plain text and HTML-escaped. The cookie table's names and lifetimes are
 * NOT here: they come from the edge's cookie constants (apps/edge/src/auth.ts) through {@link PrivacyPageInput},
 * so the page can never drift from what the Worker sets. The "Last updated" date is PRIVACY_POLICY_VERSION.
 */
/**
 * Marks copy the owner has not filled in or confirmed yet: the copy writes it as a bracketed tag, either bare
 * or followed by a colon and what to do (never spelled out in a comment here). `deploy.mjs production`
 * refuses to deploy while this file or termsPage.ts contains it (apps/edge/scripts/deployCore.mjs, a plain
 * text search of both files). Built from two parts so this
 * definition never matches that search: only a use in the copy does.
 */
export const PRIVACY_COPY_PENDING = ['[pending', 'owner'].join(' ');

/**
 * Who runs the site: the operator's legal name, the data controller on /privacy and the party to /terms
 * (termsPage.ts imports it). Filling it in is this one line. Until then it carries the marker, written out
 * literally for the deploy check.
 */
export const SITE_OPERATOR = 'Clabrate (clabrate.com), Queensland, Australia';

export const PRIVACY_COPY = {
  title: 'Privacy',
  lastUpdatedLead: 'Last updated',
  intro: [
    'Source For Atlas (sourcefor.dev) publishes explorable maps of public GitHub repositories. You can browse every atlas without an account. This page says what we collect, why, how long we keep it, and how to have it deleted.',
    `Using the site is also covered by our [Terms of use](${TERMS_PATH}).`,
  ],
  sections: [
    {
      heading: 'Who runs this site',
      blocks: [
        { kind: 'p', text: `Source For Atlas is run by ${SITE_OPERATOR}, the data controller for the personal data described on this page.` },
      ],
    },
    {
      heading: 'If you just browse',
      blocks: [
        { kind: 'p', text: 'We don’t ask who you are and we don’t set any cookies.' },
        { kind: 'p', text: 'We use Cloudflare Web Analytics to count page views and measure how fast pages load. It doesn’t use cookies or local storage to track you, and it doesn’t fingerprint visitors. It reports the page address, referrer, browser type, country and page-load timings to Cloudflare, which shows them to us only as totals.' },
        { kind: 'p', text: 'Like any website, our hosting provider (Cloudflare) processes your IP address to deliver pages and protect the site from abuse.' },
      ],
    },
    {
      heading: 'If you sign in with GitHub',
      blocks: [
        { kind: 'p', text: 'Signing in is optional. When you sign in, we store:' },
        {
          kind: 'list',
          items: [
            'your GitHub user ID and username, which GitHub shares with us',
            'your primary email address, if GitHub has verified it',
            'when you first signed in and when you last signed in',
            'which version of this privacy policy was in force when you signed up',
            'whether you asked for product updates (off unless you tick the box), and when you last changed that setting',
          ],
        },
        { kind: 'p', text: 'We use this to run your account, and to contact you about it if we need to.' },
        { kind: 'p', text: 'We only email you product news if you tick "Email me occasional product updates". Signing in alone never signs you up. You can change this at any time on your Account page.' },
        { kind: 'p', text: 'We don’t keep your GitHub access token. We use it once to read your profile and email, then discard it. We don’t sell your data or share it with advertisers.' },
      ],
    },
    {
      heading: 'If you request a scan',
      blocks: [
        { kind: 'p', text: 'Signed-in users can ask us to scan a public GitHub repository. We store the repository name, the note you add (if any), when you asked, and whether we published it or decided not to. We use this to scan and publish the repository, and we may email you about the request.' },
        { kind: 'p', text: 'We only scan public repositories, and we may decide not to scan one. Requests are listed on your Account page and are deleted with your account.' },
      ],
    },
    {
      heading: 'If you use Ask',
      blocks: [
        { kind: 'p', text: 'Ask requires sign-in. To answer your question, we send the question and a bounded selection of atlas evidence to OpenRouter and its selected model provider. We do not include your GitHub account details or sign-in cookies in the model request. Avoid putting private information in a question.' },
        { kind: 'p', text: 'Saved questions and answers stay in this browser’s IndexedDB, separated by account and atlas. They are not synced to your account or other devices. Signing out hides the thread; it does not erase browser storage. Clearing this site’s browser data removes the saved threads.' },
        { kind: 'p', text: 'We keep daily request counts linked to your GitHub user ID to enforce the five-Ask allowance and prevent abuse. These counts contain no questions or answers. When the allowance ledger is used, it removes counts older than 14 days. We also keep daily service spending totals.' },
      ],
    },
    {
      heading: 'Cookies',
      blocks: [
        { kind: 'p', text: 'We only set cookies that are strictly necessary, and only when you sign in:' },
        { kind: 'cookies' },
        { kind: 'p', text: 'We have no advertising or tracking cookies. Because these cookies are strictly necessary, we don’t ask for consent. The cookie notice is for your information only. We remember that you dismissed it in your browser’s local storage, which never leaves your device.' },
      ],
    },
    {
      heading: 'Who processes your data',
      blocks: [
        {
          kind: 'list',
          items: [
            '**Cloudflare** hosts the site, stores account data, and provides Web Analytics.',
            '**GitHub** handles sign-in.',
            '**OpenRouter and its selected model provider** process the questions and atlas evidence you submit through Ask.',
          ],
        },
      ],
    },
    {
      heading: 'How long we keep it',
      blocks: [
        { kind: 'p', text: 'We keep your account data until you delete your account, or ask us to.' },
        { kind: 'p', text: 'Our host keeps short-lived request logs (up to 7 days) and database backups (up to 30 days), so a deleted record can remain in backups for up to 30 days before it is gone for good.' },
      ],
    },
    {
      heading: 'Deleting your data',
      blocks: [
        { kind: 'p', text: 'You can delete your account yourself from the Account page. This removes your record immediately (and from backups within 30 days) and signs you out. Or email [CONTACT_EMAIL] from the address on your account and we’ll delete it within 30 days.' },
        { kind: 'p', text: 'You can also email us to ask what we hold about you, or to correct it.' },
        { kind: 'p', text: 'Deleting your account does not erase threads saved on your device. Clear this site’s browser data to remove those. Recent request counts expire as described above; retaining them briefly prevents account deletion and sign-in from resetting the daily allowance.' },
      ],
    },
    {
      heading: 'Contact',
      blocks: [
        { kind: 'p', text: '[CONTACT_EMAIL]' },
        { kind: 'p', text: 'We’ll post any changes on this page and update the date at the top.' },
      ],
    },
  ],
  cookieTable: {
    headings: ['Cookie', 'Purpose', 'Lasts'],
    /** Row order and words; the name and lifetime come from the input. */
    rows: [
      { key: 'oauthState', purpose: 'Protects the GitHub sign-in step from forgery', lastsSuffix: '' },
      { key: 'session', purpose: 'Keeps you signed in', lastsSuffix: ', or until you sign out' },
    ],
  },
  description: 'What Source For Atlas collects, why, how long we keep it, and how to have it deleted.',
} as const satisfies PrivacyCopy;

type PrivacyBlock = { kind: 'p'; text: string } | { kind: 'list'; items: readonly string[] } | { kind: 'cookies' };
type PrivacyCopy = {
  title: string;
  lastUpdatedLead: string;
  intro: readonly string[];
  sections: ReadonlyArray<{ heading: string; blocks: readonly PrivacyBlock[] }>;
  cookieTable: { headings: readonly [string, string, string]; rows: ReadonlyArray<{ key: PrivacyCookieKey; purpose: string; lastsSuffix: string }> };
  description: string;
};

export type PrivacyCookieKey = 'oauthState' | 'session';
export type PrivacyCookie = { name: string; maxAgeSeconds: number };
export type PrivacyPageInput = {
  cookies: Record<PrivacyCookieKey, PrivacyCookie>;
  /**
   * The request's origin and the deployment's public origins (OKIE_PUBLIC_ORIGIN), as for the home page: the
   * canonical link uses the request origin when it is one of them (or loopback), else CANONICAL_ORIGIN.
   */
  requestOrigin?: string;
  allowedOrigins?: readonly string[];
};

export const PRIVACY_CACHE_CONTROL = 'public, max-age=300';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-09-30` → `30 September 2026` (no locale, no time zone). */
export function formatPolicyDate(version: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(version);
  if (!match) return version;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`;
}

/** A cookie lifetime in words: `30 days`, `10 minutes`, `1 hour`. */
export function formatLifetime(seconds: number): string {
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (seconds > 0 && seconds % 86400 === 0) return unit(seconds / 86400, 'day');
  if (seconds > 0 && seconds % 3600 === 0) return unit(seconds / 3600, 'hour');
  if (seconds > 0 && seconds % 60 === 0) return unit(seconds / 60, 'minute');
  return unit(seconds, 'second');
}

/** Escape, then the copy's inline markup: `code`, **bold**, [text](/site-path), [CONTACT_EMAIL]. Shared with termsPage.ts. */
export function privacyInlineHtml(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((\/(?![\/\\])[^)\s"]*)\)/g, '<a href="$2">$1</a>')
    .replace(/\[CONTACT_EMAIL\]/g, `<a href="mailto:${LEGAL_CONTACT_EMAIL}">${LEGAL_CONTACT_EMAIL}</a>`);
}

function cookieTableHtml(input: PrivacyPageInput): string {
  const { headings, rows } = PRIVACY_COPY.cookieTable;
  const body = rows.map(row => {
    const cookie = input.cookies[row.key];
    return `<tr><td><code>${escapeHtml(cookie.name)}</code></td><td>${privacyInlineHtml(row.purpose)}</td><td>${escapeHtml(formatLifetime(cookie.maxAgeSeconds) + row.lastsSuffix)}</td></tr>`;
  });
  return `<table class="cookies" data-privacy-cookies>
          <thead><tr>${headings.map(heading => `<th scope="col">${escapeHtml(heading)}</th>`).join('')}</tr></thead>
          <tbody>
            ${body.join('\n            ')}
          </tbody>
        </table>`;
}

function blockHtml(block: PrivacyBlock, input: PrivacyPageInput): string {
  if (block.kind === 'p') return `<p>${privacyInlineHtml(block.text)}</p>`;
  if (block.kind === 'list') return `<ul>${block.items.map(item => `<li>${privacyInlineHtml(item)}</li>`).join('')}</ul>`;
  return cookieTableHtml(input);
}

/**
 * The legal pages' shared look (privacy and terms, on top of ACCOUNT_PAGE_STYLE). The cookie table never scrolls sideways: fixed layout over the full width, and long cookie names wrap anywhere
 * (at 375px the name column is ~130px wide).
 */
export const LEGAL_PAGE_STYLE = `
      .updated{color:#97a5a0;font-size:.9rem}
      article h2{margin:2rem 0 .5rem}
      ul{margin:0 0 .75rem;padding-left:1.25rem;color:#b7c3c0}
      li{margin:.2rem 0}
      strong{color:#eef4f2}
      code{font:.85em "IBM Plex Mono",ui-monospace,monospace;color:#d9ff70}
      table.cookies{width:100%;table-layout:fixed;border-collapse:collapse;margin:.25rem 0 1rem;font-size:.9rem}
      table.cookies th,table.cookies td{padding:.5rem .5rem .5rem 0;border-bottom:1px solid #1d2a28;text-align:left;vertical-align:top;overflow-wrap:anywhere;word-break:break-word}
      table.cookies th{color:#97a5a0;font-weight:600}
      table.cookies td{color:#b7c3c0}
      table.cookies th:first-child{width:40%}
      table.cookies th:last-child{width:26%}
    `;

export function privacyPageHtml(input: PrivacyPageInput): string {
  const copy = PRIVACY_COPY;
  const canonical = new URL(PRIVACY_PATH, trustedPageOrigin(input.requestOrigin ?? '', input.allowedOrigins) ?? CANONICAL_ORIGIN).href;
  const sections = copy.sections.map((section, index) => `<section aria-labelledby="privacy-${index}">
        <h2 id="privacy-${index}">${escapeHtml(section.heading)}</h2>
        ${section.blocks.map(block => blockHtml(block, input)).join('\n        ')}
      </section>`);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark" />
    <title>${escapeHtml(copy.title)} · ${SITE_NAME}</title>
    <meta name="description" content="${escapeHtml(copy.description)}" />
    <link rel="canonical" href="${escapeHtml(canonical)}" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <style>${ACCOUNT_PAGE_STYLE}${LEGAL_PAGE_STYLE}</style>
  </head>
  <body>
    <main data-privacy="true">
      ${siteBrandLinkHtml('brand')}
      <article>
      <h1>${escapeHtml(copy.title)}</h1>
      <p class="updated">${escapeHtml(copy.lastUpdatedLead)} <time datetime="${escapeHtml(PRIVACY_POLICY_VERSION)}">${escapeHtml(formatPolicyDate(PRIVACY_POLICY_VERSION))}</time></p>
      ${copy.intro.map(text => `<p>${privacyInlineHtml(text)}</p>`).join('\n      ')}
      ${sections.join('\n      ')}
      </article>
      <p class="help"><a href="/">Back to the home page</a></p>
    </main>
    ${siteFooterHtml()}
  </body>
</html>
`;
}

export type PrivacyHttpOutput = { status: 200; headers: Record<string, string>; body: string };

/** GET/HEAD; HEAD gets the headers only. Shared-cacheable: nothing on it depends on the visitor. */
export function privacyHttpOutput(method: string, input: PrivacyPageInput): PrivacyHttpOutput {
  return {
    status: 200,
    headers: { 'cache-control': PRIVACY_CACHE_CONTROL, 'content-type': 'text/html; charset=utf-8' },
    body: method.toUpperCase() === 'HEAD' ? '' : privacyPageHtml(input),
  };
}
