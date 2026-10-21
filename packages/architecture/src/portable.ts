import type { ArchitectureSnapshot, ArchitectureStory, ArchitectureView } from './model.js';
import { validateSnapshot, validateStoryDocument, validateView } from './validation.js';
import { validatePortableGraphShape } from './portable-shape.js';
import { portableSourcePath } from './portable-path.js';
import { validateDependencyFacts, type DependencyFacts } from './dependency-consumers.js';

/**
 * CLA-263 container-membership warning. Never fatal: `file-in-multiple-containers`
 * (one path cited from two containers) or `reexport-across-containers` (a component
 * whose file only re-exports a file owned by another container).
 */
export interface PortableMembershipDiagnostic {
  /** Known codes today; any non-empty code parses so a newer scanner never breaks an older viewer. */
  code: 'file-in-multiple-containers' | 'reexport-across-containers' | (string & {});
  severity: 'warning';
  path: string;
  /** The re-exported file (reexport-across-containers only). */
  target?: string;
  containerIds: string[];
  entityIds: string[];
  message: string;
}

/**
 * How scan discovery assigned files to containers, beyond the evidence graph:
 * re-export shims folded into their target's container (not sourceRefs — the
 * shim is not evidence for the target component) plus membership diagnostics.
 */
export interface PortableMembershipReport {
  reexportAliases: { path: string; target: string; unit: string }[];
  diagnostics: PortableMembershipDiagnostic[];
}

export interface PortableAtlasGenerator { name: string; version: string }

/** A portable semantic artifact. Renderer scenes are compiled by the matching viewer. */
export interface PortableAtlas {
  format: 'okie-atlas';
  version: 1;
  /** Optional: the tool and version that wrote this artifact. Informational; never gates parsing. */
  generator?: PortableAtlasGenerator;
  repository: { commitSha: string; treeHash: string; url?: string };
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  story: ArchitectureStory;
  stories: ArchitectureStory[];
  analysis: {
    mode: 'full' | 'quick';
    adapters: { language: string; tool: string; version: string; coverage: 'semantic' | 'syntax' | 'unavailable'; limitations: string[] }[];
    /** Present only when discovery folded a shim or found a membership warning (CLA-263). */
    membership?: PortableMembershipReport;
    /**
     * Scan-level limitations from source acquisition/discovery (e.g. committed symlinks
     * or submodules that were not scanned, CLA-299). Present only when non-empty.
     */
    limitations?: string[];
  };
  /** Optional full files at repository.commitSha; snippets remain in snapshot entities. */
  sources?: { path: string; text: string }[];
  /** Optional dependency facts (CLA-212). Absent in bundles scanned before dependency capture. */
  dependencies?: DependencyFacts;
}

export const PORTABLE_ATLAS_MAX_BYTES = 128 * 1024 * 1024;
const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');

export { portableSourcePath } from './portable-path.js';

/** Reject incompatible or malformed imports before persistence or compilation. */
export function parsePortableAtlas(text: string): PortableAtlas {
  if (new TextEncoder().encode(text).byteLength > PORTABLE_ATLAS_MAX_BYTES) throw new Error('Scan bundle exceeds the 128 MiB import limit.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('Scan bundle is not valid JSON.'); }
  if (!record(raw) || raw.format !== 'okie-atlas' || raw.version !== 1) throw new Error('Unsupported scan bundle. Expected okie-atlas version 1.');
  if (raw.generator !== undefined && (!record(raw.generator)
    || ![raw.generator.name, raw.generator.version].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200))) throw new Error('Scan bundle generator must name a tool and version.');
  if (!record(raw.repository) || typeof raw.repository.commitSha !== 'string' || !commitPattern.test(raw.repository.commitSha)
    || typeof raw.repository.treeHash !== 'string' || !commitPattern.test(raw.repository.treeHash)) throw new Error('Scan bundle must identify a committed source revision and tree.');
  if (raw.repository.url !== undefined) {
    if (typeof raw.repository.url !== 'string') throw new Error('Repository URL must be an HTTPS URL.');
    const url = new URL(raw.repository.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Repository URL must be an HTTPS URL without credentials.');
  }
  if (!record(raw.snapshot) || !record(raw.view) || !record(raw.story) || !Array.isArray(raw.stories)) throw new Error('Scan bundle is missing snapshot, view or story data.');
  if (raw.snapshot.commitSha !== raw.repository.commitSha) throw new Error('Snapshot revision does not match the bundled repository.');
  if (!record(raw.analysis) || typeof raw.analysis.mode !== 'string' || !['full', 'quick'].includes(raw.analysis.mode) || !Array.isArray(raw.analysis.adapters)) throw new Error('Scan bundle must report its analysis coverage.');
  for (const adapter of raw.analysis.adapters) {
    if (!record(adapter) || ![adapter.language, adapter.tool, adapter.version].every(value => typeof value === 'string' && value.length > 0)
      || typeof adapter.coverage !== 'string' || !['semantic', 'syntax', 'unavailable'].includes(adapter.coverage) || !strings(adapter.limitations)) throw new Error('Invalid analyzer coverage entry.');
  }
  if (raw.analysis.limitations !== undefined && !strings(raw.analysis.limitations)) throw new Error('Invalid scan limitations list.');
  if (raw.analysis.membership !== undefined) {
    const membership = raw.analysis.membership;
    const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.length > 0;
    if (!record(membership) || !Array.isArray(membership.reexportAliases) || !Array.isArray(membership.diagnostics)
      || !membership.reexportAliases.every(alias => record(alias) && portableSourcePath(alias.path) && portableSourcePath(alias.target) && nonEmpty(alias.unit))
      || !membership.diagnostics.every(item => record(item) && nonEmpty(item.code) && item.severity === 'warning'
        && portableSourcePath(item.path) && (item.target === undefined || portableSourcePath(item.target))
        && strings(item.containerIds) && strings(item.entityIds) && typeof item.message === 'string')) throw new Error('Invalid container-membership report.');
  }
  const bundle = raw as unknown as PortableAtlas;
  try {
    validatePortableGraphShape(raw.snapshot, raw.view);
    const issues = [...validateSnapshot(bundle.snapshot), ...validateView(bundle.snapshot, bundle.view),
      ...[bundle.story, ...bundle.stories].flatMap(story => validateStoryDocument(bundle.snapshot, bundle.view, story))];
    if (issues.length) throw new Error(issues.slice(0, 5).map(issue => `${issue.path}: ${issue.message}`).join('; '));
    const refs = [...bundle.snapshot.entities.flatMap(entity => [...entity.sourceRefs, ...(entity.exposure ?? []).map(exposure => exposure.evidence.source)]),
      ...bundle.snapshot.relations.flatMap(relation => relation.evidence.map(evidence => evidence.source))];
    if (refs.some(ref => ref.commitSha !== bundle.repository.commitSha)) throw new Error('Source evidence revision differs from the bundle revision.');
    if (refs.some(ref => !portableSourcePath(ref.path) || (ref.endLine !== undefined && ref.endLine < (ref.startLine ?? 1)))) throw new Error('Source evidence requires a repository-relative path and an ordered line range.');
    if (bundle.snapshot.entities.some(entity => entity.sourceExcerpts?.some(excerpt => excerpt.frozenRevision !== bundle.repository.commitSha))) throw new Error('Source excerpt revision differs from the bundle revision.');
  } catch (error) { throw new Error(`Invalid scan graph: ${error instanceof Error ? error.message : String(error)}`); }
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources)) throw new Error('Bundled sources must be a list of files.');
    const paths = new Set<string>();
    for (const file of raw.sources) {
      if (!record(file) || !portableSourcePath(file.path) || typeof file.text !== 'string' || paths.has(file.path)) throw new Error('Bundled source paths must be unique repository-relative files.');
      paths.add(file.path);
    }
  }
  if (raw.dependencies !== undefined) {
    try { validateDependencyFacts(raw.dependencies, raw.repository.commitSha); }
    catch (error) { throw new Error(`Invalid dependency facts: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return bundle;
}

export function serializePortableAtlas(bundle: PortableAtlas): string {
  const text = JSON.stringify(bundle) + '\n';
  parsePortableAtlas(text);
  return text;
}
