// CLA-610: the built viewer inside <iframe sandbox="allow-scripts"> (no allow-same-origin). The framed document has
// an opaque origin, so even reading window.localStorage throws SecurityError; one unguarded read used to unmount the
// whole app when the inspector's Overview opened. Needs `pnpm build` (apps/web/dist) and Playwright's Chromium
// (`pnpm exec playwright install chromium`, or CHROMIUM_PATH=<executable>).
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const dist = resolve(fileURLToPath(new URL('../apps/web/dist', import.meta.url)));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const VIEWER = '/?backend=canvas2d';

let server, origin, browser;
before(async () => {
  server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/embed') {
      const sandbox = url.searchParams.get('sandbox');
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><body style="margin:0"><iframe ${sandbox === null ? '' : `sandbox="${sandbox}"`} src="${VIEWER}" style="border:0;width:100vw;height:100vh"></iframe></body>`);
      return;
    }
    const path = extname(url.pathname) ? resolve(dist, `.${decodeURIComponent(url.pathname)}`) : resolve(dist, 'index.html');
    try {
      if (!path.startsWith(`${dist}${sep}`)) throw new Error('outside dist');
      const body = await readFile(path);
      // An opaque-origin document fetches the app's crossorigin module script and stylesheet in CORS mode.
      response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
      response.end(body);
    } catch {
      response.writeHead(404); response.end();
    }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
});
after(async () => {
  await browser?.close();
  await new Promise(done => server?.close(done) ?? done());
});

/** Load the viewer in the embed, open the inspector's Overview, and report what the framed document shows. */
async function openOverview(sandbox) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  try {
    await page.goto(`${origin}/embed${sandbox === null ? '' : `?sandbox=${sandbox}`}`);
    const frame = await (await page.waitForSelector('iframe')).contentFrame();
    await frame.locator('canvas').first().waitFor({ timeout: 30_000 });
    const isolation = await frame.evaluate(() => {
      let storage = 'readable';
      try { void window.localStorage; } catch (error) { storage = error.name; }
      return { origin: self.origin, storage };
    });
    // The golden map's inspector starts closed on Details; Overview is where the block planner reads its flag.
    await frame.getByRole('button', { name: 'Open details panel', exact: true }).click();
    await frame.getByRole('tab', { name: 'Overview', exact: true }).click();
    await frame.locator('[data-testid="inspector-overview"]').waitFor({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    const shown = await frame.evaluate(() => {
      const canvas = document.querySelector('canvas');
      let distinctPixels = 0;
      if (canvas && canvas.width > 0) {
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        const seen = new Set();
        for (let i = 0; i < data.length && seen.size < 64; i += 4 * 97) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
        distinctPixels = seen.size;
      }
      return {
        appMounted: (document.getElementById('root')?.childElementCount ?? 0) > 0,
        overviewPanel: Boolean(document.querySelector('[data-testid="inspector-overview"]')),
        distinctPixels,
      };
    });
    return { isolation, shown, pageErrors };
  } finally {
    await page.close();
  }
}

test('control: a plain iframe opens Overview with the map drawn', async () => {
  const result = await openOverview(null);
  assert.notEqual(result.isolation.origin, 'null');
  assert.equal(result.isolation.storage, 'readable');
  assert.deepEqual(result.pageErrors, []);
  assert.equal(result.shown.appMounted, true);
  assert.equal(result.shown.overviewPanel, true);
  assert.ok(result.shown.distinctPixels > 4, `map canvas looks blank (${result.shown.distinctPixels} colours)`);
});

test('sandbox="allow-scripts" without allow-same-origin: Overview opens and the map stays drawn', async () => {
  const result = await openOverview('allow-scripts');
  // Prove the sandbox is real: an opaque origin whose storage getter throws.
  assert.equal(result.isolation.origin, 'null');
  assert.equal(result.isolation.storage, 'SecurityError');
  assert.equal(result.shown.appMounted, true, `the app unmounted (blank embed): ${result.pageErrors.join(' | ')}`);
  assert.deepEqual(result.pageErrors, []);
  assert.equal(result.shown.overviewPanel, true);
  assert.ok(result.shown.distinctPixels > 4, `map canvas looks blank (${result.shown.distinctPixels} colours)`);
});
