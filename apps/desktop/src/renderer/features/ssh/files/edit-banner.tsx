import { useShallow } from 'zustand/react/shallow';
import { Check, FilePen } from 'lucide-react';
import { editsOf, useEditsStore } from './edits-store.js';
import type { EditRow } from './edits-store.js';

const LINK = 'rounded px-1.5 text-xs text-fg-default hover:bg-surface-hover';

const STATE_LABEL: Record<Exclude<EditRow['state'], 'remote-changed' | 'failed'>, string> = {
  watching: 'Waiting for a save',
  uploading: 'Uploading…',
  uploaded: 'Uploaded',
  kept: 'Kept the host’s version; not watching',
};

function Row({ row }: { readonly row: EditRow }) {
  const { reply, stop } = useEditsStore.getState();
  return (
    <li data-testid="files-edit" data-state={row.state} className="flex items-center gap-2 px-3 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate text-fg-default">{row.name}</span>
      {row.state === 'remote-changed' ? (
        <>
          <span className="text-status-warning">Changed on the host since it was opened</span>
          <button
            type="button"
            className={LINK}
            onClick={() => {
              reply(row.editId, 'overwrite');
            }}
          >
            Overwrite
          </button>
          <button
            type="button"
            className={LINK}
            onClick={() => {
              reply(row.editId, 'keep-remote');
            }}
          >
            Keep remote
          </button>
        </>
      ) : row.state === 'failed' ? (
        <span className="max-w-64 truncate text-status-danger" title={row.error}>
          {row.error ?? 'The upload failed'}
        </span>
      ) : (
        <span className="flex items-center gap-1 text-fg-muted">
          {row.state === 'uploaded' && <Check size={12} aria-hidden="true" className="text-status-success" />}
          {STATE_LABEL[row.state]}
        </span>
      )}
      <button
        type="button"
        className={LINK}
        onClick={() => {
          stop(row.editId);
        }}
      >
        Stop editing
      </button>
    </li>
  );
}

/**
 * Over a Files tab's panes while it has files open in the system editor: how many, that each save is
 * uploaded, and per file its last upload state, the "changed on the host" question inline, and Stop editing.
 */
export function EditBanner({ tabId }: { readonly tabId: string }) {
  const rows = useEditsStore(useShallow((s) => editsOf(s, tabId)));
  if (rows.length === 0) return null;
  const count = rows.length === 1 ? '1 file' : `${String(rows.length)} files`;
  return (
    <section
      aria-label="Files open in an editor"
      data-testid="files-edit-banner"
      className="border-b border-hairline bg-surface-raised"
    >
      <p className="flex items-center gap-1.5 px-3 pt-1 text-xs text-fg-subtle">
        <FilePen size={12} aria-hidden="true" />
        {count} open in an editor · uploads on save
      </p>
      <ul>
        {rows.map((row) => (
          <Row key={row.editId} row={row} />
        ))}
      </ul>
    </section>
  );
}
