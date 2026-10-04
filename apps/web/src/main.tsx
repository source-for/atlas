import { StrictMode } from 'react';
import { installPerformanceDiagnostics } from './performance/install';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@fontsource/ibm-plex-sans/latin-400.css';
import '@fontsource/ibm-plex-sans/latin-500.css';
import '@fontsource/ibm-plex-sans/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-600.css';
import '@okie/theme/tokens.css';
import './app.css';
import { ASPECT_PRESET_TARGET, parsePortableAtlas, type PortableAtlas } from '@okie/architecture';
import { installPublishedAtlasAttribution } from './atlasAttribution';
import { hostedAtlasBootPlan } from './hostedAtlas';
import { installPublicAtlasOembedDiscovery } from './oembed';
import { readDemoQuery } from './renderer/query';
import { setActiveScanFixture } from './renderer/fixtureBundle';
import { compileScanFixture } from './renderer/scanFixture';
import { PortableAtlasControls } from './portable/PortableAtlasControls';
import { PortableAtlasOpenScreen } from './portable/PortableAtlasOpenScreen';
import { portableNavigationDiffers, portableReloadPath, setActivePortableAtlas } from './portable/runtime';
import { createIndexedDbPortableStore, createPortablePersistence, portableStorageKey } from './portable/storage';
import { registerWebMcpFoundation } from './webmcp';
import { applyPageMeta, SITE_NAME } from './siteMeta';
import { bootPlan } from './bootPlan';
import { mountCookieNotice } from './cookieNotice';
import { MobileNotice, mobileNoticeCopy, readMobileGateInput } from './mobileGate';
import { NotFoundScreen } from './siteFooter';
import { readPortableFile, rememberPortableSession, forgetPortableSession } from './portable/session';
import { OperatorWorkspace } from './operator/OperatorWorkspace';
import { previewReturnSelection } from './operator/workspaceController';
import { clearDraftPreviewContext, setDraftPreviewContext, setPublishedPreviewContext } from './operator/previewContext';
import { loadPublishedExplanations } from './operator/publishedExplanations';
import { captureBlockPlannerQueryFlag, setBlockPlannerScan } from './blocks/blockPlannerScan';
import { documentPageFor, setDocumentPage } from './pageScroll';
import {
  availableScanRepoSlugs,
  fetchScanNeighborhoodHost,
  fetchScanTrioLoader,
  loadScanFixture,
  loadScanNeighborhoodFixtureFromSearch,
  ScanFixtureError,
  type ScanFixture,
  type ScanTrioLoader,
} from './renderer/scanFixture';

const performanceDiagnostics = installPerformanceDiagnostics();
performanceDiagnostics.mark('bootstrap-start');
import.meta.hot?.dispose(() => performanceDiagnostics.dispose());

// CLA-149: read `?planner=jev` before anything can rewrite the URL.
captureBlockPlannerQueryFlag(window.location.search);
const root = createRoot(document.getElementById('root')!);
let indexedDb: IDBFactory | undefined;
try { indexedDb = window.indexedDB; } catch { /* Browser policy may deny even reading the factory. */ }
let portablePersistence = createPortablePersistence(createIndexedDbPortableStore(indexedDb, `active-v1:${new URL('./', window.location.href).pathname}`));

/**
 * Published scan / neighborhood compile aspect (CLA-96). Landscape ~1.6 is a
 * compile input, not the live viewport, so `/r/…` L1 Fit is a shareable
 * context map. Portrait reflow is not this slice; golden/demo omit targetAspect.
 */
function bootstrapScanAspect(): number {
  return ASPECT_PRESET_TARGET.landscape;
}

function ScanErrorScreen({ error }: { error: unknown }) {
  const issues = error instanceof ScanFixtureError ? error.issues : [];
  const message = error instanceof Error ? error.message : String(error);
  return <main role="alert" style={{ maxWidth: '720px', margin: '0 auto', padding: '4rem 1.5rem', color: '#eef4f2', fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif' }}>
    <h1 style={{ fontSize: '1.4rem', marginBottom: '0.75rem' }}>Scanned snapshot could not be loaded</h1>
    <p style={{ color: '#b7c3c0' }}>The <code>fixtures/scan/</code> trio failed to load or validate. Nothing is rendered rather than showing an invalid snapshot.</p>
    {issues.length
      ? <ul style={{ lineHeight: 1.8 }}>{issues.map((issue, index) => <li key={index}>{issue.path ? <><code style={{ color: '#d9ff70' }}>{issue.path}</code>{' — '}</> : null}{issue.message}</li>)}</ul>
      : <pre style={{ whiteSpace: 'pre-wrap', color: '#ff9b9b' }}>{message}</pre>}
    <p style={{ color: '#79dfd4', marginTop: '1.5rem' }}>Regenerate with <code>okie-scan</code>, or load the <a href="?fixture=okie" style={{ color: '#79dfd4' }}>demo</a>.</p>
  </main>;
}

async function tryBootScanFixture(
  load: ScanTrioLoader | undefined,
  slug: string | undefined,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  try {
    const fixture: ScanFixture = await loadScanFixture(load, { targetAspect: bootstrapScanAspect() }, slug);
    setActiveScanFixture(fixture);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function tryBootNeighborhoodFixture(
  slug: string | undefined,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  root.render(<main aria-busy="true" role="status" style={{ padding: '4rem 2rem', color: '#eef4f2', fontFamily: 'IBM Plex Sans, sans-serif' }}><h1>Preparing architecture map…</h1><p>Loading the published information and arranging your first view.</p></main>);
  try {
    const fixture: ScanFixture = await loadScanNeighborhoodFixtureFromSearch(
      fetchScanNeighborhoodHost(slug),
      window.location.search,
      { targetAspect: bootstrapScanAspect() },
    );
    setActiveScanFixture(fixture);
    // CLA-149: the Jev block planner (flagged) plans against this exact immutable publication only.
    setBlockPlannerScan(slug && fixture.publication ? { slug, versionId: fixture.publication.versionId } : undefined);
    if (slug && fixture.publication) {
      try {
        const scopes = await loadPublishedExplanations(slug, fixture.publication.versionId);
        if (scopes) setPublishedPreviewContext(fixture.publication.versionId, scopes);
      } catch {
        // Never mix explanation content from another publication. The atlas itself
        // remains readable when this optional sidecar is absent or unavailable.
      }
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

async function bootScanFixture(load: ScanTrioLoader | undefined, slug: string | undefined): Promise<boolean> {
  const result = await tryBootScanFixture(load, slug);
  if (!result.ok) {
    setDocumentPage(documentPageFor('error'));
    root.render(<StrictMode><ScanErrorScreen error={result.error} /></StrictMode>);
    return false;
  }
  return true;
}

function portableMarkerEnabled(): boolean {
  return document.querySelector('meta[name="okie-portable"]')?.getAttribute('content') === 'true';
}

function preparePortableAtlas(bundle: PortableAtlas): { fixture?: ScanFixture; error?: string } {
  try {
    const fixture = compileScanFixture({
      snapshot: bundle.snapshot,
      view: bundle.view,
      story: bundle.story,
      stories: { stories: bundle.stories },
    }, { targetAspect: bootstrapScanAspect() });
    return { fixture };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

let portableMountSequence = 0;
/** Restored when returning from a draft preview. `draftRevisionId` only when the reviewed revision was an explicit pin (CLA-264): otherwise the workspace follows the run's current revision. */
let operatorReviewSelection: { runId?: string; draftRevisionId?: string } = {};

async function mountPortableAtlas(bundle: PortableAtlas, fixture: ScanFixture, notice?: string, resetNavigation = true): Promise<void> {
  const { App, refreshAppScanFixture } = await import('./App');
  // Unmount first: no old App effect may observe the replacement's module state.
  flushSync(() => root.render(null));
  setActivePortableAtlas(bundle);
  setBlockPlannerScan(undefined);
  setActiveScanFixture(fixture);
  refreshAppScanFixture();
  if (resetNavigation || portableNavigationDiffers(window.location.search, bundle)) {
    window.history.replaceState(null, '', portableReloadPath({ pathname: window.location.pathname, hash: '' }));
  }
  portableMountSequence += 1;
  setDocumentPage(documentPageFor('portable'));
  root.render(<StrictMode key={portableMountSequence}>
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
    <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}><App /></div>
    <PortableAtlasControls bundle={bundle} notice={notice}
      onReplace={openPortableFile}
      onForget={async () => {
        const message = await forgetPortableSession(portablePersistence);
        flushSync(() => root.render(null));
        setActivePortableAtlas(undefined);
        setActiveScanFixture(undefined);
        refreshAppScanFixture();
        window.history.replaceState(null, '', portableReloadPath({ pathname: window.location.pathname, hash: '' }, true));
        showPortablePicker(message);
        return { ok: true };
      }}
    />
    </div>
  </StrictMode>);
}

/** Operator previews deliberately use the same compiled atlas and App as a portable
 * bundle, but never place a draft in the user's portable IndexedDB session. */
async function mountOperatorDraftPreview(draftRevisionId: string, scopes: import('./operator/api').OperatorScope[]): Promise<void> {
  const { operatorApi } = await import('./operator/api');
  const raw = await operatorApi.bundle(draftRevisionId);
  const bundle = parsePortableAtlas(JSON.stringify(raw));
  const prepared = preparePortableAtlas(bundle);
  if (!prepared.fixture) throw new Error(prepared.error ?? 'Draft bundle could not be compiled.');
  const { App, refreshAppScanFixture } = await import('./App');
  flushSync(() => root.render(null));
  setActivePortableAtlas(bundle);
  setBlockPlannerScan(undefined);
  setDraftPreviewContext(draftRevisionId, scopes);
  setActiveScanFixture(prepared.fixture);
  refreshAppScanFixture();
  setDocumentPage(documentPageFor('preview'));
  root.render(<StrictMode><div className="operator-preview-shell"><header><span>Operator draft preview · pinned revision {draftRevisionId}</span><button onClick={() => { setActivePortableAtlas(undefined); clearDraftPreviewContext(); setActiveScanFixture(undefined); refreshAppScanFixture(); void mountOperatorWorkspace(); }}>Return to review</button></header><div><App /></div></div></StrictMode>);
}

async function mountOperatorWorkspace(): Promise<void> {
  flushSync(() => root.render(null));
  clearDraftPreviewContext();
  setDocumentPage(documentPageFor('operator'));
  root.render(<StrictMode><OperatorWorkspace initialDraftRevisionId={operatorReviewSelection.draftRevisionId} initialRunId={operatorReviewSelection.runId} onPreview={async (runId, draftRevisionId, scopes, pinned) => { operatorReviewSelection = previewReturnSelection(runId, draftRevisionId, pinned); await mountOperatorDraftPreview(draftRevisionId, scopes); }}/></StrictMode>);
}

async function openPortableFile(file: File): Promise<{ ok: true } | { ok: false; message: string }> {
  const loaded = await readPortableFile(file);
  if (!loaded.bundle) return { ok: false, message: loaded.error ?? 'Could not read this atlas.' };
  const prepared = preparePortableAtlas(loaded.bundle);
  if (!prepared.fixture) return { ok: false, message: prepared.error ?? 'Could not compile this atlas.' };
  const notice = await rememberPortableSession(portablePersistence, loaded.bundle);
  await mountPortableAtlas(loaded.bundle, prepared.fixture, notice);
  return { ok: true };
}

function showPortablePicker(error?: string): void {
  setDocumentPage(documentPageFor('picker'));
  root.render(<StrictMode><PortableAtlasOpenScreen error={error} onOpen={openPortableFile} /></StrictMode>);
}

async function bootPortableAtlas(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  let unavailableMessage: string | undefined;
  let packaged: PortableAtlas | undefined;
  // Resolve this site's package before consulting remembered imports. Each static
  // folder and each deployed artifact version owns a separate convenience slot.
  try {
    const response = await fetch('./atlas.okie.json');
    if (response.ok) {
      const text = await response.text();
      packaged = parsePortableAtlas(text);
      try {
        const key = await portableStorageKey(window.location.href, text);
        portablePersistence = createPortablePersistence(createIndexedDbPortableStore(indexedDb, key));
      } catch {
        // Without a reliable package identity, retain session-only operation.
        portablePersistence = createPortablePersistence(createIndexedDbPortableStore(undefined));
      }
    } else if (response.status !== 404) {
      unavailableMessage = `Packaged atlas is unavailable (${response.status}).`;
    }
  } catch (error) {
    unavailableMessage = error instanceof Error ? error.message : String(error);
  }
  if (params.get('open') !== '1') {
    const remembered = await portablePersistence.restore();
    if (remembered.bundle) {
      const prepared = preparePortableAtlas(remembered.bundle);
      if (prepared.fixture) {
        await mountPortableAtlas(remembered.bundle, prepared.fixture, undefined, false);
        return;
      }
      unavailableMessage = `The saved local atlas could not be compiled: ${prepared.error}`;
    } else if (remembered.error) {
      unavailableMessage ??= remembered.error;
    }
    if (packaged) {
      const prepared = preparePortableAtlas(packaged);
      if (prepared.fixture) {
        const notice = await rememberPortableSession(portablePersistence, packaged);
        await mountPortableAtlas(packaged, prepared.fixture, notice, false);
        return;
      }
      unavailableMessage = prepared.error;
    }
  }
  showPortablePicker(unavailableMessage);
}

async function boot() {
  // WebMCP is progressive enhancement (CLA-40). Missing APIs are a silent no-op.
  void registerWebMcpFoundation();
  // CLA-318: the whole mount decision (and its ordering) is bootPlan.ts, unit-tested.
  const plan = bootPlan({
    pathname: window.location.pathname,
    search: window.location.search,
    portableMarker: portableMarkerEnabled(),
    gate: readMobileGateInput(),
  });
  // CLA-316: the cookie notice, in its own root outside App (never in embeds, portable, operator or demos).
  void mountCookieNotice({ portable: plan.kind === 'portable' });
  if (plan.kind === 'portable') {
    // A self-hosted portable viewer is not a sourcefor.dev page: brand the tab only. applyPageMeta (and
    // its canonical) never runs here, and build-portable-viewer.mjs strips the shell's canonical/og/twitter tags.
    document.title = SITE_NAME;
    await bootPortableAtlas();
    return;
  }
  // CLA-318: per-route <title>, description and canonical (every route change is a full page load).
  applyPageMeta(document, window.location.pathname);
  if (plan.kind === 'operator') {
    await mountOperatorWorkspace();
    return;
  }
  // A path the SPA does not route. The edge and Vite servers already answer these with the static
  // 404 page (real status); this covers any other host that falls back to the shell.
  if (plan.kind === 'notFound') {
    document.title = `Page not found · ${SITE_NAME}`;
    setDocumentPage(documentPageFor('landing'));
    root.render(<StrictMode><NotFoundScreen /></StrictMode>);
    return;
  }
  // A scanned fixture is fetched, validated and compiled BEFORE App is imported,
  // so App reads the compiled scene/story synchronously (like the golden fixture).
  //
  // Selection, in order:
  //   /new                       → the paste-a-repo landing (no atlas machinery)
  //   /r/<owner>/<repo>          → public share URL (no login). Neighborhood
  //                                packet via runtime fetch (CLA-73); THISS/okie
  //                                also falls back through the bundled self-scan
  //                                to the golden demo.
  //   ?fixture=scan[:<slug>]     → neighborhood fetch first, then the R3a glob
  if (plan.kind === 'landing') {
    const { ScanLandingScreen } = await import('./scanLanding');
    setDocumentPage(documentPageFor('landing'));
    root.render(<StrictMode><ScanLandingScreen /></StrictMode>);
    return;
  }
  const { route } = plan;
  // A touch-primary small screen gets a "best on a larger screen" notice before any atlas loads (never in
  // embeds); "Continue anyway" carries on and is remembered for the session.
  if (plan.kind === 'mobileNotice') {
    setDocumentPage(documentPageFor('landing'));
    const copy = mobileNoticeCopy(route);
    await new Promise<void>(resolve => {
      root.render(<StrictMode><MobileNotice description={copy.description} heading={copy.heading} onContinue={resolve} /></StrictMode>);
    });
    flushSync(() => root.render(null));
    window.scrollTo(0, 0);
  }
  if (route.kind === 'repo') {
    // Public share URL (no login). oEmbed discovery points docs sites at /oembed.
    installPublicAtlasOembedDiscovery(window.location.href);
    const plan = hostedAtlasBootPlan(route, { bundledSlugs: availableScanRepoSlugs() });
    let lastError: unknown;
    let atlasReady = false;
    for (const step of plan) {
      if (step.kind === 'golden') {
        atlasReady = true;
        break;
      }
      if (step.kind === 'fetch') {
        const neighborhood = await tryBootNeighborhoodFixture(step.slug);
        if (neighborhood.ok) {
          atlasReady = true;
          break;
        }
        lastError = neighborhood.error;
        continue;
      }
      const result = await tryBootScanFixture(undefined, step.slug);
      if (result.ok) {
        atlasReady = true;
        break;
      }
      lastError = result.error;
    }
    if (!atlasReady) {
      setDocumentPage(documentPageFor('error'));
      root.render(<StrictMode><ScanErrorScreen error={lastError} /></StrictMode>);
      return;
    }
  } else {
    const query = readDemoQuery(window.location.search);
    if (query.fixture === 'scan') {
      const neighborhood = await tryBootNeighborhoodFixture(query.scanRepo);
      if (!neighborhood.ok) {
        const bundled = query.scanRepo === undefined || availableScanRepoSlugs().includes(query.scanRepo);
        const load = bundled ? undefined : fetchScanTrioLoader(query.scanRepo);
        if (!await bootScanFixture(load, query.scanRepo)) return;
      }
    }
  }
  const { App } = await import('./App');
  setDocumentPage(documentPageFor('atlas'));
  root.render(<StrictMode><App /></StrictMode>);
  // CLA-266: a published atlas credits its upstream repository, commit and licence; embeds get the compact
  // owner/repo · licence · source line (CLA-328). The result also tells App the atlas is a publication (CLA-329).
  if (route.kind === 'repo') void installPublishedAtlasAttribution(route.slug);
}

void boot().then(() => performanceDiagnostics.mark('bootstrap-complete'));
