/** Fixture disposal is expected lifecycle cancellation. Genuine load/publication
 * failures remain visible to the current caller rather than becoming unhandled. */
export async function completeFixturePreparation<T>(work: Promise<T>, current: () => boolean, publish: (result: T) => void, reportFailure: (error: unknown) => void): Promise<void> {
  try {
    const result = await work;
    if (current()) publish(result);
  } catch (error) {
    if (current() && !(typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')) reportFailure(error);
  }
}
