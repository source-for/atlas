export type DisplayTextMode = 'word' | 'path' | 'identifier';
export type DisplayFontMetrics =
  | 'sans'
  | 'sans-regular'
  | 'sans-medium'
  | 'sans-semibold'
  | 'mono'
  | 'mono-regular'
  | 'mono-semibold';

// Normalized advances for ASCII 32–126 plus U+2026, frozen from the bundled
// IBM Plex Sans static faces at 48 px. The native atlas uses these exact TTF
// bytes and fontdue advance_width values; both IBM Plex Mono faces are 0.6 em.
const sansRegularAdvances = [
  .236, .284, .419, .713, .598, .927, .694, .242, .335, .335, .45, .6, .272, .399, .272, .383,
  .6, .6, .6, .6, .6, .6, .6, .6, .6, .6, .292, .292, .6, .6, .6, .477,
  .891, .641, .653, .621, .671, .583, .559, .695, .707, .4, .51, .634, .501, .812, .707, .708,
  .606, .708, .64, .581, .572, .678, .609, .891, .613, .593, .58, .317, .383, .317, .6, .565,
  .6, .534, .58, .503, .58, .549, .324, .528, .568, .25, .25, .527, .272, .873, .568, .56,
  .58, .58, .367, .487, .351, .568, .492, .768, .507, .499, .464, .343, .314, .343, .6, .803,
] as const;

const sansMediumAdvances = [
  .236, .298, .451, .678, .599, .947, .707, .253, .336, .336, .514, .6, .29, .401, .29, .417,
  .6, .6, .6, .6, .6, .6, .6, .6, .6, .6, .31, .31, .6, .6, .6, .487,
  .896, .662, .659, .634, .683, .593, .57, .705, .714, .416, .531, .66, .513, .814, .714, .712,
  .627, .712, .655, .598, .577, .686, .628, .926, .639, .617, .591, .325, .417, .325, .6, .561,
  .6, .549, .592, .51, .592, .556, .34, .537, .58, .265, .265, .547, .285, .882, .58, .564,
  .592, .592, .383, .494, .365, .58, .512, .799, .53, .514, .487, .354, .353, .356, .6, .846,
] as const;

const sansSemiboldAdvances = [
  .236, .309, .471, .656, .6, .96, .713, .26, .337, .337, .556, .6, .298, .402, .298, .437,
  .6, .6, .6, .6, .6, .6, .6, .6, .6, .6, .318, .318, .6, .6, .6, .493,
  .899, .672, .663, .642, .689, .6, .577, .712, .719, .423, .545, .678, .521, .816, .719, .712,
  .641, .712, .664, .611, .58, .69, .638, .949, .655, .632, .599, .329, .437, .329, .6, .559,
  .6, .559, .6, .513, .6, .558, .35, .545, .588, .276, .276, .562, .294, .888, .588, .563,
  .6, .6, .393, .499, .374, .588, .524, .819, .544, .524, .502, .363, .376, .363, .6, .868,
] as const;

function glyphAdvance(character: string, metrics: DisplayFontMetrics): number {
  if (metrics.startsWith('mono')) return 0.6;
  const advances = metrics === 'sans-medium'
    ? sansMediumAdvances
    : metrics === 'sans-semibold'
      ? sansSemiboldAdvances
      : sansRegularAdvances;
  if (character === '…') return advances[95]!;
  const code = character.codePointAt(0) ?? 63;
  const slot = code >= 32 && code <= 126 ? code - 32 : 63 - 32;
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
