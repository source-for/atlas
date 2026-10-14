import { ScanFixtureError } from './renderer/scanFixture';

/**
 * Shown when a scanned or published atlas fails to load or validate (a missing repository, an aborted or failed
 * neighbourhood request). Nothing is rendered rather than an invalid snapshot. CLA-268: "Try again" re-runs the boot
 * (a reload), since a failed request is often transient.
 */
export function ScanErrorScreen({ error, onRetry }: { error: unknown; onRetry(): void }) {
  const issues = error instanceof ScanFixtureError ? error.issues : [];
  const message = error instanceof Error ? error.message : String(error);
  return <main role="alert" style={{ maxWidth: '720px', margin: '0 auto', padding: '4rem 1.5rem', color: '#eef4f2', fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif' }}>
    <h1 style={{ fontSize: '1.4rem', marginBottom: '0.75rem' }}>Scanned snapshot could not be loaded</h1>
    <p style={{ color: '#b7c3c0' }}>The <code>fixtures/scan/</code> trio failed to load or validate. Nothing is rendered rather than showing an invalid snapshot.</p>
    {issues.length
      ? <ul style={{ lineHeight: 1.8 }}>{issues.map((issue, index) => <li key={index}>{issue.path ? <><code style={{ color: '#d9ff70' }}>{issue.path}</code>{' — '}</> : null}{issue.message}</li>)}</ul>
      : <pre style={{ whiteSpace: 'pre-wrap', color: '#ff9b9b' }}>{message}</pre>}
    <p style={{ color: '#79dfd4', marginTop: '1.5rem' }}>Regenerate with <code>okie-scan</code>, or load the <a href="?fixture=okie" style={{ color: '#79dfd4' }}>demo</a>.</p>
    <button onClick={onRetry} style={{ marginTop: '1rem', padding: '0.5rem 1rem', border: '1px solid #79dfd4', borderRadius: '6px', background: 'transparent', color: '#79dfd4', font: 'inherit', cursor: 'pointer' }} type="button">Try again</button>
  </main>;
}
