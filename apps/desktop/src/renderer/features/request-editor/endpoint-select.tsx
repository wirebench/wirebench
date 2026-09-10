import { useMemo, useState } from 'react';
import type { InterfaceSummary } from '../../../shared/wire-types.js';

const CUSTOM = '__custom__';

export interface EndpointSelectProps {
  readonly summary: InterfaceSummary | undefined;
  /** Clark-notation binding QName of the request's operation; its ports are offered first. */
  readonly bindingName: string;
  readonly value: string | undefined;
  readonly onChange: (endpoint: string) => void;
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
 * Endpoint picker: the interface's declared addresses, then a free-text escape hatch. The
 * draft already carries the first matching port address, so this is normally a confirmation.
 */
export function EndpointSelect({ summary, bindingName, value, onChange }: EndpointSelectProps) {
  const options = useMemo(() => collectOptions(summary, bindingName), [summary, bindingName]);
  const known = value !== undefined && options.some((option) => option.address === value);
  const [custom, setCustom] = useState(!known && value !== undefined);

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <select
        aria-label="Endpoint"
        className="h-row min-w-0 max-w-[26rem] flex-1 truncate rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default"
        value={custom || !known ? CUSTOM : value}
        onChange={(event) => {
          if (event.target.value === CUSTOM) {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.address} value={option.address}>
            {option.address} — {option.label}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </select>

      {(custom || !known) && (
        <input
          type="url"
          aria-label="Custom endpoint URL"
          className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default"
          placeholder="https://host/path"
          value={value ?? ''}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </div>
  );
}
