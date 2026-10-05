import { displayTextWidth, fitDisplayText, fitDisplayTextAtSize, type DisplayFontMetrics } from './display-text.js';

const graphemes = (text: string) => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map(value => value.segment);

/** Longest grapheme prefix plus an ellipsis that fits, or '' when no glyph fits. */
function ellipsizeGraphemes(text: string, width: number, size: number, metrics: DisplayFontMetrics): string {
  let prefix = '';
  for (const glyph of graphemes(text)) {
    if (displayTextWidth(`${prefix}${glyph}…`, size, metrics) > width) break;
    prefix += glyph;
  }
  return prefix.trimEnd() ? `${prefix.trimEnd()}…` : '';
}

/** Deterministic word wrapping in authored units; only the final capped line ellipsizes. */
export function wrapDisplayText(text: string, width: number, size: number, maxLines: number, metrics: DisplayFontMetrics = 'sans-regular'): string[] {
  const remaining = text.trim().replace(/[^\S\n]+/gu, ' ').split(/(\n)| +/u).filter((value): value is string => Boolean(value));
  const lines: string[] = [];
  if (!(width > 0 && size > 0 && maxLines > 0)) return lines;
  while (remaining.length && lines.length < maxLines) {
    if (lines.length === maxLines - 1) {
      const rest = remaining.filter(word => word !== '\n').join(' ');
      const last = fitDisplayText(rest, width, size, 'word', metrics);
      if (last !== '…') { lines.push(last); break; }
      // The first word alone overflows: cut it at a grapheme rather than dropping it.
      const cut = ellipsizeGraphemes(rest, width, size, metrics);
      if (cut) lines.push(cut);
      // Not even one glyph fits: mark the omission on the previous line, never alone.
      else if (lines.length) lines.push(ellipsizeGraphemes(`${lines.pop()!} ${rest}`, width, size, metrics) || '…');
      break;
    }
    let line = '';
    while (remaining.length) {
      if (remaining[0] === '\n') { remaining.shift(); if (line) break; continue; }
      const next = line ? `${line} ${remaining[0]}` : remaining[0]!;
      if (displayTextWidth(next, size, metrics) <= width) { line = next; remaining.shift(); continue; }
      if (line) break;
      const chars = graphemes(remaining.shift()!);
      while (chars.length && displayTextWidth(line + chars[0], size, metrics) <= width) line += chars.shift();
      if (!line) return lines; // No whole glyph fits; never paint beyond the width.
      if (chars.length) remaining.unshift(chars.join(''));
      break;
    }
    lines.push(line);
  }
  return lines;
}

/** Kicker baseline → title baseline: clears kicker descenders and reserves ≥1.2× the
 * title size (docs/product/golden-okie-hierarchy.md). */
export function cardTitleStep(gap: number, kickerClearance: number, titleSize: number): number {
  return Math.max(gap, kickerClearance, titleSize * .2) + titleSize;
}

/** Baseline step into each support line: reserves ≥1.35× the support size. */
export function cardDescriptionStep(gap: number, descriptionSize: number): number {
  return Math.max(gap + descriptionSize * 1.2, descriptionSize * 1.35);
}

export type CardTextLine = { role: 'kicker' | 'title' | 'description'; content: string; size: number; baseline: number; metrics: DisplayFontMetrics };
/** Shared GPU/Canvas layout, in caller-selected world or CSS units. */
export function cardContentLayout(input: {
  width: number; inset: number; top: number; bottom: number; gap: number;
  kicker: string; title: string; description?: string | undefined; descriptionLines: number;
  kickerSize: number; titleSize: number; titleFloor: number; titleFitStep?: number; descriptionSize: number; mono?: boolean;
  /** Minimum kicker-baseline → title-top clearance (kicker descenders + a hairline). */
  kickerClearance?: number;
}) {
  const maxWidth = Math.max(1, input.width - 2 * input.inset);
  const titleMetrics = input.mono ? 'mono-semibold' : 'sans-semibold';
  const descriptionMetrics = input.mono ? 'mono-regular' : 'sans-regular';
  const title = fitDisplayTextAtSize(input.title, maxWidth, input.titleSize, input.titleFloor, 'identifier', titleMetrics, input.titleFitStep);
  const lines: CardTextLine[] = [];
  let baseline = input.top + input.kickerSize;
  lines.push({ role: 'kicker', content: fitDisplayText(input.kicker, maxWidth, input.kickerSize, 'word', 'sans-semibold'), size: input.kickerSize, baseline, metrics: 'sans-semibold' });
  baseline += cardTitleStep(input.gap, input.kickerClearance ?? 0, title.fontSize);
  lines.push({ role: 'title', content: title.content, size: title.fontSize, baseline, metrics: titleMetrics });
  for (const content of input.description ? wrapDisplayText(input.description, maxWidth, input.descriptionSize, input.descriptionLines, descriptionMetrics) : []) {
    baseline += cardDescriptionStep(input.gap, input.descriptionSize);
    lines.push({ role: 'description', content, size: input.descriptionSize, baseline, metrics: descriptionMetrics });
  }
  return { lines, maxWidth, height: baseline + input.bottom };
}
