import { isFramedBrowsingContext } from './embedCanvas';
import { initialInspectorOpen, isEmbedChrome, isEmbedQueryFlag } from './embedChrome';
import { embedButtonVisible } from './embedSnippet';
import { isDogfoodAtlas } from './hostedAtlas';
import { clampInspectorWidth, defaultInspectorWidth, inspectorWidthStorageKey } from './inspector/inspectorPanel';
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
  /** App's initial inspector width: the repository's saved width when its identity is known, else the default. */
  detailsWidth: number;
};

type WidthStorage = Pick<Storage, 'getItem'>;

/**
 * The layout inputs App reads on its first render, from the same helpers App uses. `repositoryId` is App's repository
 * identity (bootShellRepositoryId); without it the width is App's default, as App would show for a repository with
 * no saved width.
 */
export function bootShellLayout(
  win: { innerWidth: number; self?: unknown; top?: unknown },
  search: string,
  saved?: { storage: WidthStorage | undefined; repositoryId: string | undefined },
): BootShellLayout {
  const framed = isFramedBrowsingContext(win as { self: unknown; top: unknown });
  return {
    embed: isEmbedChrome({ framed, embedQuery: isEmbedQueryFlag(search) }),
    detailsOpen: initialInspectorOpen(win, search),
    detailsWidth: initialInspectorWidth(win.innerWidth, saved?.storage, saved?.repositoryId),
  };
}

/** App's `detailsWidth` initializer: the saved `okie:inspector-width:<repositoryId>` (clamped), else the default. */
export function initialInspectorWidth(viewportWidth: number, storage: WidthStorage | undefined, repositoryId: string | undefined): number {
  let stored = Number.NaN;
  if (storage && repositoryId !== undefined) {
    try {
      stored = Number.parseFloat(storage.getItem(inspectorWidthStorageKey(repositoryId)) ?? '');
    } catch {
      // Storage can be unavailable in privacy modes; use the repository default.
    }
  }
  return clampInspectorWidth(Number.isFinite(stored) ? stored : defaultInspectorWidth(viewportWidth), viewportWidth);
}

// navigationState.ts's URL rules, mirrored here so the boot chunk does not carry the navigation module
// (bootShellState.test.ts checks the two agree).
const MAX_NAVIGATION_QUERY_LENGTH = 4_096;
const MAX_NAVIGATION_ID_LENGTH = 512;
const NAVIGATION_URL_VERSION = '1';

function cleanNavigationId(value: string | undefined, fallback: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && candidate.length <= MAX_NAVIGATION_ID_LENGTH && !/[\u0000-\u001f\u007f]/.test(candidate) ? candidate : fallback;
}

/**
 * The repository identity App keys the inspector width by (`navigationStateFromUrl(...).repositoryId`): a shared
 * view's `repo` parameter, else the atlas's own repository (`atlasRepositoryId`, undefined until known).
 */
export function bootShellRepositoryId(href: string, atlasRepositoryId: string | undefined): string | undefined {
  const atlas = cleanNavigationId(atlasRepositoryId, atlasRepositoryId);
  let url: URL;
  try { url = new URL(href); } catch { return atlas; }
  if (url.search.length > MAX_NAVIGATION_QUERY_LENGTH) return atlas;
  const version = url.searchParams.getAll('nav').at(-1);
  if (version !== undefined && version !== NAVIGATION_URL_VERSION) return atlas;
  const repo = url.searchParams.getAll('repo').at(-1);
  return repo === undefined ? atlas : cleanNavigationId(repo, atlas);
}

/**
 * Which repository a boot route showed last time, so the skeleton's first frame can use that repository's saved
 * inspector width before this visit's data says which repository it is.
 */
const ROUTE_REPOSITORY_KEY = 'okie:boot-repository:';

export function recallRouteRepository(storage: WidthStorage | undefined, routeKey: string): string | undefined {
  try {
    return storage?.getItem(ROUTE_REPOSITORY_KEY + routeKey) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberRouteRepository(storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, routeKey: string, repositoryId: string): void {
  try {
    if (storage && storage.getItem(ROUTE_REPOSITORY_KEY + routeKey) !== repositoryId) storage.setItem(ROUTE_REPOSITORY_KEY + routeKey, repositoryId);
  } catch {
    // Storage can be unavailable in privacy modes: the width then applies once the data names the repository.
  }
}

export type BootShellFrame = {
  step: BootShellStep;
  fontsReady: boolean;
  /** The atlas's repository, once known (recalled for the route, then from the data). */
  atlasRepositoryId: string | undefined;
};

/**
 * Who owns the root while the skeleton shows. main.tsx must call `release()` synchronously before it renders
 * anything else into the root: `root.render` is asynchronous, so the DOM cannot say whether the skeleton is still
 * the root's content, and a late font load re-rendering the skeleton would replace App (or an error screen).
 */
export function createBootShellOwner(deps: {
  render(frame: BootShellFrame): void;
  /** True when the wordmark's faces are already loaded. */
  fontsLoaded(): boolean;
  /** Settles once the wordmark's faces have loaded or failed. */
  loadFonts(): Promise<unknown>;
  aborted(): boolean;
}) {
  let step: BootShellStep | undefined;
  let fonts: 'pending' | 'loading' | 'ready' = 'pending';
  let atlasRepositoryId: string | undefined;
  const paint = () => {
    if (step && !deps.aborted()) deps.render({ step, fontsReady: fonts === 'ready', atlasRepositoryId });
  };
  return {
    /** Paints the skeleton at `next` (steps only move forward), with the atlas's repository when it is known. */
    show(next: BootShellStep, repositoryId?: string) {
      step = step ? advanceBootShellStep(step, next) : next;
      if (repositoryId !== undefined) atlasRepositoryId = repositoryId;
      if (fonts === 'pending') {
        fonts = 'loading';
        try {
          if (deps.fontsLoaded()) fonts = 'ready';
          // Re-paint once the wordmark's faces are in (a failure shows it in the fallback face rather than never).
          else void deps.loadFonts().catch(() => undefined).then(() => {
            fonts = 'ready';
            paint();
          });
        } catch {
          fonts = 'ready';
        }
      }
      paint();
    },
    /** The root is about to get something else: nothing the skeleton scheduled may paint it again. */
    release() {
      step = undefined;
    },
    get owns() {
      return step !== undefined;
    },
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
