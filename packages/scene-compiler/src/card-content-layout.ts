import { displayTextWidth, fitDisplayText, fitDisplayTextAtSize, type DisplayFontMetrics } from './display-text.js';

/** Deterministic word wrapping in authored units; only the final capped line ellipsizes. */
export function wrapDisplayText(text: string, width: number, size: number, maxLines: number, metrics: DisplayFontMetrics = 'sans-regular'): string[] {
  const remaining = text.trim().replace(/[^\S\n]+/gu, ' ').split(/(\n)| +/u).filter((value): value is string => Boolean(value));
  const lines: string[] = [];
  if (!(width > 0 && size > 0 && maxLines > 0)) return lines;
  while (remaining.length && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      const rest = remaining.filter(word => word !== '\n').join(' ');
      const last = fitDisplayText(rest, width, size, 'word', metrics);
      // Never paint a lone ellipsis: fold the omission into the previous line instead.
      if (last === '…' && lines.length) lines.push(fitDisplayText(`${lines.pop()!} ${rest}`, width, size, 'word', metrics));
      else lines.push(last);
      break;
    }
    let line = '';
    while (remaining.length) {
      if (remaining[0] === '\n') { remaining.shift(); if (line) break; continue; }
      const next = line ? `${line} ${remaining[0]}` : remaining[0]!;
      if (displayTextWidth(next, size, metrics) <= width) { line = next; remaining.shift(); continue; }
      if (line) break;
      const chars = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(remaining.shift()!)].map(value => value.segment);
      while (chars.length && displayTextWidth(line + chars[0], size, metrics) <= width) line += chars.shift();
      if (!line) return lines; // No whole glyph fits; never paint beyond the width.
      if (chars.length) remaining.unshift(chars.join(''));
      break;
    }
    lines.push(line);
  }
  return lines;
}

export type CardTextLine = { role: 'kicker' | 'title' | 'description'; content: string; size: number; baseline: number; metrics: DisplayFontMetrics };
/** Shared GPU/Canvas layout, in caller-selected world or CSS units. */
export function cardContentLayout(input: {
  width: number; inset: number; top: number; bottom: number; gap: number;
  kicker: string; title: string; description?: string | undefined; descriptionLines: number;
  kickerSize: number; titleSize: number; titleFloor: number; titleFitStep?: number; descriptionSize: number; mono?: boolean;
}) {
  const maxWidth = Math.max(1, input.width - 2 * input.inset);
  const titleMetrics = input.mono ? 'mono-semibold' : 'sans-semibold';
  const descriptionMetrics = input.mono ? 'mono-regular' : 'sans-regular';
  const title = fitDisplayTextAtSize(input.title, maxWidth, input.titleSize, input.titleFloor, 'identifier', titleMetrics, input.titleFitStep);
  const lines: CardTextLine[] = [];
  let baseline = input.top + input.kickerSize;
  lines.push({ role: 'kicker', content: fitDisplayText(input.kicker, maxWidth, input.kickerSize, 'word', 'sans-semibold'), size: input.kickerSize, baseline, metrics: 'sans-semibold' });
  baseline += input.gap + title.fontSize;
  lines.push({ role: 'title', content: title.content, size: title.fontSize, baseline, metrics: titleMetrics });
  for (const content of input.description ? wrapDisplayText(input.description, maxWidth, input.descriptionSize, input.descriptionLines, descriptionMetrics) : []) {
    baseline += input.gap + input.descriptionSize * 1.2;
    lines.push({ role: 'description', content, size: input.descriptionSize, baseline, metrics: descriptionMetrics });
  }
  return { lines, maxWidth, height: baseline + input.bottom };
}
