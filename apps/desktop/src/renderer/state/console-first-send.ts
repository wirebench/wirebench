import { toneFor } from '../features/request-editor/response-status.js';
import { useExchangesStore, type LogEntry } from './exchanges.js';
import { countProblems, useProblemsStore } from './problems.js';
import { CONSOLE_COLLAPSED_BELOW_PX, fixedLayout, useUiStore } from './ui.js';
import type { ConsoleTab } from './ui-state.js';

/** A send the console should show unasked: no response at all, a fault, a 4xx or 5xx, a gRPC error. */
export function isFailedSend(entry: LogEntry): boolean {
  return entry.kind === 'failure' || toneFor(entry.exchange) === 'bad';
}

/**
 * Opens the console when something goes wrong: a send fails (see {@link isFailedSend}) or a new
 * problem appears. A workspace's console starts collapsed and a send that worked leaves it so
 * (G07); it keeps opening itself only until the user opens, closes or resizes it, the choice the
 * workspace then remembers. A short window keeps it collapsed and the promise for later: open
 * there, it left the editor and response about 150px each (#636). Returns the unsubscribe.
 */
export function subscribeConsoleToTrouble(windowHeight: () => number = () => globalThis.innerHeight): () => void {
  const open = (tab: ConsoleTab): void => {
    if (!isShortWindow(windowHeight())) useUiStore.getState().openConsoleForFirstSend(tab);
  };
  const offLog = useExchangesStore.subscribe((state, previous) => {
    // The newest row, not the length: a full log drops its oldest row as it adds one.
    const newest = state.log.at(-1);
    if (newest !== undefined && newest !== previous.log.at(-1) && isFailedSend(newest)) open('http-log');
  });
  const offProblems = useProblemsStore.subscribe((state, previous) => {
    if (
      state.items !== previous.items &&
      countProblems(state.items).problems > countProblems(previous.items).problems
    ) {
      open('problems');
    }
  });
  return () => {
    offLog();
    offProblems();
  };
}

/** Whether a window this tall is too short for the console beside the editor; never in a fixed e2e layout. */
export function isShortWindow(height: number): boolean {
  return !fixedLayout() && height > 0 && height < CONSOLE_COLLAPSED_BELOW_PX;
}

/**
 * Collapses an open console when the window is resized below the short-window height, as a short
 * window starts with it collapsed, and reopens it when the window grows back if nothing else
 * touched it in between (#636). Returns the unsubscribe.
 */
export function collapseConsoleInShortWindow(
  target: Pick<Window, 'addEventListener' | 'removeEventListener' | 'innerHeight'> = window,
): () => void {
  let short = isShortWindow(target.innerHeight);
  // True only while the console is collapsed because of the window; any open or close by the
  // user (or a send) clears it, so growing the window never undoes their choice.
  let collapsedByResize = false;
  const stopWatching = useUiStore.subscribe((state, previous) => {
    if (state.console.visible !== previous.console.visible) collapsedByResize = false;
  });
  const onResize = (): void => {
    const nowShort = isShortWindow(target.innerHeight);
    if (nowShort === short) return;
    short = nowShort;
    const ui = useUiStore.getState();
    if (nowShort && ui.console.visible) {
      ui.collapseConsole();
      collapsedByResize = true;
    } else if (!nowShort && collapsedByResize) {
      ui.expandConsole();
      collapsedByResize = false;
    }
  };
  target.addEventListener('resize', onResize);
  return () => {
    target.removeEventListener('resize', onResize);
    stopWatching();
  };
}
