import { createSourceRequestController, sourceContextIsLoading } from './sourceRequest';
import { fetchSourceRange, immutableFileUrl, type SourceContext, type SourceRange } from './sourceFetch';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SceneSourceExcerpt } from '../renderer/types';
import type { PortableAtlas } from '@okie/architecture';
import { getActivePortableAtlas } from '../portable/runtime';

export type SourceLanguage = SceneSourceExcerpt['language'];
export type SourceToken = { kind: 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'punctuation'; text: string };
export type SourceEditor = 'vscode' | 'cursor' | 'zed';
export type LocalWorkspaceContext = {
  repositoryRoot: string;
  checkedRevision?: string;
  openEditor?: (editor: SourceEditor, target: { relativePath: string; line: number; column: 1 }) => void | Promise<void>;
};

const sourceTokenPattern = /(\/\/.*$|\/\*.*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b|\b(?:as|async|await|break|const|continue|crate|else|enum|export|false|fn|for|from|function|if|impl|import|in|interface|let|match|mod|move|mut|new|null|pub|return|self|static|struct|super|this|trait|true|type|undefined|use|where|while)\b|[{}()[\],.;:<>+=!&|?\-*/])/giu;

export function sourceLanguage(excerpt: SceneSourceExcerpt): SourceLanguage {
  return excerpt.path.toLowerCase().endsWith('.json') ? 'json' : excerpt.language;
}

export function tokenizeSourceLine(line: string, _language: SourceLanguage): SourceToken[] {
  const tokens: SourceToken[] = [];
  let cursor = 0;
  for (const match of line.matchAll(sourceTokenPattern)) {
    const index = match.index ?? cursor;
    if (index > cursor) tokens.push({ kind: 'plain', text: line.slice(cursor, index) });
    const text = match[0];
    const kind: SourceToken['kind'] = text.startsWith('//') || text.startsWith('/*')
      ? 'comment'
      : text.startsWith('"') || text.startsWith("'") || text.startsWith('`')
        ? 'string'
        : /^(?:0x[\da-f]+|\d)/iu.test(text)
          ? 'number'
          : /^\p{L}/u.test(text)
            ? 'keyword'
            : 'punctuation';
    tokens.push({ kind, text });
    cursor = index + text.length;
  }
  if (cursor < line.length) tokens.push({ kind: 'plain', text: line.slice(cursor) });
  return tokens.length ? tokens : [{ kind: 'plain', text: line }];
}

export function tokenizeSourceLines(lines: readonly string[], language: SourceLanguage): SourceToken[][] {
  let multilineComment = false;
  return lines.map(line => {
    if (multilineComment) {
      const end = line.indexOf('*/');
      if (end < 0) return [{ kind: 'comment', text: line }];
      multilineComment = false;
      return [
        { kind: 'comment', text: line.slice(0, end + 2) },
        ...tokenizeSourceLine(line.slice(end + 2), language),
      ];
    }
    const start = line.indexOf('/*');
    if (start < 0 || line.indexOf('*/', start + 2) >= 0) return tokenizeSourceLine(line, language);
    multilineComment = true;
    return [
      ...tokenizeSourceLine(line.slice(0, start), language),
      { kind: 'comment', text: line.slice(start) },
    ];
  });
}

export function validRelativeSourcePath(path: string): boolean {
  if (!path
    || path.startsWith('/')
    || path.startsWith('\\')
    || path.includes('\\')
    || /[:?#\u0000-\u001f\u007f]/u.test(path)) return false;
  return path.split('/').every(segment => {
    if (!segment || segment === '.' || segment === '..') return false;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded !== '.' && decoded !== '..'
        && !decoded.includes('/') && !decoded.includes('\\')
        && !/[:?#\u0000-\u001f\u007f]/u.test(decoded);
    } catch {
      return false;
    }
  });
}

export function absoluteSourcePath(repositoryRoot: string | undefined, path: string): string | undefined {
  const root = repositoryRoot?.trim().replace(/[\\/]+$/u, '');
  if (!root || !validRelativeSourcePath(path)) return undefined;
  return `${root}/${path.replaceAll('\\', '/')}`;
}

export function editorSourceUri(editor: SourceEditor, absolutePath: string, line = 1): string {
  const path = absolutePath.split('/').map(segment => encodeURIComponent(segment)).join('/');
  const safeLine = Number.isFinite(line) ? Math.max(1, Math.trunc(line)) : 1;
  if (editor === 'vscode') return `vscode://file/${path}:${safeLine}:1`;
  if (editor === 'cursor') return `cursor://file/${path}:${safeLine}:1`;
  if (editor === 'zed') return `zed://file/${path}:${safeLine}:1`;
  throw new Error('Unsupported editor.');
}

async function writeClipboard(value: string) {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser.');
  await navigator.clipboard.writeText(value);
}

/** Only recognized hosting URLs can produce a trustworthy commit-pinned file URL. */
export function portableRepositoryRevisionUrl(repository: PortableAtlas['repository']): string | undefined {
  if (!repository.url || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(repository.commitSha)) return undefined;
  let url: URL;
  try { url = new URL(repository.url); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return undefined;
  const match = /^\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/?$/iu.exec(url.pathname);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]!.replace(/\.git$/u, '')}/tree/${repository.commitSha}`;
}

export function portableSourceUrls(repository: PortableAtlas['repository'], excerpt: SceneSourceExcerpt): { file: string; raw: string } | undefined {
  if (repository.commitSha !== excerpt.frozenRevision || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/iu.test(repository.commitSha)
    || !validRelativeSourcePath(excerpt.path) || !repository.url) return undefined;
  let url: URL;
  try { url = new URL(repository.url); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.port) return undefined;
  const match = /^\/([a-z0-9-]+)\/([a-z0-9_.-]+)\/?$/iu.exec(url.pathname);
  if (!match) return undefined;
  const repo = match[2]!.replace(/\.git$/u, '');
  const target = `${match[1]}/${repo}/${repository.commitSha}/${excerpt.path.split('/').map(encodeURIComponent).join('/')}`;
  return { file: `https://github.com/${match[1]}/${repo}/blob/${repository.commitSha}/${excerpt.path.split('/').map(encodeURIComponent).join('/')}#L${excerpt.highlightLine}`, raw: `https://raw.githubusercontent.com/${target}` };
}

export function bundledSourceRange(bundle: PortableAtlas, excerpt: SceneSourceExcerpt, start = 1, end = Number.MAX_SAFE_INTEGER): SourceRange | undefined {
  if (bundle.repository.commitSha !== excerpt.frozenRevision) return undefined;
  const file = bundle.sources?.find(source => source.path === excerpt.path);
  if (!file) return undefined;
  const lines = file.text.split(/\r?\n/u);
  const first = Math.max(1, Math.min(start, lines.length));
  const last = Math.max(first, Math.min(end, lines.length));
  return { repository: bundle.repository.url ?? '', commit: bundle.repository.commitSha, path: file.path,
    startLine: first, endLine: last, totalLines: lines.length, lines: lines.slice(first - 1, last), digest: '' };
}

export function SourceViewer({
  excerpt,
  localWorkspace,
  sourceContext,
  portableAtlas = getActivePortableAtlas(),
  pending,
  onFeedback,
}: {
  excerpt?: SceneSourceExcerpt;
  /** Why there is no excerpt yet: still being fetched, or the fetch failed. Absent means none exists. */
  pending?: 'loading' | 'failed';
  localWorkspace?: LocalWorkspaceContext;
  sourceContext?: SourceContext;
  portableAtlas?: PortableAtlas;
  onFeedback: (message: string) => void;
}) {
  const identity = JSON.stringify([sourceContext, portableAtlas?.repository, excerpt]);
  const requestRef = useRef(createSourceRequestController());
  requestRef.current.select(identity);
  const [loaded, setLoaded] = useState<{ identity: string; range: SourceRange }>();
  const [loadState, setLoadState] = useState<{ identity: string; loading?: boolean; error?: string }>();
  const contextLoading = sourceContextIsLoading(requestRef.current, identity, loadState);
  const range = loaded?.identity === identity ? loaded.range : undefined;
  const display = excerpt && range ? { ...excerpt, ...range } : excerpt;
  const portableUrls = portableAtlas && excerpt ? portableSourceUrls(portableAtlas.repository, excerpt) : undefined;
  const bundled = portableAtlas && excerpt ? bundledSourceRange(portableAtlas, excerpt) : undefined;
  const fullUrl = portableAtlas ? portableUrls?.file : sourceContext && excerpt && validRelativeSourcePath(excerpt.path) ? immutableFileUrl(sourceContext, excerpt.frozenRevision, excerpt.path) : undefined;
  useEffect(() => () => { requestRef.current.cancel(); }, [identity]);
  const loadMore = async () => {
    if (!excerpt || !display) return;
    if (portableAtlas) {
      const local = bundledSourceRange(portableAtlas, excerpt, Math.max(1, display.startLine - 30), display.endLine + 30);
      if (local) setLoaded({ identity, range: local });
      return;
    }
    if (!sourceContext) return;
    setLoadState({ identity, loading: true });
    const start = Math.max(1, display.startLine - 30);
    const end = Math.min(start + 499, display.endLine + 30);
    await requestRef.current.run(identity,
      signal => fetchSourceRange(sourceContext, excerpt.frozenRevision, excerpt.path, start, end, signal),
      result => { setLoaded({ identity, range: result }); setLoadState({ identity }); },
      error => setLoadState({ identity, error: error instanceof Error ? error.message : 'Historical source unavailable.' }),
    );
  };
  const fetchPortableFile = async () => {
    if (!portableUrls || !excerpt || !portableAtlas) return;
    setLoadState({ identity, loading: true });
    await requestRef.current.run(identity, async signal => {
      const response = await fetch(portableUrls.raw, { signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error('Full file unavailable from GitHub at this commit.');
      if (Number(response.headers.get('content-length')) > 5 * 1024 * 1024) throw new Error('Full file exceeds the 5 MiB viewer limit.');
      const text = await response.text();
      if (text.length > 5 * 1024 * 1024) throw new Error('Full file exceeds the 5 MiB viewer limit.');
      return bundledSourceRange({ ...portableAtlas, sources: [{ path: excerpt.path, text }] }, excerpt)!;
    }, result => { setLoaded({ identity, range: result }); setLoadState({ identity }); },
    error => setLoadState({ identity, error: error instanceof Error ? error.message : 'Historical source unavailable.' }));
  };
  const highlightedLineRef = useRef<HTMLDivElement | null>(null);
  const [feedback, setFeedback] = useState<string>();
  const absolutePath = excerpt ? absoluteSourcePath(localWorkspace?.repositoryRoot, excerpt.path) : undefined;
  const language = excerpt ? sourceLanguage(excerpt) : 'typescript';
  const lineTokens = useMemo(() => tokenizeSourceLines(display?.lines ?? [], language), [display, language]);

  useEffect(() => {
    highlightedLineRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [excerpt?.path, excerpt?.highlightLine]);

  const notify = (message: string) => {
    setFeedback(message);
    onFeedback(message);
  };
  const copy = async (label: string, value: string | undefined) => {
    if (!value) {
      notify(`${label} is unavailable.`);
      return;
    }
    try {
      await writeClipboard(value);
      notify(`${label} copied.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : `${label} could not be copied.`);
    }
  };
  const openEditor = async (editor: SourceEditor) => {
    if (!excerpt || !absolutePath) {
      notify('Configure VITE_OKIE_REPOSITORY_ROOT to enable local editor actions.');
      return;
    }
    try {
      if (localWorkspace?.openEditor) {
        await localWorkspace.openEditor(editor, { relativePath: excerpt.path, line: excerpt.highlightLine || excerpt.startLine || 1, column: 1 });
      } else {
        window.open(editorSourceUri(editor, absolutePath, excerpt.highlightLine || excerpt.startLine || 1), '_blank', 'noopener,noreferrer');
      }
      notify(`Opening ${editor === 'vscode' ? 'VS Code' : editor === 'cursor' ? 'Cursor' : 'Zed'} at line ${excerpt.highlightLine}.`);
    } catch (error) {
      notify(error instanceof Error ? error.message : 'The local editor is unavailable.');
    }
  };

  if (!excerpt && pending === 'loading') return <SourceViewerSkeleton/>;
  if (!excerpt && pending === 'failed') {
    return <div className="source-unavailable" role="status"><strong>Source excerpt could not be loaded</strong><p>Select Details and then Source to try again. Details and relative evidence remain available.</p></div>;
  }
  if (!excerpt) {
    return <div className="source-unavailable" role="status"><strong>Source excerpt unavailable</strong><p>This entity has no portable frozen source excerpt. Details and relative evidence remain available.</p></div>;
  }

  return <section aria-label={`Read-only source for ${excerpt.symbol ?? excerpt.path}`} className="source-viewer">
    <header className="source-meta">
      <div><strong>{excerpt.path}</strong><span>{excerpt.symbol ?? 'File excerpt'} · lines {display?.startLine}–{display?.endLine}</span></div>
      <span className="source-language">{language}</span>
    </header>
    <div aria-label={`${excerpt.path}, read only`} className="source-code" role="region" tabIndex={0}>
      <div className="source-lines">
        {lineTokens.map((tokens, index) => {
          const line = (display?.startLine ?? excerpt.startLine) + index;
          const highlighted = line === excerpt.highlightLine;
          return <div {...(highlighted ? { 'aria-current': 'line' as never } : {})} className={`source-line ${highlighted ? 'highlighted' : ''}`} key={line} ref={highlighted ? highlightedLineRef : undefined}>
            <span aria-hidden="true" className="source-line-number">{line}</span>
            <code>{tokens.map((token, tokenIndex) => <span className={`token-${token.kind}`} key={`${tokenIndex}:${token.text}`}>{token.text}</span>)}</code>
          </div>;
        })}
      </div>
    </div>
    {loadState?.identity === identity && loadState.error && <p role="status">{loadState.error} Showing saved source.</p>}
    <div aria-label="Source actions" className="source-actions">
      {portableAtlas ? <>
        {bundled ? <>
          <button disabled={!!range && range.startLine === 1 && range.endLine === range.totalLines} onClick={() => { void loadMore(); }} type="button">Load more context</button>
          <button disabled={!!range && range.startLine === 1 && range.endLine === range.totalLines} onClick={() => setLoaded({ identity, range: bundled })} type="button">View full bundled file</button>
        </> : <>
          <span>Full source is not bundled. The saved excerpt remains available.</span>
          {portableUrls && <button disabled={contextLoading} onClick={() => { void fetchPortableFile(); }} type="button">{contextLoading ? 'Loading full file…' : 'Fetch full file from GitHub'}</button>}
        </>}
        {fullUrl && <a href={fullUrl} target="_blank" rel="noopener noreferrer">View full file at this commit</a>}
      </> : fullUrl && <>
        <button disabled={contextLoading || !!range && (range.endLine - range.startLine + 1 >= 500 || range.startLine === 1 && range.endLine === range.totalLines)} onClick={() => { void loadMore(); }} type="button">{contextLoading ? 'Loading context…' : 'Load more context'}</button>
        <a href={fullUrl} target="_blank" rel="noopener noreferrer">View full file at this commit</a>
      </>}
      <button disabled={!excerpt.symbol} onClick={() => { void copy('Symbol', excerpt.symbol); }} type="button">Copy symbol</button>
      <button onClick={() => { void copy('Relative path', excerpt.path); }} type="button">Copy relative</button>
      {absolutePath && <button onClick={() => { void copy('Absolute path', absolutePath); }} type="button">Copy absolute</button>}
      {absolutePath && <details className="editor-menu">
        <summary aria-label="Open source in editor">Open in…</summary>
        <div role="menu">
          {(['vscode', 'cursor', 'zed'] as const).map(editor => <button key={editor} onClick={() => { void openEditor(editor); }} role="menuitem" type="button">{editor === 'vscode' ? 'VS Code' : editor === 'cursor' ? 'Cursor' : 'Zed'}</button>)}
        </div>
      </details>}
    </div>
    <footer className="source-revision"><span>Frozen @ {excerpt.frozenRevision.slice(0, 12)}</span>{localWorkspace?.checkedRevision && localWorkspace.checkedRevision !== excerpt.frozenRevision && <span className="source-revision-warning">Working tree revision differs</span>}{feedback && <span aria-live="polite">{feedback}</span>}</footer>
  </section>;
}

const skeletonLineWidths = [62, 48, 71, 39, 66, 54, 30, 58, 74, 45, 61, 36];

/** The viewer's own boxes with placeholder lines, so the excerpt replaces it in place. */
export function SourceViewerSkeleton() {
  return <section aria-busy="true" aria-label="Loading source excerpt" className="source-viewer source-viewer-loading" data-testid="source-loading">
    <header className="source-meta"><div><span className="inspector-skeleton-line" style={{ width: 180 }}/><span className="inspector-skeleton-line" style={{ width: 120 }}/></div></header>
    <div className="source-code"><div className="source-lines">
      {skeletonLineWidths.map((width, index) => <div aria-hidden="true" className="source-line" key={index}><span className="source-line-number"/><span className="inspector-skeleton-line" style={{ width: `${width}%` }}/></div>)}
    </div></div>
    <p className="source-loading-status" role="status">Loading source excerpt…</p>
  </section>;
}
