/**
 * The HTTP Log's filter bar: a search field (URL, headers, bodies, name; regex and match-case toggles), chip groups for method, status class and protocol
 * (multi-select; none selected means all), the "n of m" count, and Reset — which clears the filter
 * and is distinct from Clear, which empties the log. State lives in the exchanges store.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../components/button.js';
import type { StatusClass } from '../../state/exchanges.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { methodsIn } from './log-filter.js';
import { compileMatcher } from './log-search.js';

const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx', 'failed'];
const PROTOCOLS = [
  { id: 'soap', label: 'SOAP' },
  { id: 'rest', label: 'REST' },
  { id: 'grpc', label: 'gRPC' },
  { id: 'websocket', label: 'WS' },
] as const;
/** Long enough to coalesce a burst of keystrokes, short enough to feel live. */
const DEBOUNCE_MS = 100;

/** `values` with `value` added if absent or removed if present. */
function toggled<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

function Chip({
  label,
  pressed,
  onToggle,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`rounded-full border px-2 py-0.5 font-mono text-xs transition-colors ${
        pressed
          ? 'border-accent bg-surface-selected text-fg-default'
          : 'border-hairline text-fg-muted hover:bg-surface-hover hover:text-fg-default'
      }`}
    >
      {label}
    </button>
  );
}

/** A small on/off button inside the search field (`.*`, `Aa`). */
function SearchToggle({
  label,
  glyph,
  pressed,
  onToggle,
}: {
  readonly label: string;
  readonly glyph: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onToggle}
      className={`rounded px-1 font-mono text-xs leading-4 ${
        pressed ? 'bg-surface-selected text-fg-default' : 'text-fg-faint hover:bg-surface-hover hover:text-fg-default'
      }`}
    >
      {glyph}
    </button>
  );
}

function ChipGroup({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex shrink-0 items-center gap-1">
      {children}
    </div>
  );
}

export interface LogFilterBarProps {
  /** Rows the filter lets through. */
  readonly shown: number;
  /** Rows in the log. */
  readonly total: number;
  /** Log-wide actions shown at the end of the toolbar (the secrets toggle, Clear). */
  readonly actions?: ReactNode;
}

export function LogFilterBar({ shown, total, actions }: LogFilterBarProps) {
  const filter = useExchangesStore((state) => state.filter);
  const setFilter = useExchangesStore((state) => state.setFilter);
  const resetFilter = useExchangesStore((state) => state.resetFilter);
  const log = useExchangesStore((state) => state.log);
  const methods = useMemo(() => methodsIn(log), [log]);

  // The field is local so typing is instant; the store follows after a short quiet period, and a
  // store change from elsewhere (Reset) pulls the field back into line.
  const [text, setText] = useState(filter.text);
  useEffect(() => {
    setText(filter.text);
  }, [filter.text]);
  useEffect(() => {
    if (text === filter.text) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setFilter({ text });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [text, filter.text, setFilter]);
  // Checked against the field, not the debounced store text, so the outline follows each keystroke.
  const invalid = useMemo(
    () => text !== '' && compileMatcher({ text, regex: filter.regex, matchCase: filter.matchCase }).invalid === true,
    [text, filter.regex, filter.matchCase],
  );

  return (
    <div
      data-testid="http-log-filter"
      /* One line, scrolled sideways when it does not fit: a wrapped bar eats the height of a short
         console, and the rows are what the panel is for. */
      className="flex shrink-0 items-center gap-3 overflow-x-auto border-b border-hairline px-2 py-1"
    >
      <div className="relative flex shrink-0 items-center">
        <input
          type="search"
          aria-label="Search the log"
          placeholder="Search URL, headers, bodies, name"
          value={text}
          aria-invalid={invalid}
          title={invalid ? 'Not a valid regular expression' : undefined}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
          className={`h-row w-64 rounded-md border bg-surface-raised pl-2 pr-12 font-mono text-xs text-fg-default placeholder:text-fg-faint ${
            invalid ? 'border-status-danger' : 'border-hairline'
          }`}
        />
        <div className="absolute right-1 flex items-center gap-0.5">
          <SearchToggle
            label="Use regular expression"
            glyph=".*"
            pressed={filter.regex}
            onToggle={() => {
              setFilter({ regex: !filter.regex });
            }}
          />
          <SearchToggle
            label="Match case"
            glyph="Aa"
            pressed={filter.matchCase}
            onToggle={() => {
              setFilter({ matchCase: !filter.matchCase });
            }}
          />
        </div>
      </div>
      <ChipGroup label="Method">
        {methods.map((method) => (
          <Chip
            key={method}
            label={method}
            pressed={filter.methods.includes(method)}
            onToggle={() => {
              setFilter({ methods: toggled(filter.methods, method) });
            }}
          />
        ))}
      </ChipGroup>
      <ChipGroup label="Status">
        {STATUS_CLASSES.map((status) => (
          <Chip
            key={status}
            label={status}
            pressed={filter.statuses.includes(status)}
            onToggle={() => {
              setFilter({ statuses: toggled(filter.statuses, status) });
            }}
          />
        ))}
      </ChipGroup>
      <ChipGroup label="Protocol">
        {PROTOCOLS.map((protocol) => (
          <Chip
            key={protocol.id}
            label={protocol.label}
            pressed={filter.protocols.includes(protocol.id)}
            onToggle={() => {
              setFilter({ protocols: toggled(filter.protocols, protocol.id) });
            }}
          />
        ))}
      </ChipGroup>
      <span data-testid="http-log-count" className="ml-auto shrink-0 font-mono text-xs text-fg-subtle">
        {shown} of {total}
      </span>
      <Button variant="ghost" onClick={resetFilter}>
        Reset
      </Button>
      {actions !== undefined && <div className="flex items-center gap-1 border-l border-hairline pl-2">{actions}</div>}
    </div>
  );
}
