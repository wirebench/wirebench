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

/** The trust a pairing gives, said once (spec §18.2). */
export const PAIRING_TRUST_TEXT =
  'A paired machine sends requests from this server’s workspaces on your behalf, including to addresses on that machine’s network.';

/** How often the list is read again while a code is shown, so a pairing made elsewhere appears. */
const CODE_POLL_MS = 3_000;

function statusText(status: AgentStatus, version: string | undefined): string {
  if (status === 'connected') return version === undefined ? 'Connected' : `Connected (agent ${version})`;
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
      <SettingsGroup title="Local agent" hint={PAIRING_TRUST_TEXT}>
        <SettingsItem>
          <p data-testid="agent-status" data-status={status} className="mb-2 text-sm text-fg-default">
            {statusText(status, version)}
          </p>
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
                    <p className="truncate text-sm text-fg-default">Port {String(pairing.port)}</p>
                    <p className="text-xs text-fg-subtle">
                      paired {new Date(pairing.createdAt).toLocaleString()} · last seen{' '}
                      {new Date(pairing.lastSeenAt).toLocaleString()}
                    </p>
                  </div>
                  <Button
                    data-testid="agent-unpair"
                    aria-label={`Unpair the machine on port ${String(pairing.port)}`}
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
