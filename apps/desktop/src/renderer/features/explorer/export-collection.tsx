/**
 * **Export as Postman Collection… / OpenCollection…** (collection exporters spec §4): main picks the
 * folder and writes the files; this asks for the export and shows what came back — the files, and
 * the report of what could not be represented.
 */

import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { ImportReportView } from './import-report.js';

export type CollectionFormat = 'postman' | 'opencollection';

export const COLLECTION_FORMAT_LABELS: Readonly<Record<CollectionFormat, string>> = {
  postman: 'Postman Collection',
  opencollection: 'OpenCollection',
};

/** What one export wrote, for the report dialog. */
export interface CollectionExportReport {
  readonly format: CollectionFormat;
  readonly dir: string;
  readonly files: readonly string[];
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

interface ExportReportState {
  readonly report: CollectionExportReport | null;
  readonly setReport: (report: CollectionExportReport | null) => void;
}

export const useCollectionExportReport = create<ExportReportState>((set) => ({
  report: null,
  setReport: (report) => set({ report }),
}));

/** What to export: a project, or one API or interface (main finds its project). */
export type CollectionExportTarget = { readonly projectId: string } | { readonly containerId: string };

/** Asks main to export `target`; a cancelled dialog does nothing, a refusal is a toast. */
export async function exportCollection(target: CollectionExportTarget, format: CollectionFormat): Promise<void> {
  const result = await ipc().workspace.exportCollection({ ...target, format });
  if (!result.ok) {
    showToast(result.error.message);
    return;
  }
  const { cancelled, dir, files, warnings, notes } = result.value;
  if (cancelled || dir === undefined) {
    return;
  }
  useCollectionExportReport.getState().setReport({ format, dir, files, warnings, notes });
}

/** The report text **Copy report** puts on the clipboard. */
export function exportReportText(report: CollectionExportReport): string {
  return [
    `Exported as ${COLLECTION_FORMAT_LABELS[report.format]} to ${report.dir}:`,
    ...report.files.map((file) => `  ${file}`),
    ...report.warnings.map((line) => `Warning: ${line}`),
    ...report.notes.map((line) => `Note: ${line}`),
  ].join('\n');
}

/** The dialog an export ends in, mounted once by the shell. */
export function CollectionExportReportDialog() {
  const report = useCollectionExportReport((state) => state.report);
  const setReport = useCollectionExportReport((state) => state.setReport);
  return (
    <Dialog.Root
      open={report !== null}
      onOpenChange={(open) => {
        if (!open) setReport(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="collection-export-report"
          className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          {report !== null && (
            <>
              <Dialog.Title className="text-md font-medium text-fg-default">
                Exported as {COLLECTION_FORMAT_LABELS[report.format]}
              </Dialog.Title>
              <Dialog.Description asChild>
                <div className="text-sm text-fg-subtle">
                  <p>
                    Written to <span className="font-mono text-fg-default">{report.dir}</span>:
                  </p>
                  <ul data-testid="collection-export-files" className="mt-1 font-mono text-xs">
                    {report.files.map((file) => (
                      <li key={file}>{file}</li>
                    ))}
                  </ul>
                </div>
              </Dialog.Description>
              {report.warnings.length === 0 && report.notes.length === 0 ? (
                <p className="text-sm text-fg-default">Everything was exported.</p>
              ) : (
                <ImportReportView
                  warnings={report.warnings}
                  notes={report.notes}
                  reportText={exportReportText(report)}
                  testId="collection-export"
                />
              )}
              <div className="flex justify-end">
                <Dialog.Close asChild>
                  <Button>Close</Button>
                </Dialog.Close>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
