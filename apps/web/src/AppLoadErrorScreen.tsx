/**
 * CLA-268: shown instead of the boot skeleton when App's own code fails to load (most often a tab opened before a
 * deploy, whose hashed chunk is gone). The skeleton would otherwise claim "Opening the map…" for good. Reloading
 * fetches the current page and its chunks.
 */
export function AppLoadErrorScreen({ error, onReload }: { error: unknown; onReload(): void }) {
  const message = error instanceof Error ? error.message : String(error);
  return <main role="alert" style={{ maxWidth: '720px', margin: '0 auto', padding: '4rem 1.5rem', color: '#eef4f2', fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif' }}>
    <h1 style={{ fontSize: '1.4rem', marginBottom: '0.75rem' }}>The atlas could not be opened</h1>
    <p style={{ color: '#b7c3c0' }}>Its data loaded, but part of the app did not. This can happen when the site was updated after this page was opened. Reloading the page usually fixes it.</p>
    <pre style={{ whiteSpace: 'pre-wrap', color: '#ff9b9b' }}>{message}</pre>
    <button onClick={onReload} style={{ marginTop: '1rem', padding: '0.5rem 1rem', border: '1px solid #79dfd4', borderRadius: '6px', background: 'transparent', color: '#79dfd4', font: 'inherit', cursor: 'pointer' }} type="button">Reload page</button>
  </main>;
}
