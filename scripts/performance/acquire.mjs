#!/usr/bin/env node
/** Network is used only to acquire this immutable public pin, never by measured browser runs. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { dataRoot, pinPath, sha256 } from './common.mjs';
const identity = {
  schemaVersion: 1, slug: 'source-for__atlas', origin: 'https://sourcefor.dev',
  publication: { versionId: 'publication-fd362d5c-bc5e-4a21-92ca-ca93462dc940', artifactRevisionId: 'artifact-50929931-2e70-41c6-a798-bfcac45a4b90' },
  snapshotId: 'snapshot:source-for-atlas:9831775f5bbe', commitSha: '9831775f5bbed310b771900225501be42b6d159e',
  entityCount: 5507, relationCount: 13003,
};
const writePin = process.argv.includes('--write-pin');
const expected = writePin ? undefined : JSON.parse(await readFile(pinPath, 'utf8'));
await mkdir(dataRoot, { recursive: true });
const responses = [];
async function acquire(file, parameter, value, optional = false) {
  const params = new URLSearchParams({ version: identity.publication.versionId });
  if (parameter && value) params.set(parameter, value);
  const key = `${file}${parameter && value ? `?${new URLSearchParams({ [parameter]: value })}` : ''}`;
  const source = `${identity.origin}/scan/${identity.slug}/${file}?${params}`;
  const response = await fetch(source);
  if (!response.ok && !(optional && response.status === 404)) throw new Error(`Acquisition failed ${response.status}: ${key}`);
  const body = Buffer.from(await response.arrayBuffer());
  const json = body.length && response.ok ? JSON.parse(body.toString('utf8')) : undefined;
  const entry = { key, source, status: response.status, bytes: body.length, sha256: sha256(body), file: `${String(responses.length).padStart(3,'0')}-${file}` };
  if (expected) {
    const old = expected.responses.find(item => item.key === key);
    if (!old || old.sha256 !== entry.sha256 || old.bytes !== entry.bytes || old.status !== entry.status) throw new Error(`Immutable source changed: ${key}; refusing to update the pin.`);
  }
  await writeFile(resolve(dataRoot, entry.file), body);
  responses.push(entry);
  console.log(`Acquired ${key}: ${body.length} bytes ${entry.sha256.slice(0,12)}`);
  return json;
}
const packet = await acquire('neighborhood.json');
if (packet.snapshot.id !== identity.snapshotId || packet.snapshot.commitSha !== identity.commitSha
  || packet.snapshot.entities.length !== identity.entityCount || packet.snapshot.relations.length !== identity.relationCount
  || packet.publication?.versionId !== identity.publication.versionId || packet.publication?.artifactRevisionId !== identity.publication.artifactRevisionId) throw new Error('Published large identity does not match.');
const snapshot = await acquire('snapshot.json');
if(snapshot.id !== identity.snapshotId || snapshot.commitSha !== identity.commitSha) throw new Error('Full snapshot pin mismatch.');
await acquire('view.json');
const story = await acquire('story.json');
await acquire('stories.json');
await acquire('enrichment-report.json');
await acquire('enrichment-status.json');
await acquire('operator-explanations.json', undefined, undefined, true);
const focuses = new Set([packet.view.rootEntityId,
  ...packet.snapshot.entities.filter(entity => entity.kind === 'container').map(entity => entity.id),
  ...story.steps.flatMap(step => step.focusEntityIds),
]);
for (const id of [...focuses].sort()) {
  // External context peers are already complete leaves and never fetched by the app.
  const entity = packet.snapshot.entities.find(entity => entity.id === id);
  if (entity?.kind === 'externalSystem') continue;
  const scoped = await acquire('neighborhood.json','focus',id);
  if (scoped.snapshot.commitSha !== identity.commitSha || scoped.publication?.versionId !== identity.publication.versionId) throw new Error(`Focus pin mismatch: ${id}`);
}
for (const id of [...new Set(story.steps.flatMap(step => step.focusEntityIds))].sort()) {
  const entity = packet.snapshot.entities.find(entity => entity.id === id);
  if (entity?.kind === 'component' || entity?.kind === 'code') await acquire('excerpt.json','entity',id);
}
let attributionIndex = expected?.attributionIndex;
if (writePin) {
  const response = await fetch(`${identity.origin}/scan/index.json`);
  if (!response.ok) throw new Error('Attribution index acquisition failed');
  const sourceBody = Buffer.from(await response.arrayBuffer());
  const index = JSON.parse(sourceBody);
  const row = index.repos.find(row => row.slug === identity.slug);
  if (!row || row.commitSha !== identity.commitSha || row.versionId !== identity.publication.versionId) throw new Error('Index row no longer describes the chosen publication. Keep the existing reviewed index pin.');
  attributionIndex = { source: `${identity.origin}/scan/index.json`, sourceSha256: sha256(sourceBody), row };
}
const indexBody = Buffer.from(JSON.stringify({ schema:'okie.published-index/v1',schemaVersion:1,repos:[attributionIndex.row] })+'\n');
const indexEntry = { key:'index.json',source:attributionIndex.source,status:200,bytes:indexBody.length,sha256:sha256(indexBody),file:'023-index.json' };
if (expected && expected.responses.find(e=>e.key==='index.json')?.sha256 !== indexEntry.sha256) throw new Error('Attribution index pin mismatch.');
await writeFile(resolve(dataRoot,indexEntry.file),indexBody);responses.push(indexEntry);
const manifest = { ...identity, attributionIndex, sourceDescription: 'Immutable public API responses, byte-verified; no live scan or model.', responses };
if (writePin) await writeFile(pinPath, `${JSON.stringify(manifest,null,2)}\n`);
else if (responses.length !== expected.responses.length) throw new Error('Captured response set changed.');
console.log(`Verified ${responses.length} pinned responses. Bodies remain gitignored.`);
