import { AlertTriangle, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  AttachmentPatchWire,
  AttachmentTypeWire,
  AttachmentWire,
  MimePartWire,
} from '../../../../shared/wire-types.js';
import { formatBytes } from '../../../lib/format-size.js';
import { useGridNavigation } from '../../../lib/grid-navigation.js';
import { InspectorIconButton } from './inspector-strip.js';

/** Media types offered as a datalist on the Content type cell; the field stays free text. */
const COMMON_CONTENT_TYPES = [
  'application/octet-stream',
  'application/pdf',
  'application/xml',
  'application/zip',
  'application/json',
  'image/png',
  'image/jpeg',
  'image/gif',
  'text/plain',
  'text/xml',
];

/** Every value the model's `type` may take, in the order the picker lists them. */
const ATTACHMENT_TYPES: readonly AttachmentTypeWire[] = ['XOP', 'MIME', 'SWAREF', 'CONTENT', 'UNKNOWN'];

/** Shown next to a `path`-source attachment main has refused to read this session. */
export const OUTSIDE_PROJECT_TITLE = 'Outside the project — remove and add it again';

const CELL_INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-1.5 font-mono text-xs text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

const SELECT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-1 text-xs text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

/**
 * A cell whose edits stay local until Enter or blur — a keystroke is never a project mutation.
 *
 * `onEnd` fires on every way out of edit mode (Enter, Escape, blur), whether or not the draft
 * changed, so a caller using it to clear "currently renaming" state can never get stuck there —
 * `onCommit` alone would skip it for a no-op edit or an Escape.
 */
function EditableCell({
  label,
  value,
  list,
  onCommit,
  onEnd,
}: {
  readonly label: string;
  readonly value: string;
  readonly list?: string;
  readonly onCommit: (next: string) => void;
  readonly onEnd?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const commit = (): void => {
    if (draft !== value) onCommit(draft);
    onEnd?.();
  };

  return (
    <input
      aria-label={label}
      className={CELL_INPUT_CLASS}
      value={draft}
      {...(list !== undefined ? { list } : {})}
      onChange={(event) => {
        setDraft(event.target.value);
      }}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') commit();
        if (event.key === 'Escape') {
          setDraft(value);
          onEnd?.();
        }
        // Otherwise Delete-in-a-field would detach the row the caret sits in.
        event.stopPropagation();
      }}
    />
  );
}

export interface AttachmentsTableProps {
  readonly attachments: readonly AttachmentWire[];
  /** The WSDL parts this operation's input declares; empty when it is a plain `soap:body`. */
  readonly mimeParts: readonly MimePartWire[];
  readonly selectedId: string | undefined;
  readonly outsideProjectIds: ReadonlySet<string>;
  readonly onSelect: (attachmentId: string) => void;
  readonly onPatch: (attachmentId: string, patch: AttachmentPatchWire) => void;
  readonly onOpen: (attachmentId: string) => void;
  readonly onRemoveSelected: () => void;
}

/**
 * The attachment grid: one row per attachment, with the editable cells the attachments tab
 * offers. Selection lives with the caller (it is also what the `request.removeAttachment`
 * command acts on); the arrow keys move it and Delete detaches the selected row.
 */
export function AttachmentsTable({
  attachments,
  mimeParts,
  selectedId,
  outsideProjectIds,
  onSelect,
  onPatch,
  onOpen,
  onRemoveSelected,
}: AttachmentsTableProps) {
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const listId = 'attachment-content-types';

  // The shared APG grid model owns Up/Down/Home/End and the single roving tab stop; selection
  // follows focus, because this grid's selection *is* what the Delete/F2 commands act on.
  const { rowProps, gridProps, setActiveRow } = useGridNavigation(attachments.length, {
    onActiveRowChange: (index) => {
      const target = attachments[index];
      if (target !== undefined) onSelect(target.id);
    },
  });

  return (
    <>
      <datalist id={listId}>
        {COMMON_CONTENT_TYPES.map((type) => (
          <option key={type} value={type} />
        ))}
      </datalist>
      <table
        role="grid"
        data-testid="attachments-table"
        aria-label="Request attachments"
        aria-rowcount={attachments.length}
        // Before any row has taken focus the grid itself is the tab stop; once it has, the
        // roving `tabindex` on the rows is the single stop and this one is skipped.
        tabIndex={attachments.length === 0 ? 0 : -1}
        className="w-full border-collapse text-sm"
        onKeyDown={(event) => {
          if (event.key === 'Delete' || event.key === 'Backspace') {
            // Only from the grid or a row: a Part/Type `<select>` doesn't stop propagation, so
            // without this a Delete meant for that control's own value would bubble up and
            // detach the row it lives in.
            const target = event.target as HTMLElement;
            if (target !== event.currentTarget && target.getAttribute('data-grid-row') === null) return;
            if (selectedId !== undefined && renamingId === undefined) {
              event.preventDefault();
              onRemoveSelected();
            }
          } else if (event.key === 'F2' && selectedId !== undefined) {
            event.preventDefault();
            setRenamingId(selectedId);
          }
          gridProps.onKeyDown(event);
        }}
      >
        <thead>
          <tr role="row" className="text-left text-xs tracking-wider text-fg-subtle uppercase">
            <th role="columnheader" className="pb-1 font-medium">
              Name
            </th>
            <th role="columnheader" className="pb-1 font-medium">
              Content type
            </th>
            <th role="columnheader" className="pb-1 font-medium">
              Size
            </th>
            <th role="columnheader" className="pb-1 font-medium">
              Part
            </th>
            <th role="columnheader" className="pb-1 font-medium">
              Type
            </th>
            <th role="columnheader" className="pb-1 font-medium">
              Content ID
            </th>
            <th role="columnheader" className="pb-1 font-medium">
              Cached
            </th>
            <th role="columnheader" className="w-8">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {attachments.map((attachment, index) => {
            const selected = attachment.id === selectedId;
            const outside = outsideProjectIds.has(attachment.id);
            return (
              <tr
                key={attachment.id}
                data-testid="attachment-row"
                role="row"
                aria-rowindex={index + 1}
                aria-selected={selected}
                className={selected ? 'bg-accent-muted' : undefined}
                onClick={() => {
                  onSelect(attachment.id);
                  // Keep the tab stop where the pointer just put the selection.
                  setActiveRow(index);
                }}
                {...rowProps(index)}
              >
                <td role="gridcell" className="py-0.5 pr-2 align-middle">
                  <div className="flex items-center gap-1">
                    {outside && (
                      <span title={OUTSIDE_PROJECT_TITLE} className="shrink-0 text-status-warning">
                        <AlertTriangle size={13} aria-label={OUTSIDE_PROJECT_TITLE} />
                      </span>
                    )}
                    {renamingId === attachment.id ? (
                      <EditableCell
                        label={`Name of ${attachment.name}`}
                        value={attachment.name}
                        onCommit={(name) => {
                          if (name.trim().length > 0) onPatch(attachment.id, { name: name.trim() });
                        }}
                        onEnd={() => {
                          setRenamingId(undefined);
                        }}
                      />
                    ) : (
                      // Double-click opens the file (F2 renames): the row already carries an
                      // explicit Open button, and this is the gesture people try first.
                      <span
                        className="min-w-0 flex-1 cursor-default truncate font-mono text-xs text-fg-default"
                        onDoubleClick={() => {
                          onOpen(attachment.id);
                        }}
                      >
                        {attachment.name}
                      </span>
                    )}
                  </div>
                </td>
                <td role="gridcell" className="py-0.5 pr-2 align-middle">
                  <EditableCell
                    label={`Content type of ${attachment.name}`}
                    value={attachment.contentType}
                    list={listId}
                    onCommit={(contentType) => {
                      onPatch(attachment.id, { contentType });
                    }}
                  />
                </td>
                <td
                  role="gridcell"
                  className="py-0.5 pr-2 align-middle text-xs whitespace-nowrap text-fg-muted"
                  title={`${String(attachment.size)} bytes`}
                >
                  {formatBytes(attachment.size)}
                </td>
                <td role="gridcell" className="py-0.5 pr-2 align-middle">
                  {mimeParts.length === 0 ? (
                    <span className="text-xs text-fg-faint">—</span>
                  ) : (
                    <select
                      aria-label={`Part of ${attachment.name}`}
                      className={SELECT_CLASS}
                      value={attachment.part ?? ''}
                      onChange={(event) => {
                        const part = event.target.value;
                        // Naming a part is also what says how it travels, so the type stops
                        // being UNKNOWN at the same moment (see task 33a's note).
                        onPatch(attachment.id, part === '' ? { part: null } : { part, type: 'MIME' });
                      }}
                    >
                      <option value="">—</option>
                      {mimeParts.map((part) => (
                        <option key={part.part} value={part.part}>
                          {part.part}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
                <td role="gridcell" className="py-0.5 pr-2 align-middle">
                  <select
                    aria-label={`Type of ${attachment.name}`}
                    className={SELECT_CLASS}
                    value={attachment.type}
                    onChange={(event) => {
                      onPatch(attachment.id, { type: event.target.value as AttachmentTypeWire });
                    }}
                  >
                    {ATTACHMENT_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </td>
                <td role="gridcell" className="py-0.5 pr-2 align-middle">
                  <EditableCell
                    label={`Content ID of ${attachment.name}`}
                    value={attachment.contentId}
                    onCommit={(contentId) => {
                      onPatch(attachment.id, { contentId });
                    }}
                  />
                </td>
                <td role="gridcell" className="py-0.5 pr-2 align-middle text-xs text-fg-muted">
                  {attachment.cached ? '✓' : '–'}
                </td>
                <td role="gridcell" className="py-0.5 align-middle">
                  <InspectorIconButton
                    label="Open attachment"
                    onClick={() => {
                      onOpen(attachment.id);
                    }}
                  >
                    <ExternalLink size={13} aria-hidden="true" />
                  </InspectorIconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
