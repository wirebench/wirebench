/**
 * Settings → *Paired browsers* (hosted edition spec §18.2, §18.5), on the desktop only (`machine-agent`): the
 * servers whose browser tabs may send from this machine, with *Unpair* and *Remove here only*, whether the
 * agent listens, and the `${#System#…}` names a paired tab's send may read here. The calls are the main
 * process's own `machineAgent.*` channels.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { showToast } from '../../../components/toast.js';
import type { MachineAgentStatusWire } from '@shared/agent.js';
import { ipc } from '../../../state/ipc-client.js';
import { useUiStore } from '../../../state/ui.js';

/** The trust a pairing gives, said once (spec §18.2). */
export const PAIRED_BROWSER_TRUST_TEXT =
  'A paired server can send requests from this machine on your behalf, including to addresses on this machine’s network.';

/** The allowlist as typed: names split on commas, spaces and new lines. */
export function parseNames(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

function statusText(status: MachineAgentStatusWire | undefined): string {
  if (status === undefined) return 'Reading…';
  if (status.port !== undefined) return `Listening on port ${String(status.port)}`;
  return status.pairings.length === 0 ? 'Off: it starts when this machine is paired' : 'Off';
}

export function PairedBrowsersSection() {
  const [status, setStatus] = useState<MachineAgentStatusWire | undefined>(undefined);
  const [names, setNames] = useState('');
  const [busy, setBusy] = useState(false);
  const dialogOpen = useUiStore((state) => state.pairMachineDialogOpen);
  const openPairDialog = useUiStore((state) => state.setPairMachineDialogOpen);

  const show = useCallback((next: MachineAgentStatusWire): void => {
    setStatus(next);
    setNames(next.allowedSystemNames.join(', '));
  }, []);

  const load = useCallback(async (): Promise<void> => {
    const result = await ipc().machineAgent.status(undefined);
    if (result.ok) show(result.value);
    else showToast(result.error.message);
  }, [show]);

  // Read again whenever the pair dialog closes: it may have added a pairing.
  useEffect(() => {
    if (!dialogOpen) void load();
  }, [dialogOpen, load]);

  const unpair = async (pairingId: string, local: boolean): Promise<void> => {
    setBusy(true);
    const result = await ipc().machineAgent.unpair({ pairingId, ...(local ? { local: true } : {}) });
    setBusy(false);
    if (result.ok) show(result.value);
    else showToast(result.error.message);
  };

  const saveNames = async (): Promise<void> => {
    setBusy(true);
    const result = await ipc().machineAgent.setAllowedSystemNames({ names: parseNames(names) });
    setBusy(false);
    if (result.ok) {
      show(result.value);
      showToast('Allowed variables saved');
    } else {
      showToast(result.error.message);
    }
  };

  const paired = status?.paired === true;

  return (
    <div data-testid="paired-browsers-section">
      <SettingsGroup title="Local agent" hint={PAIRED_BROWSER_TRUST_TEXT}>
        <SettingsItem>
          <p data-testid="machine-agent-status" className="mb-2 text-sm text-fg-default">
            {statusText(status)}
          </p>
          <Button data-testid="machine-agent-pair" onClick={() => openPairDialog(true)}>
            Pair this machine…
          </Button>
        </SettingsItem>
      </SettingsGroup>
      <SettingsGroup title="Pairings">
        <SettingsItem>
          {status !== undefined && status.pairings.length === 0 ? (
            <p className="text-sm text-fg-subtle">No server is paired with this machine.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {(status?.pairings ?? []).map((pairing) => (
                <li
                  key={pairing.pairingId}
                  data-testid="machine-agent-pairing"
                  className="flex items-center gap-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg-default">
                      {pairing.origin} · {pairing.email}
                    </p>
                    <p className="text-xs text-fg-subtle">
                      paired {new Date(pairing.createdAt).toLocaleDateString()}
                      {pairing.port !== undefined ? ` · port ${String(pairing.port)}` : ''}
                    </p>
                  </div>
                  <Button
                    data-testid="machine-agent-unpair"
                    aria-label={`Unpair ${pairing.origin}`}
                    disabled={busy}
                    onClick={() => void unpair(pairing.pairingId, false)}
                  >
                    Unpair
                  </Button>
                  <Button
                    data-testid="machine-agent-remove-local"
                    aria-label={`Remove ${pairing.origin} here only`}
                    disabled={busy}
                    onClick={() => void unpair(pairing.pairingId, true)}
                  >
                    Remove here only
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </SettingsItem>
      </SettingsGroup>
      <SettingsGroup
        title="Allowed system variables"
        hint="A paired server’s request reads ${#System#NAME} on this machine only for the names listed here. Any other name stays empty."
      >
        <SettingsItem>
          {!paired && status !== undefined && (
            <p data-testid="machine-agent-names-note" className="mb-2 text-sm text-fg-subtle">
              Pair this machine first: the list is kept with its pairings.
            </p>
          )}
          <label className="block text-sm text-fg-subtle" htmlFor="machine-agent-names">
            Variable names, separated by commas
          </label>
          <input
            id="machine-agent-names"
            data-testid="machine-agent-names"
            disabled={!paired || busy}
            spellCheck={false}
            placeholder="CI_REGION, BUILD_ID"
            value={names}
            onChange={(event) => setNames(event.target.value)}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 font-mono text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
          />
          <div className="mt-2">
            <Button data-testid="machine-agent-names-save" disabled={!paired || busy} onClick={() => void saveNames()}>
              Save
            </Button>
          </div>
        </SettingsItem>
      </SettingsGroup>
    </div>
  );
}
