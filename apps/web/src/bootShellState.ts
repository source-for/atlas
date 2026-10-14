import { isFramedBrowsingContext } from './embedCanvas';
import { initialInspectorOpen, isEmbedChrome, isEmbedQueryFlag } from './embedChrome';
import { embedButtonVisible } from './embedSnippet';
import { isDogfoodAtlas } from './hostedAtlas';
import { clampInspectorWidth, defaultInspectorWidth } from './inspector/inspectorPanel';
import type { AppRoute } from './renderer/route';

/**
 * CLA-268: the atlas shell skeleton main.tsx paints while a published atlas loads. It stands in the same boxes as
 * App's shell (same classes, same inspector width and open state) so the swap to App does not move anything, and it
 * says which boot step is running. These are its pure decisions; BootShell.tsx is the view.
 */

/** Boot steps in the order they run. The skeleton never shows an earlier step after a later one. */
export const BOOT_SHELL_STEPS = ['data', 'view', 'opening'] as const;
export type BootShellStep = typeof BOOT_SHELL_STEPS[number];

const LABELS: Record<BootShellStep, string> = {
  data: 'Loading atlas data…',
  view: 'Preparing the view…',
  opening: 'Opening the map…',
};

export function bootShellStepLabel(step: BootShellStep): string {
  return LABELS[step];
}

/** The step to show after `next` is reported: steps only move forward (a late report of an earlier step is ignored). */
export function advanceBootShellStep(current: BootShellStep, next: BootShellStep): BootShellStep {
  return BOOT_SHELL_STEPS.indexOf(next) > BOOT_SHELL_STEPS.indexOf(current) ? next : current;
}

export type BootShellLayout = {
  /** Embed chrome (framed or `?embed=1`): App's `data-embed`, which drops the tabs row and closes the inspector. */
  embed: boolean;
  /** App's initial inspector state (`initialInspectorOpen`). */
  detailsOpen: boolean;
  /** App's initial inspector width before a repository's stored width is known. */
  detailsWidth: number;
};

/** The layout inputs App reads on its first render, from the same helpers App uses. */
export function bootShellLayout(win: { innerWidth: number; self?: unknown; top?: unknown }, search: string): BootShellLayout {
  const framed = isFramedBrowsingContext(win as { self: unknown; top: unknown });
  return {
    embed: isEmbedChrome({ framed, embedQuery: isEmbedQueryFlag(search) }),
    detailsOpen: initialInspectorOpen(win, search),
    detailsWidth: clampInspectorWidth(defaultInspectorWidth(win.innerWidth), win.innerWidth),
  };
}

/** App's header controls, in its order: each skeleton slot copies its control's classes, so App's responsive rules apply. */
export type BootShellHeaderSlot = 'import' | 'screenshot' | 'share' | 'embed' | 'repo';

/**
 * App's header controls on its first frame: import, screenshot, share and source repository always; the embed button
 * on a `/r/` page outside embeds (shown for the dogfood atlas, held for a publication while the index answers). The
 * account menu waits on a sign-in lookup App makes after mount, so it has no slot.
 */
export function bootShellHeaderSlots(route: AppRoute, embed: boolean): BootShellHeaderSlot[] {
  const embedSlot = embedButtonVisible({
    routeIsRepo: route.kind === 'repo',
    published: true,
    dogfood: route.kind === 'repo' && isDogfoodAtlas(route.owner, route.repo),
    embedded: embed,
    portable: false,
  });
  return embedSlot ? ['import', 'screenshot', 'share', 'embed', 'repo'] : ['import', 'screenshot', 'share', 'repo'];
}
