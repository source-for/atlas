import type { ArchitectureExtraction, ArchitectureExtractionEntity, ArchitectureExtractionEvidence, ArchitectureExtractionRelation } from '@okie/architecture';
import { ARCHITECTURE_EXTRACTION_LIMITS, validateArchitectureExtraction, compareText } from '@okie/architecture';
import { createHash } from 'node:crypto';
import { typedId } from './ids.js';

export interface ComponentMembershipDocument {
  version: 1;
  containers: Array<{
    containerId: string;
    components: Array<{ id: string; name: string; responsibility?: string; tags?: string[]; paths: string[] }>;
  }>;
}

export type ComponentMapProvenance = { kind: 'external' | 'committed'; path: string; sha256: string };
export type ComponentMapReport = {
  accepted: boolean;
  provenance?: ComponentMapProvenance;
  mappedComponents: number;
  mappedPaths: number;
  reasons: string[];
};

export type ComponentMapInput = { document: unknown; provenance?: ComponentMapProvenance };
export type ComponentMapOutcome = { extraction: ArchitectureExtraction; report: ComponentMapReport };

const stableId = /^component:[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const key = (evidence: ArchitectureExtractionEvidence): string => JSON.stringify([evidence.source.path, evidence.source.symbol ?? '', evidence.source.startLine ?? null, evidence.source.endLine ?? null, evidence.reason ?? '']);
const local = (id: string) => id.slice(id.indexOf(':') + 1);

/** Applies an explicit architectural interpretation over observed file/code facts. */
export function applyComponentMembership(base: ArchitectureExtraction, input: ComponentMapInput): ComponentMapOutcome {
  const reasons: string[] = [];
  const raw = input.document;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) reasons.push('component map must be a JSON object');
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Partial<ComponentMembershipDocument>;
  if (doc.version !== 1) reasons.push('component map version must be 1');
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw).some(field => field !== 'version' && field !== 'containers')) reasons.push('component map contains an unsupported field');
  if (!Array.isArray(doc.containers) || doc.containers.length === 0) reasons.push('component map containers must be a non-empty array');
  const byId = new Map(base.entities.map(entity => [entity.id, entity]));
  const fileComponentByPath = new Map<string, ArchitectureExtractionEntity>();
  for (const entity of base.entities) {
    if (entity.kind === 'component' && entity.sourceRefs.length === 1 && entity.sourceRefs[0]?.path) fileComponentByPath.set(entity.sourceRefs[0].path, entity);
  }
  const mappedFileToComponent = new Map<string, string>();
  const additions: ArchitectureExtractionEntity[] = [];
  const usedIds = new Set(base.entities.map(entity => entity.id));
  const seenContainers = new Set<string>();
  for (const group of Array.isArray(doc.containers) ? doc.containers : []) {
    if (!group || typeof group !== 'object' || !text(group.containerId) || !Array.isArray(group.components) || group.components.length === 0) {
      reasons.push('each component map container needs containerId and non-empty components'); continue;
    }
    if (Object.keys(group).some(field => field !== 'containerId' && field !== 'components')) reasons.push(`container ${group.containerId} contains an unsupported field`);
    if (seenContainers.has(group.containerId)) reasons.push(`duplicate container ${group.containerId}`);
    seenContainers.add(group.containerId);
    const container = byId.get(group.containerId);
    if (!container || container.kind !== 'container') { reasons.push(`unknown container ${group.containerId}`); continue; }
    for (const component of group.components) {
      if (!component || typeof component !== 'object' || !text(component.id) || !stableId.test(component.id) || !text(component.name) || !Array.isArray(component.paths) || component.paths.length === 0) {
        reasons.push(`component in ${group.containerId} needs typed id, name, and non-empty paths`); continue;
      }
      if (Object.keys(component).some(field => !['id', 'name', 'responsibility', 'tags', 'paths'].includes(field))) reasons.push(`component ${component.id} contains an unsupported field`);
      if (component.responsibility !== undefined && !text(component.responsibility)) reasons.push(`component ${component.id} responsibility must be a non-blank string`);
      if (component.tags !== undefined && (!Array.isArray(component.tags) || component.tags.some(tag => !text(tag) || tag.trim().startsWith('okie:')))) { reasons.push(`component ${component.id} tags must be non-blank and must not use the reserved okie: namespace`); continue; }
      if (component.paths.some(path => !text(path))) { reasons.push(`component ${component.id} paths must be non-blank strings`); continue; }
      if (usedIds.has(component.id)) reasons.push(`component id collides with observed entity ${component.id}`);
      usedIds.add(component.id);
      if (component.paths.length > ARCHITECTURE_EXTRACTION_LIMITS.maxSourceRefs) reasons.push(`component ${component.id} has ${component.paths.length} paths; maximum is ${ARCHITECTURE_EXTRACTION_LIMITS.maxSourceRefs}`);
      const paths = [...component.paths].sort();
      if (new Set(paths).size !== paths.length) reasons.push(`component ${component.id} repeats a path`);
      for (const path of paths) {
        const fileComponent = fileComponentByPath.get(path);
        if (!fileComponent || fileComponent.parentId !== group.containerId) reasons.push(`component ${component.id} path is not an in-container source file: ${path}`);
        else if (!base.entities.some(entity => entity.kind === 'code' && entity.parentId === fileComponent.id)) reasons.push(`component ${component.id} path has no retained code ownership: ${path}`);
        else if (mappedFileToComponent.has(fileComponent.id)) reasons.push(`source file ${path} belongs to both ${mappedFileToComponent.get(fileComponent.id)} and ${component.id}`);
        else mappedFileToComponent.set(fileComponent.id, component.id);
      }
      additions.push({ id: component.id, kind: 'component', parentId: group.containerId, name: component.name,
        ...(text(component.responsibility) ? { responsibility: component.responsibility } : {}),
        tags: [...new Set(['okie:component-mapping', ...(component.tags ?? [])])].sort(),
        sourceRefs: paths.map(path => ({ path })), });
    }
  }
  if (reasons.length) return { extraction: base, report: { accepted: false, ...(input.provenance ? { provenance: input.provenance } : {}), mappedComponents: 0, mappedPaths: 0, reasons: [...new Set(reasons)].sort() } };

  const reparented = base.entities.map(entity => entity.kind === 'code' && entity.parentId && mappedFileToComponent.has(entity.parentId)
    ? { ...entity, parentId: mappedFileToComponent.get(entity.parentId)! } : entity);
  const removed = new Set(mappedFileToComponent.keys());
  const entities = [...reparented.filter(entity => !removed.has(entity.id)), ...additions].sort((a, b) => compareText(a.id, b.id));
  const grouped = new Map<string, ArchitectureExtractionRelation[]>();
  const untouched: ArchitectureExtractionRelation[] = [];
  for (const relation of base.relations) {
    const from = mappedFileToComponent.get(relation.from) ?? relation.from;
    const to = mappedFileToComponent.get(relation.to) ?? relation.to;
    if (from === relation.from && to === relation.to) { untouched.push(relation); continue; }
    if (from === to && relation.kind !== 'calls') continue;
    const groupKey = JSON.stringify([from, to, relation.kind, relation.label ?? '', relation.technology ?? '', relation.optional ?? false]);
    const bucket = grouped.get(groupKey) ?? []; bucket.push({ ...relation, from, to }); grouped.set(groupKey, bucket);
  }
  const mappedRelations: ArchitectureExtractionRelation[] = [];
  for (const [groupKey, bucket] of grouped) {
    const first = bucket[0]!;
    const evidence = [...new Map(bucket.flatMap(row => row.evidence).map(item => [key(item), item])).values()].sort((a, b) => compareText(key(a), key(b)));
    if (evidence.length > ARCHITECTURE_EXTRACTION_LIMITS.maxEvidenceItems) reasons.push(`aggregate ${first.from} -> ${first.to} has ${evidence.length} evidence items; maximum is ${ARCHITECTURE_EXTRACTION_LIMITS.maxEvidenceItems}`);
    const identity = createHash('sha256').update(groupKey).digest('hex').slice(0, 16);
    mappedRelations.push({ ...first, id: typedId('relation', local(first.from), local(first.to), first.kind, identity), evidence });
  }
  const relationIds = new Set(untouched.map(relation => relation.id));
  for (const relation of mappedRelations) if (relationIds.has(relation.id)) reasons.push(`mapped relation id collides with observed relation ${relation.id}`); else relationIds.add(relation.id);
  const extraction = { schemaVersion: 1 as const, entities, relations: [...untouched, ...mappedRelations].sort((a, b) => compareText(a.id, b.id)) };
  reasons.push(...validateArchitectureExtraction(extraction).map(issue => `gate: ${issue.path} ${issue.message}`));
  if (reasons.length) return { extraction: base, report: { accepted: false, ...(input.provenance ? { provenance: input.provenance } : {}), mappedComponents: 0, mappedPaths: 0, reasons: [...new Set(reasons)].sort() } };
  return { extraction, report: { accepted: true, ...(input.provenance ? { provenance: input.provenance } : {}), mappedComponents: additions.length, mappedPaths: mappedFileToComponent.size, reasons: [] } };
}
