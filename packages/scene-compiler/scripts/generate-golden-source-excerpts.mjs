#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { compareText, SOURCE_EXCERPT_LIMITS } from '@okie/architecture';
import { GOLDEN_SOURCE_EXCERPTS } from '../dist/golden-source-excerpts.js';

const repositoryRoot = new URL('../../../', import.meta.url);
const target = fileURLToPath(new URL('../src/golden-source-excerpts.ts', import.meta.url));
const escapePattern = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function anchorLine(lines, symbol) {
  if (!symbol) return 0;
  if (symbol.includes('::')) {
    const [owner, method] = symbol.split('::');
    const implementation = lines.findIndex(line => new RegExp(`^\\s*impl(?:<[^>]+>)?\\s+${escapePattern(owner)}\\b`).test(line));
    return lines.findIndex((line, index) => index > implementation && new RegExp(`\\bfn\\s+${escapePattern(method)}\\b`).test(line));
  }
  const escaped = escapePattern(symbol);
  const declarations = new RegExp(`\\b(?:function|class|interface|type|const|struct|enum|trait|fn)\\s+${escaped}\\b`);
  const declaration = lines.findIndex(line => declarations.test(line));
  return declaration >= 0 ? declaration : lines.findIndex(line => new RegExp(`\\b${escaped}\\b`).test(line));
}

function excerptWithinLimits(lines) {
  return lines.length <= SOURCE_EXCERPT_LIMITS.maxLines
    && lines.every(line => [...line].length <= SOURCE_EXCERPT_LIMITS.maxLineCharacters)
    && [...lines.join('\n')].length <= SOURCE_EXCERPT_LIMITS.maxTextCharacters;
}

function safeAnchorLine(lines, symbol) {
  const preferred = anchorLine(lines, symbol);
  if (preferred < 0) return preferred;
  const candidates = [preferred];
  if (symbol && !symbol.includes('::')) {
    const occurrence = new RegExp(`\\b${escapePattern(symbol)}\\b`);
    lines.forEach((line, index) => {
      if (index !== preferred && occurrence.test(line)) candidates.push(index);
    });
  }
  return candidates.find(index => excerptWithinLimits(lines.slice(index, Math.min(lines.length, index + 6)))) ?? preferred;
}

const generated = [];
for (const [id, previous] of Object.entries(GOLDEN_SOURCE_EXCERPTS).sort(([left], [right]) => compareText(left, right))) {
  if (previous.path.startsWith('/') || previous.path.includes('\\') || previous.path.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new Error(`Unsafe repository-relative source path for ${id}: ${previous.path}`);
  }
  const sourceUrl = new URL(previous.path, repositoryRoot);
  const lines = (await readFile(sourceUrl, 'utf8')).replace(/\r\n/g, '\n').split('\n');
  const index = safeAnchorLine(lines, previous.symbol);
  if (index < 0) throw new Error(`Cannot find ${previous.symbol ?? previous.path} for ${id}`);
  const excerptLines = lines.slice(index, Math.min(lines.length, index + 6));
  if (!excerptWithinLimits(excerptLines)) {
    throw new Error(`Frozen source excerpt exceeds architecture limits for ${id}`);
  }
  generated.push([id, {
    path: previous.path,
    ...(previous.symbol ? { symbol: previous.symbol } : {}),
    language: previous.language,
    startLine: index + 1,
    endLine: index + excerptLines.length,
    highlightLine: index + 1,
    frozenRevision: previous.frozenRevision,
    lines: excerptLines,
    text: excerptLines.join('\n'),
  }]);
}

let output = 'import type { SourceExcerpt } from "@okie/architecture";\n\n';
output += '/** Checked source content; regenerate deliberately when the frozen revision changes. */\n';
output += 'export const GOLDEN_SOURCE_EXCERPTS = {\n';
for (const [id, excerpt] of generated) {
  output += `  ${JSON.stringify(id)}: ${JSON.stringify(excerpt, null, 2).replace(/^/gm, '  ').trimStart()},\n`;
}
output += '} as const satisfies Readonly<Record<string, SourceExcerpt>>;\n';
await writeFile(target, output, 'utf8');
