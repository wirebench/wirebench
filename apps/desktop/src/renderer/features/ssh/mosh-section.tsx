import { useId } from 'react';
import { useUiStore } from '../../state/ui.js';
import type { GroupEntryWire, MoshSettingsWire, SshProtocolWire } from '../../../shared/ssh-wire.js';
import { INPUT_CLASS, sourceText, type Provenance } from './inherited-field.js';

export const PROTOCOL_LABELS: Record<SshProtocolWire, string> = { ssh: 'SSH', mosh: 'Mosh', telnet: 'Telnet' };
const PORTS = /^(\d{1,5})(?::(\d{1,5}))?$/;

/** The protocol the enclosing groups (outermost first) set: the nearest that says, else SSH. */
export function inheritedProtocol(chain: readonly GroupEntryWire[]): Provenance<SshProtocolWire> {
  for (const g of [...chain].reverse()) {
    if (g.ssh.protocol !== undefined) return { value: g.ssh.protocol, from: { group: g.name } };
  }
  return { value: 'ssh', from: 'default' };
}

/** The nearest group's `mosh` block, whole: blocks are never merged. */
export function inheritedMosh(chain: readonly GroupEntryWire[]): Provenance<MoshSettingsWire> {
  for (const g of [...chain].reverse()) {
    if (g.ssh.mosh !== undefined) return { value: g.ssh.mosh, from: { group: g.name } };
  }
  return { value: undefined, from: 'default' };
}

/** A port or `LOW:HIGH` within 1–65535, LOW no higher than HIGH: the same rule `hosts.yaml` holds it to. */
export function validMoshPorts(text: string): boolean {
  const match = PORTS.exec(text);
  if (!match) return false;
  const low = Number(match[1]);
  const high = match[2] === undefined ? low : Number(match[2]);
  return low >= 1 && high <= 65535 && low <= high;
}

/** Why Save waits on this block, or undefined. */
export function moshProblem(mosh: MoshSettingsWire | undefined): string | undefined {
  if (mosh?.ports !== undefined && !validMoshPorts(mosh.ports)) {
    return 'UDP ports must be a port or LOW:HIGH (Advanced)';
  }
  return undefined;
}

/** A block whose fields are all empty is no block: the level inherits again. */
export function cleanMosh(mosh: MoshSettingsWire | undefined): MoshSettingsWire | undefined {
  if (mosh === undefined) return undefined;
  const server = mosh.server?.trim();
  const out: MoshSettingsWire = {
    ...(server === undefined || server === '' ? {} : { server }),
    ...(mosh.ports === undefined || mosh.ports === '' ? {} : { ports: mosh.ports }),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

export interface MoshSectionProps {
  /** This level's own `ssh.protocol`; `undefined` inherits. */
  readonly protocol: SshProtocolWire | undefined;
  readonly mosh: MoshSettingsWire | undefined;
  readonly inheritedProtocol: Provenance<SshProtocolWire>;
  readonly inheritedMosh: Provenance<MoshSettingsWire>;
  readonly onProtocol: (next: SshProtocolWire | undefined) => void;
  readonly onMosh: (next: MoshSettingsWire | undefined) => void;
}

/**
 * The host and group form's protocol (#419): SSH, Mosh, which starts a mosh server over SSH and then runs the
 * session over UDP with the installed mosh-client, or Telnet (#425), in plain text. For Mosh, the server command
 * and UDP ports, as one block that replaces a group's whole. Telnet is offered only while this build allows it,
 * and stays shown on an entry already set to it.
 */
export function MoshSection({
  protocol,
  mosh,
  inheritedProtocol: inheritedP,
  inheritedMosh: inheritedM,
  onProtocol,
  onMosh,
}: MoshSectionProps) {
  const serverId = useId();
  const portsId = useId();
  const telnetAllowed = useUiStore((s) => s.telnetEnabled);
  const fromGroup = typeof inheritedP.from === 'object';
  const effective = protocol ?? inheritedP.value ?? 'ssh';
  const inheritedLabel = PROTOCOL_LABELS[inheritedP.value ?? 'ssh'];
  const blockSource = mosh === undefined ? sourceText(inheritedM, () => 'settings') : undefined;
  const portsBad = mosh?.ports !== undefined && mosh.ports !== '' && !validMoshPorts(mosh.ports);
  const setField = (key: keyof MoshSettingsWire, value: string): void => {
    const next = { ...(mosh ?? {}), [key]: value === '' ? undefined : value };
    onMosh(cleanMosh(next));
  };
  return (
    <section aria-label="Protocol" className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs">
        <span className="flex gap-2 text-fg-subtle">
          Protocol
          {protocol === undefined && fromGroup && (
            <span className="text-fg-faint">{sourceText(inheritedP, (v) => PROTOCOL_LABELS[v])}</span>
          )}
        </span>
        <select
          aria-label="Protocol"
          className={INPUT_CLASS}
          value={protocol ?? ''}
          onChange={(e) => {
            onProtocol(e.target.value === '' ? undefined : (e.target.value as SshProtocolWire));
          }}
        >
          <option value="">{fromGroup ? `Inherit (${inheritedLabel})` : 'SSH'}</option>
          {fromGroup && <option value="ssh">SSH</option>}
          <option value="mosh">Mosh</option>
          {(telnetAllowed || protocol === 'telnet') && (
            <option value="telnet">{telnetAllowed ? 'Telnet' : 'Telnet (switched off)'}</option>
          )}
        </select>
      </label>
      {effective === 'telnet' && (
        <p role="note" className="text-xs text-status-warning">
          Telnet is not encrypted: everything typed and shown, the password included, travels in plain text. Use it only
          on a network you trust, or reach the device through an SSH jump host.
          {!telnetAllowed && ' This build of Wirebench has Telnet switched off, so the host does not connect.'}
        </p>
      )}
      {effective === 'mosh' && (
        <>
          <p role="note" className="text-xs text-fg-subtle">
            Starts a mosh server over SSH, then runs the session over UDP with mosh-client, which must be installed on
            this computer. UDP goes straight to the host, not through a jump host.
            {blockSource !== undefined && <span className="text-fg-faint"> Server settings {blockSource}.</span>}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1 text-xs">
              <label htmlFor={serverId} className="text-fg-subtle">
                Server command
              </label>
              <input
                id={serverId}
                className={`${INPUT_CLASS} min-w-0`}
                placeholder={inheritedM.value?.server ?? 'mosh-server'}
                value={mosh?.server ?? ''}
                onChange={(e) => {
                  setField('server', e.target.value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1 text-xs">
              <label htmlFor={portsId} className="text-fg-subtle">
                UDP ports
              </label>
              <input
                id={portsId}
                className={`${INPUT_CLASS} min-w-0`}
                placeholder={inheritedM.value?.ports ?? '60000:61000'}
                aria-invalid={portsBad}
                value={mosh?.ports ?? ''}
                onChange={(e) => {
                  setField('ports', e.target.value.trim());
                }}
              />
            </div>
          </div>
          {portsBad && (
            <p role="alert" className="text-xs text-status-danger">
              Enter one port, or a range as LOW:HIGH (for example 60000:60010).
            </p>
          )}
        </>
      )}
    </section>
  );
}
