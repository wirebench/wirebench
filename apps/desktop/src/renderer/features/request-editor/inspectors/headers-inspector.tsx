import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useProblemsStore } from '../../../state/problems.js';
import { useProjectStore } from '../../../state/project.js';
import type { HeaderEntryWire } from '../../../../shared/wire-types.js';
import type { GridRowProps } from '../../../lib/grid-navigation.js';
import { useGridNavigation } from '../../../lib/grid-navigation.js';
import { InspectorIconButton } from './inspector-strip.js';

/**
 * Headers Wirebench computes for every send (`send.ts`'s SOAP content type and SOAPAction, plus
 * what undici adds on the wire). Naming one here replaces the computed value rather than
 * appending a second copy, which is worth saying out loud next to the field.
 */
const COMPUTED_HEADERS = new Set([
  'content-type',
  'soapaction',
  'user-agent',
  'accept-encoding',
  'content-length',
  'host',
]);

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-xs text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

export interface HeadersInspectorProps {
  readonly requestId: string;
}

interface RowProps {
  readonly index: number;
  /** Roving-tabindex props from {@link useGridNavigation}; spread onto the `<tr>`. */
  readonly rowProps: GridRowProps;
  readonly header: HeaderEntryWire;
  readonly first: boolean;
  readonly last: boolean;
  readonly problems: readonly string[];
  readonly onCommit: (header: HeaderEntryWire) => void;
  readonly onRemove: () => void;
  readonly onMove: (delta: -1 | 1) => void;
}

/**
 * One header row. Edits stay local until Enter or blur — a keystroke is never a project
 * mutation — and Escape puts the field back to what the model holds.
 */
function HeaderRow({ index, rowProps, header, first, last, problems, onCommit, onRemove, onMove }: RowProps) {
  const [name, setName] = useState(header.name);
  const [value, setValue] = useState(header.value);
  useEffect(() => {
    setName(header.name);
  }, [header.name]);
  useEffect(() => {
    setValue(header.value);
  }, [header.value]);

  const position = index + 1;
  const overrides = COMPUTED_HEADERS.has(header.name.trim().toLowerCase());

  /**
   * Commits the name field, applying the same trim + non-empty rule `add()` uses for a
   * new header: a blank (or whitespace-only) name is never a valid commit, so it reverts
   * to what the model already holds instead of writing an empty header name.
   */
  const commitName = (): void => {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setName(header.name);
      return;
    }
    onCommit({ name: trimmed, value });
  };

  return (
    <tr data-testid="header-row" aria-rowindex={position + 1} {...rowProps}>
      <td role="gridcell" className="py-0.5 pr-2 align-top">
        <input
          aria-label={`Name of header ${position}`}
          className={INPUT_CLASS}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onBlur={() => {
            commitName();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitName();
            if (event.key === 'Escape') setName(header.name);
          }}
        />
        {overrides && <p className="mt-0.5 text-xs text-fg-faint">overrides the default</p>}
      </td>
      <td role="gridcell" className="py-0.5 pr-2 align-top">
        <input
          aria-label={`Value of header ${position}`}
          className={INPUT_CLASS}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
          onBlur={() => {
            onCommit({ name, value });
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onCommit({ name, value });
            if (event.key === 'Escape') setValue(header.value);
          }}
        />
        {problems.map((problem) => (
          <p key={problem} role="status" className="mt-0.5 text-xs text-status-warning">
            {problem}
          </p>
        ))}
      </td>
      <td role="gridcell" className="w-24 py-0.5 align-top whitespace-nowrap">
        <InspectorIconButton
          label={`Move header ${position} (${header.name}) up`}
          disabled={first}
          onClick={() => {
            onMove(-1);
          }}
        >
          <ChevronUp size={13} aria-hidden="true" />
        </InspectorIconButton>
        <InspectorIconButton
          label={`Move header ${position} (${header.name}) down`}
          disabled={last}
          onClick={() => {
            onMove(1);
          }}
        >
          <ChevronDown size={13} aria-hidden="true" />
        </InspectorIconButton>
        <InspectorIconButton label={`Remove header ${position} (${header.name})`} onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </InspectorIconButton>
      </td>
    </tr>
  );
}

/** Matches the message `exchanges.ts` builds for an unresolved reference found inside a header. */
function problemsForHeader(messages: readonly string[], name: string): string[] {
  const needle = `in header "${name}"`;
  return messages.filter((message) => message.includes(needle));
}

/**
 * The request pane's Headers inspector: the ordered, duplicate-tolerating list of headers this
 * request adds to (or overrides on) every send. Values may carry `${...}` property expansions;
 * any that would not resolve are reported inline, from the same Problems entries the preflight
 * writes.
 */
export function HeadersInspector({ requestId }: HeadersInspectorProps) {
  const headers = useProjectStore((state) => state.requests[requestId]?.headers);
  const editRequest = useProjectStore((state) => state.editRequest);
  // Select the raw list and narrow it here: a selector that built a new array on every call
  // would give zustand a fresh snapshot each render and loop forever.
  const problemItems = useProblemsStore((state) => state.items);
  const expansionMessages = useMemo(
    () =>
      problemItems
        .filter((item) => item.source === 'expansion' && item.requestId === requestId)
        .map((item) => item.problem.message),
    [problemItems, requestId],
  );
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const { gridProps, rowProps } = useGridNavigation(headers?.length ?? 0);

  if (headers === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">This request no longer exists.</p>;
  }

  const commit = (next: readonly HeaderEntryWire[]): void => {
    editRequest(requestId, { headers: [...next] });
  };

  const replaceAt = (index: number, header: HeaderEntryWire): void => {
    const existing = headers[index];
    if (existing === undefined || (existing.name === header.name && existing.value === header.value)) {
      return;
    }
    commit(headers.map((entry, i) => (i === index ? header : entry)));
  };

  const move = (index: number, delta: -1 | 1): void => {
    const target = index + delta;
    if (target < 0 || target >= headers.length) return;
    const next = [...headers];
    const [moved] = next.splice(index, 1);
    if (moved !== undefined) next.splice(target, 0, moved);
    commit(next);
  };

  const add = (): void => {
    const name = newName.trim();
    if (name.length === 0) return;
    commit([...headers, { name, value: newValue }]);
    setNewName('');
    setNewValue('');
  };

  return (
    <div className="flex flex-col gap-2 p-2">
      {headers.length === 0 ? (
        <p className="text-sm text-fg-subtle">No custom headers. Anything added here is sent with every request.</p>
      ) : (
        <table
          role="grid"
          aria-label="Request headers"
          aria-rowcount={headers.length + 1}
          className="w-full table-fixed border-collapse text-sm"
          {...gridProps}
        >
          <thead>
            <tr aria-rowindex={1} className="text-left text-xs tracking-wider text-fg-subtle uppercase">
              <th role="columnheader" scope="col" className="pb-1 font-medium">
                Name
              </th>
              <th role="columnheader" scope="col" className="pb-1 font-medium">
                Value
              </th>
              <th role="columnheader" scope="col" className="w-24">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {headers.map((header, index) => (
              // Duplicate names are legal here, so the index IS the identity: two rows named
              // `Accept` are two different headers, not one row that moved.
              <HeaderRow
                key={index}
                index={index}
                rowProps={rowProps(index)}
                header={header}
                first={index === 0}
                last={index === headers.length - 1}
                problems={problemsForHeader(expansionMessages, header.name)}
                onCommit={(next) => {
                  replaceAt(index, next);
                }}
                onRemove={() => {
                  commit(headers.filter((_, i) => i !== index));
                }}
                onMove={(delta) => {
                  move(index, delta);
                }}
              />
            ))}
          </tbody>
        </table>
      )}

      <div className="flex items-center gap-2">
        <input
          aria-label="New header name"
          placeholder="name"
          className={INPUT_CLASS}
          value={newName}
          onChange={(event) => {
            setNewName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
        />
        <input
          aria-label="New header value"
          placeholder="value"
          className={INPUT_CLASS}
          value={newValue}
          onChange={(event) => {
            setNewValue(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') add();
          }}
        />
        <button
          type="button"
          onClick={add}
          className="h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-3 text-xs text-fg-default hover:bg-surface-hover"
        >
          Add header
        </button>
      </div>
    </div>
  );
}
