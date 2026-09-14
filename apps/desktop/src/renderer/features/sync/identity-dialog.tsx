import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { useSyncStore } from '../../state/sync.js';

/**
 * Blocks on `git.identityNeeded`: git needs `user.name`/`user.email` before it can commit.
 * There is nothing to cancel to — closing it without setting an identity leaves sync unable to
 * commit — so it has no Cancel action and ignores an Escape/overlay dismissal (the identity
 * requirement only clears itself once {@link useSyncStore.setIdentity} succeeds).
 */
export function IdentityDialog() {
  const identityNeeded = useSyncStore((state) => state.identityNeeded);
  const setIdentity = useSyncStore((state) => state.setIdentity);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const canSubmit = trimmedName.length > 0 && trimmedEmail.length > 0 && !busy;

  const submit = async (): Promise<void> => {
    if (!canSubmit) {
      return;
    }
    setBusy(true);
    await setIdentity(trimmedName, trimmedEmail);
    setBusy(false);
  };

  return (
    <Dialog.Root open={identityNeeded} onOpenChange={() => undefined}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="sync-identity-dialog"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            event.preventDefault();
          }}
          className="fixed top-1/2 left-1/2 w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Set up your identity</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            Commits made from this machine are signed with this name and email.
          </Dialog.Description>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="sync-identity-name">
            Name
          </label>
          <input
            id="sync-identity-name"
            data-testid="sync-identity-name"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
          />

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="sync-identity-email">
            Email
          </label>
          <input
            id="sync-identity-email"
            data-testid="sync-identity-email"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
          />

          <div className="mt-4 flex justify-end">
            <Button
              data-testid="sync-identity-submit"
              variant="primary"
              disabled={!canSubmit}
              onClick={() => {
                void submit();
              }}
            >
              Continue
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
