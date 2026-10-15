import { useExchangesStore } from './exchanges.js';
import { useUiStore } from './ui.js';

/**
 * Opens the console the first time the HTTP log gains a row, so a fresh workspace (whose console
 * starts collapsed) shows the log of its first send. After that, and once the user has opened,
 * closed or resized the console, a send leaves it as it is. Returns the unsubscribe.
 */
export function subscribeConsoleToFirstSend(): () => void {
  return useExchangesStore.subscribe((state, previous) => {
    if (state.log.length > previous.log.length) {
      useUiStore.getState().openConsoleForFirstSend();
    }
  });
}
