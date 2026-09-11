import { create } from 'zustand';
import type { WsiReportWire } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';
import { usePreferencesStore } from './preferences.js';
import { useUiStore } from './ui.js';

/** What the WS-I Report tab is doing right now. */
export type WsiStatus = 'idle' | 'running' | 'ready' | 'error';

/** The console's WS-I Report tab holds exactly one report — the last one that was run. */
export interface WsiStore {
  readonly status: WsiStatus;
  /** The last report, kept while a new run is in flight so the tab does not flash empty. */
  readonly report?: WsiReportWire | undefined;
  /** Set when the last run failed; the tab shows it instead of a table. */
  readonly error?: string | undefined;
  /** Whether the table shows the passing/not-applicable rows too. Seeded from `wsi.verbose`. */
  readonly showAll: boolean;
  readonly setShowAll: (showAll: boolean) => void;
  /** Runs the description catalogue over one imported interface. */
  readonly checkWsdl: (interfaceId: string) => Promise<void>;
  /** Runs the message catalogue over one cached send. */
  readonly checkExchange: (sendId: string) => Promise<void>;
  /** Exports the current report as HTML through the save dialog. */
  readonly exportHtml: () => Promise<void>;
  readonly clear: () => void;
}

/** A filename that is safe on every platform and still recognisable. */
function suggestedName(report: WsiReportWire): string {
  const slug = report.label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug.length === 0 ? 'ws-i' : slug}-ws-i-report.html`;
}

/** The toast one finished run shows. */
function summarize(report: WsiReportWire): string {
  const { failed, warning } = report.summary;
  if (failed === 0 && warning === 0) {
    return `WS-I ${report.profile}: no failures in ${String(report.assertions.length)} assertions.`;
  }
  const parts = [
    ...(failed > 0 ? [`${String(failed)} failed`] : []),
    ...(warning > 0 ? [`${String(warning)} warning${warning === 1 ? '' : 's'}`] : []),
  ];
  return `WS-I ${report.profile}: ${parts.join(' and ')}.`;
}

/**
 * The renderer half of the WS-I checks: both runs go through main (`wsi.checkWsdl` /
 * `wsi.checkExchange`), land here, and reveal the console's WS-I Report tab. Kept out of the
 * menus and commands so the palette, the two context menus and Task 45's Interface editor tab
 * all take exactly the same path.
 */
export const useWsiStore = create<WsiStore>((set, get) => {
  const finish = (result: { ok: true; value: WsiReportWire } | { ok: false; error: { message: string } }): void => {
    if (!result.ok) {
      set({ status: 'error', error: result.error.message });
      showToast(`WS-I check failed: ${result.error.message}`);
      return;
    }
    set({ status: 'ready', report: result.value, error: undefined });
    showToast(summarize(result.value));
  };

  const begin = (): void => {
    set({ status: 'running', error: undefined, showAll: usePreferencesStore.getState().preferences.wsi.verbose });
    useUiStore.getState().showConsoleTab('ws-i-report');
  };

  return {
    status: 'idle',
    showAll: false,
    setShowAll: (showAll) => {
      set({ showAll });
    },
    checkWsdl: async (interfaceId) => {
      begin();
      finish(await ipc().wsi.checkWsdl({ interfaceId }));
    },
    checkExchange: async (sendId) => {
      begin();
      finish(await ipc().wsi.checkExchange({ sendId }));
    },
    exportHtml: async () => {
      const report = get().report;
      if (report === undefined) {
        return;
      }
      const result = await ipc().wsi.exportHtml({
        report,
        suggestedName: suggestedName(report),
        verbose: get().showAll,
      });
      if (!result.ok) {
        showToast(`Export failed: ${result.error.message}`);
        return;
      }
      showToast(result.value.cancelled ? 'Export cancelled.' : `Report written to ${result.value.path ?? ''}`);
    },
    clear: () => {
      set({ status: 'idle', report: undefined, error: undefined });
    },
  };
});
