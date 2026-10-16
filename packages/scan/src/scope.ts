import type { ArchitectureExtraction, ArchitectureExtractionEntity } from "@okie/architecture";
import { compareText } from "@okie/architecture";

/**
 * The per-container view the enrichment machinery reasons over: which file-components
 * carry code (enrichable), which are empty (left on the deterministic base), and the
 * code entities to be re-partitioned. Derived purely from the extraction — no I/O.
 */
export interface ContainerScope {
  container: ArchitectureExtractionEntity;
  components: ArchitectureExtractionEntity[];
  codeBearing: ArchitectureExtractionEntity[];
  emptyComponents: ArchitectureExtractionEntity[];
  code: ArchitectureExtractionEntity[];
  codeByComponentId: Map<string, ArchitectureExtractionEntity[]>;
  pathByComponentId: Map<string, string>;
  pathsByComponentId: Map<string, string[]>;
  scopePaths: string[];
}

function firstPath(entity: ArchitectureExtractionEntity): string | undefined {
  return entity.sourceRefs[0]?.path;
}

/** Builds a ContainerScope for every container, keyed by container id (sorted contents). */
export function containerScopes(extraction: ArchitectureExtraction): Map<string, ContainerScope> {
  const containers = extraction.entities.filter(entity => entity.kind === "container");
  const componentsByContainer = new Map<string, ArchitectureExtractionEntity[]>();
  for (const entity of extraction.entities) {
    if (entity.kind !== "component" || entity.parentId === undefined) continue;
    const bucket = componentsByContainer.get(entity.parentId) ?? [];
    bucket.push(entity);
    componentsByContainer.set(entity.parentId, bucket);
  }
  const codeByComponent = new Map<string, ArchitectureExtractionEntity[]>();
  for (const entity of extraction.entities) {
    if (entity.kind !== "code" || entity.parentId === undefined) continue;
    const bucket = codeByComponent.get(entity.parentId) ?? [];
    bucket.push(entity);
    codeByComponent.set(entity.parentId, bucket);
  }
  const byIdSort = (left: ArchitectureExtractionEntity, right: ArchitectureExtractionEntity): number =>
    compareText(left.id, right.id);

  const scopes = new Map<string, ContainerScope>();
  for (const container of containers) {
    const components = (componentsByContainer.get(container.id) ?? []).slice().sort(byIdSort);
    const codeByComponentId = new Map<string, ArchitectureExtractionEntity[]>();
    const pathByComponentId = new Map<string, string>();
    const pathsByComponentId = new Map<string, string[]>();
    const codeBearing: ArchitectureExtractionEntity[] = [];
    const emptyComponents: ArchitectureExtractionEntity[] = [];
    const code: ArchitectureExtractionEntity[] = [];
    for (const component of components) {
      const children = (codeByComponent.get(component.id) ?? []).slice().sort(byIdSort);
      codeByComponentId.set(component.id, children);
      const path = firstPath(component);
      if (path !== undefined) pathByComponentId.set(component.id, path);
      const paths = [...new Set([
        ...component.sourceRefs.map(ref => ref.path),
        ...children.flatMap(child => child.sourceRefs.map(ref => ref.path)),
      ])].sort();
      pathsByComponentId.set(component.id, paths);
      if (children.length > 0) {
        codeBearing.push(component);
        code.push(...children);
      } else {
        emptyComponents.push(component);
      }
    }
    code.sort(byIdSort);
    const scopePaths = [...new Set(components.flatMap(component => pathsByComponentId.get(component.id) ?? []))].sort();
    scopes.set(container.id, {
      container,
      components,
      codeBearing,
      emptyComponents,
      code,
      codeByComponentId,
      pathByComponentId,
      pathsByComponentId,
      scopePaths,
    });
  }
  return scopes;
}
