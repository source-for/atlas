import type { ArchitectureNeighborhoodPacket } from '@okie/architecture';
import { describe, expect, it, vi } from 'vitest';
import { bootNeighborhoodAtlas } from './neighborhoodBoot';
import type { OperatorScope } from './operator/api';
import type { ScanFixture, ScanNeighborhoodHost } from './renderer/scanFixture';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const PACKET = { kind: 'neighborhood', snapshot: { repositoryId: 'repo:source-for-atlas' } } as unknown as ArchitectureNeighborhoodPacket;
const SCOPES = [{ entityId: 'system:x', scopeId: 's', name: 'X', state: 'not run' }] as unknown as OperatorScope[];

function harness(options: { slug?: string; versionId?: string; fixtureVersionId?: string } = {}) {
  const log: string[] = [];
  const neighborhood = deferred<ArchitectureNeighborhoodPacket>();
  const compile = deferred<void>();
  let publication: { versionId: string; artifactRevisionId: string } | undefined;
  const host: ScanNeighborhoodHost = {
    loadNeighborhood: vi.fn(async (focus: string) => {
      log.push(`neighborhood:${focus || 'bootstrap'}`);
      if (focus) return PACKET;
      const packet = await neighborhood.promise;
      if (options.versionId) publication = { versionId: options.versionId, artifactRevisionId: 'r' };
      return packet;
    }),
    loadExcerpts: async () => undefined,
    loadStory: async () => ({}),
    publication: () => publication,
  };
  const loadExplanations = vi.fn(async (slug: string, versionId: string) => { log.push(`explanations:${slug}@${versionId}`); return SCOPES; });
  const fixtureVersion = options.fixtureVersionId ?? options.versionId;
  const loadFixture = vi.fn(async (wrapped: ScanNeighborhoodHost) => {
    await wrapped.loadNeighborhood('');
    log.push('compile:start');
    await compile.promise;
    await wrapped.loadNeighborhood('component:deep'); // a deep link's focus packet: not the bootstrap
    log.push('compile:end');
    return (fixtureVersion ? { publication: { versionId: fixtureVersion, artifactRevisionId: 'r' } } : {}) as ScanFixture;
  });
  const onNeighborhoodArrived = vi.fn(() => { log.push('arrived'); });
  const run = bootNeighborhoodAtlas({ slug: 'slug' in options ? options.slug : 'source-for__atlas', host, loadFixture, loadExplanations, onNeighborhoodArrived });
  return { log, neighborhood, compile, run, loadExplanations, onNeighborhoodArrived };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('CLA-268 published atlas boot ordering', () => {
  it('nothing else starts until the neighbourhood body has arrived', async () => {
    const boot = harness({ versionId: 'publication-1' });
    await flush();
    expect(boot.log).toEqual(['neighborhood:bootstrap']);
    expect(boot.onNeighborhoodArrived).not.toHaveBeenCalled();
    expect(boot.loadExplanations).not.toHaveBeenCalled();
    boot.neighborhood.resolve(PACKET);
    boot.compile.resolve();
    await boot.run;
  });

  it('then requests the explanations and reports arrival while the compile is still running, once', async () => {
    const boot = harness({ versionId: 'publication-1' });
    boot.neighborhood.resolve(PACKET);
    await flush();
    expect(boot.log).toEqual(['neighborhood:bootstrap', 'explanations:source-for__atlas@publication-1', 'arrived', 'compile:start']);
    boot.compile.resolve();
    const { explanations } = await boot.run;
    await expect(explanations).resolves.toBe(SCOPES);
    expect(boot.loadExplanations).toHaveBeenCalledTimes(1);
    expect(boot.onNeighborhoodArrived).toHaveBeenCalledTimes(1);
    // The skeleton learns the repository (for its saved inspector width) from the bootstrap packet.
    expect(boot.onNeighborhoodArrived).toHaveBeenCalledWith('repo:source-for-atlas');
    expect(boot.log).toContain('neighborhood:component:deep');
  });

  it('never mixes publications: a fixture on another version gets its own request', async () => {
    const boot = harness({ versionId: 'publication-1', fixtureVersionId: 'publication-2' });
    boot.neighborhood.resolve(PACKET);
    boot.compile.resolve();
    await (await boot.run).explanations;
    expect(boot.loadExplanations.mock.calls).toEqual([['source-for__atlas', 'publication-1'], ['source-for__atlas', 'publication-2']]);
  });

  it('requests no explanations without a slug or a publication', async () => {
    for (const options of [{ slug: undefined, versionId: 'publication-1' }, {}]) {
      const boot = harness(options);
      boot.neighborhood.resolve(PACKET);
      boot.compile.resolve();
      await expect((await boot.run).explanations).resolves.toBeUndefined();
      expect(boot.loadExplanations).not.toHaveBeenCalled();
      expect(boot.onNeighborhoodArrived).toHaveBeenCalledTimes(1);
    }
  });

  it('a failed early request is the caller\'s to handle, never an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const boot = harness({ versionId: 'publication-1' });
      boot.loadExplanations.mockImplementationOnce(async () => { throw new Error('503'); });
      boot.neighborhood.resolve(PACKET);
      await flush();
      boot.compile.resolve();
      const { explanations } = await boot.run;
      await flush();
      expect(unhandled).not.toHaveBeenCalled();
      await expect(explanations).rejects.toThrow('503');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a failed neighbourhood fails the boot and starts nothing else', async () => {
    const boot = harness({ versionId: 'publication-1' });
    boot.neighborhood.reject(new Error('offline'));
    await expect(boot.run).rejects.toThrow('offline');
    expect(boot.onNeighborhoodArrived).not.toHaveBeenCalled();
    expect(boot.loadExplanations).not.toHaveBeenCalled();
  });
});
