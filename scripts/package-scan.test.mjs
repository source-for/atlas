// Packs the CLI exactly as it would be published and tests the installed copy. Needs the portable
// viewer build (pnpm build:portable) and registry access for the tarball's npm dependencies.
// Run with `pnpm test:package`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const product = JSON.parse(readFileSync(join(root, 'packages/scan/product.json'), 'utf8'));
const work = mkdtempSync(join(tmpdir(), 'sourcefor-atlas-package-'));
const installed = join(work, 'prefix/node_modules', product.packageName);
const modules = join(work, 'prefix/node_modules');
const bin = join(work, 'prefix/node_modules/.bin', product.bin);

const run = (args, options = {}) => spawnSync(bin, args, { cwd: work, encoding: 'utf8', ...options });

function commitRepository(name, files) {
  const directory = join(work, name);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(directory, path, '..'), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  const git = args => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.email=test@example.invalid', '-c', 'user.name=test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);
  return directory;
}

/** Move a path aside for the duration of `body`, then put it back. */
function without(path, body) {
  const aside = `${path}.aside`;
  const present = existsSync(path);
  if (present) renameSync(path, aside);
  try { return body(); } finally { if (present) renameSync(aside, path); }
}

before(() => {
  execFileSync(process.execPath, [join(root, 'scripts/package-scan.mjs')], { cwd: root, stdio: 'inherit' });
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: join(root, 'dist/okie-cli'), encoding: 'utf8' }));
  mkdirSync(join(work, 'prefix'));
  execFileSync('npm', ['install', '--prefix', join(work, 'prefix'), '--ignore-scripts', '--no-audit', '--no-fund', join(work, packed[0].filename)], { stdio: 'inherit' });
});

after(() => rmSync(work, { recursive: true, force: true }));

test('the packed manifest names one bin from product.json and pins analyser dependencies exactly', () => {
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, product.packageName);
  assert.deepEqual(manifest.bin, { [product.bin]: 'bin/cli.mjs' });
  for (const name of ['typescript', 'tree-sitter', 'tree-sitter-rust', '@scip-code/scip', '@bufbuild/protobuf']) {
    assert.match(manifest.dependencies[name] ?? '', /^\d+\.\d+\.\d+$/, `${name} must be an exact version`);
  }
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+$/, `${name} must be an exact version`);
    assert.equal(JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version, version, `${name} installs at its pin`);
  }
  assert.ok(!Object.keys(manifest.dependencies).some(name => name.startsWith('@okie/')), 'workspace packages are bundled, not depended on');
});

test('the viewer manifest lists exactly the bundled viewer files', () => {
  const viewer = join(installed, 'viewer');
  const manifest = JSON.parse(readFileSync(join(viewer, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.artifactFormats, [{ format: 'okie-atlas', version: 1 }]);
  const list = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? list(join(directory, entry.name)) : [relative(viewer, join(directory, entry.name)).split(sep).join('/')]);
  const onDisk = list(viewer).filter(path => path !== 'manifest.json').sort().map(path => {
    const bytes = readFileSync(join(viewer, path));
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  assert.deepEqual(manifest.files, onDisk);
  assert.equal(manifest.build, createHash('sha256').update(onDisk.map(file => `${file.sha256}  ${file.path}\n`).join('')).digest('hex'));
  const paths = onDisk.map(file => file.path);
  assert.ok(paths.includes('index.html') && paths.some(path => path.endsWith('.wasm')), 'viewer has its entry and renderer');
  assert.match(readFileSync(join(viewer, 'index.html'), 'utf8'), /name="okie-portable"/);
  for (const pruned of ['_headers', 'home.js', 'og-default.png']) assert.ok(!paths.includes(pruned), `${pruned} is pruned`);
  assert.ok(!paths.some(path => path.startsWith('docs/') || /stress-5000/.test(path)), 'hosted docs and the stress fixture are pruned');
  // Every relative asset the viewer's JS and HTML names is bundled.
  for (const path of paths.filter(path => /\.(?:js|html|css)$/.test(path))) {
    for (const [, asset] of readFileSync(join(viewer, path), 'utf8').matchAll(/["'(]\.?\/?(assets\/[\w.-]+\.\w+)["')]/g)) {
      assert.ok(paths.includes(asset), `${path} references missing ${asset}`);
    }
  }
});

test('without a tree-sitter prebuild: help, TypeScript-only scans and export work; Rust degrades with one warning', () => {
  const prebuild = join(modules, 'tree-sitter/prebuilds', `${process.platform}-${process.arch}`);
  const typescriptOnly = commitRepository('ts-only', {
    'package.json': '{ "name": "ts-only", "version": "1.0.0" }\n',
    'src/index.ts': 'export function add(left: number, right: number): number { return left + right; }\n',
  });
  const mixed = commitRepository('mixed', {
    'package.json': '{ "name": "mixed", "version": "1.0.0" }\n',
    'src/index.ts': 'export const answer = 42;\n',
    'Cargo.toml': '[package]\nname = "mixed"\nversion = "0.1.0"\nedition = "2021"\n',
    'src/lib.rs': 'pub fn hello() -> u32 { 1 }\n',
  });
  without(prebuild, () => {
    const help = run(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`Usage: ${product.bin} `));

    const typescriptScan = run(['--source', typescriptOnly, '--quick', '--out', join(work, 'out-ts')]);
    assert.equal(typescriptScan.status, 0, typescriptScan.stderr);
    assert.equal(typescriptScan.stderr, '');
    const typescriptAtlas = JSON.parse(readFileSync(join(work, 'out-ts/atlas.okie.json'), 'utf8'));
    assert.deepEqual(typescriptAtlas.analysis.adapters.map(adapter => [adapter.language, adapter.coverage]), [['typescript/javascript', 'syntax']]);
    assert.deepEqual(typescriptAtlas.generator, { name: product.packageName, version: JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version });

    const mixedScan = run(['--source', mixed, '--quick', '--out', join(work, 'out-mixed')]);
    assert.equal(mixedScan.status, 0, mixedScan.stderr);
    const warnings = mixedScan.stderr.trim().split('\n');
    assert.equal(warnings.length, 1, mixedScan.stderr);
    assert.match(warnings[0], /warning: Rust is not mapped\. Rust parser unavailable: tree-sitter has no usable native build for /);
    const rust = JSON.parse(readFileSync(join(work, 'out-mixed/atlas.okie.json'), 'utf8')).analysis.adapters.find(adapter => adapter.language === 'rust');
    assert.equal(rust?.coverage, 'unavailable');

    const exported = run(['export', '--bundle', join(work, 'out-mixed/atlas.okie.json'), '--out', join(work, 'site')]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.ok(existsSync(join(work, 'site/index.html')) && existsSync(join(work, 'site/atlas.okie.json')), 'export used the bundled viewer');
  });
  // Control: with the prebuild back, the same repository maps Rust syntax.
  const control = run(['--source', mixed, '--quick', '--out', join(work, 'out-mixed-control')]);
  assert.equal(control.status, 0, control.stderr);
  assert.equal(control.stderr, '');
  const rust = JSON.parse(readFileSync(join(work, 'out-mixed-control/atlas.okie.json'), 'utf8')).analysis.adapters.find(adapter => adapter.language === 'rust');
  assert.equal(rust?.coverage, 'syntax');
});

test('help needs no language tooling at all', () => {
  without(join(modules, 'typescript'), () => without(join(modules, 'tree-sitter'), () => {
    const help = run(['--help']);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, new RegExp(`Usage: ${product.bin} `));
  }));
});
