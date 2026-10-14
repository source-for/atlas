import { useEffect, useId, useRef, useState } from 'react';
import type { MermaidConfig } from 'mermaid';
import { mermaidReleased, releaseMermaid, whenMermaidReleased } from './mermaidLoadGate';

const MAX_MERMAID_SOURCE_LENGTH = 40_000;
const MAX_MERMAID_SVG_LENGTH = 2_000_000;
const MERMAID_RENDER_SEED = 'okie-atlas-mermaid-v1';

/**
 * Elements/attributes forbidden in rendered SVG. Single source of truth applied
 * twice: inside mermaid's own DOMPurify pass (ATLAS_MERMAID_CONFIG.dompurifyConfig)
 * and again in an independent post-render DOMPurify pass (parseSafeMermaidSvg).
 */
const MERMAID_SVG_FORBID_TAGS = ['a', 'foreignObject', 'iframe', 'image', 'script', 'use'];
const MERMAID_SVG_FORBID_ATTR = ['href', 'xlink:href'];

export const ATLAS_MERMAID_CONFIG: Readonly<MermaidConfig> = {
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  deterministicIds: true,
  deterministicIDSeed: MERMAID_RENDER_SEED,
  htmlLabels: false,
  maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
  maxEdges: 250,
  logLevel: 'fatal',
  theme: 'base',
  look: 'classic',
  fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif',
  secure: [
    'deterministicIds',
    'deterministicIDSeed',
    'dompurifyConfig',
    'flowchart',
    'fontFamily',
    'htmlLabels',
    'maxEdges',
    'maxTextSize',
    'securityLevel',
    'startOnLoad',
    'suppressErrorRendering',
    'theme',
    'themeCSS',
    'themeVariables',
  ],
  themeVariables: {
    background: '#070a0b',
    primaryColor: '#162022',
    primaryTextColor: '#eef4f2',
    primaryBorderColor: '#52666a',
    secondaryColor: '#15201f',
    secondaryTextColor: '#d9ff70',
    secondaryBorderColor: '#506965',
    tertiaryColor: '#101617',
    tertiaryTextColor: '#b7c3c0',
    tertiaryBorderColor: '#3d4a4d',
    lineColor: '#79dfd4',
    textColor: '#eef4f2',
    mainBkg: '#162022',
    nodeBorder: '#52666a',
    clusterBkg: '#0d1314',
    clusterBorder: '#3d4a4d',
    edgeLabelBackground: '#0d1213',
    noteBkgColor: '#1a2118',
    noteBorderColor: '#73824d',
    noteTextColor: '#eef4f2',
    fontFamily: 'IBM Plex Sans, ui-sans-serif, system-ui, sans-serif',
  },
  flowchart: {
    htmlLabels: false,
    useMaxWidth: true,
    curve: 'basis',
    nodeSpacing: 44,
    rankSpacing: 64,
    diagramPadding: 16,
  },
  dompurifyConfig: {
    FORBID_TAGS: [...MERMAID_SVG_FORBID_TAGS],
    FORBID_ATTR: [...MERMAID_SVG_FORBID_ATTR],
  },
};

type MermaidApi = Pick<typeof import('mermaid')['default'], 'render'>;
type MermaidModule = { default: Pick<typeof import('mermaid')['default'], 'initialize' | 'render'> };

let importMermaidModule: () => Promise<MermaidModule> = () => import('mermaid');
let mermaidModulePromise: Promise<MermaidApi> | undefined;

/**
 * Test seam: swap the Mermaid loader and reset the cached module promise so the
 * fail-then-retry path can be exercised deterministically. Called with no
 * argument it restores the real dynamic import.
 */
export function setMermaidModuleLoaderForTests(loader?: () => Promise<MermaidModule>): void {
  importMermaidModule = loader ?? (() => import('mermaid'));
  mermaidModulePromise = undefined;
}

export function loadMermaid(): Promise<MermaidApi> {
  if (mermaidModulePromise) return mermaidModulePromise;
  const pending = importMermaidModule().then(({ default: mermaid }) => {
    mermaid.initialize(ATLAS_MERMAID_CONFIG);
    return mermaid;
  });
  // A rejected import must not poison the cache: otherwise the error UI's
  // "Retry render" would keep re-receiving the same cached failure forever.
  pending.catch(() => { if (mermaidModulePromise === pending) mermaidModulePromise = undefined; });
  mermaidModulePromise = pending;
  return pending;
}

type DompurifyApi = typeof import('dompurify')['default'];

let dompurifyPromise: Promise<DompurifyApi> | undefined;

/**
 * DOMPurify is loaded lazily — it ships inside mermaid's dynamic chunk, so this
 * adds ~0 to the initial bundle — and cached with the same reject-clears-cache
 * discipline as loadMermaid so a failed chunk load can recover on Retry.
 */
function loadDompurify(): Promise<DompurifyApi> {
  if (dompurifyPromise) return dompurifyPromise;
  const pending = import('dompurify').then(module => module.default);
  pending.catch(() => { if (dompurifyPromise === pending) dompurifyPromise = undefined; });
  dompurifyPromise = pending;
  return pending;
}

export function stableMermaidRenderId(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `okie-mermaid-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function assertSafeMermaidSource(source: string): void {
  if (!source.trim()) throw new Error('Mermaid source is empty');
  if (source.length > MAX_MERMAID_SOURCE_LENGTH) throw new Error('Mermaid source exceeds the render limit');
  const semanticLines = source.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('%%'));
  if (!/^flowchart\s+(?:LR|TB)$/u.test(semanticLines[0] ?? '')) {
    throw new Error('Only deterministic LR or TB flowcharts can be rendered');
  }
  if (semanticLines.slice(1).some(line => /^flowchart\b/u.test(line))) {
    throw new Error('Mermaid source contains more than one diagram');
  }
  // `%%` comment lines are ignored by Mermaid (Okie embeds entity metadata there); every other line is checked.
  const statements = semanticLines.join('\n');
  // Quoted label text cannot start a statement, so `;`-separated directive checks skip it.
  const unquoted = statements.replace(/"[^"\n]*"/gu, '""');
  if (/^[ \t]*%%\s*\{/imu.test(source)
    || /(?:^|;)[ \t]*(?:click|classDef|class|linkStyle|style)\s+/imu.test(unquoted)
    // Shape data (`a@{ img: "…" }`) makes Mermaid fetch resources before DOMPurify runs.
    || /@\s*\{/u.test(statements)
    || /javascript\s*:|data\s*:\s*text\/html/iu.test(source)
    // No URLs of any kind (mirrors the server validator): schemes and protocol-relative `//host`.
    || /\b(?:https?|ftp|file|data)\s*:|\/\//iu.test(statements)) {
    throw new Error('Mermaid source contains an unsupported active directive');
  }
}

function assertLocalUrlReferences(value: string): void {
  for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/giu)) {
    if (!/^#[A-Za-z_][\w:.-]*$/u.test(match[2] ?? '')) {
      throw new Error('Rendered Mermaid SVG contains an external URL');
    }
  }
}

/**
 * Decodes CSS escape sequences (`\XX` hex + optional trailing space, or `\<char>`)
 * so escape-obfuscated payloads — `url\28 …\29`, `\68ttp:`, `@im\70 ort` — are
 * normalized before the substring checks. DOMPurify intentionally leaves CSS
 * untouched (`style` is URI-safe-listed), so this decode-then-check is the
 * authoritative defense for CSS, replacing the previous raw-regex inspection.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\(?:([0-9a-fA-F]{1,6})[ \t\r\n\f]?|([^\r\n\f0-9a-fA-F]))/gu, (_full, hex: string | undefined, literal: string | undefined) => {
    if (hex === undefined) return literal ?? '';
    const codePoint = Number.parseInt(hex, 16);
    if (codePoint === 0 || codePoint > 0x10_ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(codePoint);
  });
}

export function assertSafeCssText(css: string): void {
  // Normalize BEFORE matching: strip CSS comments, decode CSS escapes, then
  // collapse whitespace — so comment-split (url(/**/…)), escape-obfuscated
  // (\75rl, \68ttp) and whitespace tricks all reduce to canonical text first.
  const normalized = decodeCssEscapes(css.replace(/\/\*[^]*?\*\//gu, '')).replace(/\s+/gu, ' ');
  // Allowlist, not blocklist: @import is never permitted (no remote stylesheets)
  // and IE expression() is an execution vector url() allowlisting cannot cover.
  // Deliberately no scheme enumeration (javascript:/data:) — every url() token is
  // required to be a local #fragment below, which is what actually closes the hole.
  if (/@import\b|expression\s*\(/iu.test(normalized)) {
    throw new Error('Rendered Mermaid SVG contains active styles');
  }
  assertLocalUrlReferences(normalized);
}

export function assertSafeMermaidSvgText(svg: string): void {
  if (!/^\s*<svg\b/iu.test(svg)) throw new Error('Mermaid did not return an SVG document');
  if (svg.length > MAX_MERMAID_SVG_LENGTH) throw new Error('Rendered Mermaid SVG exceeds the display limit');
  if (/<\s*(?:a|audio|embed|foreignObject|iframe|image|object|script|use|video)\b/iu.test(svg)) {
    throw new Error('Rendered Mermaid SVG contains an unsupported element');
  }
  if (/\s+on[a-z][\w:.-]*\s*=/iu.test(svg) || /\s+(?:href|xlink:href)\s*=/iu.test(svg)) {
    throw new Error('Rendered Mermaid SVG contains an active attribute');
  }
  if (/javascript\s*:|data\s*:\s*text\/html|@import\b/iu.test(svg)) {
    throw new Error('Rendered Mermaid SVG contains active content');
  }
  assertLocalUrlReferences(svg);
}

const allowedSvgElements = new Set([
  'circle',
  'clippath',
  'defs',
  'desc',
  'ellipse',
  'fedropshadow',
  'filter',
  'g',
  'line',
  'lineargradient',
  'marker',
  'mask',
  'path',
  'polygon',
  'polyline',
  'rect',
  'stop',
  'style',
  'svg',
  'text',
  'title',
  'tspan',
]);

function parseSafeMermaidSvg(svg: string, ownerDocument: Document, purify: DompurifyApi): SVGSVGElement {
  assertSafeMermaidSvgText(svg);

  // Independent hardened sanitizer over the rendered output: DOMPurify parses the
  // markup with a real HTML/SVG parser (defeating markup-level obfuscation the raw
  // text checks can miss) and drops the shared forbid list. DOMPurify deliberately
  // does NOT sanitize CSS (`style` is URI-safe-listed), so assertSafeCssText below
  // remains the authoritative defense for url()/@import in styles and <style>.
  const fragment = purify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [...MERMAID_SVG_FORBID_TAGS],
    FORBID_ATTR: [...MERMAID_SVG_FORBID_ATTR],
    RETURN_DOM_FRAGMENT: true,
  });

  const root = fragment.querySelector('svg');
  if (!root || root.namespaceURI !== 'http://www.w3.org/2000/svg') {
    throw new Error('Mermaid did not return a standalone SVG');
  }

  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.namespaceURI !== 'http://www.w3.org/2000/svg' || !allowedSvgElements.has(element.localName.toLowerCase())) {
      throw new Error('Rendered Mermaid SVG contains an unsupported element');
    }
    for (const attribute of element.getAttributeNames()) {
      const normalized = attribute.toLowerCase();
      const value = element.getAttribute(attribute) ?? '';
      if (normalized.startsWith('on') || normalized === 'href' || normalized === 'xlink:href') {
        throw new Error('Rendered Mermaid SVG contains an active attribute');
      }
      if (normalized === 'style') {
        assertSafeCssText(value);
        continue;
      }
      if (/javascript\s*:|data\s*:\s*text\/html|@import\b/iu.test(value)) {
        throw new Error('Rendered Mermaid SVG contains active content');
      }
      assertLocalUrlReferences(value);
    }
    if (element.localName.toLowerCase() === 'style') {
      assertSafeCssText(element.textContent ?? '');
    }
  }

  const safeRoot = ownerDocument.importNode(root, true) as unknown as SVGSVGElement;
  safeRoot.setAttribute('aria-hidden', 'true');
  safeRoot.setAttribute('focusable', 'false');
  return safeRoot;
}

type RenderState = 'loading' | 'ready' | 'error';

type MermaidDiagramProps = {
  source: string;
  title: string;
  /** Inspector architecture brief: smaller chrome, no derived-diagram outline note. */
  compact?: boolean;
  /** Error-state copy naming what the reader still has; defaults describe the host surface. */
  fallbackNote?: string;
};

export function MermaidDiagram({ source, title, compact = false, fallbackNote }: MermaidDiagramProps) {
  const headingId = useId();
  const hostRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<RenderState>('loading');
  const [expanded, setExpanded] = useState(false);
  const [zoom, setZoom] = useState(1);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const expandedHostRef = useRef<HTMLDivElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const [released, setReleased] = useState(mermaidReleased);

  // Held until the first map frame (mermaidLoadGate), unless the reader can already see this diagram.
  useEffect(() => {
    if (released) return;
    if (mermaidReleased()) { setReleased(true); return; }
    const stop = whenMermaidReleased(() => setReleased(true));
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === 'undefined') { releaseMermaid(); return stop; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) releaseMermaid();
    });
    observer.observe(section);
    return () => { stop(); observer.disconnect(); };
  }, [released]);

  useEffect(() => {
    if (!expanded) return;
    const dialog = dialogRef.current;
    const host = hostRef.current;
    const expandedHost = expandedHostRef.current;
    const svg = host?.firstElementChild;
    if (!dialog || !host || !expandedHost || !svg) return;
    const renderRequest = requestRef.current;
    // Move the already-sanitized SVG instead of rendering a duplicate with the
    // same marker IDs. Closing restores the exact inline preview immediately.
    expandedHost.replaceChildren(svg);
    dialog.showModal();
    return () => {
      dialog.close();
      if (requestRef.current === renderRequest) host.replaceChildren(svg);
      else svg.remove();
      expandButtonRef.current?.focus();
    };
  }, [expanded]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const request = ++requestRef.current;
    let cancelled = false;
    host.replaceChildren();
    setExpanded(false);
    setState('loading');
    if (!released) return;

    void (async () => {
      try {
        assertSafeMermaidSource(source);
        const [mermaid, purify] = await Promise.all([loadMermaid(), loadDompurify()]);
        if (cancelled || request !== requestRef.current) return;
        const result = await mermaid.render(stableMermaidRenderId(source), source);
        if (cancelled || request !== requestRef.current) return;
        const safeSvg = parseSafeMermaidSvg(result.svg, host.ownerDocument, purify);
        if (cancelled || request !== requestRef.current) return;
        host.replaceChildren(safeSvg);
        setState('ready');
      } catch {
        if (cancelled || request !== requestRef.current) return;
        host.replaceChildren();
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
      if (request === requestRef.current) {
        requestRef.current += 1;
        host.replaceChildren();
      }
    };
  }, [released, retry, source]);

  return <section aria-labelledby={headingId} className={`semantic-mermaid-diagram${compact ? ' is-compact' : ''}`} data-mermaid-compact={compact ? 'true' : undefined} ref={sectionRef}>
    <header>
      <div><span>Rendered view</span><h2 id={headingId}>{title}</h2></div>
      <small>Strict · deterministic SVG</small>
    </header>
    <div className={`semantic-mermaid-canvas is-${state}`}>
      <div aria-hidden="true" className="semantic-mermaid-svg" data-render-state={state} ref={hostRef}/>
      {state === 'ready' && <button className="semantic-mermaid-expand" ref={expandButtonRef} type="button" aria-label={`Expand diagram: ${title}`} onClick={() => { setZoom(1); setExpanded(true); }}><span>Expand diagram ↗</span></button>}
      {state === 'loading' && <div className="semantic-mermaid-status" role="status"><span/>Rendering diagram…</div>}
      {state === 'error' && <div className="semantic-mermaid-error" role="alert"><strong>Diagram preview unavailable</strong><span>{fallbackNote ?? (compact ? 'The system and container names in this architecture brief are still available.' : 'The structured participants and interactions below are still available.')}</span><button onClick={() => setRetry(value => value + 1)} type="button">Retry render</button></div>}
    </div>
    <dialog className="semantic-mermaid-viewer" ref={dialogRef} aria-label={title} onKeyDown={event => event.stopPropagation()} onClose={() => setExpanded(false)} onClick={event => { if (event.target === event.currentTarget) setExpanded(false); }}>
      <header>
        <h2>{title}</h2>
        <div className="semantic-mermaid-viewer-controls">
          <button type="button" aria-label="Zoom out diagram" disabled={zoom <= 1} onClick={() => setZoom(value => Math.max(1, value - .5))}>−</button>
          <button type="button" onClick={() => setZoom(1)}>Fit</button>
          <button type="button" aria-label="Zoom in diagram" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + .5))}>+</button>
          <button type="button" aria-label="Close expanded diagram" onClick={() => setExpanded(false)}>Close</button>
        </div>
      </header>
      <div className="semantic-mermaid-viewer-scroll">
        <div className="semantic-mermaid-viewer-svg" role="img" aria-label={title} ref={expandedHostRef} style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}/>
      </div>
    </dialog>
    {compact ? null : <p className="semantic-mermaid-outline-note">The structured outline below is the accessible and interactive representation of this diagram.</p>}
  </section>;
}

type CopyState = 'idle' | 'copied' | 'error';

export function MermaidSourceDisclosure({ source }: { source: string }) {
  const [copyState, setCopyState] = useState<CopyState>('idle');

  useEffect(() => setCopyState('idle'), [source]);

  const copySource = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(source);
      setCopyState('copied');
    } catch {
      setCopyState('error');
    }
  };

  return <details className="semantic-mermaid-source">
    <summary>Generated Mermaid source</summary>
    <div className="semantic-mermaid-source-actions">
      <span aria-live="polite">{copyState === 'copied' ? 'Source copied' : copyState === 'error' ? 'Copy unavailable' : 'Deterministic export payload'}</span>
      <button onClick={() => void copySource()} type="button">{copyState === 'copied' ? 'Copied' : 'Copy source'}</button>
    </div>
    <pre><code>{source}</code></pre>
  </details>;
}
