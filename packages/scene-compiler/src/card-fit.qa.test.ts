import assert from 'node:assert/strict';
import test from 'node:test';
import { buildC4ProjectionBundle, C4_BAND_FOCUS_ZOOM, c4ScanComponentCardFace, type ArchitectureEntity, type ArchitectureSnapshot } from '@okie/architecture';
import { compileC4Scene } from './compile-c4.js';
import { displayTextWidth } from './display-text.js';

const summary = 'Coordinates atlas loading and keeps navigation state consistent during scene updates.';
function packet(blank = false): ArchitectureSnapshot {
  const entity = (id: string, kind: ArchitectureEntity['kind'], parentId?: string, responsibility?: string): ArchitectureEntity => ({ id, kind, name: id.split(':')[1]!, sourceRefs: [], ...(parentId ? { parentId } : {}), ...(responsibility ? { responsibility } : {}) });
  return { schemaVersion: 1, id: 'snapshot:card-fit', repositoryId: 'repo:card-fit', commitSha: 'c', generatedAt: '2026-01-01T00:00:00Z', relations: [], entities: [
    entity('system:atlas', 'softwareSystem', undefined, summary),
    entity('container:web', 'container', 'system:atlas', summary),
    ...Array.from({ length: 16 }, (_, i) => entity(`component:file${i}`, 'component', 'container:web', !blank && i === 0 ? summary : undefined)),
    ...Array.from({ length: 24 }, (_, i) => entity(`code:symbol${String(i).padStart(2, '0')}`, 'code', 'component:file9')),
  ] };
}
// Authored (golden-style) compile by default; `scan` adds the scan landscape target.
function compile(snapshot: ArchitectureSnapshot, focus = 'container:web', maxBand: 'component' | 'code' = 'component', scan = false) {
  const aspect = scan ? { targetAspect: 16 / 9 } : {};
  const bundle = buildC4ProjectionBundle(snapshot, { rootEntityId: 'system:atlas', focusEntityId: focus, maxBand, ...aspect });
  return compileC4Scene(snapshot, bundle, aspect);
}
function representation(compiled: ReturnType<typeof compile>, id: string, band: string) {
  const visual = compiled.projections.index.visualNodeIdsByEntityId[id]![0]!;
  const result = compiled.scene.objects.find(object => object.id === visual)!.representations.find(value => value.id === `${visual}:${band}`);
  assert.ok(result, `${id}:${band} must be materialized`);
  return result;
}
function texts(rep: ReturnType<typeof representation>) { return rep.primitives.filter(value => value.kind === 'text'); }

test('card summaries compile into capped complete lines contained inside their painted faces', () => {
  assert.ok(summary.length <= 140);
  const compiled = compile(packet(), 'container:web', 'component', true);
  for (const [id, band, cap] of [['system:atlas', 'context', 3], ['container:web', 'container', 3], ['component:file0', 'component', 2]] as const) {
    const rep = representation(compiled, id, band);
    const lines = texts(rep).slice(2);
    assert.ok(lines.length > 1 && lines.length <= cap, `${id} needs multiple lines within ${cap}`);
    assert.equal(lines.map(line => line.content).join(' '), summary, `${id} must retain this short summary without ellipsis`);
    const bounds = rep.bounds!;
    for (const line of lines) {
      assert.ok(displayTextWidth(line.content, line.fontSize, 'sans-regular') <= line.maxWidth! + 1e-6);
      assert.ok(line.position.x > bounds.x && line.position.x + line.maxWidth! < bounds.x + bounds.width);
      assert.ok(line.position.y - line.fontSize > bounds.y && line.position.y < bounds.y + bounds.height);
    }
  }
});

test('typical near-140 character summaries end cleanly within each compiled line cap', () => {
  const long = 'Coordinates atlas loading, scene updates and navigation history while retaining selected entities and consistent camera state for users.';
  assert.ok(long.length >= 120 && long.length <= 140);
  const snapshot = packet();
  for (const entity of snapshot.entities) if (entity.responsibility) entity.responsibility = long;
  const compiled = compile(snapshot, 'container:web', 'component', true);
  for (const [id, band, cap] of [['system:atlas', 'context', 3], ['container:web', 'container', 3], ['component:file0', 'component', 2]] as const) {
    const lines = texts(representation(compiled, id, band)).slice(2);
    assert.ok(lines.length > 1 && lines.length <= cap);
    const painted = lines.map(line => line.content).join(' ');
    const prefix = painted.replace(/…$/, '');
    assert.ok(long.startsWith(prefix), `${id} summary must retain its ordered prose`);
    if (painted.endsWith('…')) assert.ok(long[prefix.length] === ' ', `${id} must truncate at a complete word`);
    else assert.equal(painted, long);
    for (const line of lines) assert.ok(displayTextWidth(line.content, line.fontSize, 'sans-regular') <= line.maxWidth! + 1e-6);
  }
});

test('mixed-summary peer rows use equal painted heights while all-blank peers compact', () => {
  const mixed = compile(packet());
  const faces = Array.from({ length: 16 }, (_, i) => representation(mixed, `component:file${i}`, 'component').bounds!);
  const sameRow = faces.filter(face => Math.abs(face.y - faces[0]!.y) < 1e-6);
  assert.ok(sameRow.length > 1, `fixture must exercise a mixed peer row: ${JSON.stringify(faces)}`);
  for (const face of sameRow) assert.equal(face.height, faces[0]!.height);
  assert.equal(texts(representation(mixed, 'component:file1', 'component')).length, 2);
  const blankCompiled = compile(packet(true));
  const blank = representation(blankCompiled, 'component:file0', 'component').bounds!;
  assert.ok(blank.height < faces[0]!.height, 'blank rows must not reserve description height');
  // Scan tiles are proportional child-count reservations (CLA-95/119/121): never compacted.
  const scanBlank = representation(compile(packet(true), 'container:web', 'component', true), 'component:file0', 'component').bounds!;
  assert.equal(scanBlank.height, c4ScanComponentCardFace(16 / 9).height);
});

test('scan L4 retains symbol containment and readable fonts beneath a separated owner heading', () => {
  const compiled = compile(packet(), 'component:file9', 'code', true);
  const owner = representation(compiled, 'component:file9', 'code');
  const heading = texts(owner);
  assert.ok(heading[1]!.position.y - heading[1]!.fontSize > heading[0]!.position.y, 'owner title must start below kicker baseline');
  const bounds = owner.bounds!;
  for (let i = 0; i < 24; i++) {
    const child = representation(compiled, `code:symbol${String(i).padStart(2, '0')}`, 'code');
    const box = child.bounds!;
    assert.ok(box.x >= bounds.x && box.y >= heading[1]!.position.y);
    assert.ok(box.x + box.width <= bounds.x + bounds.width + 1e-6 && box.y + box.height <= bounds.y + bounds.height + 1e-6);
    const title = texts(child)[1]!;
    assert.ok(title.fontSize * C4_BAND_FOCUS_ZOOM.code >= 10.9, 'symbol title must reach ~11 CSS pixels at code focus');
  }
});

test('scan geometry never compacts: summaries change no rect, and L3 siblings stay off the expanded owner', () => {
  const scanPacket = (blank: boolean): ArchitectureSnapshot => {
    const base = packet(blank);
    const extra = (id: string, kind: ArchitectureEntity['kind'], parentId: string): ArchitectureEntity => ({ id, kind, name: id.split(':')[1]!, sourceRefs: [], parentId, ...(blank ? {} : { responsibility: summary }) });
    return { ...base, entities: [...base.entities, extra('container:api', 'container', 'system:atlas'), extra('dataStore:db', 'dataStore', 'system:atlas'),
      extra('component:route', 'component', 'container:api')] };
  };
  for (const [focus, maxBand] of [['container:web', 'component'], ['component:file1', 'code'], ['component:file9', 'code']] as const) {
    const withSummaries = compile(scanPacket(false), focus, maxBand, true).projections;
    const blank = compile(scanPacket(true), focus, maxBand, true).projections;
    assert.deepEqual(withSummaries.index.boundsByEntityIdAndBand, blank.index.boundsByEntityIdAndBand, `${focus} scan rects must not depend on summaries`);
  }
  const scoped = compile(scanPacket(false), 'container:web', 'component', true).projections;
  const owner = scoped.index.boundsByEntityIdAndBand['container:web']!.component!;
  for (const sibling of ['container:api', 'dataStore:db']) {
    const box = scoped.index.boundsByEntityIdAndBand[sibling]?.component;
    if (!box) continue;
    const overlaps = box.x < owner.x + owner.width && owner.x < box.x + box.width && box.y < owner.y + owner.height && owner.y < box.y + box.height;
    assert.equal(overlaps, false, `${sibling} must stay off the expanded L3 owner shell`);
  }
});
