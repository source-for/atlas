import { PORTABLE_ATLAS_MAX_BYTES, serializePortableAtlas, type PortableAtlas, type PortableAtlasGenerator } from '@okie/architecture';
import { fitDependencyFacts } from './dependency-facts.js';
import type { ScanArtifacts } from './scan.js';

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * Build the portable bundle. Dependency facts never push a bundle that fits without
 * them over `maxBytes`: they are trimmed (symbol references, then imports, then
 * declarations) into the remaining space, measured after coverage is rebuilt. When no
 * row fits, a minimal facts object (packages + coverage carrying
 * DEPENDENCY_FACTS_OMITTED_LIMIT) is kept so queries report the size limit.
 */
export function portableAtlasFromScan(artifacts: ScanArtifacts, repositoryUrl?: string, maxBytes: number = PORTABLE_ATLAS_MAX_BYTES, generator?: PortableAtlasGenerator): PortableAtlas {
  const base: PortableAtlas = {
    format: 'okie-atlas', version: 1,
    ...(generator ? { generator } : {}),
    repository: { commitSha: artifacts.pin.commitSha, treeHash: artifacts.pin.treeHash, ...(repositoryUrl ? { url: repositoryUrl } : {}) },
    snapshot: artifacts.snapshot, view: artifacts.view, story: artifacts.story, stories: artifacts.stories,
    analysis: artifacts.analysis,
    ...(artifacts.sources ? { sources: artifacts.sources } : {}),
  };
  let dependencies = artifacts.dependencies;
  const baseBytes = bytes(base) + 1; // trailing newline
  const overhead = ',"dependencies":'.length;
  if (baseBytes + overhead + bytes(dependencies) > maxBytes) {
    dependencies = fitDependencyFacts(dependencies, Math.max(0, maxBytes - baseBytes - overhead));
  }
  // Last resort, only when even the ~1 KB stand-in (no packages) cannot fit: drop the field
  // rather than fail an export that fit before.
  const bundle: PortableAtlas = baseBytes + overhead + bytes(dependencies) > maxBytes ? base : { ...base, dependencies };
  serializePortableAtlas(bundle);
  return bundle;
}
