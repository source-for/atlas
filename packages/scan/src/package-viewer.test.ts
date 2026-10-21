import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parsePortableAtlas } from '@okie/architecture';
import { packagePortableViewer, runPackageViewer } from './package-viewer.js';

test('static export keeps its bundled artifact and assets usable under a host subpath', () => {
  const root = mkdtempSync(join(tmpdir(), 'okie-package-viewer-'));
  try {
    const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), 'utf8')
      .replaceAll('golden-worktree-okie-2026-07-14-v1', 'a'.repeat(40)));
    const bundle = { format: 'okie-atlas', version: 1, repository: { commitSha: 'a'.repeat(40), treeHash: 'b'.repeat(40) },
      snapshot: read('snapshot'), view: read('view'), story: read('story'), stories: [], analysis: { mode: 'quick', adapters: [] } };
    const bundleFile = join(root, 'input.json'), viewer = join(root, 'viewer'), output = join(root, 'site');
    writeFileSync(bundleFile, JSON.stringify(bundle));
    mkdirSync(join(viewer, 'assets'), { recursive: true });
    writeFileSync(join(viewer, 'index.html'), '<html><head><script type="module" src="./assets/app.js"></script><link href="./assets/app.css" rel="stylesheet"></head><body></body></html>');
    writeFileSync(join(viewer, 'assets/app.js'), 'console.log("viewer")');
    packagePortableViewer(bundleFile, viewer, output);
    const html = readFileSync(join(output, 'index.html'), 'utf8');
    assert.match(html, /name="okie-portable" content="true"/);
    assert.match(html, /src="\.\/assets\/app.js"/);
    assert.match(html, /href="\.\/assets\/app.css"/);
    assert.equal(readFileSync(join(output, 'assets/app.js'), 'utf8'), 'console.log("viewer")');
    assert.deepEqual(parsePortableAtlas(readFileSync(join(output, 'atlas.okie.json'), 'utf8')), bundle);
    assert.throws(() => packagePortableViewer(bundleFile, viewer, output), /empty/);
    assert.throws(() => packagePortableViewer(bundleFile, viewer, join(viewer, 'nested')), /outside/);
    writeFileSync(join(viewer, 'index.html'), '<html><head><script src="/assets/app.js"></script></head></html>');
    assert.throws(() => packagePortableViewer(bundleFile, viewer, join(root, 'absolute-assets')), /relative assets/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('export without --viewer needs the packaged CLI and says how to build a viewer from source', () => {
  assert.throws(() => runPackageViewer(['--bundle', 'atlas.okie.json', '--out', 'site']), /No bundled viewer: this CLI is running from source\. .*pnpm build:portable.*--viewer apps\/web\/dist-portable/);
  assert.throws(() => runPackageViewer(['--bundle', 'atlas.okie.json']), /Export requires --bundle and --out\. Usage: sourcefor-atlas export/);
});
