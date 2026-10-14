import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { getPublishedAtlasAttribution, getPublishedAtlasAttributionSettled, onPublishedAtlasAttribution } from './atlasAttribution';
import { isFramedBrowsingContext } from './embedCanvas';
import {
  buildEmbedLink,
  buildEmbedSnippet,
  DEFAULT_EMBED_PRESET,
  EMBED_OEMBED_NOTE,
  EMBED_SIZE_PRESETS,
  embedAvailabilityInput,
  embedButtonSlotReserved,
  embedButtonVisible,
  type EmbedSizePresetId,
} from './embedSnippet';
import { CheckIcon, CodeIcon } from './icons';
import type { PublicAtlasDisplayNames } from './oembed';

/**
 * CLA-329: the header's "Embed this atlas" button and its dialog (size presets, start-at-this-view, the iframe
 * snippet and Copy). The decisions are pure helpers below (tested in node); the component is a thin shell.
 */

export const EMBED_DIALOG_TITLE = 'Embed this atlas';
export const EMBED_COPY_FAILED_MESSAGE = 'Could not access the clipboard. Select the snippet above and copy it manually.';
/** The link field sits below the status line and is what gets selected on failure. */
export const EMBED_LINK_COPY_FAILED_MESSAGE = 'Could not access the clipboard. The link below is selected; copy it manually.';
export const EMBED_UNAVAILABLE_MESSAGE = "This atlas URL can't be embedded.";
const COPIED_FEEDBACK_MS = 2400;
const WINDOW_TIMERS: TimerApi = { set: (callback, ms) => window.setTimeout(callback, ms), clear: handle => window.clearTimeout(handle) };

/** Where Tab/Shift+Tab should wrap to inside the dialog, or undefined to let the browser move focus. */
export function focusTrapTarget(input: { index: number; count: number; shift: boolean }): number | undefined {
  const { index, count, shift } = input;
  if (count <= 0) return undefined;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return undefined;
}

export type TimerHandle = number | undefined;
export type TimerApi = { set(callback: () => void, ms: number): TimerHandle; clear(handle: TimerHandle): void };

/**
 * Settle a copy's feedback once its clipboard write has resolved. Any pending "Copied" reset is cleared first,
 * whatever the outcome, so an earlier copy's timer can never wipe a later result (Copy then Copy link in quick
 * succession, either succeeding or failing). Only a success schedules a new reset.
 */
export function settleCopyFeedback(ref: { current: TimerHandle }, timers: TimerApi, copied: boolean, reset: () => void, ms: number): void {
  timers.clear(ref.current);
  ref.current = copied ? timers.set(reset, ms) : undefined;
}

export type EmbedClipboard = { writeText(text: string): Promise<void> } | undefined;

/** True when the snippet reached the clipboard. An empty snippet is never "copied". */
export async function copyEmbedSnippet(text: string, clipboard: EmbedClipboard): Promise<boolean> {
  if (!clipboard || !text) return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Tab stops in order: a radio group contributes only its checked radio (as the browser does). */
function tabStops(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(TABBABLE)]
    .filter(element => !(element instanceof HTMLInputElement && element.type === 'radio' && !element.checked));
}

/** `reserved`: the index has not answered yet and a publication would show the button (CLA-268: hold its slot). */
export type EmbedAvailability = { visible: boolean; reserved: boolean; displayNames?: PublicAtlasDisplayNames };

/** Whether this page offers the embed button; reacts to the publication index resolving after mount. */
export function useEmbedAtlasAvailability(portable: boolean): EmbedAvailability {
  const attribution = useSyncExternalStore(onPublishedAtlasAttribution, getPublishedAtlasAttribution, getPublishedAtlasAttribution);
  const settled = useSyncExternalStore(onPublishedAtlasAttribution, getPublishedAtlasAttributionSettled, getPublishedAtlasAttributionSettled);
  const framed = useMemo(() => isFramedBrowsingContext(), []);
  const { pathname, search } = window.location;
  return useMemo(() => {
    const input = embedAvailabilityInput({ pathname, search, framed, portable, attribution });
    const visible = embedButtonVisible(input);
    const reserved = embedButtonSlotReserved(input, settled);
    return attribution ? { visible, reserved, displayNames: { owner: attribution.owner, repo: attribution.repo } } : { visible, reserved };
  }, [pathname, search, framed, portable, attribution, settled]);
}

/** Which Copy last ran and how it went (the snippet's and the link's buttons share one status line). */
export type EmbedCopyState = 'idle' | 'copied' | 'failed' | 'link-copied' | 'link-failed';

export type EmbedDialogProps = {
  titleId: string;
  preset: EmbedSizePresetId;
  startAtView: boolean;
  snippet: string;
  copyState: EmbedCopyState;
  /** The plain atlas link (oEmbed discovery), '' when unavailable. */
  link: string;
  onCopyLink(): void;
  onPreset(preset: EmbedSizePresetId): void;
  onStartAtView(value: boolean): void;
  onCopy(): void;
};

/** The dialog's contents (no behaviour of its own). */
export function EmbedDialogBody(props: EmbedDialogProps) {
  const { titleId, preset, startAtView, snippet, copyState, link } = props;
  return <>
    <h2 id={titleId}>{EMBED_DIALOG_TITLE}</h2>
    <fieldset className="embed-size-presets">
      <legend>Size</legend>
      {EMBED_SIZE_PRESETS.map(candidate => (
        <label key={candidate.id}>
          <input checked={preset === candidate.id} name={`${titleId}-size`} onChange={() => props.onPreset(candidate.id)} type="radio" value={candidate.id}/>
          <span>{candidate.label}</span>
        </label>
      ))}
    </fieldset>
    <label className="embed-start-at-view">
      <input checked={startAtView} onChange={event => props.onStartAtView(event.currentTarget.checked)} type="checkbox"/>
      <span>Start at this view</span>
    </label>
    <label className="embed-snippet-field">
      <span className="sr-only">Embed code</span>
      <textarea data-testid="embed-snippet" onFocus={event => event.currentTarget.select()} readOnly rows={5} spellCheck={false} value={snippet}/>
    </label>
    {!snippet && <p className="embed-unavailable" data-testid="embed-unavailable" role="alert">{EMBED_UNAVAILABLE_MESSAGE}</p>}
    <div className="embed-copy-row">
      <button className={copyState === 'copied' ? 'copied' : undefined} data-testid="embed-copy" disabled={!snippet} onClick={props.onCopy} type="button">
        {copyState === 'copied' ? <><CheckIcon size={14}/> Copied</> : 'Copy'}
      </button>
      <span aria-live="polite" className={`embed-copy-status ${copyState}`} role="status">
        {copyState === 'failed' ? EMBED_COPY_FAILED_MESSAGE : copyState === 'link-failed' ? EMBED_LINK_COPY_FAILED_MESSAGE : copyState === 'copied' ? 'Embed code copied.' : copyState === 'link-copied' ? 'Atlas link copied.' : ''}
      </span>
    </div>
    <p className="embed-oembed-note">{EMBED_OEMBED_NOTE}</p>
    <div className="embed-link-row">
      <label className="embed-link-field">
        <span className="sr-only">Atlas link</span>
        <input data-testid="embed-link" onFocus={event => event.currentTarget.select()} readOnly spellCheck={false} type="text" value={link}/>
      </label>
      <button className={copyState === 'link-copied' ? 'copied' : undefined} data-testid="embed-copy-link" disabled={!link} onClick={props.onCopyLink} type="button">
        {copyState === 'link-copied' ? <><CheckIcon size={14}/> Copied</> : 'Copy link'}
      </button>
    </div>
  </>;
}

export type EmbedAtlasControlProps = {
  /** Flush the live view into the URL (as Copy current view does) and return the page URL. */
  readPageHref(): string;
  displayNames?: PublicAtlasDisplayNames | undefined;
  /** Test seam; defaults to navigator.clipboard. */
  clipboard?: EmbedClipboard;
};

export function EmbedAtlasControl({ readPageHref, displayNames, clipboard }: EmbedAtlasControlProps) {
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<EmbedSizePresetId>(DEFAULT_EMBED_PRESET);
  const [startAtView, setStartAtView] = useState(true);
  const [pageHref, setPageHref] = useState('');
  const [copyState, setCopyState] = useState<EmbedCopyState>('idle');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<TimerHandle>(undefined);

  const snippetFor = useCallback(
    (href: string) => (href ? buildEmbedSnippet({ pageHref: href, startAtView, preset, ...(displayNames ? { displayNames } : {}) }) ?? '' : ''),
    [startAtView, preset, displayNames],
  );
  const snippet = useMemo(() => snippetFor(pageHref), [snippetFor, pageHref]);
  const linkFor = useCallback((href: string) => (href ? buildEmbedLink({ pageHref: href, startAtView }) ?? '' : ''), [startAtView]);
  const link = useMemo(() => linkFor(pageHref), [linkFor, pageHref]);

  const refresh = useCallback(() => {
    setPageHref(readPageHref());
    setCopyState('idle');
  }, [readPageHref]);

  const close = useCallback((restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  }, []);

  // Focus moves into the dialog when it opens: the snippet, selected and ready to copy.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  }, [open]);

  // A press outside the dialog (and its button) closes it; focus stays where the press put it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (dialogRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  useEffect(() => () => WINDOW_TIMERS.clear(copiedTimerRef.current), []);

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    // The dialog owns its keystrokes: none reach the atlas shortcuts (Escape, +/- zoom, v/c tools) on window.
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const stops = tabStops(dialogRef.current);
    const index = stops.indexOf(document.activeElement as HTMLElement);
    const next = focusTrapTarget({ index, count: stops.length, shift: event.shiftKey });
    if (next === undefined) return;
    event.preventDefault();
    stops[next]?.focus();
  }

  async function onCopy() {
    // The camera may have moved since the dialog opened: copy the live view, and show exactly what was copied.
    let text = snippet;
    if (startAtView) {
      const href = readPageHref();
      setPageHref(href);
      text = snippetFor(href);
    }
    if (!text) { setCopyState('idle'); return; } // the unavailable message already shows; nothing to copy
    const copied = await copyEmbedSnippet(text, clipboard ?? (typeof navigator === 'undefined' ? undefined : navigator.clipboard));
    setCopyState(copied ? 'copied' : 'failed');
    settleCopyFeedback(copiedTimerRef, WINDOW_TIMERS, copied, () => setCopyState('idle'), COPIED_FEEDBACK_MS);
    if (!copied) dialogRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.select();
  }

  async function onCopyLink() {
    let text = link;
    if (startAtView) {
      const href = readPageHref();
      setPageHref(href);
      text = linkFor(href);
    }
    if (!text) { setCopyState('idle'); return; }
    const copied = await copyEmbedSnippet(text, clipboard ?? (typeof navigator === 'undefined' ? undefined : navigator.clipboard));
    setCopyState(copied ? 'link-copied' : 'link-failed');
    settleCopyFeedback(copiedTimerRef, WINDOW_TIMERS, copied, () => setCopyState('idle'), COPIED_FEEDBACK_MS);
    if (!copied) dialogRef.current?.querySelector<HTMLInputElement>('[data-testid="embed-link"]')?.select();
  }

  return (
    <div className="embed-atlas-control">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Embed this atlas"
        className={`icon-button embed-atlas-button ${open ? 'open' : ''}`}
        data-testid="embed-atlas"
        onClick={() => {
          if (open) { close(false); return; }
          refresh();
          setOpen(true);
        }}
        ref={buttonRef}
        title="Embed"
        type="button"
      >
        <CodeIcon/>
      </button>
      {open && (
        <div aria-labelledby={titleId} aria-modal="true" className="embed-popover" data-testid="embed-dialog" onKeyDown={onDialogKeyDown} ref={dialogRef} role="dialog" tabIndex={-1}>
          <EmbedDialogBody
            copyState={copyState}
            link={link}
            onCopyLink={() => { void onCopyLink(); }}
            onCopy={() => { void onCopy(); }}
            onPreset={next => { setPreset(next); refresh(); }}
            onStartAtView={next => { setStartAtView(next); refresh(); }}
            preset={preset}
            snippet={snippet}
            startAtView={startAtView}
            titleId={titleId}
          />
        </div>
      )}
    </div>
  );
}
