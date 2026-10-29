/**
 * Settings → *This machine* (hosted edition spec §18.2, §18.3), in a browser tab only: the paired local
 * agent's status, *Pair this machine* (a code from the server, with the two ways to use it), and the
 * user's pairings with *Unpair*. The calls are the bootstrap's (`env.agent`), made with the tab's cookie.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { showToast } from '../../../components/toast.js';
import { agentEnv, useSendRouteStore } from '../../../state/send-route.js';
import type { AgentPairingView, AgentStatus } from '../../../../preload/build-api.js';

/** The trust a pairing gives, said where the pairing is offered (spec §3.8), as the desktop and the CLI say it. */
export const PAIRING_TRUST_TEXT =
  'A paired server can send requests from this machine on your behalf, including to addresses on this machine’s network.';

/** The browser's own prompt the first time this page reaches the agent (spec §3.8, decision 6). */
export const LOCAL_NETWORK_TEXT =
  'Your browser may ask whether this site may reach devices on your local network (local network access): allow it, so this tab can reach the agent on this machine.';

/** Safari refuses the agent's socket from an https page (spec §3.8, decision 6). */
export const SAFARI_TEXT =
  'Safari cannot reach an agent on this machine from an https:// page. In Safari, pair the Wirebench desktop app and open the workspace there instead.';

/** How often the list is read again while a code is shown, so a pairing made elsewhere appears. */
const CODE_POLL_MS = 3_000;

/** What a pairing this machine's agent refused three times in a row shows. */
export const REFUSED_TEXT = 'Refused by this machine’s agent';

/** A machine's short name: the first eight characters of its agent id. */
function machineLabel(pairing: AgentPairingView): string {
  return pairing.agentId === '' ? 'Machine' : `Machine ${pairing.agentId.slice(0, 8)}`;
}

function statusText(status: AgentStatus, version: string | undefined): string {
  if (status === 'connected') return version === undefined ? 'Connected' : `Connected (agent ${version})`;
  if (status === 'refused') return REFUSED_TEXT;
  if (status === 'connecting')
    return 'Paired, connecting… Start the Wirebench desktop app or wirebench agent on this machine.';
  return 'Not paired';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ThisMachineSection() {
  const agent = agentEnv();
  const status = useSendRouteStore((state) => state.agentStatus);
  const version = useSendRouteStore((state) => state.agentVersion);
  const [pairings, setPairings] = useState<readonly AgentPairingView[] | undefined>(undefined);
  const [code, setCode] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (agent === undefined) return;
    try {
      setPairings(await agent.pairings());
    } catch (error) {
      showToast(messageOf(error));
    }
  }, [agent]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a code is out, a pairing made with it (in the desktop app or the CLI) shows up on its own.
  useEffect(() => {
    if (code === undefined || agent === undefined) return;
    const timer = setInterval(() => {
      void agent.refresh().then(load);
    }, CODE_POLL_MS);
    return () => clearInterval(timer);
  }, [code, agent, load]);

  if (agent === undefined) return null;

  const pair = async (): Promise<void> => {
    setBusy(true);
    try {
      setCode((await agent.createPairingCode()).code);
    } catch (error) {
      showToast(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  const unpair = async (id: string): Promise<void> => {
    setBusy(true);
    try {
      await agent.unpair(id);
      await load();
    } catch (error) {
      showToast(messageOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="this-machine-section">
      <SettingsGroup title="Local agent">
        <SettingsItem>
          <p data-testid="agent-status" data-status={status} className="mb-2 text-sm text-fg-default">
            {statusText(status, version)}
          </p>
          <div data-testid="agent-pair-notes" className="mb-2 flex flex-col gap-1 text-sm text-fg-subtle">
            <p className="text-fg-default">{PAIRING_TRUST_TEXT}</p>
            <p>{LOCAL_NETWORK_TEXT}</p>
            <p>{SAFARI_TEXT}</p>
          </div>
          {code === undefined ? (
            <Button data-testid="agent-pair" disabled={busy} onClick={() => void pair()}>
              Pair this machine
            </Button>
          ) : (
            <div data-testid="agent-pair-code" className="flex flex-col gap-1 rounded-md border border-hairline p-2">
              <p className="text-sm text-fg-default">
                Pairing code: <span className="font-mono text-base tracking-widest">{code}</span> (valid for ten
                minutes)
              </p>
              <p className="text-sm text-fg-subtle">In the Wirebench desktop app, choose Pair this machine…</p>
              <p className="text-sm text-fg-subtle">
                Or run{' '}
                <code className="font-mono">{`wirebench agent pair ${code} --server ${agent.serverOrigin}`}</code>
              </p>
              <div>
                <Button data-testid="agent-pair-done" onClick={() => setCode(undefined)}>
                  Done
                </Button>
              </div>
            </div>
          )}
        </SettingsItem>
      </SettingsGroup>
      <SettingsGroup title="Paired machines">
        <SettingsItem>
          {pairings !== undefined && pairings.length === 0 ? (
            <p className="text-sm text-fg-subtle">No machine is paired with your account.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {(pairings ?? []).map((pairing) => (
                <li key={pairing.id} data-testid="agent-pairing-row" className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg-default">
                      <span className="font-mono">{machineLabel(pairing)}</span> · paired{' '}
                      {new Date(pairing.createdAt).toLocaleDateString()}
                    </p>
                    <p className="text-xs text-fg-subtle">
                      port {String(pairing.port)} · last seen {new Date(pairing.lastSeenAt).toLocaleString()}
                      {agent.refused(pairing.id) && (
                        <span data-testid="agent-pairing-refused" className="text-status-danger">
                          {' '}
                          · {REFUSED_TEXT}
                        </span>
                      )}
                    </p>
                  </div>
                  <Button
                    data-testid="agent-unpair"
                    aria-label={`Unpair ${machineLabel(pairing)}`}
                    disabled={busy}
                    onClick={() => void unpair(pairing.id)}
                  >
                    Unpair
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsItem>
      </SettingsGroup>
    </div>
  );
}
