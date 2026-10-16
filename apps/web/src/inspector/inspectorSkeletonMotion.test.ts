import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('skeleton motion', () => {
  const css = readFileSync(new URL('../app.css', import.meta.url), 'utf8');
  it('stops every inspector skeleton pulse under prefers-reduced-motion', () => {
    const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([^@]*?)\n\}/gu)].map(match => match[1]!).join('\n');
    expect(reduced).toMatch(/\.inspector-skeleton-line,\s*\.inspector-skeleton-block \{ animation: none; \}/u);
    for (const animated of css.matchAll(/^(\.[\w-]+(?:\s[\w.-]+)*) \{[^}]*animation: boot-pulse/gmu)) {
      if (animated[1]!.startsWith('.inspector-') || animated[1]!.startsWith('.source-')) expect(['.inspector-skeleton-line', '.inspector-skeleton-block']).toContain(animated[1]);
    }
  });
});
