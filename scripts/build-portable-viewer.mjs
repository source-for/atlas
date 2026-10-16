import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { portableIndexHtml } from './portable-html.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// `--mode portable` drops the dev-only renderer stress fixture chunk at build time (stressFixture.ts).
execFileSync('pnpm', ['--filter', '@okie/web', 'exec', 'vite', 'build', '--mode', 'portable', '--base', './', '--outDir', 'dist-portable'], { cwd: root, stdio: 'inherit' });
// Vite copies public/ whole. These files serve only the hosted sourcefor.dev site (edge headers, the
// Worker-rendered home page's script, hosted docs, the social card), so a self-hosted viewer omits them.
for (const hostedOnly of ['_headers', 'home.js', 'docs', 'og-default.png']) {
  rmSync(new URL(`../apps/web/dist-portable/${hostedOnly}`, import.meta.url), { recursive: true, force: true });
}
const index = new URL('../apps/web/dist-portable/index.html', import.meta.url);
writeFileSync(index, portableIndexHtml(readFileSync(index, 'utf8')));
console.log('Portable viewer ready in apps/web/dist-portable. It opens local scans without an application backend.');
