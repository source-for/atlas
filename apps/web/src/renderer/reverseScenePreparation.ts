/** Reverse zoom retains the current map and camera while preparing one adjacent
 * endpoint. Graph merges are allowed during ensure, then publication owns the
 * exact compilation generation, including the final promise microtask. */
export async function prepareReverseScene<T>(input: {
  signal: AbortSignal;
  owns(): boolean;
  generation(): number;
  ensure(): Promise<void>;
  compile(): Promise<T>;
  publish(scene: T): void;
}): Promise<void> {
  await input.ensure();
  if (input.signal.aborted || !input.owns()) return;
  const generation = input.generation();
  const prepared = await input.compile();
  if (input.signal.aborted || !input.owns() || generation !== input.generation()) return;
  input.publish(prepared);
}
