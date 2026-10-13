import { KeyRound } from 'lucide-react';
import type { GroupEntryWire, SshConnectResponse } from '../../../shared/ssh-wire.js';
import type { PaneSession } from './hosts-store.js';
import { InheritedSwitch, type Provenance } from './inherited-field.js';

/** How a terminal's shell stands with the local agent; absent when its host does not forward it. */
export type AgentForwardingState = NonNullable<SshConnectResponse['agentForwarding']>;

/** Whether the enclosing groups (outermost first) forward the agent: the nearest group that says, else off. */
export function inheritedForwardAgent(chain: readonly GroupEntryWire[]): Provenance<boolean> {
  for (const g of [...chain].reverse()) {
    if (g.ssh.forwardAgent !== undefined) return { value: g.ssh.forwardAgent, from: { group: g.name } };
  }
  return { value: false, from: 'default' };
}

export interface AgentForwardingSectionProps {
  /** This level's own `ssh.forwardAgent`; `undefined` inherits. */
  readonly override: boolean | undefined;
  readonly inherited: Provenance<boolean>;
  readonly onChange: (next: boolean | undefined) => void;
}

/**
 * The host and group form's Agent forwarding switch, inherited like the other `ssh` settings. While it is on,
 * a note says what forwarding hands the remote host.
 */
export function AgentForwardingSection({ override, inherited, onChange }: AgentForwardingSectionProps) {
  const on = override ?? inherited.value ?? false;
  return (
    <section aria-label="Agent forwarding" className="flex flex-col gap-1.5">
      <InheritedSwitch label="Forward SSH agent" provenance={inherited} override={override} onChange={onChange} />
      {on && (
        <p role="note" className="text-xs text-status-warning">
          Anyone with root on this host can use the keys in your agent while you are connected. Forward it only to hosts
          you trust.
        </p>
      )}
    </section>
  );
}

/** A tab's forwarding, from its open panes: any forwarded shell wins, then a reason one is not, else nothing. */
export function agentForwardingOf(
  panes: Readonly<Record<string, PaneSession>>,
  paneIds: Iterable<string>,
): AgentForwardingState | undefined {
  let found: AgentForwardingState | undefined;
  for (const id of paneIds) {
    const pane = panes[id];
    if (pane?.state !== 'open' || pane.agentForwarding === undefined) continue;
    if (pane.agentForwarding === 'on') return 'on';
    found ??= pane.agentForwarding;
  }
  return found;
}

const LABELS: Record<AgentForwardingState, string> = {
  on: 'SSH agent forwarded',
  refused: 'SSH agent not forwarded: the server refused it',
  'no-agent': 'SSH agent not forwarded: no local agent is running',
};

/** The key drawn on a terminal tab and a pane header: amber while the agent is forwarded, faint when it was not. */
export function AgentForwardingMark({ state }: { readonly state: AgentForwardingState }) {
  return (
    <span
      role="img"
      aria-label={LABELS[state]}
      title={LABELS[state]}
      data-testid="agent-forwarding-mark"
      data-state={state}
      className={`inline-flex shrink-0 ${state === 'on' ? 'text-status-warning' : 'text-fg-faint'}`}
    >
      <KeyRound size={12} aria-hidden="true" />
    </span>
  );
}
