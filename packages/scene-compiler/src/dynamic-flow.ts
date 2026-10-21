import {
  C4_BANDS,
  validateStory,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type C4Band,
  type C4ProjectionBundle,
  type EntityKind,
  type Evidence,
  type RelationKind,
  type SourceRef,
  compareText,
} from '@okie/architecture';

export const DYNAMIC_FLOW_ARTIFACT_VERSION = 1 as const;

export type DynamicFlowParticipant = {
  id: string;
  mermaidId: string;
  name: string;
  kind: EntityKind;
  parentId?: string;
  lineageId?: string;
  technology: string[];
  sourceRefs: SourceRef[];
};

export type DynamicFlowProjectionLink = {
  band: C4Band;
  id: string;
};

export type DynamicFlowStep = {
  id: string;
  index: number;
  narration: string;
  reveal: C4Band;
  focusEntityIds: string[];
  focusVisualNodeIds: string[];
  projection: DynamicFlowProjectionLink;
  interactionIds: string[];
  sourceRefs: SourceRef[];
};

export type DynamicFlowInteraction = {
  id: string;
  sequence: number;
  stepId: string;
  semanticRelationId: string;
  fromEntityId: string;
  toEntityId: string;
  kind: RelationKind;
  label: string;
  technology?: string;
  optional: boolean;
  evidence: Evidence[];
  projection: DynamicFlowProjectionLink & { visualEdgeIds: string[] };
};

export type DynamicFlowArtifact = {
  schemaVersion: typeof DYNAMIC_FLOW_ARTIFACT_VERSION;
  id: string;
  diagramType: 'dynamic';
  style: 'collaboration';
  snapshotId: string;
  viewId: string;
  storyId: string;
  title: string;
  participants: DynamicFlowParticipant[];
  steps: DynamicFlowStep[];
  interactions: DynamicFlowInteraction[];
};

export type DynamicFlowMermaidOptions = {
  direction?: 'LR' | 'TB';
};

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sourceRefKey(source: SourceRef): string {
  return [
    source.path,
    source.symbol ?? '',
    source.startLine ?? '',
    source.endLine ?? '',
    source.commitSha,
  ].join('\u0000');
}

function copiedSourceRefs(sourceRefs: readonly SourceRef[] | undefined): SourceRef[] {
  return [...(sourceRefs ?? [])]
    .sort((left, right) => compareText(sourceRefKey(left), sourceRefKey(right)))
    .map(source => ({ ...source }));
}

function evidenceKey(evidence: Evidence): string {
  return `${sourceRefKey(evidence.source)}\u0000${evidence.reason ?? ''}`;
}

function copiedEvidence(evidence: readonly Evidence[]): Evidence[] {
  return [...evidence]
    .sort((left, right) => compareText(evidenceKey(left), evidenceKey(right)))
    .map(item => ({
      source: { ...item.source },
      ...(item.reason !== undefined ? { reason: item.reason } : {}),
    }));
}

function inferredBand(snapshot: ArchitectureSnapshot, focusEntityIds: readonly string[]): C4Band {
  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const ranks = focusEntityIds.map(id => {
    const kind = entityById.get(id)?.kind;
    if (kind === 'code') return 3;
    if (kind === 'component') return 2;
    if (kind === 'container' || kind === 'dataStore' || kind === 'queue') return 1;
    return 0;
  });
  return C4_BANDS[Math.max(0, ...ranks)]!;
}

function relationLabel(relation: ArchitectureRelation): string {
  const explicit = relation.label?.trim();
  if (explicit) return explicit;
  return relation.kind.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase();
}

/** Mermaid identifiers contain only ASCII letters, digits, and underscores. */
export function mermaidSafeIdentifier(semanticId: string): string {
  const encoded = [...semanticId].map(character => character.codePointAt(0)!.toString(16)).join('_');
  return `n_${encoded || '0'}`;
}

/** Escapes all Mermaid flowchart delimiters and collapses line-breaking input. */
export function escapeMermaidLabel(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  const entities: Readonly<Record<string, string>> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
    '|': '&#124;',
    '`': '&#96;',
    '[': '&#91;',
    ']': '&#93;',
    '{': '&#123;',
    '}': '&#125;',
    '(': '&#40;',
    ')': '&#41;',
    '\\': '&#92;',
  };
  return [...normalized].map(character => entities[character] ?? character).join('');
}

function participant(entity: ArchitectureEntity): DynamicFlowParticipant {
  return {
    id: entity.id,
    mermaidId: mermaidSafeIdentifier(entity.id),
    name: entity.name,
    kind: entity.kind,
    ...(entity.parentId ? { parentId: entity.parentId } : {}),
    ...(entity.lineageId ? { lineageId: entity.lineageId } : {}),
    technology: uniqueSorted(entity.technology ?? []),
    sourceRefs: copiedSourceRefs(entity.sourceRefs),
  };
}

/**
 * Compiles an evidence-backed collaboration flow from authored story order.
 * Relations inside one step are a semantic set in schema v1, so they are
 * sorted by ID; step order remains authored and defines global interaction
 * order. Projection links let native renderers reuse the matching C4 band.
 */
export function compileC4DynamicFlowArtifact(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  story: ArchitectureStory,
  projections: C4ProjectionBundle,
): DynamicFlowArtifact {
  const issues = validateStory(snapshot, view, story);
  if (issues.length > 0) {
    throw new Error(`Cannot compile invalid dynamic flow: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`);
  }
  if (projections.family.snapshotId !== snapshot.id) {
    throw new Error('Cannot compile dynamic flow from projections for another snapshot');
  }

  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const relationById = new Map(snapshot.relations.map(relation => [relation.id, relation]));
  const participantIds = new Set<string>();
  const interactions: DynamicFlowInteraction[] = [];
  const steps: DynamicFlowStep[] = [];
  let sequence = 0;

  for (const [stepIndex, storyStep] of story.steps.entries()) {
    const reveal = storyStep.reveal ?? inferredBand(snapshot, storyStep.focusEntityIds);
    const projectionId = projections.family.projectionIds[reveal];
    const projection = projections.projectionById[projectionId];
    if (!projection) throw new Error(`Missing C4 ${reveal} projection for story step ${storyStep.id}`);

    const focusEntityIds = uniqueSorted(storyStep.focusEntityIds);
    for (const entityId of focusEntityIds) {
      if (!entityById.has(entityId)) throw new Error(`Story step ${storyStep.id} references unknown entity ${entityId}`);
      participantIds.add(entityId);
    }
    const focusVisualNodeIds = uniqueSorted(focusEntityIds.flatMap(entityId =>
      projections.index.visualNodeIdsByEntityId[entityId] ?? [],
    ).filter(visualId => projection.visualNodeIds.includes(visualId)));

    const stepInteractions: DynamicFlowInteraction[] = [];
    for (const relationId of uniqueSorted(storyStep.traceRelationIds ?? [])) {
      const relation = relationById.get(relationId);
      if (!relation) throw new Error(`Story step ${storyStep.id} references unknown relation ${relationId}`);
      if (!entityById.has(relation.from) || !entityById.has(relation.to)) {
        throw new Error(`Relation ${relation.id} has an unknown endpoint`);
      }
      participantIds.add(relation.from);
      participantIds.add(relation.to);
      sequence += 1;
      const visualEdgeIds = uniqueSorted(projections.index.visualEdgeIdsByRelationId[relation.id] ?? [])
        .filter(visualId => projection.visualEdgeIds.includes(visualId));
      stepInteractions.push({
        id: `interaction:${story.id}:${stepIndex + 1}:${relation.id}`,
        sequence,
        stepId: storyStep.id,
        semanticRelationId: relation.id,
        fromEntityId: relation.from,
        toEntityId: relation.to,
        kind: relation.kind,
        label: relationLabel(relation),
        ...(relation.technology?.trim() ? { technology: relation.technology.trim() } : {}),
        optional: relation.optional ?? false,
        evidence: copiedEvidence(relation.evidence),
        projection: { band: reveal, id: projection.id, visualEdgeIds },
      });
    }
    interactions.push(...stepInteractions);
    steps.push({
      id: storyStep.id,
      index: stepIndex,
      narration: storyStep.narration,
      reveal,
      focusEntityIds,
      focusVisualNodeIds,
      projection: { band: reveal, id: projection.id },
      interactionIds: stepInteractions.map(interaction => interaction.id),
      sourceRefs: copiedSourceRefs(storyStep.sourceRefs),
    });
  }

  const participants = [...participantIds]
    .sort(compareText)
    .map(entityId => participant(entityById.get(entityId)!));
  return {
    schemaVersion: DYNAMIC_FLOW_ARTIFACT_VERSION,
    id: `dynamic:${story.id}`,
    diagramType: 'dynamic',
    style: 'collaboration',
    snapshotId: snapshot.id,
    viewId: view.id,
    storyId: story.id,
    title: story.title,
    participants,
    steps,
    interactions,
  };
}

function kindLabel(kind: EntityKind): string {
  return kind.replace(/([a-z])([A-Z])/gu, '$1 $2').toUpperCase();
}

function mermaidCommentJson(value: unknown): string {
  return JSON.stringify(value).replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');
}

/** Deterministic Mermaid is an export payload; native UI should use the artifact. */
export function serializeDynamicFlowMermaid(
  artifact: DynamicFlowArtifact,
  options: DynamicFlowMermaidOptions = {},
): string {
  const direction = options.direction ?? 'LR';
  if (direction !== 'LR' && direction !== 'TB') throw new Error(`Unsupported Mermaid flow direction: ${direction}`);
  const participantById = new Map(artifact.participants.map(item => [item.id, item]));
  const nodeIdByEntityId = new Map(artifact.participants.map(item => [item.id, mermaidSafeIdentifier(item.id)]));
  const lines = [
    `%% okie-dynamic-flow ${mermaidCommentJson({ artifactId: artifact.id, storyId: artifact.storyId })}`,
    `flowchart ${direction}`,
  ];
  for (const item of artifact.participants) {
    const nodeId = nodeIdByEntityId.get(item.id)!;
    lines.push(`  %% okie-entity ${mermaidCommentJson({ semanticEntityId: item.id })}`);
    lines.push(`  ${nodeId}["${escapeMermaidLabel(`${item.name} · ${kindLabel(item.kind)}`)}"]`);
  }
  for (const interaction of artifact.interactions) {
    const source = participantById.get(interaction.fromEntityId);
    const target = participantById.get(interaction.toEntityId);
    if (!source || !target) throw new Error(`Dynamic interaction ${interaction.id} has a missing participant`);
    lines.push(`  %% okie-interaction ${mermaidCommentJson({
      sequence: interaction.sequence,
      stepId: interaction.stepId,
      semanticRelationId: interaction.semanticRelationId,
      visualEdgeIds: interaction.projection.visualEdgeIds,
      evidenceSources: interaction.evidence.map(item => item.source.path),
    })}`);
    const protocol = interaction.technology ? ` · ${interaction.technology}` : '';
    const optional = interaction.optional ? ' · optional' : '';
    const label = escapeMermaidLabel(`${interaction.sequence}. ${interaction.label}${protocol}${optional}`);
    lines.push(`  ${nodeIdByEntityId.get(source.id)!} -->|"${label}"| ${nodeIdByEntityId.get(target.id)!}`);
  }
  return `${lines.join('\n')}\n`;
}
