import { expect, it } from 'vitest';
import { awaitAbortableWork } from './abortableWork';
it('releases an optional sidecar wait on cancellation and consumes a late failure', async () => {
  const controller = new AbortController(); let fail!: (error: Error) => void;
  const work = new Promise<void>((_resolve, reject) => { fail = reject; });
  const pending = awaitAbortableWork(work, controller.signal);
  const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  controller.abort(); await rejection; fail(new Error('late network failure')); await Promise.resolve();
});
it('handles an already-aborted signal and preserves normal completion', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(awaitAbortableWork(Promise.reject(new Error('late')), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(await awaitAbortableWork(Promise.resolve(42), new AbortController().signal)).toBe(42);
});
