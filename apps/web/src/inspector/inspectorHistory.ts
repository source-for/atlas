import type { InspectorTab } from './inspectorPanel';
import type { NavigationState } from '../navigation/navigationState';

export type InspectorHistoryNavigation = Pick<NavigationState, 'camera' | 'detail' | 'lensPath'>;

export type InspectorHistorySubject =
  | {
      kind: 'entity';
      entityId: string;
      tab: InspectorTab;
      navigation: InspectorHistoryNavigation;
    }
  | {
      kind: 'relation';
      relationId: string;
      ownerEntityId: string;
      tab: 'details';
      navigation: InspectorHistoryNavigation;
    };

const inspectorHistoryLimit = 32;

function sameInspectorSubject(left: InspectorHistorySubject, right: InspectorHistorySubject): boolean {
  if (left.kind !== right.kind || left.tab !== right.tab) return false;
  return left.kind === 'entity' && right.kind === 'entity'
    ? left.entityId === right.entityId
    : left.kind === 'relation' && right.kind === 'relation'
      ? left.relationId === right.relationId && left.ownerEntityId === right.ownerEntityId
      : false;
}

export function pushInspectorHistory(
  history: readonly InspectorHistorySubject[],
  subject: InspectorHistorySubject,
): InspectorHistorySubject[] {
  if (history.at(-1) && sameInspectorSubject(history.at(-1)!, subject)) return [...history];
  return [...history, subject].slice(-inspectorHistoryLimit);
}

/**
 * Undoes a push of `subject` made on `before`, while `subject` is still on top. Restoring
 * `before` (not just dropping the top) brings back an entry the push's limit evicted.
 */
export function withdrawInspectorHistory(
  current: InspectorHistorySubject[],
  before: readonly InspectorHistorySubject[],
  subject: InspectorHistorySubject,
): InspectorHistorySubject[] {
  return current.at(-1) === subject ? [...before] : current;
}

export function popInspectorHistory(history: readonly InspectorHistorySubject[]): {
  history: InspectorHistorySubject[];
  subject?: InspectorHistorySubject;
} {
  if (!history.length) return { history: [] };
  return {
    history: history.slice(0, -1),
    subject: history.at(-1),
  };
}

export function inspectorHistoryRestorePlan(
  current: NavigationState,
  subject: InspectorHistorySubject,
): { mode: 'replace'; state: NavigationState } {
  const { detail: _currentDetail, lensPath: _currentLensPath, ...stable } = current;
  return {
    mode: 'replace',
    state: {
      ...stable,
      selectedId: subject.kind === 'entity' ? subject.entityId : subject.ownerEntityId,
      camera: { ...subject.navigation.camera },
      ...(subject.navigation.detail ? { detail: subject.navigation.detail } : {}),
      ...(subject.navigation.lensPath?.length ? { lensPath: [...subject.navigation.lensPath] } : {}),
    },
  };
}
