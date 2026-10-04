import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const sourceRepoLink = readFileSync(new URL('./sourceRepoLink.tsx', import.meta.url), 'utf8');
const askPanel = readFileSync(new URL('./ask/AskPanel.tsx', import.meta.url), 'utf8');
const askCss = readFileSync(new URL('./ask/ask.css', import.meta.url), 'utf8');
const diagramView = readFileSync(new URL('./diagram/SemanticDiagramSurface.tsx', import.meta.url), 'utf8');
const briefView = readFileSync(new URL('./inspector/ArchitectureBriefView.tsx', import.meta.url), 'utf8');

function declarations(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1]!;
}

function pixels(block: string, property: string): number {
  const match = block.match(new RegExp(`${property}:\\s*(\\d+)px`));
  if (!match) throw new Error(`Missing pixel declaration for ${property}`);
  return Number(match[1]);
}

describe('shared map control layout', () => {
  it('reserves the details-toggle lane beside the desktop authoring toolbar', () => {
    const toolbar = declarations(css, '.authoring-toolbar');
    const toggle = declarations(css, '.details-toggle');
    const gap = pixels(toolbar, 'right') - pixels(toggle, 'right') - pixels(toggle, 'width');

    expect(gap).toBeGreaterThanOrEqual(8);
  });

  it('stacks mobile authoring below the details and entity controls', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 780px)'));
    const toolbar = declarations(mobile, '.authoring-toolbar');
    const explorer = declarations(mobile, '.entity-explorer');
    const explorerBottom = pixels(explorer, 'top') + 31;

    expect(pixels(toolbar, 'top') - explorerBottom).toBeGreaterThanOrEqual(8);
  });
});

describe('map heading chrome shield (CLA-108)', () => {
  it('occludes world labels under the heading without deleting map titles', () => {
    const heading = declarations(css, '.map-heading');
    const canvas = declarations(css, '.atlas-canvas');

    expect(heading).toMatch(/z-index:\s*8/);
    expect(heading).toContain('isolation: isolate');
    expect(heading).toContain('background: rgba(7, 10, 11, 0.94)');
    expect(heading).toContain('box-shadow: 0 0 32px 20px rgba(7, 10, 11, 0.78)');
    expect(heading).toContain('backdrop-filter: blur(16px)');
    expect(canvas).toMatch(/z-index:\s*0/);
    expect(app).toContain('className="map-heading"');
    expect(app).toContain('<h1>{scene.title}</h1>');
    expect(app).toContain('className="semantic-breadcrumb"');
    expect(app).toContain("{ rect: rect('.map-heading'), edge: 'top' as const }");
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    const fixture = (readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8') + readFileSync(new URL('./renderer/scanScene.ts', import.meta.url), 'utf8'));
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
  });
});

describe('canvas hint chrome shield (CLA-115)', () => {
  it('occludes world labels under the gesture hint without deleting the hint', () => {
    const hint = declarations(css, '.canvas-hint');
    const heading = declarations(css, '.map-heading');
    const canvas = declarations(css, '.atlas-canvas');

    expect(hint).toMatch(/z-index:\s*8/);
    expect(hint).toContain('isolation: isolate');
    expect(hint).toContain('background: rgba(7, 10, 11, 0.94)');
    expect(hint).toContain('box-shadow: 0 0 32px 20px rgba(7, 10, 11, 0.78)');
    expect(hint).toContain('backdrop-filter: blur(16px)');
    expect(hint).toContain('border-radius: 12px');
    expect(hint).toContain('padding: 6px 14px 8px');
    expect(heading).toContain('background: rgba(7, 10, 11, 0.94)');
    expect(heading).toContain('backdrop-filter: blur(16px)');
    expect(canvas).toMatch(/z-index:\s*0/);
    expect(app).toContain('className="canvas-hint"');
    expect(app).toContain('<span>Pinch or wheel to zoom</span><i/>drag to pan<i/>');
    expect(app).toContain('drag to pan');
    expect(app).toContain('click to inspect');
    expect(app).toContain('double-click to open inside');
    expect(app).toContain("{ rect: rect('.canvas-hint'), edge: 'bottom' as const }");
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    const fixture = (readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8') + readFileSync(new URL('./renderer/scanScene.ts', import.meta.url), 'utf8'));
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
  });
});

describe('view and edit interaction modes', () => {
  it('defaults to View and gates every relationship mutation surface behind Edit', () => {
    expect(app).toContain("useState<'view' | 'edit'>('view')");
    expect(app).toContain("const editingEnabled = interactionMode === 'edit' && authoringEnabled");
    expect(app).toContain('authoringEnabled={editingEnabled}');
    expect(app).toContain("{interactionMode === 'edit' && <div aria-label=\"Relationship authoring tools\"");
    expect(app).toContain("{interactionMode === 'edit' && <div aria-label=\"Relationship editing actions\"");
    expect(app).toContain("if (!editingEnabled || !pickedRelationId)");
    expect(app).toContain('data-interaction-mode={interactionMode}');
  });

  it('cancels in-flight connect and route-guide drafts when Edit is left', () => {
    const viewportStart = app.indexOf('function CanvasViewport');
    const viewportEnd = app.indexOf('function App()', viewportStart);
    const viewport = app.slice(viewportStart, viewportEnd);

    expect(viewport).toContain('if (authoringEnabled) return;');
    expect(viewport).toContain('authoringPointerRef.current = undefined;');
    expect(viewport).toContain('updateConnectionDraft(undefined);');
    expect(viewport).toContain('updateGuideDraft(undefined);');
    expect(app).toContain("if (next === 'view') setAuthoringTool('select')");
  });

  it('keeps selected View flow rendering continuously but suspends it during route authoring', () => {
    const viewportStart = app.indexOf('function CanvasViewport');
    const viewportEnd = app.indexOf('function App()', viewportStart);
    const viewport = app.slice(viewportStart, viewportEnd);

    expect(viewport).toContain('pointerInteraction: currentPointerInteraction()');
    expect(viewport).toContain("if (authoringPointerRef.current) return 'authoring-drag'");
    expect(viewport).toContain("return pointerRef.current?.moved ? 'camera-pan' : 'idle'");
    expect(viewport).toContain('animate: animation.animateFlow');
    expect(viewport).toContain('syncContinuousRendering();');
  });

  it('does not route camera pan through the story-interruption callback', () => {
    const panStart = app.indexOf('function handlePointerMove');
    const panEnd = app.indexOf('function handlePointerUp', panStart);
    const panHandler = app.slice(panStart, panEnd);
    const cameraPan = panHandler.slice(panHandler.indexOf('pointer.moved = true'));

    expect(cameraPan).toContain('syncContinuousRendering();');
    expect(cameraPan).not.toContain("onInteractionStartRef.current('Panned the map'");
  });

  it('cancels only the transient inspector flight for direct pan, wheel, and pinch', () => {
    const viewportStart = app.indexOf('function CanvasViewport');
    const viewportEnd = app.indexOf('function App()', viewportStart);
    const viewport = app.slice(viewportStart, viewportEnd);

    expect(app).toContain('onCameraFlightCancel={handleDirectCameraInput}');
    const directInput = app.slice(app.indexOf('function handleDirectCameraInput'), app.indexOf('function handleMapInteractionStart'));
    expect(directInput).toContain('beginUserCameraIntent();');
    expect(directInput).toContain('return cancelInspectorCameraFlight();');
    expect(directInput).not.toContain('interruptStory');
    expect(app).toContain('const liveCamera = { ...renderedCameraRef.current };');
    expect(app).toContain('updateCamera(liveCamera);');
    expect(viewport.match(/onCameraFlightCancelRef\.current\(\)/g)).toHaveLength(3);
    expect(viewport).toContain("onInteractionStartRef.current('Pinched the map'");
    expect(viewport).not.toContain("onInteractionStartRef.current('Panned the map'");
  });

  it('interrupts a guided story on trackpad two-finger scroll-pan (CLA-326)', () => {
    const panStart = app.indexOf('const wheelPan = ');
    const panEnd = app.indexOf('const installSession = ', panStart);
    const wheelPan = app.slice(panStart, panEnd);

    expect(panStart).toBeGreaterThan(0);
    expect(wheelPan).toContain("onInteractionStartRef.current('Scrolled the map', liveCameraRef.current);");
    expect(wheelPan.indexOf("'Scrolled the map'")).toBeLessThan(wheelPan.indexOf('applyLiveCameraRef.current(next)'));
  });

  it('presents the mode choice as a polished two-state control', () => {
    expect(app).toContain('data-testid="interaction-mode-view"');
    expect(app).toContain('data-testid="interaction-mode-edit"');
    expect(declarations(css, '.diagram-mode-toggle')).toContain('border-radius: 8px');
    expect(declarations(css, '.diagram-mode-toggle button')).toContain('min-width: 55px');
    expect(css).toContain('.mode-indicator');
    expect(css).toContain('@keyframes authoring-tools-enter');
  });
});

describe('multi-diagram workspace shell', () => {
  it('renders one active panel with a pinned Main tab and closable derived tabs', () => {
    expect(app).toContain('role="tablist"');
    // Main tab shows no kind badge and no visible "Pinned" label (production chrome),
    // but retains its pinned accessible name.
    expect(app).not.toContain('<small>Pinned</small>');
    expect(app).toContain("aria-label={surface.kind === 'main' ? 'Main diagram, pinned'");
    expect(app).toContain("surface.kind !== 'main' && <span aria-hidden=\"true\" className={`diagram-kind-mark");
    expect(app).toContain('surface.closable && <button');
    expect(app).toContain("activeDiagramSurface.kind === 'main' ? <>");
    expect(app.match(/<CanvasViewport/g)).toHaveLength(1);
    expect(app).toContain('<SemanticDiagramSurface');
  });

  it('offers a mobile Views switcher and an inspector path to a dynamic Flow surface', () => {
    expect(app).toContain('className="mobile-diagram-switcher"');
    expect(app).toContain('aria-label="Active diagram view"');
    expect(app).toContain('data-diagram-action="open-flow"');
    expect(app).toContain("openDerivedDiagram('flow', story)");

    const mobile = css.slice(css.indexOf('@media (max-width: 780px)'));
    expect(declarations(mobile, '.diagram-tabs')).toContain('display: none');
    expect(declarations(mobile, '.mobile-diagram-switcher')).toContain('display: flex');
  });

  it('feeds derived flow and Mermaid surfaces from semantic compiler artifacts with notation readiness', () => {
    expect(app).toContain('compileC4DynamicFlowArtifact');
    expect(app).toContain('serializeDynamicFlowMermaid');
    expect(app).toContain('validateC4NotationCompleteness');
    expect(app).toContain('flowArtifact={activeDynamicFlowArtifact}');
    expect(diagramView).toContain('data-diagram-action="open-mermaid"');
    expect(css).toContain('.notation-readiness');
    expect(css).toContain('.notation-readiness-list');
    expect(css).toContain('.semantic-diagram-readiness');
  });

  it('reserves one compact shell row above the shared workspace panel', () => {
    expect(declarations(css, '.app-shell')).toContain('grid-template-rows: var(--topbar-height) var(--diagram-tabs-height) minmax(0, 1fr)');
    expect(declarations(css, '.diagram-view-bar')).toContain('border-bottom: 1px solid var(--atlas-line)');
  });
});

describe('compact inspector presentation', () => {
  it('keeps one swappable entity presentation with immediate actions and ordered navigation sections', () => {
    const presentationStart = app.indexOf('data-inspector-presentation="entity"');
    const actions = app.indexOf('aria-label="Entity actions"', presentationStart);
    const children = app.indexOf('<h3>Inside this layer</h3>', presentationStart);
    const relationships = app.indexOf('<h3>Relationships</h3>', presentationStart);
    const sources = app.indexOf('<h3>Source evidence</h3>', presentationStart);

    expect(presentationStart).toBeGreaterThan(0);
    expect(actions).toBeGreaterThan(presentationStart);
    expect(children).toBeGreaterThan(actions);
    expect(relationships).toBeGreaterThan(children);
    expect(sources).toBeGreaterThan(relationships);
    expect(app).toContain("detailListVisible('children', inspectorChildren)");
    expect(app).toContain('Known, not shown at this zoom');
    expect(app).not.toContain('child.responsibility || child.kindLabel');
    expect(app).toContain('inspectorSecondaryCopy(selectedParent)');
    expect(app).toContain('inspectorSecondaryCopy(entity)');
    expect(app).not.toContain('entity.kindLabel ?? entity.kind} · {entity.responsibility}');
    expect(app).toContain('entity.source ?? inspectorAcceptedSummary(entity)');
    expect(app).toContain('inspectorAcceptedSummary(entity) ? `${entity.name} selected. ${inspectorAcceptedSummary(entity)}`');
    expect(app).toContain("detailListVisible('source', selected.sourceRefs).map((source, index) =>");
  });

  it('enables the Source tab from inspectorCanShowSource rather than a hardcoded disable', () => {
    expect(app).toContain('inspectorCanShowSource(selected, { pickedRelation: Boolean(pickedRelation) })');
    expect(app).toContain('inspectorTabForEntity(inspectorCanShowSource(entity), intent)');
    expect(app).toContain('id="source-tab"');
    expect(app).not.toContain('disabled={!sourceAvailable} id="source-tab"');
    expect(app).toContain('data-testid="source-unavailable"');
    expect(app).not.toContain("selected.detail === 'code' && Boolean(selectedExcerpt)");
    expect(app).not.toContain("entity.detail === 'code' && Boolean(entity.sourceExcerpts?.length)");
  });

  it('ships a snapshot-derived Overview architecture brief beside Source and Details (CLA-87)', () => {
    expect(app).toContain('id="overview-tab"');
    expect(app).toContain("selectInspectorTab('overview')");
    expect(briefView).toContain('data-testid="architecture-brief"');
    expect(briefView).toContain('data-testid="architecture-brief-context-mermaid"');
    expect(briefView).toContain('data-testid="architecture-brief-flows"');
    expect(briefView).toContain('Copy markdown');
    expect(app).toContain('buildArchitectureBrief({');
    expect(app).toContain('<ArchitectureBriefView');
    expect(app).toContain("scanFixture ? 'overview' : 'details'");
    expect(app).toContain("const tabs: (InspectorTab | 'ask')[] = ['overview', 'source', 'details',");
    expect(app).toContain('id="ask-tab"');
    expect(app).toContain("if (next === 'ask') openDockedAsk()");
    expect(app).toContain('id="source-tab"');
    expect(app).toContain('id="details-tab"');
    expect(app).toContain('Architecture brief');
    expect(app).not.toContain('data-testid="scan-one-pager"');
    expect(app).not.toContain('data-testid="one-pager-containers"');
    expect(app).not.toMatch(/scanRoot|OPENROUTER_API_KEY|apiKey/);
    expect(declarations(css, '.inspector-tabs')).toContain('grid-template-columns: 1fr 1fr 1fr');
    expect(css).toContain('.architecture-brief .brief-prose');
    expect(css).toContain('.semantic-mermaid-diagram.is-compact');
  });

  it('renders an accepted section summary in Details and omits empty enrich copy', () => {
    expect(app).toContain('inspectorAcceptedSummary(selected)');
    expect(app).toContain("data-inspector-has-section-summary={selectedSummary ? 'true' : 'false'}");
    expect(app).toContain('data-inspector-section-summary=""');
    expect(app).toContain('inspectorEntityLead({ summary: selectedSummary, honestyDetails: scanFixture?.enrichmentHonesty?.details })');
    expect(app).toContain('{selectedLead.kind === \'summary\' ? <p className="responsibility" data-inspector-section-summary="">{selectedLead.text}</p> : selectedLead.kind === \'enrichment-honesty\' ? <p className="responsibility enrichment-honesty" data-inspector-enrichment-honesty-details="">{selectedLead.text}</p> : <p className="responsibility no-explanation" data-inspector-no-explanation="">{selectedLead.text}</p>}');
    expect(declarations(css, '.no-explanation')).not.toContain('orange');
    expect(app).not.toContain('<p className="responsibility">{selected.responsibility}</p>');
  });

  it('renders published enrichment honesty when a summary is missing (CLA-75)', () => {
    expect(app).toContain('data-atlas-enrichment-why={scanFixture?.enrichmentHonesty?.why ?? \'\'}');
    expect(app).toContain('data-inspector-enrichment-honesty={scanFixture?.enrichmentHonesty?.why ?? \'\'}');
    expect(app).toContain('data-testid="inspector-enrichment-honesty"');
    expect(app).toContain('scanFixture.enrichmentHonesty.chip');
    expect(app).toContain('honestyDetails: scanFixture?.enrichmentHonesty?.details');
    expect(app).not.toMatch(/enrichmentHonesty\.note/);
    expect(app).not.toMatch(/results\[.*\]\.reasons/);
    expect(app).not.toMatch(/scanRoot|OPENROUTER_API_KEY|apiKey/);
  });

  it('renders observed CODEOWNERS in Details and omits the section when none exist', () => {
    expect(app).toContain('inspectorPathOwners(selected)');
    expect(app).toContain("data-inspector-has-owners={selectedOwners.length ? 'true' : 'false'}");
    expect(app).toContain("data-inspector-section=\"ownership\"");
    expect(app).toContain('<h3>Owned by</h3>');
    expect(app).toContain('{selectedOwners.length > 0 ?');
    expect(app).toContain('data-testid="inspector-owners"');
  });

  it('renders observed McCabe cyclomatic in Details and flags complexity over 6', () => {
    expect(app).toContain('inspectorCyclomatic(selected)');
    expect(app).toContain("data-inspector-has-cyclomatic={selectedCyclomatic ? 'true' : 'false'}");
    expect(app).toContain("data-inspector-cyclomatic-flagged={selectedCyclomatic?.flagged ? 'true' : 'false'}");
    expect(app).toContain("data-inspector-section=\"cyclomatic\"");
    expect(app).toContain('<h3>Complexity</h3>');
    expect(app).toContain('data-testid="inspector-cyclomatic"');
    expect(app).toContain('McCabe {selectedCyclomatic.complexity}');
    expect(app).toContain('Over 6');
  });

  it('renders observed clone duplicates in Details from existing L4 ids', () => {
    expect(app).toContain('inspectorDuplicates(selected.id, activeSnapshot.relations, activeSnapshot.entities)');
    expect(app).toContain("data-inspector-has-duplicates={selectedDuplicates.length ? 'true' : 'false'}");
    expect(app).toContain("data-inspector-section=\"duplicates\"");
    expect(app).toContain('<h3>Duplicates</h3>');
    expect(app).toContain('data-testid="inspector-duplicates"');
    expect(app).toContain('data-inspector-duplicate-id={counterpart.id}');
  });

  it('renders observed lcov coverage in Details and omits the section when no sidecar', () => {
    expect(app).toContain('inspectorCoverage(selected)');
    expect(app).toContain("data-inspector-has-coverage={selectedCoverage ? 'true' : 'false'}");
    expect(app).toContain("data-inspector-section=\"coverage\"");
    expect(app).toContain('<h3>Coverage</h3>');
    expect(app).toContain('data-testid="inspector-coverage"');
    expect(app).toContain('this file {selectedCoverage.fileHitPercent}%');
    expect(app).toContain('{selectedCoverage ? <section');
    expect(app).not.toContain('CRAP');
    expect(app).not.toContain('crapScore');
  });

  it('renders enrichment-named untested behaviours in Details when present', () => {
    expect(app).toContain('inspectorUntestedBehaviours(selected)');
    expect(app).toContain("data-inspector-has-untested-behaviours={selectedUntestedBehaviours.length ? 'true' : 'false'}");
    expect(app).toContain('data-testid="inspector-untested-behaviours"');
    expect(app).toContain('data-inspector-untested-behaviour');
    expect(app).not.toContain('CRAP');
  });

  it('hides C4 completeness advisory ids from default Details (CLA-99)', () => {
    expect(app).toContain('presentInspectorNotationDiagnostics(notationDiagnostics');
    expect(app).toContain('inspectorNotationScope({');
    expect(app).toContain('inspectorNotationDetailsView(notationPresentation');
    expect(app).toContain("devMode ? 'diagnostics' : 'user'");
    expect(app).toContain('notationDetails.visible');
    expect(app).toContain('notationDetails.rows.map');
    expect(app).toContain('notationDetails.hiddenCount');
    expect(app).toContain('+${notationDetails.hiddenCount} more completeness notes');
    expect(app).not.toContain('notationPresentation.sample');
    expect(app).not.toContain('notationDiagnostics.map');
    expect(app).toContain('devMode={devMode} notationAdvisoryCount={notationDiagnostics.length}');
    expect(app).toContain('<h3>Diagrams</h3><span>{selectedDiagramCount}</span>');
    expect(app).toContain('selectedDiagramCount === 0 && !notationDetails.visible ? <p className="empty-inspector-section" data-inspector-diagrams-empty="">No diagrams for this element yet.</p>');
    expect(app).not.toMatch(/enrichmentHonesty\.note/);
  });

  it('grounds Ask Atlas in selected or isolated packets and keeps an honest disconnected path', () => {
    expect(askPanel).toContain("data-ask-connected={props.connected ? 'true' : 'false'}");
    expect(askPanel).toContain('data-ask-state={props.state}');
    expect(app).toContain('connected={askConnected}');
    expect(app).toContain('state={askState}');
    expect(askPanel).toContain('data-ask-auth="signed-out"');
    expect(askPanel).toContain('data-ask-state="signin"');
    expect(askPanel).toContain('ASK_SIGNIN_COPY');
    expect(app).toContain('fetchAskAuth');
    expect(app).toContain('loadAskThread');
    expect(app).toContain('isAskUnauthorized(result)');
    expect(app).toContain('buildAskContext(');
    expect(app).toContain('probeAskConnection');
    expect(app).toContain("isolateActive: visibilityMode === 'isolate'");
    expect(app).toContain('showDisconnectedAsk()');
    expect(app).toContain('ASK_NOT_CONNECTED_LIVE_MESSAGE');
    expect(askPanel).toContain('ASK_NOT_CONNECTED_COPY');
    expect(askPanel).toContain('ASK_CONNECTED_COPY');
    expect(askPanel).toContain('ASK_CONNECTED_SUBMIT_LABEL');
    expect(askPanel).toContain('ASK_DISCONNECTED_SUBMIT_LABEL');
    // CLA-265: scope is only a starting point — a scope change never discards an answered turn.
    expect(app).not.toContain('shouldCommitAskAnswer');
    expect(app).not.toMatch(/\[askOpen, currentAskScopeKey\]/);
    expect(app).not.toContain('currentAskScopeKey');
    expect(app).toContain('if (!askSignedIn) return');
    expect(app).toContain('if (!askConnected)');
    expect(app).toContain('askAtlasIdentity');
    expect(app).not.toContain('playDisconnectedAsk');
    expect(app).not.toContain('Preview explanation');
    const disconnected = app.slice(app.indexOf('function showDisconnectedAsk()'), app.indexOf('async function submitQuestion('));
    expect(disconnected).not.toContain('setStep(');
    expect(disconnected).not.toContain('setAskOpen(false)');
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('publishes canonical relation rows with destination, map status and separate reveal', () => {
    expect(app).toContain('data-inspector-presentation="canonical-relation"');
    expect(app).toContain('<strong>{row.counterpartName}</strong>');
    expect(app).toContain("inspectRelation(relation, 'panel', 'preserve')");
    expect(app).toContain('frameSelectedRelationFlow(relation, selected)');
  });

  it('swaps selected edges into a dedicated relationship inspector with endpoint and editing actions', () => {
    const presentationStart = app.indexOf('data-inspector-presentation="relation"');
    const endpoints = app.indexOf('<h3>Endpoints</h3>', presentationStart);
    const evidence = app.indexOf('<h3>Evidence context</h3>', presentationStart);
    const editing = app.indexOf('aria-label="Relationship editing actions"', presentationStart);

    expect(presentationStart).toBeGreaterThan(0);
    expect(endpoints).toBeGreaterThan(presentationStart);
    expect(evidence).toBeGreaterThan(endpoints);
    expect(editing).toBeGreaterThan(evidence);
    expect(app).toContain('selectedRelationPresentation(scene, pickedRelation, pickedRelation.from)');
    expect(app).toContain('canonicalRelationshipGroupsForEntity(activeSnapshot, scene, new Set(activeProjectionRelationIds)');
  });

  it('retains canonical inventory while membership follows actual projected entities and isolate', () => {
    expect(app).toContain('canonicalRelationshipGroupsForEntity(activeSnapshot, scene');
    expect(app).toContain("activeProjectionEntityIds.filter(id => visibilityMode !== 'isolate' || isolatedEntityIdSet.has(id))");
  });

  it('distinguishes shown aggregate hidden and unavailable relationships', () => {
    for (const status of ['shown', 'aggregated', 'hidden']) expect(app).toContain(`row.mapStatus === '${status}'`);
    expect(app).toContain('Known, unavailable in this map neighborhood');
    expect(app).toContain('No relationships captured.');
  });

  it('expands each canonical group in place with total count and five initial rows', () => {
    expect(app).toContain('expanded ? group.rows : group.rows.slice(0, 5)');
    expect(app).toContain('aria-expanded={expanded}');
    expect(app).toContain('`Show all ${group.rows.length}`');
    expect(app).toContain("'Show fewer'");
  });

  it('unifies off-camera children with visible children in one bounded stable list', () => {
    expect(app).toContain("detailListVisible('children', inspectorChildren)");
    expect(app).toContain('omittedChildNodes.some(node => node.entityId === child.id)) revealOmittedEntity(entity)');
    expect(app).toContain('`Show all ${inspectorChildren.length}`');
  });

  it('never moves the camera on selection, only on an explicit camera intent', () => {
    const focusStart = app.indexOf('function focusEntity(');
    const focusEnd = app.indexOf('function navigateInspectorHierarchy', focusStart);
    const implementation = app.slice(focusStart, focusEnd);

    expect(implementation).toContain("const explicitCameraIntent = cameraIntent === 'frame' || inspectorIntent === 'source';");
    expect(implementation).toContain("if (explicitCameraIntent) reframeEntityAfterInspectorChange(entity, nextInspectorTab === 'source');");
    expect(implementation).toContain("const nextCamera = cameraIntent === 'frame'");
    expect(implementation.match(/reframeEntityAfterInspectorChange\(/g)).toHaveLength(1);
  });

  it('selects relationship evidence without framing and reveal uses the supported route plan', () => {
    const implementation = app.slice(app.indexOf('function inspectRelation('), app.indexOf('function restoreInspectorHistoryNavigation'));
    expect(implementation).toContain("if (cameraIntent === 'frame') frameSelectedRelationFlow(relation, owner)");
    expect(app).toContain("inspectRelation(relation, 'panel', 'preserve')");
    expect(app).toContain('resolveRelationshipReveal({');
    expect(app).toContain('targetCamera: plan.framing.camera');
    expect(app).toContain('canonicalRelationForInspection(activeSnapshot, row.relationId)');
    expect(app).toContain('data-testid="canonical-relation-evidence"');
  });

  it('uses a panel-local Back stack only for inspector-originated subject traversal', () => {
    const restoreStart = app.indexOf('function restoreInspectorHistoryNavigation');
    const backStart = app.indexOf('function navigateInspectorBack()');
    const backEnd = app.indexOf('function handlePick', backStart);
    const restoreImplementation = app.slice(restoreStart, backStart);
    const backImplementation = app.slice(backStart, backEnd);

    expect(app).toContain('popInspectorHistory(inspectorHistory)');
    expect(app).toContain('inspectorHistory.length > 0 && <button aria-label="Back to previous inspector selection"');
    expect(app).toContain("focusEntity(pickedRelationPresentation.source, 'replace', 'frame', 'details', 'panel')");
    expect(app).toContain('onClick={() => navigateInspectorHierarchy(selectedParent)}');
    expect(app).toContain('void openInspectorChild(child.id)');
    expect(app).toContain('semanticInspectorHierarchyPlan(');
    expect(app).toContain('detail: plan.session.baseDetail');
    expect(app).toContain('lensPath: semanticLensCanonicalPathIds(plan.session)');
    expect(app).toContain("inspectRelation(relation, 'panel', 'preserve')");
    expect(app).toContain('camera: { ...currentNavigation.camera }');
    expect(restoreImplementation).toContain('inspectorHistoryRestorePlan(navigationRef.current, subject)');
    expect(restoreImplementation).toContain('startInspectorCameraFlight({');
    expect(restoreImplementation).toContain('targetCamera: plan.state.camera');
    expect(restoreImplementation).toContain('historyMode: plan.mode');
    expect(backImplementation).not.toContain('reframeEntityAfterInspectorChange');
    expect(backImplementation).toContain('inspectorTabButtonRef(restoredTab).current?.focus');
    expect(backImplementation).not.toContain('window.history.back()');
  });

  it('animates hierarchy navigation without story-flight coupling or per-frame history writes', () => {
    const flightStart = app.indexOf('function startInspectorCameraFlight');
    const flightEnd = app.indexOf('function cancelInspectorCameraFlight', flightStart);
    const implementation = app.slice(flightStart, flightEnd);

    expect(implementation).toContain('semanticInspectorFlightSession(');
    expect(implementation).toContain('semanticInspectorRawCameraTarget(');
    expect(implementation).toContain('compensateSemanticInspectorFlightCamera(');
    expect(implementation).toContain('onComplete: () =>');
    expect(implementation.match(/commitNavigation\(/g)).toHaveLength(1);
    expect(implementation).not.toContain('storyFlightRef');
  });

  it('aborts a hierarchy flight before external navigation can replace its destination', () => {
    const abortStart = app.indexOf('function abortInspectorCameraFlight');
    const abortEnd = app.indexOf('\n  useEffect(() => {', abortStart);
    const abortImplementation = app.slice(abortStart, abortEnd);
    const focusStart = app.indexOf('function focusEntity');
    const focusEnd = app.indexOf('function navigateInspectorHierarchy', focusStart);
    const focusImplementation = app.slice(focusStart, focusEnd);

    expect(abortImplementation).toContain('collapseInspectorFlightSession(semanticLensSessionRef.current)');
    expect(abortImplementation).toContain('inspectorCameraFlightControllerRef.current?.cancel()');
    expect(abortImplementation).toContain('pendingInspectorCameraFlightRef.current = undefined');
    expect(abortImplementation).toContain('updateCamera(liveCamera)');
    expect(abortImplementation).not.toContain('commitNavigation(');
    expect(focusImplementation.indexOf('abortInspectorCameraFlight()'))
      .toBeLessThan(focusImplementation.indexOf('setSelectedId(entity.id)'));
  });

  it('pins the compact desktop type scale and full-width mobile actions', () => {
    expect(declarations(css, '.details-panel')).toContain('grid-template-rows: 44px 34px minmax(0, 1fr)');
    expect(declarations(css, '.details-scroll')).toContain('padding: 22px 22px 36px');
    expect(declarations(css, '.entity-hero h2')).toMatch(/font-size:\s*27px/);
    expect(declarations(css, '.entity-hero h2')).toMatch(/line-height:\s*1\.08/);
    expect(declarations(css, '.detail-actions button')).toMatch(/min-height:\s*35px/);
    expect(declarations(css, '.relation-facts div')).toContain('grid-template-columns: 92px minmax(0, 1fr)');

    const mobile = css.slice(css.indexOf('@media (max-width: 470px)'));
    expect(declarations(mobile, '.details-panel')).toContain('grid-template-rows: 44px 44px minmax(0, 1fr)');
    expect(declarations(mobile, '.inspector-tabs button')).toContain('min-height: 44px');
    expect(declarations(mobile, '.detail-actions')).toContain('grid-template-columns: 1fr');
    expect(declarations(mobile, '.detail-actions button')).toContain('min-height: 44px');
    expect(declarations(mobile, '.details-header button')).toContain('height: 44px');
  });
});

describe('canvas minimap', () => {
  it('renders an interactive minimap inset that pans the camera through the canvas path', () => {
    // Drag/click on the inset routes camera writes through the same primitives as canvas pan:
    // live moves via setCamera, and settle/click via navigateCamera(..., 'replace') so story +
    // flight cancellation, bounds and replace-not-push URL semantics stay on one path. A
    // finished pan also runs the same stationary-pan lens handoff as a canvas drag, so the
    // node the user panned to takes lens ownership and reveals its interior.
    expect(app).toContain("navigateCamera(next, 'replace', 'Panned the map overview');");
    expect(app).toContain("if (phase === 'settle') stabilizeSemanticLensForPan(next);");
    expect(app.slice(app.indexOf('<Minimap'))).toContain("if (phase === 'move') {");
    // The container stays inert; the inset SVG is the sole pointer hit target.
    expect(declarations(css, '.minimap')).toContain('pointer-events: none');
    expect(declarations(css, '.minimap')).toContain('position: absolute');
    expect(declarations(css, '.minimap svg')).toContain('pointer-events: auto');
  });

  it('hides the minimap on very narrow viewports', () => {
    const narrow = css.slice(css.indexOf('@media (max-width: 390px)'));
    expect(declarations(narrow, '.minimap')).toContain('display: none');
  });

  it('publishes the per-frame rendered camera so the minimap can track gestures in real time', () => {
    // React `camera` state is throttled/settled, so the render loop broadcasts the live camera
    // to the minimap via the per-frame bridge (imperative, no 60fps React re-render).
    expect(app).toContain('publishLiveCamera(frame.camera, {');
    expect(app).toContain("import { publishLiveCamera } from './liveCameraBridge'");
  });
});

describe('canvas screenshot capture', () => {
  it('exposes a screenshot control near Share that offers copy and save', () => {
    expect(app).toContain('aria-label="Capture screenshot"');
    expect(app).toContain("captureScreenshot('copy')");
    expect(app).toContain("captureScreenshot('save')");
  });

  it('captures via the offscreen Canvas2D renderer seam with clipboard + download paths', () => {
    expect(app).toContain('captureSceneBlob({');
    expect(app).toContain("new ClipboardItem({ 'image/png': blob })");
    expect(app).toContain('downloadBlob(blob, screenshotFilename(activeDiagramSurface.title');
  });
});

describe('story launcher chrome (CLA-98)', () => {
  it('keeps Ask Atlas plus a catalog on one row and does not wrap over minimap chrome', () => {
    expect(declarations(css, '.story-launcher')).toContain('flex-wrap: nowrap');
    expect(declarations(css, '.story-launcher')).toContain('bottom: 62px');
    expect(css).toMatch(/\.saved-story,\s*\.story-catalog-menu > summary \{[^}]*height: 51px/);
    expect(declarations(css, '.story-catalog-menu > div')).toContain('bottom: 59px');
    expect(app).toContain('storyCatalog.length === 1');
    expect(app).toContain('className="story-catalog-menu"');
    expect(app).toContain('className="saved-story"');
    expect(app).toContain('className="story-catalog-item"');
    expect(app).toContain("data-testid={plan.id === defaultStory.id ? 'story-launch-overview' : 'story-launch-flow'}");
    expect(app).toContain('Guided tours');
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('leaves the golden single-story chip on the launcher and collapses N stories into the menu', () => {
    expect(app).toContain('{storyCatalog.length === 1 ? storyCatalog.map(plan => (');
    expect(app).toContain('<details className="story-catalog-menu">');
    const compact = css.slice(css.indexOf('@media (max-width: 1060px)'));
    expect(declarations(compact, '.saved-story')).toContain('display: none');
    expect(compact).not.toMatch(/\.story-catalog-menu\s*\{[^}]*display:\s*none/);
  });

  it('docks the Ask panel beside the map, clear of the canvas card, tours and minimap (CLA-100, CLA-265)', () => {
    expect(app).toContain('className="ask-anchor"');
    expect(app.indexOf('className="ask-anchor"')).toBeLessThan(app.indexOf('className="ask-button"'));
    // The panel is a map-stage sibling of the launcher (not inside its transformed box).
    const floatingMount = app.indexOf('{askPanelVisible && !askDocked ? askPanelView : null}');
    expect(floatingMount).toBeGreaterThan(app.indexOf('className="story-launcher"'));
    expect(floatingMount).toBeLessThan(app.indexOf('className="canvas-hint"'));
    expect(app.match(/<AskPanel\s/g)).toHaveLength(1);
    expect(app).toContain('className="inspector-ask-panel" id="ask-panel" role="tabpanel">{askPanelView}</div>');
    expect(askPanel).toContain("data-ask-placement={props.placement ?? 'floating'}");
    expect(declarations(css, '.ask-anchor')).toContain('position: relative');
    const panel = declarations(askCss, '.ask-popover');
    expect(panel).toContain('position: absolute');
    expect(panel).toContain('left: 76px');
    expect(panel).toContain('bottom: var(--ask-bottom-clearance)');
    expect(panel).toContain('max-height: calc(100% - var(--ask-top-clearance) - var(--ask-bottom-clearance))');
    expect(panel).toContain('--ask-bottom-clearance: 124px');
    expect(panel).toContain('--ask-top-clearance: 132px');
    // Bottom clearance keeps it above the launcher (bottom 62px + 51px tall chips).
    expect(pixels(declarations(css, '.story-launcher'), 'bottom') + 51).toBeLessThan(124);
    const sheet = declarations(askCss.slice(askCss.indexOf('@container (max-width: 800px)')), '.ask-popover');
    expect(sheet).toContain('left: 12px');
    expect(sheet).toContain('right: 12px');
    expect(sheet).toContain('width: auto');
    expect(sheet).toContain('max-height: min(45%,');
    expect(askCss).not.toMatch(/\.ask-popover \{[^}]*position: fixed/);
    // Citation chips drill like inspector links (scan neighborhoods, canonical band, L4 owner) — never a
    // bare select+frame that can land on an undrawn band (CLA-265 QA: empty map on a code chip).
    const askPanelJsx = app.slice(app.indexOf('<AskPanel'), app.indexOf('/>', app.indexOf('turns={askThread?.turns')));
    expect(askPanelJsx).toMatch(/onFocusCitation=\{id => \{[^}]*void openInspectorChild\(id\)/);
    expect(askPanelJsx).not.toContain("focusEntity(entity, 'push', 'frame')");
    // Show on map picks its level from the cited parts (L3 in one container, else L2) and drills there
    // through the same inspector-link path; Restore goes back to the saved pre-Show view.
    expect(askPanelJsx).toContain('void showAskTurnOnMap(citedIds, turn.id)');
    expect(askPanelJsx).toContain('onRestoreMap={restoreAskMapView}');
    expect(app).toContain('const plan = askShowOnMapPlan(citedIds,');
    expect(app).toMatch(/function showAskPlanOnMap[\s\S]*?void openInspectorChild\(target\)/);
    expect(app).toContain('cluster.smallestPx < ASK_MAP_MIN_CARD_PX');
    expect(app).toMatch(/function restoreAskMapView[\s\S]*?commitNavigation\(saved\.navigation, 'replace'\)/);
    // Wiring guards for the pure decisions in ask/askMapSession.ts (unit tested there).
    for (const site of ['function focusEntity(', 'function handlePick(', 'async restore(next, source) {', 'function changeVisibility(', 'function toggleDetails(']) {
      const body = app.slice(app.indexOf(site), app.indexOf(site) + 400);
      expect(body, site).toContain('cancelAskMapShow();');
    }
    const showTurn = app.slice(app.indexOf('async function showAskTurnOnMap'), app.indexOf('function restoreAskMapView'));
    expect(showTurn.indexOf('cancelAskMapShow();')).toBeLessThan(showTurn.indexOf('await Promise.all'));
    expect(showTurn).toContain('if (!askMapStepCurrent(generation)) return;');
    expect(app).toContain('if (!askMapStepCurrent(generation, target)) return;');
    expect(app).toContain('if (!askMapViewShouldReset(previous, visibilityMode)) return;');
    expect(app).toContain('if (!askPanelReframeDue(askPanelLayout, askReframeRequest, askReframeHandledRef.current)) return;');
    expect(askPanelJsx).toContain("if (inspectorSelectionRef.current === id) selectInspectorTab('source', false);");
    // The panel is a left overlay for framing, so a framed citation lands beside it.
    expect(app).toContain("{ rect: rect('.ask-popover'), edge: askPanelOverlayEdge(rect('.ask-popover'), canvasRect) }");
    // Exactly one scroll container: the thread. Nothing inside a turn scrolls.
    expect(askCss.match(/overflow-y: auto|overflow: auto/g)).toHaveLength(1);
    expect(declarations(askCss, '.ask-scroll')).toContain('overflow-y: auto');
    expect(css).not.toContain('.ask-popover');
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });
});

describe('oEmbed embed chrome (CLA-85)', () => {
  it('collapses the Overview architecture brief at overlay width and keeps the overview tour on the map', () => {
    expect(app).toContain('initialInspectorOpen()');
    expect(app).toContain("data-embed={isEmbedChrome({ framed: isFramedBrowsingContext(), embedQuery: isEmbedQueryFlag(window.location.search) }) ? 'true' : 'false'}");
    expect(app).toContain("'embed'");
    expect(app).not.toContain('window.innerWidth > 780');
    expect(css).toContain('@media (max-width: 900px)');
    expect(css).toContain('.app-shell[data-embed="true"] .saved-story { display: flex; }');
    expect(css).toContain('.app-shell[data-embed="true"] .ask-button { display: none; }');
    expect(css).toContain('.app-shell[data-embed="true"] .diagram-view-bar { display: none; }');
    expect(css).toContain('grid-template-rows: var(--topbar-height) minmax(0, 1fr)');
    expect(app).toContain("'story-launch-overview'");
    expect(app).not.toMatch(/scanRoot|OPENROUTER_API_KEY|apiKey/);
  });
});

describe('production dev-mode gate', () => {
  it('defaults dev mode off, persists it, and toggles with Shift+Alt+D', () => {
    expect(app).toContain("localStorage.getItem('okie.devMode') === '1'");
    expect(app).toContain("localStorage.setItem('okie.devMode', devMode ? '1' : '0')");
    expect(app).toContain('shouldToggleDevMode(event)');
    expect(app).toContain('setDevMode(value => !value)');
    expect(app).toContain("data-dev-mode={devMode ? 'true' : 'false'}");
  });

  it('forces view mode and closes diagnostics when dev mode is off', () => {
    expect(app).toContain("if (!devMode) { setInteractionMode('view'); setDiagnosticsOpen(false); }");
  });

  it('gates the renderer pill, diagnostics panel, mode toggle, and create-diagram menu behind dev mode', () => {
    expect(app).toContain('{devMode && <button aria-expanded={diagnosticsOpen}');
    expect(app).toContain('{devMode && diagnosticsOpen && <aside className="diagnostics-card"');
    expect(app).toContain('{devMode && <div aria-label="Diagram interaction mode"');
    expect(app).toContain('{devMode && <details className="diagram-add-menu"');
  });
});

describe('header Open source and account chrome (CLA-101)', () => {
  it('opens the source repository and account/sign-in instead of dead header buttons', () => {
    // CLA-329: the link lives in SourceRepoLink (GitHub mark + "View on GitHub" for GitHub repositories).
    expect(app).toContain('<SourceRepoLink url={sourceRepositoryUrl}/>');
    expect(sourceRepoLink).toContain('data-testid="open-source-repo"');
    expect(app).toContain('atlasSourceRepositoryUrl(askAtlasIdentity)');
    expect(sourceRepoLink).toContain("'Open source repository'");
    expect(sourceRepoLink).toContain('aria-label={label}');
    expect(sourceRepoLink).toContain('rel="noreferrer"');
    expect(sourceRepoLink).toContain('target="_blank"');
    expect(app).toContain('className="diagram-add-menu screenshot-menu account-menu"');
    expect(app).toContain('data-testid="account-menu"');
    expect(app).toContain('data-testid="account-signin"');
    expect(askPanel).toContain('askSignInHref(loginPath, props.returnPath)');
    expect(app).toContain('returnPath={askReturnPath}');
    expect(app).toContain("askSignInHref(askAuth?.logoutPath ?? '/api/auth/logout', askReturnPath)");
    expect(app).toContain('Sign in with GitHub');
    expect(app).toContain('Sign out');
    expect(app).toContain('accountInitials(askAuth?.login)');
    expect(sourceRepoLink).not.toMatch(/<button aria-label=/);
    expect(app).not.toMatch(/<button aria-label="Open account menu"/);
    expect(app).not.toContain('>BC</button>');
    expect(app).not.toContain('>BC</summary>');
    expect(css).toContain('a.icon-button { text-decoration: none; }');
    expect(css).toContain('.account-menu summary.avatar-button');
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('CLA-329: the embed button renders only behind the availability gate, right after Share', () => {
    expect(app).toContain('const embedAtlas = useEmbedAtlasAvailability(Boolean(portableAtlas));');
    expect(app.match(/<EmbedAtlasControl /g)).toHaveLength(1);
    expect(app).toContain('{embedAtlas.visible && <EmbedAtlasControl displayNames={embedAtlas.displayNames} readPageHref={readCurrentViewHref}/>}');
    const share = app.indexOf('title="Copy current view"');
    expect(share).toBeGreaterThan(0);
    expect(app.indexOf('<EmbedAtlasControl ')).toBeGreaterThan(share);
    expect(app.indexOf('<EmbedAtlasControl ')).toBeLessThan(app.indexOf('<SourceRepoLink '));
    // Share and Embed read the same flushed view.
    expect(app).toMatch(/async function copyCurrentView\(\) \{\n    const url = readCurrentViewHref\(\);/);
  });

  it('leaves Share, Mermaid import, and screenshot wired', () => {
    expect(app).toContain('data-testid="import-mermaid"');
    expect(app).toContain("copyCurrentView()");
    expect(app).toContain("captureScreenshot('copy')");
    expect(app).toContain("captureScreenshot('save')");
    expect(app).toContain('aria-label="Capture screenshot"');
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });
});

describe('Mermaid import onto the atlas (CLA-35)', () => {
  it('exposes a first-class import path on the atlas, not behind dev mode', () => {
    expect(app).toContain('data-testid="import-mermaid"');
    expect(app).toContain('aria-label="Import Mermaid diagram"');
    expect(app).toContain('<ImportMermaidDialog');
    expect(app).toContain('applyImportedMermaid');
    expect(app).toContain("data-atlas-source={importedAtlas ? 'imported-mermaid'");
    expect(app).not.toContain('{devMode && <ImportMermaidDialog');
    expect(css).toContain('.import-mermaid-dialog');
  });

  it('compiles imported mermaid through the atlas scene path and leaves scan-from-repo in place', () => {
    expect(app).toContain('compileImportedMermaidScene');
    expect(app).toContain('importMermaidToAtlas');
    expect(app).toContain("setLiveMessage(result.message)");
    expect(app).toContain('The atlas is unchanged.');
    expect(app).toContain('createArchitectureAuthoringDocument(result.atlas.snapshot.repositoryId)');
    expect(app).toContain('authoring?.repositoryId === imported.snapshot.repositoryId');
    expect(app).toContain("scanFixture ? 'scan' : 'golden'");
    const landing = readFileSync(new URL('./scanLanding.tsx', import.meta.url), 'utf8');
    expect(landing).toContain('Map a repository');
    expect(landing).toContain('aria-label="GitHub repository URL"');
    expect(landing).toContain('Scan');
  });
});

describe('selected relationship focus wiring', () => {
  it('keeps transient endpoint/path promotion behind story selection ownership', () => {
    expect(app).toContain("currentStory === undefined || storyPhase === 'idle' || storySelectionOverride ? pickedRelationId : undefined");
    expect(app).toContain('relationFocusIds={relationFocus.endpointIds}');
    expect(app).toContain('projectionOverride={relationFocus.projectionOverride}');
    // Ask "Show on map" isolates the cited set AND keeps the current selection visible (CLA-265).
    expect(app).toContain('new Set([...storyFocus.requiredIds, ...relationFocus.endpointIds])');
    expect(app).toContain("(askMapFocus && visibilityMode === 'isolate' ? askMapFocus : pathFocus)");
  });

  it('lifts isolate from a code story step to the file-component neighborhood', () => {
    expect(app).toContain('isolateNeighborhoodIds(scene.entities, visibilityFocusIds');
    expect(app).toContain('liftCodeStoryFocus:');
    expect(app).toContain("visibilityMode === 'isolate' ? isolatedEntityIdSet : storyFocus.focusedIds");
  });

  it('resolves selected route handles from the retained projected relation and carries its own detail', () => {
    expect(app).toContain('selectedProjectedRelationForFocus(scene, selectedRelationId, projectionOverride, authoringDetail)');
    expect(app).toContain('detail: authoringPointer.detail');
    expect(app).toContain("selectedRoute={authoringTool === 'select'\n          ? guideDraft ? undefined : selectedProjectedRoute");
    expect(app).toContain('guideDraft ? { points: guideDraft.points, safe: guideDraft.applied }');
    expect(app).not.toContain('projectedRelationsByDetail[authoringDetail]\n            .find(relation => relation.id === selectedRelationId');
  });
});


describe('inspector hierarchy QA regressions', () => {
  it('marks a successful hierarchy selection explicit before changing the selected entity', () => {
    const start = app.indexOf('function navigateInspectorHierarchy(');
    const end = app.indexOf('startInspectorCameraFlight({', start);
    const hierarchy = app.slice(start, end);
    expect(hierarchy.indexOf('setExplicitInspectorSelection(true)')).toBeGreaterThan(hierarchy.indexOf('if (!plan)'));
    expect(hierarchy.indexOf('setExplicitInspectorSelection(true)')).toBeLessThan(hierarchy.indexOf('setSelectedId(entity.id)'));
    expect(app).toContain('explicitInspectorSelection ? selected.id : semanticLensCanonicalPathIds(semanticLensSession)');
  });
  it('builds dependency participants from the same scene facts used to offer the action', () => {
    expect(app).toContain('const hasDependencyDiagram = scene.relations.some');
    expect(app).toContain("kind === 'dependency' ? [...new Set([selected.id, ...scene.relations.filter");
  });
});

it('keeps relation reveal labels on one line and separates overview list counts', () => {
  const reveal = declarations(css, '.canonical-relation-row > button.secondary-detail-action');
  expect(reveal).toContain('display: inline-flex');
  expect(reveal).toContain('grid-template-columns: none');
  expect(reveal).toContain('white-space: nowrap');
  expect(declarations(css, '.relation-group > .section-heading')).toContain('justify-content: space-between');
});

it('code structure includes every direct code child without dependency slots or arbitrary truncation', () => {
  const start = app.indexOf('function selectedDiagramEntityIds()');
  const implementation = app.slice(start, app.indexOf('function applyImportedMermaid', start));
  expect(implementation).toContain("selectedChildren.filter(child => child.detail === 'code').map(child => child.id)");
  expect(implementation).not.toContain('scene.relations');
  expect(implementation).not.toContain('.slice(');
});

it('resets overview list expansion by subject and bounds evidence and named diagram lists', () => {
  expect(app).toContain('<ContextualOverviewView key={contextualOverview?.entity.id}');
  expect(app).toContain("detailListVisible('exposure', selectedExposure)");
  expect(app).toContain("detailListVisible('named-diagrams', namedDiagramStories)");
  expect(app).toContain('`Show all ${selectedExposure.length}`');
  expect(app).toContain('`Show all ${namedDiagramStories.length} named diagrams`');
});
