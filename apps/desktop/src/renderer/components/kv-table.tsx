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
import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
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
 * A field whose edits are local until they are committed: Enter or blur saves, Escape reverts, and
 * a value that arrives from outside (a snapshot, an undo) replaces the draft.
 *
 * The returned handlers go straight onto an `<input>`; `commit` is called only when the value
 * actually changed, so a focus pass over an untouched row writes nothing.
 */
export function useCommittedDraft(
  value: string,
  commit: (next: string) => void,
): {
  readonly value: string;
  readonly onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  readonly onBlur: () => void;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
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
    onChange([...rows, row]);
  };

  const testid = (part: string): string => `${testidPrefix}-${part}`;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border border-hairline">
        <table
          role="grid"
          aria-label={label}
          data-testid={testid('table')}
          className="w-full table-fixed border-collapse text-sm"
        >
          <colgroup>
            {columns.map((column) => (
              <col key={column} className={column === 'enabled' ? 'w-11' : column === 'name' ? 'w-[26%]' : undefined} />
            ))}
            <col className="w-9" />
          </colgroup>
          <thead>
            <tr className="border-b border-hairline text-left text-xs tracking-wider text-fg-subtle uppercase">
              {columns.map((column) => (
                <th
                  key={column}
                  className="px-2 py-1.5 font-medium"
                  {...(column === 'enabled' ? { title: 'Enabled' } : {})}
                >
                  {HEADING[column]}
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
            {rows.map((row, index) => (
              <KvRow
                // Rows are ordered and may repeat a name, so the index is the only stable key.
                key={index}
                row={row}
                columns={columns}
                testid={testid}
                rowProps={rowProps(index)}
                lockName={lockNames}
                onPatch={(changes) => {
                  patch(index, changes);
                }}
                onRemove={() => {
                  remove(index);
                }}
              />
            ))}
            {computed.map((row, index) => (
              <tr
                key={`computed-${String(index)}`}
                role="row"
                data-testid={testid('computed-row')}
                className="border-b border-hairline text-fg-subtle"
                {...rowProps(rows.length + index)}
              >
                {columns.map((column) => (
                  <td key={column} className="px-2 py-1 font-mono text-sm">
                    {column === 'enabled' ? (
                      <input type="checkbox" aria-label={`${row.name} is computed`} checked disabled />
                    ) : column === 'name' ? (
                      row.name
                    ) : column === 'value' ? (
                      row.value
                    ) : (
                      (row.description ?? '')
                    )}
                  </td>
                ))}
                <td className="px-2 py-1 text-right text-xs" title="Computed for this request">
                  auto
                </td>
              </tr>
            ))}
            <tr
              role="row"
              data-testid={testid('add-row')}
              className="hover:bg-surface-hover"
              {...rowProps(rows.length + computed.length)}
            >
              {columns.map((column) => (
                <td key={column} className="px-2 py-1">
                  {column === 'enabled' ? (
                    // Nothing to toggle yet: the row does not exist until something is typed.
                    <input type="checkbox" aria-label="New row enabled" checked disabled />
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
                        append({ [column]: event.target.value } as Partial<KeyValueWire>);
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
          <td key={column} className="px-2 py-1 text-center">
            <input
              type="checkbox"
              aria-label={`Enable ${row.name}`}
              data-testid={testid('enabled')}
              checked={row.enabled}
              onChange={(event) => {
                onPatch({ enabled: event.target.checked });
              }}
            />
          </td>
        ) : (
          <td key={column} className="px-2 py-1">
            <input
              aria-label={`${HEADING[column]} of ${row.name}`}
              data-testid={testid(column)}
              className={KV_INPUT_CLASS}
              readOnly={column === 'name' && lockName}
              {...fields[column]}
            />
          </td>
        ),
      )}
      <td className="px-2 py-1 text-center">
        <IconButton label={`Remove ${row.name}`} data-testid={testid('delete')} onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </IconButton>
      </td>
    </tr>
  );
}
