import { useCallback, useEffect, useId, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type {
  GroupEntryWire,
  ResolvedHostWire,
  SerialSettingsWire,
  SshSerialPortWire,
} from '../../../shared/ssh-wire.js';
import { detectPlatform } from '../../lib/platform.js';
import { ipc } from '../../state/ipc-client.js';
import { INPUT_CLASS, sourceText, type Provenance } from './inherited-field.js';

/** What a serial console speaks when its block leaves a field out (#426); `@wirebench/ssh` must agree (tested). */
export const SERIAL_DEFAULTS = {
  baud: 115200,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
  flowControl: 'none',
} as const satisfies SerialLineWire;

/** The common rates the Baud field suggests; any whole number is accepted. */
export const SERIAL_BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

const MAX_BAUD = 20_000_000;

function dropUndefined(settings: SerialSettingsWire | undefined): SerialSettingsWire {
  return Object.fromEntries(Object.entries(settings ?? {}).filter(([, v]) => v !== undefined));
}

/** Every field of the line filled in. */
export type SerialLineWire = { readonly [K in keyof SerialSettingsWire]-?: NonNullable<SerialSettingsWire[K]> };

/** The block with its defaults filled in, per field. */
export function serialLineOf(settings: SerialSettingsWire | undefined): SerialLineWire {
  return {
    baud: settings?.baud ?? SERIAL_DEFAULTS.baud,
    dataBits: settings?.dataBits ?? SERIAL_DEFAULTS.dataBits,
    parity: settings?.parity ?? SERIAL_DEFAULTS.parity,
    stopBits: settings?.stopBits ?? SERIAL_DEFAULTS.stopBits,
    flowControl: settings?.flowControl ?? SERIAL_DEFAULTS.flowControl,
  };
}

/** `9600 8N1`, `115200 7E2 · RTS/CTS`: the line as consoles are labelled. */
/** An example port path in this computer's own form: COM3 meant nothing on a Mac or Linux (S16). */
export function serialPathExample(platform = detectPlatform()): string {
  return platform === 'win' ? 'COM3' : platform === 'mac' ? '/dev/cu.usbserial-0001' : '/dev/ttyUSB0';
}

export function serialLabel(settings: SerialSettingsWire | undefined): string {
  const line = serialLineOf(settings);
  const flow = line.flowControl === 'rtscts' ? ' · RTS/CTS' : line.flowControl === 'xonxoff' ? ' · XON/XOFF' : '';
  return `${String(line.baud)} ${String(line.dataBits)}${line.parity.charAt(0).toUpperCase()}${String(line.stopBits)}${flow}`;
}

/** How a list or card names a serial console where another host shows its address: `Serial · 9600 8N1`. */
export function serialTargetText(host: ResolvedHostWire | undefined): string {
  return `Serial · ${serialLabel(host?.ssh.serial?.value)}`;
}

/** The nearest group's `serial` block, whole: blocks are never merged. */
export function inheritedSerial(chain: readonly GroupEntryWire[]): Provenance<SerialSettingsWire> {
  for (const g of [...chain].reverse()) {
    if (g.ssh.serial !== undefined) return { value: g.ssh.serial, from: { group: g.name } };
  }
  return { value: undefined, from: 'default' };
}

/** Why Save waits on this block, or undefined. */
export function serialProblem(serial: SerialSettingsWire | undefined): string | undefined {
  const baud = serial?.baud;
  if (baud !== undefined && (!Number.isInteger(baud) || baud < 1 || baud > MAX_BAUD)) {
    return 'Baud must be a whole number of bits per second';
  }
  return undefined;
}

/** A block whose fields are all left out is no block: the level inherits again. */
export function cleanSerial(serial: SerialSettingsWire | undefined): SerialSettingsWire | undefined {
  const out = dropUndefined(serial);
  return Object.keys(out).length === 0 ? undefined : out;
}

/** This machine's serial ports, read on mount and on `refresh`; `unavailable` when it has no serial support. */
export function useSerialPorts(): {
  readonly ports: readonly SshSerialPortWire[];
  readonly unavailable: boolean;
  readonly loading: boolean;
  readonly refresh: () => void;
} {
  const [ports, setPorts] = useState<readonly SshSerialPortWire[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [round, setRound] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.resolve()
      .then(() => ipc().ssh.serialPorts(undefined))
      .then((result) => {
        if (!live) return;
        setPorts(result.ok ? result.value.ports : []);
        setUnavailable(!result.ok && result.error.code === 'serial-unavailable');
      })
      .catch(() => {
        if (live) setPorts([]);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [round]);
  const refresh = useCallback(() => {
    setRound((r) => r + 1);
  }, []);
  return { ports, unavailable, loading, refresh };
}

/** `/dev/tty.usbserial-A10KJ3 — FTDI`. */
export const portText = (port: SshSerialPortWire): string =>
  port.label === undefined ? port.path : `${port.path} — ${port.label}`;

/** What the port list says under a device field. */
export function portsNote(state: ReturnType<typeof useSerialPorts>): string {
  if (state.unavailable) return 'Serial ports are not available on this computer.';
  if (state.loading) return 'Looking for serial ports…';
  if (state.ports.length === 0) return 'No serial ports found. Plug in the adapter, then Refresh.';
  return `Found: ${state.ports.map(portText).join(', ')}`;
}

export function RefreshPortsButton({ state }: { readonly state: ReturnType<typeof useSerialPorts> }) {
  return (
    <button
      type="button"
      aria-label="Refresh serial ports"
      title="Refresh serial ports"
      disabled={state.loading}
      onClick={state.refresh}
      className="inline-flex size-7 shrink-0 items-center justify-center rounded border border-hairline text-fg-subtle hover:bg-surface-hover hover:text-fg-default disabled:opacity-50"
    >
      <RefreshCw size={12} aria-hidden="true" />
    </button>
  );
}

/**
 * The device a serial host opens on this computer: one of the ports found, with a Refresh for an adapter
 * plugged in since, or any path typed. It is kept on this machine, never in `hosts.yaml`.
 */
export function SerialDeviceField({
  value,
  onChange,
}: {
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  const id = useId();
  const listId = useId();
  const state = useSerialPorts();
  return (
    <div className="flex flex-col gap-1 text-xs">
      <label htmlFor={id} className="text-fg-subtle">
        Device on this computer
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          list={listId}
          className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
          placeholder={state.ports[0]?.path ?? serialPathExample()}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
        />
        <datalist id={listId}>
          {state.ports.map((port) => (
            <option key={port.path} value={port.path}>
              {portText(port)}
            </option>
          ))}
        </datalist>
        <RefreshPortsButton state={state} />
      </div>
      <p className="text-fg-faint">{`${portsNote(state)} Kept on this computer only, never in hosts.yaml.`}</p>
    </div>
  );
}

const PARITY_LABELS = { none: 'None', even: 'Even', odd: 'Odd', mark: 'Mark', space: 'Space' } as const;
const FLOW_LABELS = { none: 'None', rtscts: 'RTS/CTS', xonxoff: 'XON/XOFF' } as const;

/**
 * A serial console's line settings (#426): baud, data bits, parity, stop bits and flow control, as one block
 * that replaces a group's whole. Changing a field starts this level's own block from what it inherits.
 */
export function SerialLineSection({
  own,
  inherited,
  onChange,
}: {
  readonly own: SerialSettingsWire | undefined;
  readonly inherited: Provenance<SerialSettingsWire>;
  readonly onChange: (next: SerialSettingsWire | undefined) => void;
}) {
  const baudId = useId();
  const ratesId = useId();
  const [baudText, setBaudText] = useState<string | undefined>(undefined);
  const shown = serialLineOf(own ?? inherited.value);
  const source = own === undefined ? sourceText(inherited, () => 'settings') : undefined;
  const set = <K extends keyof SerialSettingsWire>(key: K, value: SerialSettingsWire[K]): void => {
    onChange(cleanSerial({ ...(own ?? inherited.value ?? {}), [key]: value }));
  };
  const badBaud = serialProblem(own) !== undefined;
  const select = <K extends 'dataBits' | 'parity' | 'stopBits' | 'flowControl'>(
    key: K,
    label: string,
    options: readonly { readonly value: NonNullable<SerialSettingsWire[K]>; readonly text: string }[],
  ) => (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-fg-subtle">{label}</span>
      <select
        aria-label={label}
        className={INPUT_CLASS}
        value={String(shown[key])}
        onChange={(e) => {
          set(key, options.find((o) => String(o.value) === e.target.value)?.value);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.text}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <section aria-label="Serial line" className="flex flex-col gap-2">
      {/* The fields below say the line already: the summary stays only to say where an inherited one is from (S16). */}
      {source !== undefined && (
        <p className="text-xs text-fg-subtle">
          {`Line: ${serialLabel(own ?? inherited.value)}`}
          <span className="text-fg-faint">{` · ${source}`}</span>
        </p>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1 text-xs">
          <label htmlFor={baudId} className="text-fg-subtle">
            Baud
          </label>
          <input
            id={baudId}
            inputMode="numeric"
            list={ratesId}
            aria-invalid={badBaud}
            className={`${INPUT_CLASS} min-w-0`}
            value={baudText ?? String(shown.baud)}
            onChange={(e) => {
              const text = e.target.value.trim();
              setBaudText(text);
              set('baud', text === '' ? undefined : Number(text));
            }}
            onBlur={() => {
              setBaudText(undefined);
            }}
          />
          <datalist id={ratesId}>
            {SERIAL_BAUD_RATES.map((rate) => (
              <option key={rate} value={rate} />
            ))}
          </datalist>
        </div>
        {select(
          'dataBits',
          'Data bits',
          ([5, 6, 7, 8] as const).map((v) => ({ value: v, text: String(v) })),
        )}
        {select(
          'parity',
          'Parity',
          (Object.keys(PARITY_LABELS) as (keyof typeof PARITY_LABELS)[]).map((v) => ({
            value: v,
            text: PARITY_LABELS[v],
          })),
        )}
        {select(
          'stopBits',
          'Stop bits',
          ([1, 1.5, 2] as const).map((v) => ({ value: v, text: String(v) })),
        )}
        {select(
          'flowControl',
          'Flow control',
          (Object.keys(FLOW_LABELS) as (keyof typeof FLOW_LABELS)[]).map((v) => ({ value: v, text: FLOW_LABELS[v] })),
        )}
      </div>
      {badBaud && (
        <p role="alert" className="text-xs text-status-danger">
          Enter the baud rate as a whole number, for example 9600 or 115200.
        </p>
      )}
    </section>
  );
}
