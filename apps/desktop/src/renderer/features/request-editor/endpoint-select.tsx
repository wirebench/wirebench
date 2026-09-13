import { useMemo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';
import type { InterfaceSummary } from '../../../shared/wire-types.js';

const ITEM_CLASS =
  'flex cursor-pointer flex-col items-start rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

export interface EndpointSelectProps {
  readonly summary: InterfaceSummary | undefined;
  /** Clark-notation binding QName of the request's operation; its ports are offered first. */
  readonly bindingName: string;
  readonly value: string | undefined;
  readonly onChange: (endpoint: string) => void;
  /** Opens the interface's endpoint manager; omitted where there is nothing to manage. */
  readonly onEditEndpoints?: () => void;
}

interface EndpointOption {
  readonly address: string;
  readonly label: string;
  readonly matchesBinding: boolean;
}

/** Every port address the interface declares, this operation's binding first. */
function collectOptions(summary: InterfaceSummary | undefined, bindingName: string): readonly EndpointOption[] {
  const seen = new Set<string>();
  const options: EndpointOption[] = [];

  for (const service of summary?.services ?? []) {
    for (const port of service.ports) {
      if (port.address === undefined || seen.has(port.address)) {
        continue;
      }
      seen.add(port.address);
      options.push({
        address: port.address,
        label: `${service.name} · ${port.name}`,
        matchesBinding: port.binding === bindingName,
      });
    }
  }

  return [...options.filter((o) => o.matchesBinding), ...options.filter((o) => !o.matchesBinding)];
}

/**
 * The endpoint combobox: a text field that always shows the URL the request will be sent to and
 * commits every keystroke, plus a caret that drops down the addresses the interface declares.
 *
 * The URL is the one thing a user checks before sending, so it is never hidden behind a select
 * — a declared address is a shortcut into the same field, not a separate mode (the Task 32b
 * feedback: the old select squeezed the URL down to a few characters).
 */
export function EndpointSelect({ summary, bindingName, value, onChange, onEditEndpoints }: EndpointSelectProps) {
  const options = useMemo(() => collectOptions(summary, bindingName), [summary, bindingName]);

  return (
    <div className="flex min-w-[16rem] flex-1 items-center gap-1">
      <input
        type="url"
        aria-label="Endpoint"
        data-testid="request-endpoint"
        className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default"
        placeholder="https://host/path"
        value={value ?? ''}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />

      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Endpoint options"
            data-testid="request-endpoint-menu"
            title="Choose an endpoint"
            className="h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
          >
            <ChevronDown size={12} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="bottom"
            align="end"
            sideOffset={4}
            className="max-w-[32rem] min-w-64 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
          >
            {options.map((option) => (
              <DropdownMenu.Item
                key={option.address}
                className={ITEM_CLASS}
                onSelect={() => {
                  onChange(option.address);
                }}
              >
                <span className="max-w-full truncate font-mono">{option.address}</span>
                <span className="text-xs text-fg-subtle">{option.label}</span>
              </DropdownMenu.Item>
            ))}
            {onEditEndpoints !== undefined && (
              <>
                {options.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-hairline" />}
                <DropdownMenu.Item
                  className={ITEM_CLASS}
                  onSelect={() => {
                    onEditEndpoints();
                  }}
                >
                  Edit endpoints…
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
