import { useEffect, useRef } from 'react';
import { levels, semanticDetails } from '../semantic/semanticLensEngine';
import type { SemanticDetail } from '../navigation/navigationState';

/** The child an open-inside is compiling a map for, shown in the inspector until that map commits. */
export type PendingInspectorChild = {
  id: string;
  name: string;
  levelLabel: string;
  /** The selection the open started from; any other selection hides the pending view. */
  fromSelectionId: string;
};

type LabelledEntity = { id: string; name: string; kind: string; detail?: SemanticDetail; kindLabel?: string };

/** The inspector kicker ("L3 · COMPONENT"). The loaded inspector and the pending header both use it. */
export function inspectorLevelLabel(entity: Omit<LabelledEntity, 'id' | 'name'>): string {
  const level = Math.max(0, semanticDetails.indexOf(entity.detail ?? 'context'));
  return `${levels[level]?.short ?? 'L1'} · ${(entity.kindLabel ?? entity.detail ?? entity.kind).toUpperCase()}`;
}

/** `entity` is the record the loaded inspector resolves for the child (`resolveInspectorEntity`). */
export function pendingInspectorChild(entity: LabelledEntity, fromSelectionId: string): PendingInspectorChild {
  return { id: entity.id, name: entity.name, levelLabel: inspectorLevelLabel(entity), fromSelectionId };
}

/**
 * One pending open-inside at a time. The latest `show` wins: settling an older
 * one is a no-op, so a slow superseded open can never clear (or repaint) the
 * newer target. `clear` drops whatever is pending, for a cancelled navigation.
 */
export function createPendingInspectorChildSlot(publish: (pending: PendingInspectorChild | undefined) => void) {
  let current: PendingInspectorChild | undefined;
  return {
    show(child: PendingInspectorChild) {
      const entry = { ...child };
      current = entry;
      publish(entry);
      return { settle() { if (current === entry) { current = undefined; publish(undefined); } } };
    },
    clear() {
      if (!current) return;
      current = undefined;
      publish(undefined);
    },
  };
}

/** The pending child to draw, only while the reader is still on the selection they opened it from. */
export function visiblePendingInspectorChild(pending: PendingInspectorChild | undefined, selectedId: string, relationPicked: boolean) {
  return pending && !relationPicked && pending.fromSelectionId === selectedId ? pending : undefined;
}

/**
 * The target's header at once, then placeholder sections in the boxes the loaded
 * inspector uses. The body reveals after 120 ms (CSS), so a cached open that
 * commits sooner never flashes the skeleton. "Loading …" is announced through the
 * app's polite live region by the caller. The view replaces the row that was just
 * activated, so a focus that fell to the document moves to this heading.
 */
export function PendingInspectorChildView({ pending }: { pending: PendingInspectorChild }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) headingRef.current?.focus({ preventScroll: true });
  }, [pending.id]);
  return <article aria-busy="true" aria-labelledby="inspector-pending-title" className="inspector-presentation inspector-entity-presentation inspector-pending" data-inspector-pending-entity-id={pending.id} data-testid="inspector-pending-child">
    <header className="entity-hero">
      <div className="entity-kicker"><span>{pending.levelLabel}</span></div>
      <h2 id="inspector-pending-title" ref={headingRef} tabIndex={-1}>{pending.name}</h2>
      <div aria-hidden="true" className="inspector-pending-body inspector-pending-lead">
        <span className="inspector-skeleton-line" style={{ width: '92%' }}/>
        <span className="inspector-skeleton-line" style={{ width: '64%' }}/>
      </div>
      <div aria-hidden="true" className="detail-actions inspector-pending-body">
        <span className="inspector-skeleton-block"/>
        <span className="inspector-skeleton-block"/>
      </div>
    </header>
    {[4, 3].map((rows, section) => <section aria-hidden="true" className="detail-section inspector-pending-body" key={section}>
      <span className="inspector-skeleton-line inspector-pending-section-title"/>
      {Array.from({ length: rows }, (_, row) => <span className="inspector-skeleton-block inspector-pending-row" key={row}/>)}
    </section>)}
  </article>;
}
