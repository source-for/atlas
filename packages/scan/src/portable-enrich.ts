import {
  adaptArchitectureExtraction,
  serializePortableAtlas,
  type ArchitectureExtraction,
  type ArchitectureSnapshot,
  type ArchitectureView,
  type PortableAtlas,
  compareText,
} from "@okie/architecture";
import { mergeEnrichment, type EnrichmentReport } from "./enrich.js";
import { buildOverviewStory } from "./overview-story.js";
import { buildUserFlowStories } from "./flow-story.js";

/** Convert the portable snapshot back to the gate's semantic input shape. */
function extractionFromPortable(bundle: PortableAtlas): ArchitectureExtraction {
  return {
    schemaVersion: 1,
    entities: bundle.snapshot.entities.filter(entity => entity.kind !== "boundary").map(entity => ({
      id: entity.id,
      kind: entity.kind as ArchitectureExtraction["entities"][number]["kind"],
      ...(entity.parentId ? { parentId: entity.parentId } : {}),
      name: entity.name,
      ...(entity.responsibility ? { responsibility: entity.responsibility } : {}),
      ...(entity.technology ? { technology: entity.technology } : {}),
      ...(entity.tags ? { tags: entity.tags } : {}),
      ...(entity.exposure ? { exposure: entity.exposure.map(exposure => ({
        kind: exposure.kind,
        evidence: { ...(exposure.evidence.reason ? { reason: exposure.evidence.reason } : {}), source: withoutRevision(exposure.evidence.source) },
      })) } : {}),
      ...(entity.untestedBehaviours ? { untestedBehaviours: entity.untestedBehaviours } : {}),
      sourceRefs: entity.sourceRefs.map(withoutRevision),
      ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
    })),
    relations: bundle.snapshot.relations.filter(relation => relation.kind !== "duplicates").map(relation => ({
      id: relation.id,
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      ...(relation.label ? { label: relation.label } : {}),
      ...(relation.technology ? { technology: relation.technology } : {}),
      ...(relation.optional !== undefined ? { optional: relation.optional } : {}),
      evidence: relation.evidence.map(evidence => ({ ...(evidence.reason ? { reason: evidence.reason } : {}), source: withoutRevision(evidence.source) })),
      ...(relation.confidence !== undefined ? { confidence: relation.confidence } : {}),
    })),
  };
}

function withoutRevision(ref: { path: string; symbol?: string; startLine?: number; endLine?: number }): { path: string; symbol?: string; startLine?: number; endLine?: number } {
  return {
    path: ref.path,
    ...(ref.symbol ? { symbol: ref.symbol } : {}),
    ...(ref.startLine !== undefined ? { startLine: ref.startLine } : {}),
    ...(ref.endLine !== undefined ? { endLine: ref.endLine } : {}),
  };
}

function sameIds(left: readonly { id: string }[], right: readonly { id: string }[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.map(item => item.id).sort();
  const b = right.map(item => item.id).sort();
  return a.every((id, index) => id === b[index]);
}

function relationIdentityKey(relation: {
  from: string; to: string; kind: string;
  evidence: readonly { source: { path: string; symbol?: string; startLine?: number; endLine?: number }; reason?: string }[];
}): string {
  return JSON.stringify({
    from: relation.from, to: relation.to, kind: relation.kind,
    // The gate rebuild can normalize ids and presentation fields while an
    // actor-only/summary merge leaves the observed endpoint and evidence fact intact.
    // Those facts identify an original relation safe to restore verbatim.
    evidence: relation.evidence.map(evidence => ({
      ...(evidence.reason !== undefined ? { reason: evidence.reason } : {}),
      source: withoutRevision(evidence.source),
    })).sort((left, right) => compareText(JSON.stringify(left), JSON.stringify(right))),
  });
}

function refreshedSnapshot(bundle: PortableAtlas, extraction: ArchitectureExtraction): ArchitectureSnapshot {
  const previousEntities = new Map(bundle.snapshot.entities.map(entity => [entity.id, entity]));
  const previousRelations = new Map(bundle.snapshot.relations.map(relation => [relation.id, relation]));
  const adapted = adaptArchitectureExtraction(extraction, {
    snapshotId: bundle.snapshot.id,
    repositoryId: bundle.snapshot.repositoryId,
    commitSha: bundle.repository.commitSha,
    generatedAt: bundle.snapshot.generatedAt,
  });
  const refreshedById = new Map(adapted.entities.map(entity => {
    const previous = previousEntities.get(entity.id);
    return [entity.id, {
      ...entity,
      ...(previous?.lineageId ? { lineageId: previous.lineageId } : {}),
      ...(previous?.owners ? { owners: previous.owners } : {}),
      ...(previous?.cyclomaticComplexity !== undefined ? { cyclomaticComplexity: previous.cyclomaticComplexity } : {}),
      ...(previous?.coverageFileHitRate !== undefined ? { coverageFileHitRate: previous.coverageFileHitRate } : {}),
      ...(previous?.coverageUntestedRanges ? { coverageUntestedRanges: previous.coverageUntestedRanges } : {}),
      ...(previous?.sourceExcerpts ? { sourceExcerpts: previous.sourceExcerpts } : {}),
    }];
  }));
  const entities = [
    ...bundle.snapshot.entities.flatMap(entity => {
      const refreshed = refreshedById.get(entity.id);
      // `boundary` is a snapshot-only deterministic record: enrichment does not
      // model it and must never remove it from a valid portable graph.
      return refreshed ? [refreshed] : entity.kind === "boundary" ? [entity] : [];
    }),
    ...[...refreshedById.entries()].filter(([id]) => !previousEntities.has(id)).map(([, entity]) => entity),
  ];
  const preservedKeys = new Set(extraction.relations.map(relationIdentityKey));
  const originalRelations = bundle.snapshot.relations.filter(relation =>
    relation.kind === "duplicates" || preservedKeys.has(relationIdentityKey(relation)));
  const originalKeys = new Set(originalRelations.filter(relation => relation.kind !== "duplicates").map(relationIdentityKey));
  const refreshedRelations = adapted.relations.map(relation => ({
    ...relation,
    ...(previousRelations.get(relation.id)?.lineageId ? { lineageId: previousRelations.get(relation.id)!.lineageId } : {}),
  }));
  return {
    ...adapted,
    entities,
    relations: [
      ...originalRelations,
      ...refreshedRelations.filter(relation => !originalKeys.has(relationIdentityKey(relation))),
    ],
  };
}

function refreshedView(bundle: PortableAtlas, snapshot: ArchitectureSnapshot): ArchitectureView {
  if (sameIds(bundle.snapshot.entities, snapshot.entities) && sameIds(bundle.snapshot.relations, snapshot.relations)) return bundle.view;
  const existing = bundle.view.layout.nodes;
  const nodes: ArchitectureView["layout"]["nodes"] = {};
  for (const [index, entity] of [...snapshot.entities].sort((a, b) => compareText(a.id, b.id)).entries()) {
    nodes[entity.id] = existing[entity.id] ?? {
      x: 120 + (index % 8) * 330,
      y: 120 + Math.floor(index / 8) * 210,
      width: 280,
      height: 140,
    };
  }
  return {
    ...bundle.view,
    snapshotId: snapshot.id,
    entityIds: snapshot.entities.map(entity => entity.id),
    relationIds: snapshot.relations.map(relation => relation.id),
    layout: { nodes },
  };
}

export interface PortableEnrichmentOutcome {
  bundle: PortableAtlas;
  report: EnrichmentReport;
}

/**
 * Apply new gated enrichment docs to an existing portable artifact. This never
 * reads a checkout: evidence remains pinned to the bundled commit and all
 * scanner-derived overlay fields are copied from the validated input snapshot.
 */
export function enrichPortableAtlas(bundle: PortableAtlas, docs: ReadonlyMap<string, unknown>): PortableEnrichmentOutcome {
  // serialize validates commit, evidence, excerpts, and graph shape before any merge.
  serializePortableAtlas(bundle);
  const outcome = mergeEnrichment(extractionFromPortable(bundle), docs);
  if (!outcome.report.enrichedContainers.length && !outcome.report.systemScope?.accepted) return { bundle, report: outcome.report };
  const snapshot = refreshedSnapshot(bundle, outcome.extraction);
  const view = refreshedView(bundle, snapshot);
  const system = snapshot.entities.find(entity => entity.kind === "softwareSystem");
  if (!system) throw new Error("Portable scan has no softwareSystem root.");
  const repositorySlug = snapshot.repositoryId.startsWith("repo:") ? snapshot.repositoryId.slice("repo:".length) : snapshot.repositoryId;
  const story = buildOverviewStory(snapshot, view, system.id, repositorySlug, system.name);
  const stories = [story, ...buildUserFlowStories(snapshot, view, repositorySlug, system.name)];
  const next: PortableAtlas = { ...bundle, snapshot, view, story, stories };
  serializePortableAtlas(next);
  return { bundle: next, report: outcome.report };
}
