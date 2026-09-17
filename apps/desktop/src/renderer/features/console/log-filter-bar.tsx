/**
 * The HTTP Log's filter bar: a URL text field, chip groups for method, status class and protocol
 * (multi-select; none selected means all), the "n of m" count, and Reset — which clears the filter
 * and is distinct from Clear, which empties the log. State lives in the exchanges store.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../components/button.js';
import type { StatusClass } from '../../state/exchanges.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { methodsIn } from './log-filter.js';

const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx', 'failed'];
const PROTOCOLS = [
  { id: 'soap', label: 'SOAP' },
  { id: 'rest', label: 'REST' },
  { id: 'grpc', label: 'gRPC' },
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

function ChipGroup({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
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

  return (
    <div
      data-testid="http-log-filter"
      className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-2 py-1"
    >
      <input
        type="search"
        aria-label="Filter URL"
        placeholder="Filter URL"
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
        }}
        className="h-row min-w-40 rounded-md border border-hairline bg-surface-raised px-2 font-mono text-xs text-fg-default placeholder:text-fg-faint"
      />
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
      <span data-testid="http-log-count" className="ml-auto font-mono text-xs text-fg-subtle">
        {shown} of {total}
      </span>
      <Button variant="ghost" onClick={resetFilter}>
        Reset
      </Button>
      {actions !== undefined && <div className="flex items-center gap-1 border-l border-hairline pl-2">{actions}</div>}
    </div>
  );
}
