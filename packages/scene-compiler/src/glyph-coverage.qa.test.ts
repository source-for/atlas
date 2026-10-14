import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildC4ProjectionBundle } from '@okie/architecture';
import { compileC4Scene, compileC4Timeline } from './compile-c4.js';
import { displayTextWidth } from './display-text.js';
import {
  fallbackGlyphSlot,
  glyphCodePoints,
  monoGlyphAdvance,
  sansMediumAdvances,
  sansRegularAdvances,
  sansSemiboldAdvances,
  spaceAliasCodePoints,
} from './glyph-metrics.generated.js';
import { goldenSnapshot, goldenStory } from './golden-fixture.js';

const repositoryPath = (path: string): string => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const drawable = new Set<number>([...glyphCodePoints, ...spaceAliasCodePoints]);

/** Every text primitive's content anywhere in a scene, patch or timeline document. */
function textContents(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) textContents(item, found);
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.kind === 'text' && typeof record.content === 'string') found.push(record.content);
    for (const item of Object.values(record)) textContents(item, found);
  }
  return found;
}

function uncovered(contents: readonly string[]): string[] {
  return contents.flatMap(content => [...content]
    .filter(character => !drawable.has(character.codePointAt(0)!))
    .map(character => `U+${character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} in ${JSON.stringify(content)}`));
}

function compiledGolden() {
  const projections = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'view-family:okie-golden:system-root',
  });
  const compiled = compileC4Scene(goldenSnapshot, projections);
  return { scene: compiled.scene, timeline: compileC4Timeline(goldenSnapshot, goldenStory, compiled) };
}

test('every character the compiler emits for the golden atlas has a glyph in the renderer atlas', async () => {
  const compiled = compiledGolden();
  const contents = textContents(compiled);
  assert.ok(contents.some(content => content.includes('·') && content.includes('–')), 'golden code-card kickers must be covered by this check');
  assert.deepEqual(uncovered(contents), []);
  const checkedIn = await Promise.all(['fixtures/renderer/demo-scene.json', 'fixtures/renderer/demo-timeline.json']
    .map(async path => JSON.parse(await readFile(repositoryPath(path), 'utf8')) as unknown));
  assert.deepEqual(textContents(checkedIn), contents, 'checked-in renderer fixtures carry the text compiled here');
});

test('every character of the generated stress scene has a glyph in the renderer atlas', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'okie-stress-'));
  try {
    const output = join(directory, 'stress.json');
    execFileSync(process.execPath, [repositoryPath('scripts/generate-stress.mjs'), '--output', output], { stdio: 'ignore' });
    const contents = textContents(JSON.parse(await readFile(output, 'utf8')));
    assert.equal(contents.length, 5000);
    assert.deepEqual(uncovered(contents), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('added glyphs measure at their own atlas advance, not as a question mark', () => {
  const slot = (character: string) => glyphCodePoints.indexOf(character.codePointAt(0) as typeof glyphCodePoints[number]);
  for (const [metrics, advances] of [
    ['sans-regular', sansRegularAdvances],
    ['sans-medium', sansMediumAdvances],
    ['sans-semibold', sansSemiboldAdvances],
  ] as const) {
    assert.equal(advances.length, glyphCodePoints.length);
    for (const character of ['·', '–', '—', '→', '“', 'é', '€']) {
      assert.ok(slot(character) >= 96, character);
      assert.equal(displayTextWidth(character, 1, metrics), advances[slot(character)], `${metrics} ${character}`);
    }
    assert.notEqual(displayTextWidth('·', 1, metrics), displayTextWidth('?', 1, metrics));
  }
  assert.equal(displayTextWidth('FN · 34–39', 10, 'sans-semibold'),
    [...'FN · 34–39'].reduce((width, character) => width + sansSemiboldAdvances[slot(character)]! * 10, 0));
});

test('a character outside the glyph set measures as the replacement glyph in every face', () => {
  assert.equal(glyphCodePoints[fallbackGlyphSlot], 0xFFFD);
  for (const character of ['漢', '🙂', '́', '​', 'Ω', '¼']) {
    assert.equal(drawable.has(character.codePointAt(0)!), false, character);
    assert.equal(displayTextWidth(character, 1, 'sans-regular'), sansRegularAdvances[fallbackGlyphSlot]);
    assert.equal(displayTextWidth(character, 1, 'sans-medium'), sansMediumAdvances[fallbackGlyphSlot]);
    assert.equal(displayTextWidth(character, 1, 'sans-semibold'), sansSemiboldAdvances[fallbackGlyphSlot]);
    assert.equal(displayTextWidth(character, 1, 'mono-regular'), monoGlyphAdvance);
    assert.notEqual(displayTextWidth(character, 1, 'sans-regular'), displayTextWidth('?', 1, 'sans-regular'));
  }
});

test('no-break space and whitespace controls measure as a space', () => {
  for (const codePoint of spaceAliasCodePoints) {
    assert.equal(displayTextWidth(String.fromCodePoint(codePoint), 1, 'sans-medium'), displayTextWidth(' ', 1, 'sans-medium'));
  }
});
