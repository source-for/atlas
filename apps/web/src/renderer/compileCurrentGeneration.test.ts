import { expect, it, vi } from 'vitest';
import { compileCurrentGeneration } from './compileCurrentGeneration';
it('retries a merge-invalidated compile and returns the current result', async () => {
  let generation = 1;
  const compile = vi.fn(async () => { if (generation === 1) { generation++; throw new DOMException('Snapshot changed', 'AbortError'); } return generation; });
  expect(await compileCurrentGeneration(() => generation, compile)).toBe(2);
  expect(compile).toHaveBeenCalledTimes(2);
});
it('drops a completed old generation and bounds continuing merges', async () => {
  let generation = 1;
  const compile = vi.fn(async () => generation++);
  await expect(compileCurrentGeneration(() => generation, compile)).rejects.toThrow('kept changing');
  expect(compile).toHaveBeenCalledTimes(3);
});
it('never retries cancelled navigation or unrelated errors', async () => {
  const controller = new AbortController();
  let generation = 1;
  const compile = vi.fn(async () => { generation++; controller.abort(); return 'old'; });
  await expect(compileCurrentGeneration(() => generation, compile, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(compile).toHaveBeenCalledTimes(1);
  await expect(compileCurrentGeneration(() => 1, async () => { throw new Error('broken'); })).rejects.toThrow('broken');
});
it('records only the successful stable generation, including immediate cached results', async () => {
  let generation = 1; const stable = vi.fn(); const cached = {};
  const result = await compileCurrentGeneration(() => generation, async () => { if (generation === 1) generation++; return cached; }, undefined, stable);
  expect(result).toBe(cached); expect(stable).toHaveBeenCalledExactlyOnceWith(cached, 2);
});
