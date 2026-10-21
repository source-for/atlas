import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { parsePortableAtlas, serializePortableAtlas } from '@okie/architecture';
import { bundledViewerDirectory, product } from './product.js';

/** Assemble a fresh static directory; never overwrite a user's existing site. */
export function packagePortableViewer(bundleFile: string, viewerDirectory: string, outputDirectory: string): void {
  const output = resolve(outputDirectory);
  const viewer = resolve(viewerDirectory);
  if (output === viewer || !relative(viewer, output).startsWith('..')) throw new Error('Output must be outside the viewer directory.');
  if (existsSync(output) && readdirSync(output).length) throw new Error('Output directory must be empty.');
  const bundle = parsePortableAtlas(readFileSync(bundleFile, 'utf8'));
  const indexPath = join(viewer, 'index.html');
  if (!existsSync(indexPath)) throw new Error('Viewer directory must contain a built index.html.');
  let html = readFileSync(indexPath, 'utf8');
  if (!html.includes('</head>')) throw new Error('Viewer index.html has no head element.');
  // Changing index links alone does not fix absolute dynamic-import/preload URLs
  // embedded in JS. Require the relocatable Vite build rather than rewriting it.
  if (/(?:src|href)=["']\//.test(html)) throw new Error('Viewer must use relative assets. Build it with pnpm build:portable.');
  if (!html.includes('name="okie-portable"')) html = html.replace('</head>', '<meta name="okie-portable" content="true">\n</head>');
  mkdirSync(output, { recursive: true });
  cpSync(viewer, output, { recursive: true });
  writeFileSync(join(output, 'index.html'), html);
  writeFileSync(join(output, 'atlas.okie.json'), serializePortableAtlas(bundle));
}

export function runPackageViewer(args: readonly string[]): void {
  const usage = `Usage: ${product.bin} export --bundle atlas.okie.json --out <empty-site-dir> [--viewer <built-viewer-dir>]`;
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!key || !['--bundle', '--viewer', '--out'].includes(key) || !value || value.startsWith('--')) throw new Error(usage);
    values.set(key, value);
  }
  const bundle = values.get('--bundle'), out = values.get('--out');
  if (!bundle || !out) throw new Error(`Export requires --bundle and --out. ${usage}`);
  const viewer = values.get('--viewer') ?? bundledViewerDirectory();
  if (!viewer) throw new Error('No bundled viewer: this CLI is running from source. Build one with pnpm build:portable and pass --viewer apps/web/dist-portable.');
  packagePortableViewer(bundle, viewer, out);
  process.stdout.write(`Static atlas written to ${resolve(out)}. Serve this folder with a static HTTP server.\n`);
}
