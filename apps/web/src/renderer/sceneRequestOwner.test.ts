import { expect, it } from 'vitest';
import { createSceneRequestOwner, ownsNeighborhoodSceneCache, ownsScenePublication, readNeighborhoodScene, retainNeighborhoodScene } from './sceneRequestOwner';
it('only the latest request can publish after rapid navigation, including late replies', async () => {
  const owner = createSceneRequestOwner();
  const first = owner.begin();
  const second = owner.begin();
  expect(first.signal.aborted).toBe(true);
  await Promise.resolve();
  expect(first.owns()).toBe(false);
  expect(second.owns()).toBe(true);
  owner.cancel();
  expect(second.signal.aborted).toBe(true);
  expect(second.owns()).toBe(false);
  const third = owner.begin();
  expect(third.owns()).toBe(true);
});
it('bounds retention to eight and keeps the recently read endpoint', () => {
  const cache = new Map<string, object>();
  const endpoint = {};
  retainNeighborhoodScene(cache, '0', endpoint);
  for (let i = 1; i < 8; i++) retainNeighborhoodScene(cache, String(i), {});
  expect(readNeighborhoodScene(cache, '0')).toBe(endpoint);
  retainNeighborhoodScene(cache, '8', {});
  expect(cache.size).toBe(8);
  expect(cache.has('1')).toBe(false);
  expect(cache.get('0')).toBe(endpoint);
});

it('rejects late publication after scene, semantic scope, selection or fixture changes while permitting camera motion', async () => {
  const source = { fixture: {}, scene: {}, session: {}, selection: 'a' };
  const current = { ...source, camera: { x: 0, zoom: 1 } };
  const request = createSceneRequestOwner().begin();
  const publish = async () => {
    await Promise.resolve();
    return request.owns() && ownsScenePublication(source, current);
  };
  current.camera = { x: 400, zoom: 2 };
  expect(await publish()).toBe(true);
  for (const key of ['fixture', 'scene', 'session', 'selection'] as const) {
    const changed = { ...current, [key]: key === 'selection' ? 'b' : {} };
    expect(ownsScenePublication(source, changed)).toBe(false);
  }
  current.scene = {};
  expect(await publish()).toBe(false);
});

it('invalidates neighborhoods when a replacement fixture has the same graph generation', () => {
  const fixture = {};
  const scope = { fixture, generation: 0 };
  expect(ownsNeighborhoodSceneCache(scope, fixture, 0)).toBe(true);
  expect(ownsNeighborhoodSceneCache(scope, {}, 0)).toBe(false);
  expect(ownsNeighborhoodSceneCache(scope, fixture, 1)).toBe(false);
  expect(ownsNeighborhoodSceneCache(undefined, fixture, 0)).toBe(false);
});
