import type { PortableAtlas } from '@okie/architecture';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { bundledSourceRange, portableSourceUrls, portableRepositoryRevisionUrl, absoluteSourcePath, editorSourceUri, SourceViewer, tokenizeSourceLine, tokenizeSourceLines, validRelativeSourcePath } from './SourceViewer';

describe('source viewer helpers', () => {
  it('opens the imported repository at its scanned commit, never an unrelated default branch', () => {
    const repository = { commitSha: 'a'.repeat(40), treeHash: 'b'.repeat(40), url: 'https://github.com/example/project.git' };
    expect(portableRepositoryRevisionUrl(repository)).toBe(`https://github.com/example/project/tree/${repository.commitSha}`);
    expect(portableRepositoryRevisionUrl({ ...repository, url: undefined })).toBeUndefined();
    expect(portableRepositoryRevisionUrl({ ...repository, url: 'https://unknown-host.example/project' })).toBeUndefined();
  });
  it('degrades gracefully when a code entity has source refs but no frozen excerpt', () => {
    // Refs-only entities still open Source (CLA-9); the viewer must present a
    // clean unavailable state rather than throw when selectedExcerpt is missing.
    const markup = renderToStaticMarkup(createElement(SourceViewer, { excerpt: undefined, onFeedback: () => undefined }));
    expect(markup).toContain('Source excerpt unavailable');
    expect(markup).toContain('no portable frozen source excerpt');
    expect(markup).toContain('role="status"');
  });

  it('shows a placeholder in the viewer boxes, not "unavailable", while the excerpt is still loading', () => {
    const loading = renderToStaticMarkup(createElement(SourceViewer, { excerpt: undefined, pending: 'loading', onFeedback: () => undefined }));
    expect(loading).toContain('data-testid="source-loading"');
    expect(loading).toContain('class="source-viewer source-viewer-loading"');
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain('unavailable');
    // Announced through the app's live region, not a prefilled status inside aria-busy.
    expect(loading).not.toContain('role="status"');
    const failed = renderToStaticMarkup(createElement(SourceViewer, { excerpt: undefined, pending: 'failed', onFeedback: () => undefined }));
    expect(failed).toContain('Source excerpt could not be loaded');
    expect(failed).not.toContain('no portable frozen source excerpt');
  });

  it('renders a portable frozen excerpt for a scanned code entity', () => {
    const excerpt = {
      path: 'apps/web/src/inspector/inspectorPanel.ts',
      symbol: 'inspectorAcceptedSummary',
      language: 'typescript' as const,
      startLine: 83,
      endLine: 89,
      highlightLine: 83,
      frozenRevision: 'abc123def456',
      lines: [
        'export function inspectorAcceptedSummary(',
        '  entity: InspectorSummaryEntity | undefined,',
        '): string | undefined {',
        '  const text = entity?.responsibility?.trim();',
        '  if (!text || text === INSPECTOR_EMPTY_SUMMARY) return undefined;',
        '  return text;',
        '}',
      ],
      text: '',
    };
    excerpt.text = excerpt.lines.join('\n');
    const markup = renderToStaticMarkup(createElement(SourceViewer, { excerpt, onFeedback: () => undefined }));
    expect(markup).toContain('inspectorAcceptedSummary');
    expect(markup).toContain('apps/web/src/inspector/inspectorPanel.ts');
    expect(markup).toContain('INSPECTOR_EMPTY_SUMMARY');
    expect(markup).toContain('source-viewer');
    expect(markup).not.toContain('Source excerpt unavailable');
  });

  it('tokenizes source deterministically without changing its text', () => {
    const line = 'export const answer: number = 42; // frozen';
    const tokens = tokenizeSourceLine(line, 'typescript');
    expect(tokens.map(token => token.text).join('')).toBe(line);
    expect(tokens).toEqual(expect.arrayContaining([
      { kind: 'keyword', text: 'export' },
      { kind: 'number', text: '42' },
      { kind: 'comment', text: '// frozen' },
    ]));
    expect(tokenizeSourceLine('pub fn main() { println!("ok"); }', 'rust').map(token => token.text).join(''))
      .toBe('pub fn main() { println!("ok"); }');
    expect(tokenizeSourceLine('{"enabled": true}', 'json').map(token => token.text).join(''))
      .toBe('{"enabled": true}');
    expect(tokenizeSourceLine('', 'typescript').map(token => token.text).join('')).toBe('');
    expect(tokenizeSourceLines(['const a = 1; /* open', 'still comment', 'done */ const b = 2;'], 'typescript'))
      .toEqual(expect.arrayContaining([
        expect.arrayContaining([{ kind: 'comment', text: 'still comment' }]),
      ]));
  });

  it('joins only validated relative paths to an explicitly configured root', () => {
    expect(validRelativeSourcePath('apps/web/src/App.tsx')).toBe(true);
    expect(validRelativeSourcePath('../secret')).toBe(false);
    expect(validRelativeSourcePath('/etc/passwd')).toBe(false);
    expect(validRelativeSourcePath('apps\\web\\App.tsx')).toBe(false);
    expect(validRelativeSourcePath('apps//App.tsx')).toBe(false);
    expect(validRelativeSourcePath('https://example.test/App.tsx')).toBe(false);
    expect(validRelativeSourcePath('apps/%2e%2e/secret.ts')).toBe(false);
    expect(validRelativeSourcePath('apps/%2Fsecret.ts')).toBe(false);
    expect(validRelativeSourcePath('apps/App.tsx?raw')).toBe(false);
    expect(validRelativeSourcePath('apps/App.tsx#L1')).toBe(false);
    expect(validRelativeSourcePath('apps/\u0000bad.ts')).toBe(false);
    expect(absoluteSourcePath('/work/okie/', 'apps/web/src/App.tsx')).toBe('/work/okie/apps/web/src/App.tsx');
    expect(absoluteSourcePath(undefined, 'apps/web/src/App.tsx')).toBeUndefined();
    expect(absoluteSourcePath('/work/okie', '../secret')).toBeUndefined();
  });

  it('builds editor URIs only from an already-derived absolute path', () => {
    expect(editorSourceUri('vscode', '/work/okie/apps/web/src/App.tsx', 42))
      .toBe('vscode://file//work/okie/apps/web/src/App.tsx:42:1');
    expect(editorSourceUri('cursor', '/work/okie/apps/web/src/App.tsx', 42))
      .toBe('cursor://file//work/okie/apps/web/src/App.tsx:42:1');
    expect(editorSourceUri('zed', '/work/okie/apps/web/src/App.tsx', 42))
      .toBe('zed://file//work/okie/apps/web/src/App.tsx:42:1');
    expect(editorSourceUri('vscode', '/work/okie/a#b?.ts', -4))
      .toBe('vscode://file//work/okie/a%23b%3F.ts:1:1');
    expect(() => editorSourceUri('javascript' as never, '/work/okie/App.tsx', 1)).toThrow('Unsupported editor');
  });
});


describe('portable source viewing', () => {
  const commit = 'a'.repeat(40);
  const excerpt = { path: 'src/api.ts', language: 'typescript' as const, startLine: 2, endLine: 2, highlightLine: 2, frozenRevision: commit, lines: ['export const api = 1;'], text: 'export const api = 1;' };
  const bundle = { repository: { commitSha: commit, treeHash: 'b'.repeat(40), url: 'https://github.com/example/project.git' }, sources: [{ path: excerpt.path, text: '// context\nexport const api = 1;\n// end' }] } as PortableAtlas;

  it('reads full bundled source with exact revision and range bounds', () => {
    expect(bundledSourceRange(bundle, excerpt)).toMatchObject({ startLine: 1, endLine: 3, totalLines: 3, lines: ['// context', 'export const api = 1;', '// end'] });
    expect(bundledSourceRange(bundle, excerpt, 2, 2)?.lines).toEqual(excerpt.lines);
    expect(bundledSourceRange(bundle, { ...excerpt, frozenRevision: 'c'.repeat(40) })).toBeUndefined();
    expect(bundledSourceRange(bundle, { ...excerpt, path: 'missing.ts' })).toBeUndefined();
  });

  it('creates only recognized commit-pinned external URLs', () => {
    expect(portableSourceUrls(bundle.repository, excerpt)).toEqual({ file: `https://github.com/example/project/blob/${commit}/src/api.ts#L2`, raw: `https://raw.githubusercontent.com/example/project/${commit}/src/api.ts` });
    expect(portableSourceUrls({ ...bundle.repository, url: 'https://other.example/repo' }, excerpt)).toBeUndefined();
    expect(portableSourceUrls(bundle.repository, { ...excerpt, path: '../secret' })).toBeUndefined();
    expect(portableSourceUrls(bundle.repository, { ...excerpt, frozenRevision: 'main' })).toBeUndefined();
  });

  it('offers local full source instead of backend loading and keeps excerpts when full files are absent', () => {
    const render = (portableAtlas: PortableAtlas) => renderToStaticMarkup(createElement(SourceViewer, { excerpt, portableAtlas, sourceContext: { owner: 'example', repo: 'project', scanBasePath: '/scan' }, onFeedback: () => undefined }));
    const local = render(bundle);
    expect(local).toContain('View full bundled file');
    expect(local).not.toContain('Fetch full file from GitHub');
    const absent = render({ ...bundle, sources: [] });
    expect(absent).toContain('Full source is not bundled');
    expect(absent).toContain('Fetch full file from GitHub');
    expect(absent).toContain('export');
    expect(absent).not.toContain('Load more context');
  });
});
