/**
 * The tail every import summary that has something to report shares: the warnings to look at, the
 * notes, and a button that copies the whole report as text.
 */

import { useState } from 'react';

/** One report line, its path first when it has one. A bare string is a line without a path. */
export type ImportReportLine = string | { readonly path: string; readonly message: string };

const plural = (n: number, word: string): string => `${String(n)} ${n === 1 ? word : `${word}s`}`;

/**
 * Warnings and notes, each in its own box when there are any, then **Copy report**. The test ids
 * are `${testId}-warnings`, `${testId}-notes` and `${testId}-copy-report`.
 */
export function ImportReportView({
  warnings,
  notes,
  reportText,
  testId,
}: {
  readonly warnings: readonly ImportReportLine[];
  readonly notes: readonly ImportReportLine[];
  readonly reportText: string;
  readonly testId: string;
}) {
  return (
    <>
      {warnings.length > 0 && (
        <div className="rounded border border-hairline-strong p-2">
          <p className="text-sm text-status-warning">{plural(warnings.length, 'thing')} to look at</p>
          <ReportItems items={warnings} testId={`${testId}-warnings`} />
        </div>
      )}
      {notes.length > 0 && (
        <div className="rounded border border-hairline-strong p-2">
          <p className="text-sm text-fg-default">{plural(notes.length, 'note')}</p>
          <ReportItems items={notes} testId={`${testId}-notes`} />
        </div>
      )}
      <CopyReport text={reportText} testId={`${testId}-copy-report`} />
    </>
  );
}

/** One line per report item, its path first when it has one. */
export function ReportItems({
  items,
  testId,
}: {
  readonly items: readonly ImportReportLine[];
  readonly testId: string;
}) {
  return (
    <ul data-testid={testId} className="mt-1 flex max-h-40 flex-col gap-1 overflow-auto text-xs text-fg-subtle">
      {items.map((item, index) => {
        const { path, message } = typeof item === 'string' ? { path: '', message: item } : item;
        return (
          <li key={index}>
            {path !== '' && <span className="text-fg-default">{path}</span>}
            {path !== '' && ' — '}
            {message}
          </li>
        );
      })}
    </ul>
  );
}

/** Puts an import report on the clipboard, for a ticket or a migration checklist. */
export function CopyReport({ text, testId }: { readonly text: string; readonly testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex justify-start">
      <button
        type="button"
        data-testid={testId}
        className="text-xs text-accent underline"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy report'}
      </button>
    </div>
  );
}
