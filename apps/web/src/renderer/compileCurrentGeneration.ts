/** A data merge invalidates a result, not the caller's navigation intent. */
export async function compileCurrentGeneration<T>(generation: () => number, compile: () => Promise<T>, signal?: AbortSignal, onStable?: (result: T, generation: number) => void): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Scene request superseded', 'AbortError');
    const current = generation();
    try {
      const result = await compile();
      if (signal?.aborted) throw signal.reason ?? new DOMException('Scene request superseded', 'AbortError');
      if (current === generation()) {
        onStable?.(result, current);
        return result;
      }
    } catch (error) {
      if (signal?.aborted || current === generation()) throw error;
    }
  }
  throw new Error('Atlas data kept changing during scene preparation. Try again.');
}
