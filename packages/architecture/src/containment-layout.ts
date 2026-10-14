import type { EntityKind, NodeLayout } from "./model.js";
import {
  c4ContainmentLeafSize,
  c4ExpectedChildKind,
  c4IntrinsicOwnerMetrics,
  measureC4Grid,
} from "./c4.js";
import { compareText } from "./text-order.js";

/** Minimal containment row — scan snapshot ids/kinds, no enrichment. */
export type ContainmentEntity = {
  id: string;
  kind: EntityKind;
  parentId?: string;
};

export type ComputeContainmentLayoutOptions = {
  /** Published child counts, including descendants not in `entities`. */
  childCounts?: Readonly<Record<string, number>>;
  /** Scan-mode aspect target. Absent → historical column formula. */
  targetAspect?: number;
};

export type ContainmentLayout = Record<string, NodeLayout>;

function childrenByOwner(
  entities: readonly ContainmentEntity[],
): Map<string, ContainmentEntity[]> {
  const byOwner = new Map<string, ContainmentEntity[]>();
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  for (const entity of entities) {
    if (!entity.parentId) continue;
    const owner = byId.get(entity.parentId);
    const expected = owner ? c4ExpectedChildKind(owner.kind) : undefined;
    if (!owner || !expected) continue;
    if (entity.kind !== expected && !(owner.kind === "softwareSystem"
      && (entity.kind === "container" || entity.kind === "dataStore" || entity.kind === "queue"))) {
      continue;
    }
    const children = byOwner.get(owner.id) ?? [];
    children.push(entity);
    byOwner.set(owner.id, children);
  }
  for (const children of byOwner.values()) children.sort((left, right) => compareText(left.id, right.id));
  return byOwner;
}

function placeholderId(ownerId: string, index: number): string {
  return `\uFFFF reserved:${ownerId}:${String(index).padStart(4, "0")}`;
}

export type IntrinsicSize = { width: number; height: number };

/**
 * Deterministic world-space size/rect tree from containment (CLA-81).
 * Each owner's box comes from child count / nested footprint, not from a
 * band compile. Unpublished children (via `childCounts`) reserve leaf-sized
 * placeholder slots so later neighborhood merge cannot grow the parent.
 */
export function computeContainmentLayout(
  entities: readonly ContainmentEntity[],
  options: ComputeContainmentLayoutOptions = {},
): ContainmentLayout {
  const byOwner = childrenByOwner(entities);
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const childCounts = options.childCounts;
  const targetAspect = options.targetAspect;
  const requiredById = new Map<string, IntrinsicSize>();
  const measuring = new Set<string>();

  const gridItemsFor = (owner: ContainmentEntity): Array<{ id: string; width: number; height: number }> => {
    const resident = byOwner.get(owner.id) ?? [];
    const items = resident.map(child => ({ id: child.id, ...requiredFor(child) }));
    const published = childCounts?.[owner.id] ?? resident.length;
    const missing = Math.max(0, published - resident.length);
    const childKind = c4ExpectedChildKind(owner.kind);
    if (childKind && missing > 0) {
      const leaf = c4ContainmentLeafSize(childKind, targetAspect);
      for (let index = 0; index < missing; index += 1) {
        items.push({ id: placeholderId(owner.id, index), ...leaf });
      }
    }
    return items;
  };

  const requiredFor = (entity: ContainmentEntity): IntrinsicSize => {
    const cached = requiredById.get(entity.id);
    if (cached) return cached;
    if (measuring.has(entity.id)) throw new Error(`Cyclic C4 hierarchy at ${entity.id}`);
    measuring.add(entity.id);
    let required = entity.kind === "code"
      ? c4ContainmentLeafSize("code", targetAspect)
      : { width: 0, height: 0 };
    const metrics = c4IntrinsicOwnerMetrics(entity.kind, targetAspect);
    const items = metrics ? gridItemsFor(entity) : [];
    if (metrics && items.length) {
      const measurement = measureC4Grid(items, metrics);
      required = {
        width: Math.max(required.width, measurement.width),
        height: Math.max(required.height, measurement.height),
      };
    } else if (targetAspect !== undefined && metrics) {
      required = c4ContainmentLeafSize(entity.kind, targetAspect);
    } else if (required.width === 0 || required.height === 0) {
      required = c4ContainmentLeafSize(entity.kind, targetAspect);
    }
    measuring.delete(entity.id);
    requiredById.set(entity.id, required);
    return required;
  };

  for (const entity of entities) requiredFor(entity);

  const layout: ContainmentLayout = {};
  const place = (owner: ContainmentEntity, origin: NodeLayout): void => {
    layout[owner.id] = { ...origin };
    const metrics = c4IntrinsicOwnerMetrics(owner.kind, targetAspect);
    const items = metrics ? gridItemsFor(owner) : [];
    if (!metrics || !items.length) return;
    const measurement = measureC4Grid(items, metrics);
    const availableWidth = origin.width - metrics.paddingLeft - metrics.paddingRight;
    const availableHeight = origin.height - metrics.paddingTop - metrics.paddingBottom;
    const gridX = origin.x + metrics.paddingLeft + Math.max(0, availableWidth - measurement.contentWidth) / 2;
    const gridY = origin.y + metrics.paddingTop + Math.max(0, availableHeight - measurement.contentHeight) / 2;
    const ordered = [...items].sort((left, right) => compareText(left.id, right.id));
    ordered.forEach((item, index) => {
      const column = index % measurement.columns;
      const row = Math.floor(index / measurement.columns);
      const columnX = measurement.columnWidths.slice(0, column).reduce((sum, value) => sum + value, 0)
        + metrics.gap * column;
      const rowY = measurement.rowHeights.slice(0, row).reduce((sum, value) => sum + value, 0)
        + metrics.gap * row;
      const bounds: NodeLayout = {
        x: gridX + columnX + (measurement.columnWidths[column]! - item.width) / 2,
        y: gridY + rowY + (measurement.rowHeights[row]! - item.height) / 2,
        width: item.width,
        height: item.height,
      };
      const child = byId.get(item.id);
      if (child) place(child, bounds);
      else layout[item.id] = bounds;
    });
  };

  const roots = entities.filter(entity => !entity.parentId || !byId.has(entity.parentId))
    .sort((left, right) => compareText(left.id, right.id));
  let cursorX = 0;
  for (const root of roots) {
    const size = requiredById.get(root.id) ?? c4ContainmentLeafSize(root.kind, targetAspect);
    place(root, { x: cursorX, y: 0, ...size });
    cursorX += size.width + 100;
  }
  return layout;
}

/** Width/height only — positions are session-relative. */
export function containmentSizeByEntityId(
  entities: readonly ContainmentEntity[],
  options: ComputeContainmentLayoutOptions = {},
): Record<string, IntrinsicSize> {
  const layout = computeContainmentLayout(entities, options);
  return Object.fromEntries(Object.entries(layout).map(([id, bounds]) => [id, {
    width: bounds.width,
    height: bounds.height,
  }]));
}
