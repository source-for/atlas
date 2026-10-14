import { useEffect, useState } from 'react';
import { completeFixturePreparation } from '../renderer/fixturePreparation';
import type { SceneSourceExcerpt } from '../renderer/types';

/** What the Source tab may claim about the selected entity's excerpt. */
export type InspectorSourceExcerptStatus = 'ready' | 'loading' | 'unavailable' | 'failed';

type Settled = { entityId: string; outcome: 'unavailable' | 'failed' };

/**
 * Fetches the selected code entity's excerpt while the Source tab shows it, and
 * reports `loading` from the first render that wants it, so the tab never claims
 * "unavailable" while the request is still in flight.
 *
 * Last selection wins: a response for an entity that is no longer selected is
 * dropped, and a settled outcome only describes the entity it was fetched for.
 */
export function useInspectorSourceExcerpt({ entityId, wanted, hasExcerpts, blocked, load, attach, onFailure }: {
  entityId: string;
  /** The Source tab is open on a scan code entity that may have a remote excerpt. */
  wanted: boolean;
  hasExcerpts: boolean;
  /** A foreground view is still loading; the request starts once it settles. */
  blocked: boolean;
  load: (entityId: string) => Promise<readonly SceneSourceExcerpt[] | undefined>;
  attach: (entityId: string, excerpts: readonly SceneSourceExcerpt[]) => void;
  onFailure: () => void;
}): InspectorSourceExcerptStatus {
  const [settled, setSettled] = useState<Settled>();
  useEffect(() => {
    if (!wanted || hasExcerpts || blocked) return;
    let cancelled = false;
    // A retry after a failure is loading again, not failed.
    setSettled(current => current?.entityId === entityId && current.outcome === 'failed' ? undefined : current);
    void completeFixturePreparation(load(entityId), () => !cancelled, excerpts => {
      if (excerpts?.length) attach(entityId, excerpts);
      else setSettled({ entityId, outcome: 'unavailable' });
    }, () => {
      setSettled({ entityId, outcome: 'failed' });
      onFailure();
    });
    return () => { cancelled = true; };
    // The callbacks are recreated each render; only these inputs start a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, hasExcerpts, blocked, entityId]);
  return inspectorSourceExcerptStatus({ entityId, wanted, hasExcerpts, settled });
}

export function inspectorSourceExcerptStatus({ entityId, wanted, hasExcerpts, settled }: {
  entityId: string;
  wanted: boolean;
  hasExcerpts: boolean;
  settled: Settled | undefined;
}): InspectorSourceExcerptStatus {
  if (hasExcerpts) return 'ready';
  if (!wanted) return 'unavailable';
  return settled?.entityId === entityId ? settled.outcome : 'loading';
}
