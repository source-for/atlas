import { sliceArchitectureNeighborhood, type ArchitectureSnapshot, type ArchitectureView } from '@okie/architecture';
import { expect, it, vi } from 'vitest';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { compileScanNeighborhoodFixture } from './scanFixture';
import { completeFixturePreparation } from './fixturePreparation';
it('consumes actual disposal cancellation for neighborhood and excerpt loads without publishing or reporting a failure', async () => {
  const packet = sliceArchitectureNeighborhood(structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot, structuredClone(demoView) as unknown as ArchitectureView, { focusEntityId: 'system:okie' });
  let neighborhood!: (value: typeof packet) => void;
  let excerpts!: (value: []) => void;
  const fixture = compileScanNeighborhoodFixture(packet, demoStory, {
    loadNeighborhood: () => new Promise(resolve => { neighborhood = resolve; }),
    loadExcerpts: () => new Promise(resolve => { excerpts = resolve; }),
    loadStory: async () => demoStory,
  });
  const publish = vi.fn(); const failure = vi.fn();
  const navigation = completeFixturePreparation(fixture.ensureNeighborhood('code:missing-focus'), () => true, publish, failure);
  const source = completeFixturePreparation(fixture.ensureExcerpts('container:web-app'), () => true, publish, failure);
  fixture.disposeSceneWorker(); neighborhood(packet); excerpts([]);
  await Promise.all([navigation, source]);
  expect(publish).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
  expect(fixture.getSceneGeneration()).toBe(0);
});
it('reports real failures and drops obsolete completion without hiding current publication errors', async () => {
  const failure = vi.fn(); const publish = vi.fn(); const error = new Error('host unavailable');
  await completeFixturePreparation(Promise.reject(error), () => true, publish, failure);
  expect(failure).toHaveBeenCalledExactlyOnceWith(error);
  await completeFixturePreparation(Promise.resolve('obsolete'), () => false, publish, failure);
  expect(publish).not.toHaveBeenCalled();
  const publicationError = new Error('publication failed');
  await completeFixturePreparation(Promise.resolve('ready'), () => true, () => { throw publicationError; }, failure);
  expect(failure).toHaveBeenLastCalledWith(publicationError);
});
