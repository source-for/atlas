/**
 * CLA-268: a dynamic import requested early and awaited later. Every caller shares the one pending import; a failed
 * import is forgotten (rather than cached), so the next call — a retry — imports again.
 */
export function retryableImport<T>(load: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    if (!pending) {
      const attempt = load();
      pending = attempt;
      attempt.catch(() => {
        if (pending === attempt) pending = undefined;
      });
    }
    return pending;
  };
}
