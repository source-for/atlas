import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative, sep } from 'node:path';

// Bundle workspace code into one CLI file, retaining native parsers and language tooling as
// exactly pinned npm dependencies, and ship the prebuilt portable viewer beside it. The
// resulting directory can be installed or packed independently; nothing here publishes.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'dist/okie-cli');
const viewerSource = join(root, 'apps/web/dist-portable');
const scanRoot = join(root, 'packages/scan');
const scan = JSON.parse(readFileSync(join(scanRoot, 'package.json'), 'utf8'));
const product = JSON.parse(readFileSync(join(scanRoot, 'product.json'), 'utf8'));

/** The portable artifact formats this viewer opens (`parsePortableAtlas` in @okie/architecture). */
const ARTIFACT_FORMATS = [{ format: 'okie-atlas', version: 1 }];

if (!existsSync(join(viewerSource, 'index.html')) || !readFileSync(join(viewerSource, 'index.html'), 'utf8').includes('name="okie-portable"')) {
  throw new Error('No portable viewer build in apps/web/dist-portable. Run pnpm build:portable first.');
}

// Exact versions as installed from the lockfile, never the ranges in packages/scan/package.json.
// Read the linked package directly: some packages' `exports` hide their package.json from require.
const dependencies = Object.fromEntries(Object.keys(scan.dependencies).filter(name => !name.startsWith('@okie/')).sort().map(name => {
  const { version } = JSON.parse(readFileSync(join(scanRoot, 'node_modules', name, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Cannot pin ${name}: resolved version ${version} is not exact.`);
  return [name, version];
}));

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'bin'), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ['packages/scan/src/cli.ts'],
  outfile: join(output, 'bin/cli.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  external: Object.keys(dependencies),
  alias: {
    '@okie/architecture': join(root, 'packages/architecture/src/index.ts'),
    '@okie/scene-compiler': join(root, 'packages/scene-compiler/src/index.ts'),
  },
});
chmodSync(join(output, 'bin/cli.mjs'), 0o755);
for (const name of ['enrichment-prompt.md', 'enrichment-prompt-v3.md', 'product.json']) {
  copyFileSync(join(scanRoot, name), join(output, name));
}
copyFileSync(join(root, 'LICENSE'), join(output, 'LICENSE'));
cpSync(join(root, 'skills'), join(output, 'skills'), { recursive: true });

// The viewer and a manifest of exactly what was bundled: `build` hashes the sorted file list.
cpSync(viewerSource, join(output, 'viewer'), { recursive: true });
const listFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name);
  return entry.isDirectory() ? listFiles(path) : [path];
});
const files = listFiles(join(output, 'viewer'))
  .map(path => relative(join(output, 'viewer'), path).split(sep).join('/'))
  .sort()
  .map(path => {
    const bytes = readFileSync(join(output, 'viewer', path));
    return { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
const buildHash = createHash('sha256').update(files.map(file => `${file.sha256}  ${file.path}\n`).join('')).digest('hex');
writeFileSync(join(output, 'viewer/manifest.json'), JSON.stringify({ artifactFormats: ARTIFACT_FORMATS, build: buildHash, files }, null, 2) + '\n');

writeFileSync(join(output, 'package.json'), JSON.stringify({
  name: product.packageName, version: scan.version, type: 'module',
  description: 'Scan a repository\'s committed source into an evidence-backed architecture atlas and view it locally',
  license: 'MIT',
  repository: { type: 'git', url: 'git+https://github.com/source-for/atlas.git' },
  engines: { node: '>=22' }, bin: { [product.bin]: 'bin/cli.mjs' },
  files: ['bin', 'skills', 'viewer', 'product.json', 'enrichment-prompt.md', 'enrichment-prompt-v3.md'], dependencies,
}, null, 2) + '\n');
console.log(`CLI package ${product.packageName} prepared at ${output} (viewer: ${files.length} files). Use npm pack in that directory to create a local distribution tarball.`);
