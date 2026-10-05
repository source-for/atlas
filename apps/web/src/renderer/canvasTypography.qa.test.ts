import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  C4_LABEL_MIN_TITLE_PX,
  C4_LABEL_TITLE_SHRINK_RATIO,
  c4TitleFitFloor,
  displayTextWidth,
  fitDisplayText,
  fitDisplayTextAtSize,
  truncateDisplayText,
} from '@okie/scene-compiler';
import { Canvas2DRenderer, canvasEntityPresentationMetrics, projectionRepresentationDetail } from './Canvas2DRenderer';
import type { AtlasScene, RenderState, SemanticDetail } from './types';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './scanFixture';

type TextCall = {
  content: string;
  font: string;
  x: number;
  y: number;
  maxWidth?: number;
};

function fakeCanvas() {
  const values: Record<PropertyKey, unknown> = {};
  const calls = new Map<PropertyKey, ReturnType<typeof vi.fn>>();
  const textCalls: TextCall[] = [];
  const context = new Proxy(values, {
    get(target, property) {
      if (property in target) return target[property];
      const call = calls.get(property) ?? (property === 'fillText'
        ? vi.fn((content: string, x: number, y: number, maxWidth: number) => textCalls.push({
            content,
            font: String(target.font),
            x,
            y,
            maxWidth,
          }))
        : vi.fn());
      calls.set(property, call);
      return call;
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    canvas: { width: 0, height: 0, style: {}, getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement,
    call: (name: PropertyKey) => calls.get(name) ?? vi.fn(),
    textCalls,
  };
}

const state: RenderState = {
  focusedIds: new Set(),
  activeRelationIds: new Set(),
  flowRelationIds: new Set(),
  reduceMotion: true,
  animate: false,
  visibilityMode: 'all',
};

describe('Canvas2D band-normalized typography', () => {
  it('keeps one-sided projection typography in its authored band after the midpoint', () => {
    expect(projectionRepresentationDetail('node:container', undefined, .51, 'component')).toBe('container');
    expect(projectionRepresentationDetail(undefined, 'node:component', .49, 'container')).toBe('component');
    expect(projectionRepresentationDetail('node:container', 'node:component', .49, 'context')).toBe('container');
    expect(projectionRepresentationDetail('node:container', 'node:component', .51, 'context')).toBe('component');
  });

  it.each([
    { detail: 'context' as const, zoom: 0.75, title: 20, kicker: 13.5, description: 15.5 },
    { detail: 'container' as const, zoom: 1.99, title: 15.5, kicker: 10, description: 11 },
    { detail: 'component' as const, zoom: 5.27, title: 16.5, kicker: 10, description: 11 },
    { detail: 'code' as const, zoom: 13.96, title: 14, kicker: 10, description: 11 },
  ])('keeps $detail focus labels at native presentation scale', ({ detail, zoom, title, kicker, description }) => {
    const metrics = canvasEntityPresentationMetrics(detail, false, zoom);
    expect(metrics.titleFontSize).toBeCloseTo(title, 5);
    expect(metrics.kickerFontSize).toBeCloseTo(kicker, 5);
    expect(metrics.descriptionFontSize).toBeCloseTo(description, 5);
    expect(metrics.titleFontSize).toBeLessThan(30);
  });

  it('preserves the compiler boundary-title treatment at every band', () => {
    const bands: Array<{ detail: SemanticDetail; zoom: number; title: number }> = [
      { detail: 'context', zoom: 0.75, title: 15.6 },
      { detail: 'container', zoom: 1.99, title: 12.09 },
      { detail: 'component', zoom: 5.27, title: 16.5 },
      { detail: 'code', zoom: 13.96, title: 14 },
    ];
    for (const { detail, zoom, title } of bands) {
      expect(canvasEntityPresentationMetrics(detail, true, zoom).titleFontSize).toBeCloseTo(title, 5);
    }
  });

  it('keeps L4 text within the authored comfort cap at maximum runway', () => {
    const metrics = canvasEntityPresentationMetrics('code', false, 32);
    expect(metrics.titleFontSize).toBeGreaterThanOrEqual(24);
    expect(metrics.titleFontSize).toBeLessThanOrEqual(33);
    expect(metrics.kickerFontSize).toBeGreaterThanOrEqual(15);
    expect(metrics.kickerFontSize).toBeLessThanOrEqual(24);
    expect(metrics.descriptionFontSize).toBeGreaterThanOrEqual(15);
    expect(metrics.descriptionFontSize).toBeLessThanOrEqual(26);
  });

  it('keeps native Canvas corner and stroke geometry aligned at maximum runway', () => {
    const scene: AtlasScene = {
      id: 'rounded-rect-parity-fixture',
      title: 'Rounded rectangle parity fixture',
      subtitle: '',
      entities: [
        {
          id: 'code:owner',
          name: 'Owner',
          kind: 'component',
          detail: 'code',
          responsibility: 'Owns the fixture.',
          x: 0,
          y: 0,
          width: 20,
          height: 14,
        },
        {
          id: 'code:child',
          parentId: 'code:owner',
          name: 'Child',
          kind: 'component',
          detail: 'code',
          responsibility: 'Exercises card geometry.',
          x: 2,
          y: 2,
          width: 8,
          height: 6,
        },
      ],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(800, 600, 1);
    renderer.setCamera({ x: 10, y: 7, zoom: 32 });
    renderer.setRenderState(state);
    renderer.render(0);

    const ownerMetrics = canvasEntityPresentationMetrics('code', true, 32);
    const childMetrics = canvasEntityPresentationMetrics('code', false, 32);
    const radii = target.call('roundRect').mock.calls.map(call => call[4] as number);
    expect(radii).toContainEqual(ownerMetrics.radius);
    expect(radii).toContainEqual(childMetrics.radius);
    expect(ownerMetrics.radius).toBeCloseTo(57.3066, 3);
    expect(childMetrics.radius).toBeCloseTo(20.0573, 3);
    expect(ownerMetrics.strokeWidth).toBeCloseTo(4.298, 3);
    expect(childMetrics.strokeWidth).toBeCloseTo(5.731, 3);
  });

  it('clips Canvas labels to their card and paints kind, lines, and signature at L4', () => {
    const scene: AtlasScene = {
      id: 'typography-fixture',
      title: 'Typography fixture',
      subtitle: '',
      entities: [{
        id: 'code:validation',
        name: 'validateSnapshotWithLongSuffix',
        kind: 'component',
        kindLabel: 'SOURCE',
        detail: 'code',
        responsibility: 'This prose must not replace the signature at L4.',
        source: 'packages/architecture/src/validation.ts',
        sourceRefs: [{
          path: 'packages/architecture/src/validation.ts',
          symbol: 'validateSnapshotWithLongSuffix',
          startLine: 40,
          endLine: 88,
          revision: 'test',
        }],
        sourceExcerpts: [{
          path: 'packages/architecture/src/validation.ts',
          symbol: 'validateSnapshotWithLongSuffix',
          language: 'typescript',
          startLine: 40,
          endLine: 45,
          highlightLine: 40,
          frozenRevision: 'test',
          lines: ['export function validateSnapshotWithLongSuffix(snapshot: ArchitectureSnapshot): ValidationIssue[] {'],
          text: 'export function validateSnapshotWithLongSuffix(snapshot: ArchitectureSnapshot): ValidationIssue[] {',
        }],
        x: 0,
        y: 0,
        width: 30,
        height: 20,
      }],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(600, 400, 1);
    renderer.setCamera({ x: 15, y: 10, zoom: 13.96 });
    renderer.setRenderState(state);
    renderer.render(0);

    const card = { x: 90.6, y: 60.4, width: 418.8, height: 279.2 };
    const [clipRect] = target.call('rect').mock.calls.at(-1)!;
    expect(clipRect).toBeCloseTo(card.x);
    expect(target.call('rect').mock.calls.at(-1)![1]).toBeCloseTo(card.y);
    expect(target.call('rect').mock.calls.at(-1)![2]).toBeCloseTo(card.width);
    expect(target.call('rect').mock.calls.at(-1)![3]).toBeCloseTo(card.height);
    expect(target.call('clip')).toHaveBeenCalled();
    expect(target.textCalls).toHaveLength(4);
    expect(target.textCalls[0]!.content).toBe('FN · 40–88');
    expect(target.textCalls[1]!.font).toContain('14px');
    expect(target.textCalls[2]!.content).toContain('export function');
    expect(target.textCalls[2]!.content).not.toContain('validation.ts');
    expect(target.textCalls[2]!.content).not.toContain('prose');
    for (const call of target.textCalls) {
      expect(call.x).toBeGreaterThanOrEqual(card.x);
      expect(call.x).toBeLessThanOrEqual(card.x + card.width);
      expect(call.y).toBeGreaterThanOrEqual(card.y);
      expect(call.y).toBeLessThanOrEqual(card.y + card.height);
    }
  });

  it('keeps L1/L2 titles at the 12px floor and preserves scoped package tails at context zoom', () => {
    const metrics = canvasEntityPresentationMetrics('context', false, 0.32);
    expect(metrics.titleFontSize).toBeGreaterThanOrEqual(12);
    expect(metrics.titleFontSize).toBe(12);

    const scene: AtlasScene = {
      id: 'cla-53-labels',
      title: 'CLA-53 labels',
      subtitle: '',
      entities: [
        {
          id: 'external:react',
          name: 'react',
          kind: 'system',
          kindLabel: 'EXTERNAL SYSTEM',
          detail: 'context',
          responsibility: 'No summary supplied.',
          x: 0,
          y: 0,
          width: 480,
          height: 190,
        },
        {
          id: 'external:fontsource',
          name: '@fontsource/ibm-plex-sans',
          kind: 'system',
          kindLabel: 'EXTERNAL SYSTEM',
          detail: 'context',
          responsibility: 'No summary supplied.',
          x: 520,
          y: 0,
          width: 480,
          height: 190,
        },
        {
          id: 'external:dompurify',
          name: 'dompurify',
          kind: 'system',
          kindLabel: 'EXTERNAL SYSTEM',
          detail: 'context',
          responsibility: 'No summary supplied.',
          x: 1040,
          y: 0,
          width: 480,
          height: 190,
        },
      ],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1200, 400, 1);
    renderer.setCamera({ x: 760, y: 95, zoom: 0.32 });
    renderer.setRenderState(state);
    renderer.render(0);

    const titles = target.textCalls.filter(call => call.font.includes('12px'));
    const names = titles.map(call => call.content);
    expect(names).toContain('react');
    expect(names).toContain('dompurify');
    const fontsource = names.find(name => name.includes('ibm-plex-sans') || name.includes('fontsource'));
    expect(fontsource).toBeDefined();
    expect(fontsource).toMatch(/ibm-plex-sans$/);
    expect(fontsource?.startsWith('@fontsource/ibm-') && !fontsource.includes('plex-sans')).toBe(false);
    expect(target.textCalls.some(call => call.content === 'No summary supplied.')).toBe(false);
  });

  it('separates L1 and L2 boundary type kickers from titles during a semantic morph', () => {
    for (const detail of ['context', 'container'] as const) {
      for (const zoom of [.8, 1, 1.8]) {
        const metrics = canvasEntityPresentationMetrics(detail, true, zoom);
        // The title can hold the 12px readability floor while the baseline
        // scales with geometry, so protect against the larger glyph ascent.
        expect(metrics.titleBaseline - metrics.kickerBaseline)
          .toBeGreaterThanOrEqual(metrics.titleFontSize + metrics.kickerFontSize * .25 + 2 - 1e-6);
      }
    }
    // Outward L2→L1 keeps the container source representation below halfway;
    // this is the state that previously overprinted the L1 system label.
    expect(projectionRepresentationDetail('system:container', 'system:context', .25, 'context')).toBe('container');
  });

  it('omits the empty-summary placeholder on Canvas2D cards (CLA-121)', () => {
    const scene: AtlasScene = {
      id: 'cla-58-canvas',
      title: 'CLA-58 canvas',
      subtitle: '',
      entities: [
        {
          id: 'external:react',
          name: 'react',
          kind: 'system',
          kindLabel: 'EXTERNAL SYSTEM',
          detail: 'context',
          responsibility: '',
          x: 0,
          y: 0,
          width: 480,
          height: 190,
        },
        {
          id: 'system:okie',
          name: 'okie',
          kind: 'system',
          kindLabel: 'SOFTWARE SYSTEM',
          detail: 'context',
          responsibility: 'Spatial architecture atlas.',
          x: 520,
          y: 0,
          width: 480,
          height: 190,
        },
      ],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(1200, 400, 1);
    renderer.setCamera({ x: 500, y: 95, zoom: 0.75 });
    renderer.setRenderState(state);
    renderer.render(0);

    expect(target.textCalls.some(call => call.content === 'No summary supplied.')).toBe(false);
    expect(target.textCalls.some(call => call.content === 'Spatial architecture atlas.')).toBe(true);
  });

  it('CLA-111: does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(C4_LABEL_TITLE_SHRINK_RATIO).toBe(0.65);
    const renderer = readFileSync(new URL('./Canvas2DRenderer.ts', import.meta.url), 'utf8');
    expect(renderer).toContain('c4TitleFitFloor(renderedDetail, metrics.titleFontSize, C4_LABEL_MIN_TITLE_PX)');
    expect(renderer).not.toContain('renderedDetail === \'context\' || renderedDetail === \'container\'');
  });

  it.each([
    { detail: 'component' as const, zoom: 5.27, metricsRole: 'sans-semibold' as const },
    { detail: 'code' as const, zoom: 13.96, metricsRole: 'mono-semibold' as const },
  ])('CLA-111: $detail titles shrink before ellipsis on a tight card', ({ detail, zoom, metricsRole }) => {
    const metrics = canvasEntityPresentationMetrics(detail, false, zoom);
    const floor = c4TitleFitFloor(detail, metrics.titleFontSize, C4_LABEL_MIN_TITLE_PX);
    expect(floor).toBeLessThan(metrics.titleFontSize);
    if (detail === 'component') expect(floor).toBe(C4_LABEL_MIN_TITLE_PX);
    else expect(floor).toBeCloseTo(metrics.titleFontSize * C4_LABEL_TITLE_SHRINK_RATIO, 10);

    const name = 'createNavigationHistoryController';
    const fullWidth = displayTextWidth(name, metrics.titleFontSize, metricsRole);
    const floorWidth = displayTextWidth(name, floor, metricsRole);
    const textMaxWidth = (fullWidth + floorWidth) / 2;
    const worldWidth = (textMaxWidth + metrics.horizontalInsets) / zoom;
    expect(fitDisplayText(name, textMaxWidth, metrics.titleFontSize, 'identifier', metricsRole)).toContain('…');

    const scene: AtlasScene = {
      id: 'cla-111-title-floor',
      title: 'CLA-111 title floor',
      subtitle: '',
      entities: [{
        id: `${detail}:tight`,
        name,
        kind: 'component',
        kindLabel: detail === 'code' ? 'SOURCE' : 'COMPONENT',
        detail,
        responsibility: 'Exercises shrink-before-truncate.',
        source: 'apps/web/src/navigation/historyController.ts',
        x: 0,
        y: 0,
        width: worldWidth,
        height: 20,
      }],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(800, 400, 1);
    renderer.setCamera({ x: worldWidth / 2, y: 10, zoom });
    renderer.setRenderState(state);
    renderer.render(0);

    const title = target.textCalls.find(call => call.content.includes('History') || call.content.includes('…'));
    expect(title).toBeDefined();
    expect(title!.content).toBe(name);
    const painted = Number(title!.font.match(/([\d.]+)px/u)?.[1]);
    expect(painted).toBeGreaterThanOrEqual(floor);
    expect(painted).toBeLessThan(metrics.titleFontSize);
    expect(title!.font).not.toContain(`${metrics.titleFontSize}px`);
  });

  it('CLA-111: extreme-narrow L4 still truncates at the shrink floor without growing the card', () => {
    const zoom = 13.96;
    const metrics = canvasEntityPresentationMetrics('code', false, zoom);
    const floor = c4TitleFitFloor('code', metrics.titleFontSize, C4_LABEL_MIN_TITLE_PX);
    const name = 'createNavigationHistoryController';
    const worldWidth = 8;
    const screenWidth = worldWidth * zoom;
    const textMaxWidth = Math.max(1, screenWidth - metrics.horizontalInsets);
    const fitted = fitDisplayTextAtSize(name, textMaxWidth, metrics.titleFontSize, floor, 'identifier', 'mono-semibold');
    expect(fitted.fontSize).toBe(floor);
    expect(fitted.content.includes('…') || fitted.content.length < name.length).toBe(true);

    const scene: AtlasScene = {
      id: 'cla-111-extreme-narrow',
      title: 'CLA-111 extreme narrow',
      subtitle: '',
      entities: [{
        id: 'code:tight',
        name,
        kind: 'component',
        kindLabel: 'SOURCE',
        detail: 'code',
        responsibility: 'Must not explode layout.',
        source: 'apps/web/src/navigation/historyController.ts',
        x: 0,
        y: 0,
        width: worldWidth,
        height: 12,
      }],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(400, 300, 1);
    renderer.setCamera({ x: worldWidth / 2, y: 6, zoom });
    renderer.setRenderState(state);
    renderer.render(0);

    const title = target.textCalls[1]!;
    expect(title.font).toContain(`${floor}px`);
    expect(title.content).toBe(fitted.content);
    const cardWidth = target.call('roundRect').mock.calls[0]![2] as number;
    expect(cardWidth).toBeCloseTo(screenWidth, 5);
  });

  it('CLA-112: does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
  });

  it('CLA-114: does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    const renderer = readFileSync(new URL('./Canvas2DRenderer.ts', import.meta.url), 'utf8');
    expect(renderer).toContain('codeCardCopy(entity)');
    expect(renderer).not.toMatch(/renderedDetail === 'code'\s*\n\s*\? entity\.source/u);
  });

  it('CLA-112: narrow L3 filename titles keep the stem, not a left-stemmed tail', () => {
    const zoom = 5.27;
    const metrics = canvasEntityPresentationMetrics('component', false, zoom);
    const floor = c4TitleFitFloor('component', metrics.titleFontSize, C4_LABEL_MIN_TITLE_PX);
    const name = 'src/diagnostics.rs';
    const fitted = fitDisplayTextAtSize(name, 52, metrics.titleFontSize, floor, 'identifier', 'sans-semibold');
    expect(fitted.content).toBe('di…cs.rs');
    expect(fitted.content).not.toMatch(/^…[^/]/u);
    expect(truncateDisplayText(name, 10, 'identifier')).toBe('diag…cs.rs');

    const worldWidth = (52 + metrics.horizontalInsets) / zoom;
    const scene: AtlasScene = {
      id: 'cla-112-stem',
      title: 'CLA-112 stem',
      subtitle: '',
      entities: [{
        id: 'component:diagnostics',
        name,
        kind: 'component',
        kindLabel: 'COMPONENT',
        detail: 'component',
        responsibility: 'Must keep the filename stem.',
        source: 'src/diagnostics.rs',
        x: 0,
        y: 0,
        width: worldWidth,
        height: 20,
      }],
      relations: [],
      regions: [],
    };
    const target = fakeCanvas();
    const renderer = new Canvas2DRenderer(target.canvas, 'canvas2d');
    renderer.setScene(scene);
    renderer.resize(800, 400, 1);
    renderer.setCamera({ x: worldWidth / 2, y: 10, zoom });
    renderer.setRenderState(state);
    renderer.render(0);

    const title = target.textCalls[1]!;
    expect(title.content).toBe(fitted.content);
    expect(title.content).toBe('di…cs.rs');
    expect(title.content).not.toMatch(/^…[^/]/u);
    expect(title.font).toContain(`${floor}px`);
  });
});
