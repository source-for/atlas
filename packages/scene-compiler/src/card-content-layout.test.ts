import assert from 'node:assert/strict';
import test from 'node:test';
import { cardContentLayout, wrapDisplayText } from './card-content-layout.js';
import { displayTextWidth } from './display-text.js';
import { c4CardContentLayout } from './compile-c4.js';

test('wraps a typical summary without loss and only ellipsizes the final capped line', () => {
  const summary = 'Stores qualified identities and relationships with captured source evidence so the architecture remains traceable.';
  const lines = wrapDisplayText(summary, 220, 11, 3);
  assert.equal(lines.join(' '), summary);
  assert.ok(lines.length > 1);
  for (const line of lines) assert.ok(displayTextWidth(line, 11, 'sans-regular') <= 220);
  const capped = wrapDisplayText(summary, 100, 11, 2);
  assert.equal(capped.length, 2);
  assert.ok(!capped[0]!.includes('…'));
  assert.ok(capped[1]!.endsWith('…'));
});

test('splits long tokens deterministically and omits blank support copy', () => {
  const text = 'aReallyLongIdentifierWithNoNaturalWordBoundaries';
  const lines = wrapDisplayText(text, 80, 11, 8, 'mono-regular');
  assert.equal(lines.join(''), text);
  assert.deepEqual(wrapDisplayText(text, 80, 11, 8, 'mono-regular'), lines);
  assert.deepEqual(wrapDisplayText('  ', 80, 11, 3), []);
});

test('content height ends at one padding inset, with separated header and title', () => {
  const input = { width: 250, inset: 16, top: 12, bottom: 10, gap: 4, kicker: 'COMPONENT', title: 'History controller', descriptionLines: 2, kickerSize: 10, titleSize: 16, titleFloor: 12, descriptionSize: 11 };
  const empty = cardContentLayout(input);
  const full = cardContentLayout({ ...input, description: 'Coordinates browser history and asynchronous neighborhood restoration.' });
  assert.equal(empty.lines.length, 2);
  assert.ok(full.height > empty.height);
  assert.equal(full.height - full.lines.at(-1)!.baseline, 10);
  assert.ok(full.lines[1]!.baseline - full.lines[0]!.baseline >= full.lines[1]!.size);
});

test('world/CSS layout scales identically, including wrap lines and baselines', () => {
  const world = c4CardContentLayout('component', false, 85, 'COMPONENT', 'History controller', 'Coordinates browser history and asynchronous neighborhood restoration.');
  const scaled = cardContentLayout({ width: 85 * 5.27, inset:18 *1.1, top:12 *1.1, bottom:10 *1.1, gap:4 *1.1, kicker:'COMPONENT', title:'History controller', description:'Coordinates browser history and asynchronous neighborhood restoration.', descriptionLines:2, kickerSize:10,titleSize:16.5,titleFloor:12,descriptionSize:11 });
  assert.deepEqual(world.lines.map(line => line.content), scaled.lines.map(line => line.content));
  world.lines.forEach((line,index) => assert.ok(Math.abs(line.baseline * 5.27 - scaled.lines[index]!.baseline) < 1e-8));
});

test('preserves explicit paragraph breaks and whole graphemes, with honest no-fit for tiny widths', () => {
  assert.deepEqual(wrapDisplayText('First paragraph\nSecond paragraph', 300, 11, 3), ['First paragraph', 'Second paragraph']);
  const combined = 'e\u0301e\u0301e\u0301';
  const lines = wrapDisplayText(combined, 15, 11, 8);
  assert.equal(lines.join(''), combined);
  assert.ok(lines.every(line => !line.startsWith('\u0301')));
  assert.deepEqual(wrapDisplayText('Wider', .1, 11, 3), []);
});

test('never paints a lone ellipsis line when the next word cannot fit', () => {
  const lines = wrapDisplayText('export function selectScopedArchitectureViewFromNormalizedSnapshotWithEvidence(view)', 120, 11, 2, 'mono-regular');
  assert.ok(lines.length >= 1 && lines.length <= 2);
  assert.ok(lines.every(line => line !== '…'), JSON.stringify(lines));
  for (const line of lines) assert.ok(displayTextWidth(line, 11, 'mono-regular') <= 120 + 1e-9);
});
