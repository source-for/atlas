import {
  fallbackGlyphSlot,
  glyphCodePoints,
  monoGlyphAdvance,
  sansMediumAdvances,
  sansRegularAdvances,
  sansSemiboldAdvances,
  spaceAliasCodePoints,
} from './glyph-metrics.generated.js';

export type DisplayTextMode = 'word' | 'path' | 'identifier';
export type DisplayFontMetrics =
  | 'sans'
  | 'sans-regular'
  | 'sans-medium'
  | 'sans-semibold'
  | 'mono'
  | 'mono-regular'
  | 'mono-semibold';

// The renderer's glyph set and its advances in em, generated from the native
// atlas (crates/atlas-gpu/src/glyph.rs), which rasterizes the same bundled IBM
// Plex faces. A code point outside the set draws and measures as U+FFFD.
const glyphSlotByCodePoint = new Map<number, number>([
  ...glyphCodePoints.map((codePoint, slot) => [codePoint, slot] as const),
  ...spaceAliasCodePoints.map(codePoint => [codePoint, 0] as const),
]);

function glyphAdvance(character: string, metrics: DisplayFontMetrics): number {
  if (metrics.startsWith('mono')) return monoGlyphAdvance;
  const advances = metrics === 'sans-medium'
    ? sansMediumAdvances
    : metrics === 'sans-semibold'
      ? sansSemiboldAdvances
      : sansRegularAdvances;
  const slot = glyphSlotByCodePoint.get(character.codePointAt(0) ?? -1) ?? fallbackGlyphSlot;
  return advances[slot]!;
}

export function displayMetricsForFontFamily(fontFamily: string): DisplayFontMetrics {
  const normalized = fontFamily.toLowerCase();
  if (normalized.includes('mono')) return normalized.includes('semibold') || normalized.includes('600')
    ? 'mono-semibold'
    : 'mono-regular';
  if (normalized.includes('semibold') || normalized.includes('600')) return 'sans-semibold';
  if (normalized.includes('medium') || normalized.includes('500')) return 'sans-medium';
  return 'sans-regular';
}

export function displayTextWidth(content: string, fontSize: number, metrics: DisplayFontMetrics = 'sans'): number {
  return characters(content).reduce((width, character) => width + glyphAdvance(character, metrics) * fontSize, 0);
}

function characters(value: string): string[] {
  return [...value];
}

function pathCandidate(root: string | undefined, tail: readonly string[]): string {
  return root ? `${root}/…/${tail.join('/')}` : `…/${tail.join('/')}`;
}

/** Last `.ext` when the suffix is 1–8 alphanumeric chars starting with a letter. */
function fileExtension(nameChars: readonly string[]): string[] | undefined {
  const dot = nameChars.lastIndexOf('.');
  if (dot <= 0 || dot >= nameChars.length - 1) return undefined;
  const suffix = nameChars.slice(dot + 1).join('');
  if (suffix.length < 1 || suffix.length > 8) return undefined;
  if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(suffix)) return undefined;
  return nameChars.slice(dot);
}

/**
 * Truncates a filename or last path segment without eating only the stem's
 * leading characters. Prefers a full stem (`diagnostics…`) and otherwise a
 * middle cut that keeps stem start + extension (`diag…cs.rs`).
 */
function truncateFilenameStem(content: string, maximum: number): string {
  const chars = characters(content);
  if (chars.length <= maximum) return content;
  const extension = fileExtension(chars);
  const stem = extension ? chars.slice(0, chars.length - extension.length) : chars;
  if (stem.length + 1 <= maximum) return `${stem.join('')}…`;
  if (extension && 2 + extension.length <= maximum) {
    const budget = maximum - 1 - extension.length;
    const tail = Math.min(2, Math.max(0, budget - 1));
    const head = budget - tail;
    return `${stem.slice(0, head).join('')}…${stem.slice(stem.length - tail).join('')}${extension.join('')}`;
  }
  return `${chars.slice(0, maximum - 1).join('')}…`;
}

/**
 * Fits renderer copy without measuring fonts at runtime. The renderer's fixed
 * atlas and compiler use the same deterministic fitting algorithm. This
 * conservative character capacity is retained only for callers that do not
 * yet provide a metric role; final fitting always checks true advances.
 */
export function displayGlyphCapacity(maxWidth: number, fontSize: number): number {
  if (!Number.isFinite(maxWidth) || !Number.isFinite(fontSize) || maxWidth <= 0 || fontSize <= 0) return 0;
  return Math.max(0, Math.floor(maxWidth / (fontSize * 0.625)));
}

function truncateSlashedIdentifier(content: string, maximum: number): string | undefined {
  if (!content.includes('/') || /\s/u.test(content)) return undefined;
  const segments = content.split('/').filter(Boolean);
  if (segments.length <= 1) return undefined;
  const root = segments[0]!;
  for (let index = 1; index < segments.length; index += 1) {
    const rooted = pathCandidate(root, segments.slice(index));
    if (characters(rooted).length <= maximum) return rooted;
  }
  for (let index = 1; index < segments.length; index += 1) {
    const unrooted = pathCandidate(undefined, segments.slice(index));
    if (characters(unrooted).length <= maximum) return unrooted;
  }
  const last = segments.at(-1)!;
  if (characters(last).length <= maximum) return last;
  return truncateFilenameStem(last, maximum);
}

export function truncateDisplayText(content: string, capacity: number, mode: DisplayTextMode = 'word'): string {
  const maximum = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  if (characters(content).length <= maximum) return content;
  if (maximum === 0) return '';
  if (maximum === 1) return '…';

  // Scoped package names (`@fontsource/ibm-plex-sans`) are identifiers, but a
  // left prefix (`@fontsource/ibm-…`) throws away the distinctive tail. Path
  // truncation keeps the last segment once the name no longer fits.
  if (mode === 'path' || mode === 'identifier') {
    const slashed = truncateSlashedIdentifier(content, maximum);
    if (slashed !== undefined) return slashed;
  }

  if (mode === 'identifier') return truncateFilenameStem(content, maximum);
  const prefix = characters(content).slice(0, maximum - 1).join('');
  const boundary = prefix.search(/\s+\S*$/u);
  const completeWords = (boundary >= 0 ? prefix.slice(0, boundary) : '').trimEnd();
  return completeWords ? `${completeWords}…` : '…';
}

export function fitDisplayText(
  content: string,
  maxWidth: number,
  fontSize: number,
  mode: DisplayTextMode = 'word',
  metrics: DisplayFontMetrics = 'sans',
): string {
  if (displayTextWidth(content, fontSize, metrics) <= maxWidth) return content;
  for (let capacity = Math.max(1, characters(content).length - 1); capacity >= 1; capacity -= 1) {
    const candidate = truncateDisplayText(content, capacity, mode);
    if (displayTextWidth(candidate, fontSize, metrics) <= maxWidth) return candidate;
  }
  return maxWidth >= displayTextWidth('…', fontSize, metrics) ? '…' : '';
}

/**
 * Prefers a slightly smaller type size over a truncated label. Callers pass the
 * band's authored size and a truncation floor in the same units; L1–L3 titles
 * shrink to the 12 CSS-px floor, L4 to 0.65× authored, before identifier truncation.
 */
export function fitDisplayTextAtSize(
  content: string,
  maxWidth: number,
  fontSize: number,
  minFontSize: number,
  mode: DisplayTextMode = 'word',
  metrics: DisplayFontMetrics = 'sans',
  fitStep = .25,
): { content: string; fontSize: number } {
  const ceiling = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 0;
  const floor = Number.isFinite(minFontSize) && minFontSize > 0
    ? Math.min(ceiling, minFontSize)
    : ceiling;
  if (ceiling <= 0) return { content: '', fontSize: 0 };
  if (displayTextWidth(content, ceiling, metrics) <= maxWidth) {
    return { content, fontSize: ceiling };
  }
  const step = Number.isFinite(fitStep) && fitStep > 0 ? fitStep : .25;
  for (let size = ceiling - step; size >= floor - 1e-9; size -= step) {
    const candidate = Math.max(floor, size);
    if (displayTextWidth(content, candidate, metrics) <= maxWidth) {
      return { content, fontSize: candidate };
    }
  }
  return {
    content: fitDisplayText(content, maxWidth, floor, mode, metrics),
    fontSize: floor,
  };
}
