import { useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { ipc } from '../../state/ipc-client.js';
import { licenseLineProblem } from '../../state/license-format.js';
import { useLicenseStore } from '../../state/license.js';
import { INPUT_CLASS } from './roles.js';

const EDITION = { community: 'Community', team: 'Team', enterprise: 'Enterprise' } as const;
const STATUS = {
  none: 'No license installed',
  active: 'Active',
  grace: 'Expired, in its grace period',
  expired: 'Expired',
  invalid: 'Installed, but not valid',
} as const;

/**
 * The License tab (licensing spec §3.8), for server admins. Edition, status, customer, seats and dates;
 * a pasted or chosen license; *Remove license…* behind a confirmation. No other text. The server id comes first,
 * with a *Copy*, for the order form (license-binding spec §3.4).
 */
export function LicenseTab({ url }: { readonly url: string }) {
  const { state, error, busy, load, install, remove } = useLicenseStore();
  const [text, setText] = useState('');
  const [local, setLocal] = useState<string | undefined>(undefined);
  const [confirmRemove, setConfirmRemove] = useState(false);

  useEffect(() => {
    void load(url);
    return () => {
      useLicenseStore.getState().reset();
    };
  }, [url, load]);

  const submit = async (): Promise<void> => {
    const problem = licenseLineProblem(text);
    setLocal(problem);
    if (problem !== undefined) return;
    if (await install(url, text)) setText('');
  };

  const chooseFile = async (): Promise<void> => {
    const result = await ipc().fs.openText({ filters: [{ name: 'Wirebench license', extensions: ['lic', 'txt'] }] });
    if (result.ok && result.value.text !== undefined) {
      setText(result.value.text.trim());
      setLocal(undefined);
    }
  };

  const shown = local ?? error;
  return (
    <div data-testid="license-tab" className="flex flex-col gap-3 text-sm">
      {state !== undefined && (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
          {state.serverId !== undefined && (
            <>
              <dt className="text-fg-subtle">Server id</dt>
              <dd className="flex items-center gap-2">
                <span data-testid="license-server-id" className="font-mono text-xs">
                  {state.serverId}
                </span>
                <Button
                  variant="ghost"
                  data-testid="license-copy-server-id"
                  aria-label="Copy server id"
                  onClick={() => void navigator.clipboard.writeText(state.serverId ?? '')}
                >
                  Copy
                </Button>
              </dd>
            </>
          )}
          <dt className="text-fg-subtle">Edition</dt>
          <dd data-testid="license-edition">{EDITION[state.edition]}</dd>
          <dt className="text-fg-subtle">Status</dt>
          <dd data-testid="license-status">{STATUS[state.status]}</dd>
          {state.customer !== undefined && (
            <>
              <dt className="text-fg-subtle">Customer</dt>
              <dd data-testid="license-customer">{state.customer}</dd>
            </>
          )}
          <dt className="text-fg-subtle">Seats</dt>
          <dd data-testid="license-seats">
            {state.seats.used} of {state.seats.limit ?? 'unlimited'} seats in use
          </dd>
          {state.expiresAt !== undefined && (
            <>
              <dt className="text-fg-subtle">Expires</dt>
              <dd data-testid="license-expires">{state.expiresAt.slice(0, 10)}</dd>
            </>
          )}
          {state.status === 'grace' && state.graceUntil !== undefined && (
            <>
              <dt className="text-fg-subtle">Works until</dt>
              <dd data-testid="license-grace-until">{state.graceUntil.slice(0, 10)}</dd>
            </>
          )}
          {state.message !== undefined && (
            <>
              <dt className="text-fg-subtle">Problem</dt>
              <dd data-testid="license-problem">{state.message}</dd>
            </>
          )}
        </dl>
      )}
      <textarea
        data-testid="license-input"
        aria-label="License"
        rows={3}
        spellCheck={false}
        className={`${INPUT_CLASS} font-mono text-xs`}
        placeholder="wbl1.…"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setLocal(undefined);
        }}
      />
      {shown !== undefined && (
        <p data-testid="license-error" role="alert" className="text-xs text-status-danger">
          {shown}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="primary" data-testid="license-install" disabled={busy} onClick={() => void submit()}>
          Install license
        </Button>
        <Button data-testid="license-choose-file" onClick={() => void chooseFile()}>
          Choose file…
        </Button>
        {state?.licenseId !== undefined && (
          <Button
            variant="ghost"
            data-testid="license-remove"
            disabled={busy}
            onClick={() => {
              setConfirmRemove(true);
            }}
          >
            Remove license…
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove the license?"
        description="The server goes back to the Community edition on the next request. Nobody is signed out and nothing is deleted."
        confirmLabel="Remove license"
        destructive
        testId="license-remove-confirm"
        confirmTestId="license-remove-confirm-button"
        onConfirm={() => {
          void remove(url);
        }}
      />
    </div>
  );
}
