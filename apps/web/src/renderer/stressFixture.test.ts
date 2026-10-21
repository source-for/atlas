import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('stress fixture placeholder', () => {
  it('says the fixture is loading in a build that includes it', async () => {
    const { stressPlaceholder } = await import('./stressFixture');
    expect(stressPlaceholder.title).toBe('Loading stress fixture…');
  });

  it('states up front that the portable viewer omits the fixture, and loading rejects with the same reason', async () => {
    vi.stubEnv('MODE', 'portable');
    const { loadStressFixture, stressPlaceholder } = await import('./stressFixture');
    expect(stressPlaceholder.title).toBe('Stress fixture not included');
    expect(stressPlaceholder.name).toBe('Not in this viewer');
    expect(stressPlaceholder.responsibility).toBe('The renderer stress fixture is not included in the portable viewer.');
    await expect(loadStressFixture()).rejects.toThrow(stressPlaceholder.responsibility);
  });
});
