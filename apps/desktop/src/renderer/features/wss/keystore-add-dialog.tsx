/**
 * The "Add keystore" dialog: pick a file, name it, and optionally store its password.
 *
 * Split out of `keystores-view.tsx` so the list and the add flow can be read (and tested) apart
 * from each other. The renderer still never holds key material: the path comes back from
 * `keystores.pickFile` in main, and the password goes straight into the secret store through
 * {@link SecretField}, so only a `secretRef` ever reaches the project file.
 */

import { useCallback, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { SecretField } from '../../components/secret-field.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';

export interface KeystoreAddDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

/** The file name without its extension — the name a keystore gets unless the user types one. */
function stemOf(path: string): string {
  const file = path.split(/[\\/]/).pop() ?? '';
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
}

/** The Add dialog. Rendered by {@link KeystoresView}; it owns nothing but its own draft. */
export function KeystoreAddDialog({ open, onOpenChange }: KeystoreAddDialogProps) {
  const addKeystore = useProjectStore((state) => state.addKeystore);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [passwordRef, setPasswordRef] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const flushRef = useRef<(() => Promise<string | undefined>) | undefined>(undefined);
  const registerFlush = useCallback((flush: (() => Promise<string | undefined>) | undefined) => {
    flushRef.current = flush;
  }, []);

  function reset(): void {
    setPath('');
    setName('');
    setPasswordRef(undefined);
    setBusy(false);
  }

  async function pick(): Promise<void> {
    const result = await ipc().keystores.pickFile({});
    if (!result.ok || result.value.path === undefined) {
      return;
    }
    setPath(result.value.path);
    if (name.trim().length === 0) {
      setName(stemOf(result.value.path));
    }
  }

  async function submit(): Promise<void> {
    setBusy(true);
    try {
      // A password typed but never explicitly saved must not be dropped on the floor, so the
      // SecretField is flushed first and its fresh ref used (see `auth-inspector.tsx`).
      const ref = (await flushRef.current?.()) ?? passwordRef;
      await addKeystore({
        path,
        ...(name.trim().length > 0 ? { name: name.trim() } : {}),
        ...(ref !== undefined ? { passwordSecretRef: ref } : {}),
      });
      reset();
      onOpenChange(false);
    } catch (error) {
      setBusy(false);
      showToast(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          reset();
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="keystore-add-dialog"
          className="fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Add keystore</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            A PKCS#12 (.p12/.pfx) or PEM bundle (.pem/.crt/.cer/.key). The password is stored in the OS keychain, never
            in the project.
          </Dialog.Description>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="keystore-path">
            File
          </label>
          <div className="mt-1 flex items-center gap-2">
            <input
              id="keystore-path"
              data-testid="keystore-path"
              readOnly
              value={path}
              placeholder="Choose a keystore file"
              className="min-w-0 flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none"
            />
            <Button data-testid="keystore-browse" onClick={() => void pick()}>
              Browse…
            </Button>
          </div>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="keystore-name">
            Name
          </label>
          <input
            id="keystore-name"
            data-testid="keystore-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none"
          />

          <p className="mt-3 text-sm text-fg-subtle">Password</p>
          <div className="mt-1">
            <SecretField
              label="Keystore password"
              value={passwordRef}
              onChange={setPasswordRef}
              registerFlush={registerFlush}
            />
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              data-testid="keystore-add-submit"
              disabled={path.length === 0 || busy}
              onClick={() => void submit()}
            >
              Add
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
