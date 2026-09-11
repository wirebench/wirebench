import {
  clearHistory,
  compareLastTwoHistoryEntries,
  resendLastHistoryEntry,
} from '../features/history/history-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useHistoryStore } from '../state/history.js';
import { useWsiStore } from '../state/wsi.js';

/**
 * Registers the `history.*` commands and the WS-I report export.
 *
 * None of them ships with a chord: the design's §5 table has no row for them, and inventing
 * one here would quietly take a key away from the user's own bindings. They exist so the
 * palette, the application menu and a user rebind can reach every §6.9 history action.
 */
export function registerHistoryCommands(): void {
  registerCommand({
    id: 'history.resend',
    label: 'History: Re-send Last Request',
    category: 'History',
    when: () => useHistoryStore.getState().entries.length > 0,
    whenScope: 'history.entries',
    run: () => void resendLastHistoryEntry(),
  });
  registerCommand({
    id: 'history.compare',
    label: 'History: Compare Last Two Sends',
    category: 'History',
    when: () => useHistoryStore.getState().entries.length > 1,
    whenScope: 'history.pair',
    run: () => {
      compareLastTwoHistoryEntries();
    },
  });
  registerCommand({
    id: 'history.clear',
    label: 'History: Delete All Entries',
    category: 'History',
    when: () => useHistoryStore.getState().total > 0,
    whenScope: 'history.entries',
    run: () => void clearHistory(),
  });

  registerCommand({
    id: 'request.exportWsiReport',
    label: 'Export WS-I Report…',
    category: 'Request',
    // The console's WS-I Report tab holds exactly one report — whichever check ran last — so
    // there is something to export only once one has.
    when: () => useWsiStore.getState().report !== undefined,
    whenScope: 'wsi.report',
    run: () => void useWsiStore.getState().exportHtml(),
  });
}
