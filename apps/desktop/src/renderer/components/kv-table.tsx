/**
 * The ordered key/value grid the REST editor uses for path parameters, query parameters, headers
 * and form fields.
 *
 * It differs from the Environments variables table in the one way that matters: rows here are an
 * ordered *list* that may contain the same name twice (a query string legitimately can, and so can
 * a header), whereas a variables scope is a keyed map with an inheritance chain behind it. The two
 * therefore stay separate components rather than one bending to the other's data model; what they
 * share — the "a keystroke is not a mutation" rule, and the input's look — lives in
 * {@link useCommittedDraft} and {@link KV_INPUT_CLASS}, which the variables table imports from here.
 *
 * Interaction rules, once, for every column: typing edits a local draft; Enter or moving focus
 * away commits it; Escape puts the row back to what it was. There is always one empty row at the
 * bottom, and typing into it appends a row rather than needing an "Add" button.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { ClampedValueField } from './clamped-value-field.js';
import { IconButton } from './icon-button.js';
import { useGridNavigation } from '../lib/grid-navigation.js';
import type { KeyValueWire } from '../../shared/wire-types.js';

/**
 * A transparent border by default so a row reads as data rather than a form field; hover swaps the
 * border's colour without adding one, so nothing shifts a pixel.
 */
export const KV_INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 font-mono text-sm text-fg-default hover:border-hairline-strong focus:border-transparent focus:outline-none focus:ring-1 focus:ring-accent';

/**
 * The table's own cells: the input's look, as a one-line text area that grows to fit, so a long
 * value (a SOAPAction URI, a token) wraps inside its column instead of running under the next one.
 */
const KV_TEXTAREA_CLASS =
  'block field-sizing-content min-h-row w-full min-w-0 resize-none rounded-md border border-transparent bg-transparent px-2 py-[3px] font-mono text-sm leading-[18px] [overflow-wrap:anywhere] whitespace-pre-wrap text-fg-default hover:border-hairline-strong focus:border-transparent focus:outline-none focus:ring-1 focus:ring-accent';

/**
 * The checkbox, the `auto` tag and the delete button sit centred on a row's first line, so a value
 * that wraps onto a second line leaves them level with the name rather than floating mid-row; and
 * centred in their column, so every row's checkbox is in one line down the table.
 */
const FIRST_LINE = 'flex h-row items-center justify-center';

/** The narrowest a resized column may get, in pixels. */
const MIN_COLUMN_PX = 56;
/** The fixed columns: the On checkbox and the delete button. */
const ENABLED_PX = 44;
const ACTIONS_PX = 36;
/** How far one arrow-key press moves a column edge. */
const KEY_STEP_PX = 16;

/**
 * Column widths a table was resized to, as fractions of its text columns' share, keyed by the
 * table's testid prefix and columns. Session state: switching tabs and coming back keeps them.
 */
const resizedWidths = new Map<string, readonly number[]>();

/** Name a little narrower than value; description, when shown, as wide as name. */
function defaultWidths(textColumns: readonly KvColumn[]): readonly number[] {
  const weight = (column: KvColumn): number => (column === 'value' ? 4 : 3);
  const total = textColumns.reduce((sum, column) => sum + weight(column), 0);
  return textColumns.map((column) => weight(column) / total);
}

/**
 * A field whose edits are local until they are committed: Enter or blur saves, Escape reverts, and
 * a value that arrives from outside (a snapshot, an undo) replaces the draft.
 *
 * The returned handlers go straight onto an `<input>` or a `<textarea>`; `commit` is called only
 * when the value actually changed, so a focus pass over an untouched row writes nothing. In a text
 * area Enter still saves rather than starting a new line: a key or value is one line.
 */
export function useCommittedDraft(
  value: string,
  commit: (next: string) => void,
): {
  readonly value: string;
  readonly onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
} {
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const save = (next: string): void => {
    if (next !== value) {
      commit(next);
    }
  };

  return {
    value: draft,
    onChange: (event) => {
      setDraft(event.target.value);
    },
    onBlur: () => {
      save(draft);
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter') {
        if (event.currentTarget instanceof HTMLTextAreaElement) {
          event.preventDefault();
        }
        save(draft);
      }
      if (event.key === 'Escape') {
        setDraft(value);
        // Escape in a table cell means "undo this edit", not "close the dialog behind it".
        event.stopPropagation();
      }
    },
  };
}

/** Which columns a table shows. `name` and `value` are always there; the other two are opt-in. */
export type KvColumn = 'enabled' | 'name' | 'value' | 'description';

export interface KvTableProps {
  /** Accessible name of the grid — e.g. `Query parameters`. */
  readonly label: string;
  readonly rows: readonly KeyValueWire[];
  /** Called with the whole next list: rows are ordered, so a caller replaces rather than merges. */
  readonly onChange: (rows: readonly KeyValueWire[]) => void;
  /** Columns to render, in this order. Defaults to enabled + name + value. */
  readonly columns?: readonly KvColumn[];
  /**
   * Whether two rows may carry the same name. A query string and a header list may (and the URL
   * round trip depends on it); a form's fields, by convention here, may not.
   */
  readonly allowDuplicates?: boolean;
  /** Prefix for every testid in the table, so two tables on one tab stay addressable. */
  readonly testidPrefix: string;
  /**
   * Rows the request computes for itself — a content type from the body, a cookie header. Shown
   * greyed under the editable ones, and never written back.
   */
  readonly computed?: readonly KeyValueWire[];
  /** Rows whose name may not be edited: a path parameter's name comes from the URL. */
  readonly lockNames?: boolean;
  readonly emptyMessage?: string;
  /** Placeholders for the add row, when "name"/"value" is not what this table holds. */
  readonly placeholders?: { readonly name?: string; readonly value?: string };
}

const DEFAULT_COLUMNS: readonly KvColumn[] = ['enabled', 'name', 'value'];

/** The header label for each column. */
const HEADING: Readonly<Record<KvColumn, string>> = {
  enabled: 'On',
  name: 'Name',
  value: 'Value',
  description: 'Description',
};

/**
 * The editable key/value grid. It owns no data: every edit hands the caller the complete next list,
 * which is what the REST request patch carries (tables are replaced wholesale, never merged).
 */
export function KvTable({
  label,
  rows,
  onChange,
  columns = DEFAULT_COLUMNS,
  allowDuplicates = true,
  testidPrefix,
  computed = [],
  lockNames = false,
  emptyMessage,
  placeholders,
}: KvTableProps) {
  const [error, setError] = useState<string | undefined>(undefined);
  const tableRef = useRef<HTMLTableElement>(null);
  // The row and column a keystroke in the add row just created, waiting for the caller to render it.
  const pendingFocus = useRef<{ readonly index: number; readonly column: KvColumn } | undefined>(undefined);
  const frameRef = useRef<HTMLDivElement>(null);
  const textColumns = columns.filter((column) => column !== 'enabled');
  const widthsKey = `${testidPrefix}:${textColumns.join(',')}`;
  const [widths, setWidths] = useState<readonly number[]>(
    () => resizedWidths.get(widthsKey) ?? defaultWidths(textColumns),
  );
  // The pixels the text columns share, measured, so a fraction becomes a width that adds up to
  // the table's. Unmeasured (no layout, as under jsdom) the columns fall back to percentages.
  const [shared, setShared] = useState<number | undefined>(undefined);
  const fixedPx = (columns.includes('enabled') ? ENABLED_PX : 0) + ACTIONS_PX;
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const measure = (): void => {
      const width = frame.clientWidth - fixedPx;
      setShared(width > 0 ? width : undefined);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => {
      observer.disconnect();
    };
  }, [fixedPx]);

  /** Moves the edge between text columns `index` and `index + 1` by `deltaPx`. */
  const resize = (index: number, deltaPx: number): void => {
    setWidths((previous) => {
      const total = shared ?? 600;
      const left = (previous[index] ?? 0) * total;
      const right = (previous[index + 1] ?? 0) * total;
      const min = Math.min(MIN_COLUMN_PX, (left + right) / 2);
      const nextLeft = Math.min(Math.max(left + deltaPx, min), left + right - min);
      const next = previous.map((width, at) =>
        at === index ? nextLeft / total : at === index + 1 ? (left + right - nextLeft) / total : width,
      );
      resizedWidths.set(widthsKey, next);
      return next;
    });
  };
  const resetWidths = (): void => {
    resizedWidths.delete(widthsKey);
    setWidths(defaultWidths(textColumns));
  };
  // One row per editable row, plus the computed rows and the always-present add row.
  const { gridProps, rowProps } = useGridNavigation(rows.length + computed.length + 1);

  const patch = (index: number, changes: Partial<KeyValueWire>): void => {
    const next = rows.map((row, at) => (at === index ? { ...row, ...changes } : row));
    if (changes.name !== undefined && !allowDuplicates && duplicated(next, index)) {
      setError(`There is already a row named "${changes.name}".`);
      return;
    }
    setError(undefined);
    onChange(next);
  };

  const remove = (index: number): void => {
    setError(undefined);
    onChange(rows.filter((_, at) => at !== index));
  };

  /** Appends a row the moment something is typed into the add row. */
  const append = (changes: Partial<KeyValueWire>): void => {
    const row: KeyValueWire = { name: '', value: '', enabled: true, ...changes };
    if (row.name !== '' && !allowDuplicates && rows.some((existing) => existing.name === row.name)) {
      setError(`There is already a row named "${row.name}".`);
      return;
    }
    setError(undefined);
    pendingFocus.current = { index: rows.length, column: column(changes) };
    onChange([...rows, row]);
  };

  // Typing goes on in the row the first keystroke created: without moving focus there, the caret
  // stays in the (again empty) add row and every further character would append a row of its own.
  // The caller may render the new row a moment later (an IPC round trip), so this waits for it.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (pending === undefined || rows.length <= pending.index) {
      return;
    }
    pendingFocus.current = undefined;
    const input = tableRef.current?.querySelectorAll<HTMLInputElement>(
      `[data-testid="${testidPrefix}-${pending.column}"]`,
    )[pending.index];
    if (input !== undefined) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }, [rows.length, testidPrefix]);

  const testid = (part: string): string => `${testidPrefix}-${part}`;

  return (
    <div className="flex flex-col gap-2">
      <div ref={frameRef} className="overflow-hidden rounded-md border border-hairline">
        <table
          ref={tableRef}
          role="grid"
          aria-label={label}
          data-testid={testid('table')}
          className="w-full table-fixed border-collapse text-sm"
        >
          <colgroup>
            {columns.map((column) => {
              if (column === 'enabled') {
                return <col key={column} style={{ width: ENABLED_PX }} />;
              }
              const fraction = widths[textColumns.indexOf(column)] ?? 0;
              return (
                <col
                  key={column}
                  style={{ width: shared === undefined ? `${String(fraction * 100)}%` : fraction * shared }}
                />
              );
            })}
            <col style={{ width: ACTIONS_PX }} />
          </colgroup>
          <thead>
            <tr className="border-b border-hairline text-left text-xs tracking-wider text-fg-subtle uppercase">
              {columns.map((column) => (
                <th
                  key={column}
                  className={`relative px-2 py-1.5 font-medium ${column === 'enabled' ? 'text-center' : divider(columns, column)}`}
                  {...(column === 'enabled' ? { title: 'Enabled' } : {})}
                >
                  {HEADING[column]}
                  {column !== 'enabled' && textColumns.indexOf(column) < textColumns.length - 1 && (
                    <ColumnResizer
                      label={`Resize ${HEADING[column]} column`}
                      share={share(widths, textColumns.indexOf(column))}
                      testid={testid(`resize-${column}`)}
                      onResize={(deltaPx) => {
                        resize(textColumns.indexOf(column), deltaPx);
                      }}
                      onReset={resetWidths}
                    />
                  )}
                </th>
              ))}
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody {...gridProps}>
            {rows.length === 0 && computed.length === 0 && emptyMessage !== undefined && (
              <tr className="border-b border-hairline">
                <td colSpan={columns.length + 1} className="px-2 py-2 text-sm text-fg-subtle">
                  {emptyMessage}
                </td>
              </tr>
            )}
            {computed.map((row, index) => (
              <tr
                key={`computed-${String(index)}`}
                role="row"
                data-testid={testid('computed-row')}
                className="border-b border-hairline text-fg-subtle"
                {...rowProps(index)}
              >
                {columns.map((column) =>
                  column === 'enabled' ? (
                    <td key={column} className="px-2 py-1 align-top">
                      <span className={FIRST_LINE}>
                        <input type="checkbox" aria-label={`${row.name} is computed`} checked disabled />
                      </span>
                    </td>
                  ) : (
                    // The text sits where an editable cell's text does (field padding plus its 1px
                    // border), and wraps like it.
                    <td key={column} className={`px-2 py-1 align-top font-mono text-sm ${divider(columns, column)}`}>
                      <span className="block px-[9px] py-[4px] leading-[18px] [overflow-wrap:anywhere] whitespace-pre-wrap">
                        {column === 'name' ? row.name : column === 'value' ? row.value : (row.description ?? '')}
                      </span>
                    </td>
                  ),
                )}
                <td className="px-2 py-1 align-top text-xs" title="Computed for this request">
                  <span className={FIRST_LINE}>auto</span>
                </td>
              </tr>
            ))}
            {rows.map((row, index) => (
              <KvRow
                // Rows are ordered and may repeat a name, so the index is the only stable key.
                key={index}
                row={row}
                columns={columns}
                testid={testid}
                rowProps={rowProps(computed.length + index)}
                lockName={lockNames}
                onPatch={(changes) => {
                  patch(index, changes);
                }}
                onRemove={() => {
                  remove(index);
                }}
              />
            ))}
            <tr
              role="row"
              data-testid={testid('add-row')}
              className="hover:bg-surface-hover"
              {...rowProps(computed.length + rows.length)}
            >
              {columns.map((column) => (
                <td key={column} className={`px-2 py-1 align-top ${divider(columns, column)}`}>
                  {column === 'enabled' ? (
                    // Nothing to toggle yet: the row does not exist until something is typed.
                    <span className={FIRST_LINE}>
                      <input type="checkbox" aria-label="New row enabled" checked disabled />
                    </span>
                  ) : (
                    <input
                      aria-label={`New ${HEADING[column].toLowerCase()}`}
                      data-testid={testid(`new-${column}`)}
                      placeholder={
                        column === 'name'
                          ? (placeholders?.name ?? 'name')
                          : column === 'value'
                            ? (placeholders?.value ?? 'value')
                            : 'description'
                      }
                      className={KV_INPUT_CLASS}
                      value=""
                      readOnly={column === 'name' && lockNames}
                      onChange={(event) => {
                        // One keystroke creates the row and the caller re-renders with it, so the
                        // add row is empty again and focus follows the new row's own input.
                        append({ [column]: event.target.value });
                      }}
                    />
                  )}
                </td>
              ))}
              <td className="px-2 py-1" />
            </tr>
          </tbody>
        </table>
      </div>
      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The rule between two text columns, the same border on the heading and down every row so the two
 * line up to the pixel: on the left edge of each text column but the first. The On and delete
 * columns get none. The header's resize handle sits over this rule and only lights up on hover.
 */
function divider(columns: readonly KvColumn[], column: KvColumn): string {
  const text: readonly KvColumn[] = columns.filter((candidate) => candidate !== 'enabled');
  return text.indexOf(column) > 0 ? 'border-l border-hairline' : '';
}

/** The column an add-row keystroke typed into. */
function column(changes: Partial<KeyValueWire>): KvColumn {
  return changes.name !== undefined ? 'name' : changes.value !== undefined ? 'value' : 'description';
}

/** Whether `rows[index]`'s name is also carried by another row. */
function duplicated(rows: readonly KeyValueWire[], index: number): boolean {
  const name = rows[index]?.name;
  return name !== undefined && name !== '' && rows.some((row, at) => at !== index && row.name === name);
}

interface KvRowProps {
  readonly row: KeyValueWire;
  readonly columns: readonly KvColumn[];
  readonly testid: (part: string) => string;
  readonly rowProps: ReturnType<ReturnType<typeof useGridNavigation>['rowProps']>;
  readonly lockName: boolean;
  readonly onPatch: (changes: Partial<KeyValueWire>) => void;
  readonly onRemove: () => void;
}

/** One editable row. */
function KvRow({ row, columns, testid, rowProps, lockName, onPatch, onRemove }: KvRowProps) {
  const name = useCommittedDraft(row.name, (next) => {
    onPatch({ name: next });
  });
  const value = useCommittedDraft(row.value, (next) => {
    onPatch({ value: next });
  });
  const description = useCommittedDraft(row.description ?? '', (next) => {
    onPatch({ description: next });
  });
  const fields = { name, value, description } as const;

  return (
    <tr
      role="row"
      data-testid={testid('row')}
      className={`border-b border-hairline hover:bg-surface-hover ${row.enabled ? '' : 'opacity-50'}`}
      {...rowProps}
    >
      {columns.map((column) =>
        column === 'enabled' ? (
          <td key={column} className="px-2 py-1 align-top">
            <span className={FIRST_LINE}>
              <input
                type="checkbox"
                aria-label={`Enable ${row.name}`}
                data-testid={testid('enabled')}
                checked={row.enabled}
                onChange={(event) => {
                  onPatch({ enabled: event.target.checked });
                }}
              />
            </span>
          </td>
        ) : (
          <td key={column} className={`px-2 py-1 align-top ${divider(columns, column)}`}>
            {column === 'value' ? (
              // A long value (a token, a cookie) folds to two lines and opens in full on focus.
              <ClampedValueField
                aria-label={`${HEADING[column]} of ${row.name}`}
                data-testid={testid(column)}
                className={KV_TEXTAREA_CLASS}
                {...fields[column]}
              />
            ) : (
              <textarea
                rows={1}
                aria-label={`${HEADING[column]} of ${row.name}`}
                data-testid={testid(column)}
                className={KV_TEXTAREA_CLASS}
                readOnly={column === 'name' && lockName}
                {...fields[column]}
              />
            )}
          </td>
        ),
      )}
      <td className="px-2 py-1 align-top">
        <span className={FIRST_LINE}>
          <IconButton label={`Remove ${row.name}`} data-testid={testid('delete')} onClick={onRemove}>
            <Trash2 size={13} aria-hidden="true" />
          </IconButton>
        </span>
      </td>
    </tr>
  );
}

/** How much of the two columns either side of edge `index` the left one takes, as a whole percent. */
function share(widths: readonly number[], index: number): number {
  const left = widths[index] ?? 0;
  const right = widths[index + 1] ?? 0;
  return left + right > 0 ? Math.round((left / (left + right)) * 100) : 50;
}

interface ColumnResizerProps {
  readonly label: string;
  /** The edge's position for assistive technology: the left column's share of the pair, 0–100. */
  readonly share: number;
  readonly testid: string;
  readonly onResize: (deltaPx: number) => void;
  readonly onReset: () => void;
}

/**
 * The drag handle on a column's right edge. Dragging moves the edge it sits on, taking the width
 * from (or giving it to) the column on its right; the arrow keys do the same a step at a time, and
 * a double click puts every column back. The pointer is captured, so a drag that leaves the
 * handle keeps resizing until it is released.
 */
function ColumnResizer({ label, share, testid, onResize, onReset }: ColumnResizerProps) {
  const lastX = useRef<number | undefined>(undefined);
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      // A focusable separator is a widget: it must say where it is (WAI-ARIA `separator`).
      aria-valuenow={share}
      aria-valuemin={0}
      aria-valuemax={100}
      data-testid={testid}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      className="absolute top-0 -right-1 z-10 h-full w-2 cursor-col-resize touch-none after:absolute after:top-1/4 after:left-1/2 after:h-1/2 after:w-px after:bg-transparent hover:after:bg-accent focus-visible:outline-none focus-visible:after:bg-accent"
      onPointerDown={(event) => {
        event.preventDefault();
        lastX.current = event.clientX;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (lastX.current === undefined) {
          return;
        }
        onResize(event.clientX - lastX.current);
        lastX.current = event.clientX;
      }}
      onPointerUp={(event) => {
        lastX.current = undefined;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        lastX.current = undefined;
      }}
      onDoubleClick={onReset}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          onResize(event.key === 'ArrowLeft' ? -KEY_STEP_PX : KEY_STEP_PX);
        }
      }}
    />
  );
}
