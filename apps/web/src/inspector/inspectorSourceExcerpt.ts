import { useEffect, useRef, useState } from 'react';
import { completeFixturePreparation } from '../renderer/fixturePreparation';
import type { SceneSourceExcerpt } from '../renderer/types';

/** What the Source tab may claim about the selected entity's excerpt. */
export type InspectorSourceExcerptStatus = 'ready' | 'loading' | 'unavailable' | 'failed';

/** One excerpt request: from the render that wants it until the tab, the entity or a foreground load changes. */
type RequestSession = { entityId: string };
type Settled = { session: RequestSession; outcome: 'unavailable' | 'failed' };

/**
 * Fetches the selected code entity's excerpt while the Source tab shows it, and
 * reports `loading` from the first render that wants it, so the tab never claims
 * "unavailable" while a request is still in flight.
 *
 * A settled outcome only describes the request that produced it: reopening the
 * tab, returning to the entity or retrying after a foreground load starts a new
 * request, which is `loading` again until it settles. A response for an entity
 * that is no longer selected is dropped.
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
  // Derived during render so the first render of a new request already reads `loading`.
  const sessionRef = useRef<RequestSession>(undefined);
  if (!wanted || hasExcerpts || blocked) sessionRef.current = undefined;
  else if (sessionRef.current?.entityId !== entityId) sessionRef.current = { entityId };
  const session = sessionRef.current;
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    void completeFixturePreparation(load(session.entityId), () => !cancelled, excerpts => {
      if (excerpts?.length) attach(session.entityId, excerpts);
      else setSettled({ session, outcome: 'unavailable' });
    }, () => {
      setSettled({ session, outcome: 'failed' });
      onFailure();
    });
    return () => { cancelled = true; };
    // The callbacks are recreated each render; only a new session starts a request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);
  return inspectorSourceExcerptStatus({ wanted, hasExcerpts, session, settled });
}

export function inspectorSourceExcerptStatus({ wanted, hasExcerpts, session, settled }: {
  wanted: boolean;
  hasExcerpts: boolean;
  session: RequestSession | undefined;
  settled: Settled | undefined;
}): InspectorSourceExcerptStatus {
  if (hasExcerpts) return 'ready';
  if (!wanted) return 'unavailable';
  return session && settled?.session === session ? settled.outcome : 'loading';
}
