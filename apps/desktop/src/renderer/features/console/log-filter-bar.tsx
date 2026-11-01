/**
 * The HTTP Log's filter bar: a search field (URL, headers, bodies, name; regex and match-case toggles),
 * a **Filters ▾** menu of method, status class and protocol choices (multi-select; none selected means
 * all) whose button shows how many are on, the "n of m" count, and Reset — which clears the filter
 * and is distinct from Clear, which empties the log. State lives in the exchanges store.
 */
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, XCircle } from 'lucide-react';
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

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1 font-mono text-xs text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/** One choice in the Filters menu; picking it leaves the menu open for the next one. */
function FilterItem({
  label,
  checked,
  onToggle,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <DropdownMenu.CheckboxItem
      checked={checked}
      onCheckedChange={onToggle}
      onSelect={(event) => {
        event.preventDefault();
      }}
      className={ITEM_CLASS}
    >
      <span className="flex size-3.5 items-center justify-center">
        <DropdownMenu.ItemIndicator>
          <Check aria-hidden="true" className="size-3.5" />
        </DropdownMenu.ItemIndicator>
      </span>
      {label}
    </DropdownMenu.CheckboxItem>
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

function FilterGroup({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <DropdownMenu.Group aria-label={label} className="py-0.5">
      <DropdownMenu.Label className="px-2 py-0.5 text-xs text-fg-subtle">{label}</DropdownMenu.Label>
      {children}
    </DropdownMenu.Group>
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
  const invalidId = useId();
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
  const active = filter.methods.length + filter.statuses.length + filter.protocols.length;

  return (
    <div
      data-testid="http-log-filter"
      /* One line where it fits: a wrapped bar eats the height of a short console, and the rows are what
         the panel is for. The choices sit in the Filters menu, the actions are icons and the search field
         gives way first; only a console narrower than all that (the code panel open beside it) wraps,
         rather than scrolling Reset and the actions out of view (#636). */
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline px-2 py-1"
    >
      <div className="relative flex min-w-32 max-w-64 flex-1 basis-32 items-center">
        <input
          type="search"
          aria-label="Search the log"
          placeholder="Search URL, headers, bodies, name"
          value={text}
          aria-invalid={invalid}
          aria-describedby={invalid ? invalidId : undefined}
          title={invalid ? 'Not a valid regular expression' : undefined}
          onChange={(event) => {
            setText(event.currentTarget.value);
          }}
          className={`h-row w-full rounded-md border bg-surface-raised pl-2 font-mono text-xs text-fg-default placeholder:text-fg-faint ${
            invalid ? 'border-status-danger pr-16' : 'border-hairline pr-12'
          }`}
        />
        <div className="absolute right-1 flex items-center gap-0.5">
          {/* The border alone would tell a bad pattern by colour only (#803): a cross says it too. */}
          {invalid && (
            <span
              data-testid="http-log-filter-invalid"
              title="Not a valid regular expression"
              className="flex items-center px-0.5 text-status-danger"
            >
              <XCircle size={12} aria-hidden="true" />
              <span id={invalidId} className="sr-only">
                Invalid pattern
              </span>
            </span>
          )}
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
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <Button
            variant="ghost"
            data-testid="http-log-filters"
            aria-label={active === 0 ? 'Filters' : `Filters, ${String(active)} on`}
            className="shrink-0"
          >
            Filters
            {active > 0 && (
              <span
                data-testid="http-log-filters-count"
                className="rounded-full bg-highlight px-1.5 font-mono text-xs leading-4 text-fg-on-highlight"
              >
                {active}
              </span>
            )}
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            sideOffset={4}
            className="z-dropdown max-h-[60vh] min-w-40 overflow-y-auto rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          >
            {methods.length > 0 && (
              <FilterGroup label="Method">
                {methods.map((method) => (
                  <FilterItem
                    key={method}
                    label={method}
                    checked={filter.methods.includes(method)}
                    onToggle={() => {
                      setFilter({ methods: toggled(filter.methods, method) });
                    }}
                  />
                ))}
              </FilterGroup>
            )}
            <FilterGroup label="Status">
              {STATUS_CLASSES.map((status) => (
                <FilterItem
                  key={status}
                  label={status}
                  checked={filter.statuses.includes(status)}
                  onToggle={() => {
                    setFilter({ statuses: toggled(filter.statuses, status) });
                  }}
                />
              ))}
            </FilterGroup>
            <FilterGroup label="Protocol">
              {PROTOCOLS.map((protocol) => (
                <FilterItem
                  key={protocol.id}
                  label={protocol.label}
                  checked={filter.protocols.includes(protocol.id)}
                  onToggle={() => {
                    setFilter({ protocols: toggled(filter.protocols, protocol.id) });
                  }}
                />
              ))}
            </FilterGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <span data-testid="http-log-count" className="ml-auto shrink-0 font-mono text-xs text-fg-subtle">
        {shown} of {total}
      </span>
      <Button variant="ghost" className="shrink-0" onClick={resetFilter}>
        Reset
      </Button>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-1 border-l border-hairline pl-2">{actions}</div>
      )}
    </div>
  );
}
