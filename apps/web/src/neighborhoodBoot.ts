import type { OperatorScope } from './operator/api';
import type { ScanFixture, ScanNeighborhoodHost } from './renderer/scanFixture';

/**
 * CLA-268: boot ordering for a published atlas. The neighbourhood request goes first and alone. The moment its body
 * has arrived (and its publication is known), the operator explanations sidecar is requested, in parallel with the
 * worker compile instead of after it, and the caller is told (main.tsx then fetches App's chunk and the renderer's
 * WASM). Explanations are still awaited before App mounts, so what App shows on its first frame is unchanged.
 */
export type NeighborhoodBootDeps = {
  slug: string | undefined;
  host: ScanNeighborhoodHost;
  /** Fetch, validate and compile the atlas through `host` (loadScanNeighborhoodFixtureFromSearch). */
  loadFixture(host: ScanNeighborhoodHost): Promise<ScanFixture>;
  loadExplanations(slug: string, versionId: string): Promise<OperatorScope[] | undefined>;
  /**
   * Called once, after the bootstrap neighbourhood body has arrived (and after the explanations request starts), with
   * the repository it belongs to.
   */
  onNeighborhoodArrived(repositoryId: string): void;
};

export type NeighborhoodBoot = {
  fixture: ScanFixture;
  /** The publication's explanations: undefined when there is no publication; rejects when the sidecar fails. */
  explanations: Promise<OperatorScope[] | undefined>;
};

export async function bootNeighborhoodAtlas(deps: NeighborhoodBootDeps): Promise<NeighborhoodBoot> {
  const { host, slug } = deps;
  let early: { versionId: string; scopes: Promise<OperatorScope[] | undefined> } | undefined;
  let arrived = false;
  const startExplanations = (versionId: string) => {
    const scopes = deps.loadExplanations(slug!, versionId);
    // Settled by the caller's await; a rejection before then must not surface as unhandled.
    scopes.catch(() => undefined);
    return { versionId, scopes };
  };
  const wrapped: ScanNeighborhoodHost = {
    ...host,
    async loadNeighborhood(focusEntityId, signal) {
      const packet = await host.loadNeighborhood(focusEntityId, signal);
      if (!arrived) {
        arrived = true;
        const versionId = host.publication?.()?.versionId;
        if (slug && versionId) early = startExplanations(versionId);
        deps.onNeighborhoodArrived(packet.snapshot.repositoryId);
      }
      return packet;
    },
  };
  const fixture = await deps.loadFixture(wrapped);
  const versionId = fixture.publication?.versionId;
  if (!slug || !versionId) return { fixture, explanations: Promise.resolve(undefined) };
  // Never mix explanation content from another publication.
  const explanations = early?.versionId === versionId ? early.scopes : startExplanations(versionId).scopes;
  return { fixture, explanations };
}
