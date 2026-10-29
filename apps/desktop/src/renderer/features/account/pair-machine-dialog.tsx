import { useEffect, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore } from '../../state/ui.js';
import { PAIRED_BROWSER_TRUST_TEXT } from '../preferences/sections/paired-browsers-section.js';

const INPUT_CLASS =
  'mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';

/** What a successful pairing says: who this machine now sends for, and for which server. */
export function pairedText(email: string, origin: string): string {
  return `Paired as ${email} with ${origin}`;
}

/**
 * *Pair this machine…* (hosted edition spec §18.2), desktop only: the server's address and the code its
 * Settings → This machine shows. The code crosses the bridge once and is cleared when the dialog closes.
 */
export function PairMachineDialog() {
  const open = useUiStore((state) => state.pairMachineDialogOpen);
  const setOpen = useUiStore((state) => state.setPairMachineDialogOpen);
  const [serverUrl, setServerUrl] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCode('');
    setError(undefined);
    setBusy(false);
  }, [open]);

  const submit = async (): Promise<void> => {
    if (busy || serverUrl.trim().length === 0 || code.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().machineAgent.pair({ serverUrl: serverUrl.trim(), code: code.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCode('');
    setOpen(false);
    showToast(pairedText(result.value.email, result.value.origin));
  };

  const onEnter = (event: KeyboardEvent): void => {
    if (event.key === 'Enter') void submit();
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="pair-machine-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Pair this machine</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            In the server’s browser tab, open Settings → This machine and choose Pair this machine to get a code.{' '}
            {PAIRED_BROWSER_TRUST_TEXT}
          </Dialog.Description>
          <label className={LABEL_CLASS} htmlFor="pair-machine-url">
            Server URL
          </label>
          <input
            id="pair-machine-url"
            data-testid="pair-machine-url"
            autoFocus
            placeholder="https://wirebench.example.com"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
            onKeyDown={onEnter}
            className={INPUT_CLASS}
          />
          <label className={LABEL_CLASS} htmlFor="pair-machine-code">
            Pairing code
          </label>
          <input
            id="pair-machine-code"
            data-testid="pair-machine-code"
            autoComplete="off"
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={onEnter}
            className={`${INPUT_CLASS} font-mono tracking-widest`}
          />
          {error !== undefined && (
            <p role="alert" data-testid="pair-machine-error" className="mt-3 text-sm text-status-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="pair-machine-submit"
              disabled={busy || serverUrl.trim().length === 0 || code.trim().length === 0}
              onClick={() => void submit()}
            >
              Pair
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
