import { useExchangesStore } from './exchanges.js';
import { CONSOLE_COLLAPSED_BELOW_PX, fixedLayout, useUiStore } from './ui.js';

/**
 * Opens the console the first time the HTTP log gains a row, so a fresh workspace (whose console
 * starts collapsed) shows the log of its first send. After that, and once the user has opened,
 * closed or resized the console, a send leaves it as it is. A short window keeps it collapsed and
 * the first-send promise for later: open there, it left the editor and response about 150px each
 * (#636). Returns the unsubscribe.
 */
export function subscribeConsoleToFirstSend(windowHeight: () => number = () => globalThis.innerHeight): () => void {
  return useExchangesStore.subscribe((state, previous) => {
    if (state.log.length > previous.log.length && !isShortWindow(windowHeight())) {
      useUiStore.getState().openConsoleForFirstSend();
    }
  });
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
