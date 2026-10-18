import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { TerminalSharePreviewResponse } from '@shared/terminal-share-wire.js';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { closeJoinShare, joinShare, openJoinShare, useTerminalShareStore } from './terminal-share-store.js';

/**
 * Join shared terminal… (#429): paste the invite link a teammate copied, see whose terminal it is, and open
 * it in a tab. The account signed in to the link's server joins; a link for a server without one is refused.
 */
export function JoinShareDialog() {
  const open = useTerminalShareStore((s) => s.joinOpen);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) openJoinShare();
        else closeJoinShare();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        {open && <JoinShareBody />}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function JoinShareBody() {
  const [link, setLink] = useState('');
  const [preview, setPreview] = useState<TerminalSharePreviewResponse | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const look = async (text: string): Promise<void> => {
    setPreview(undefined);
    setError(undefined);
    if (text.trim().length === 0) return;
    const result = await ipc().terminalShare.preview({ link: text.trim() });
    if (result.ok) setPreview(result.value);
    else setError(result.error.message);
  };

  const join = async (): Promise<void> => {
    setBusy(true);
    const result = await joinShare(link.trim());
    setBusy(false);
    if (result.ok) closeJoinShare();
    else setError(result.message);
  };

  return (
    <Dialog.Content
      data-testid="join-share-dialog"
      className="fixed top-1/2 left-1/2 flex w-[32rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-md bg-surface-raised p-4 shadow-lg"
    >
      <Dialog.Title className="text-base font-medium text-fg-default">Join shared terminal</Dialog.Title>
      <Dialog.Description className="text-sm text-fg-muted">
        Paste the invite link a teammate copied from their terminal.
      </Dialog.Description>
      <input
        aria-label="Invite link"
        className="h-8 rounded border border-hairline bg-surface-sunken px-2 text-sm text-fg-default"
        placeholder="wirebench://terminal-share/…"
        value={link}
        onChange={(event) => {
          setLink(event.target.value);
          void look(event.target.value);
        }}
      />
      {preview !== undefined && (
        <p className="text-sm text-fg-default" data-testid="join-share-preview">
          {preview.ownerName}’s terminal on {preview.hostName} · {preview.viewers} watching
        </p>
      )}
      {error !== undefined && (
        <p className="text-sm text-status-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            closeJoinShare();
          }}
        >
          Cancel
        </Button>
        <Button
          disabled={preview === undefined || busy}
          onClick={() => {
            void join();
          }}
        >
          Join
        </Button>
      </div>
    </Dialog.Content>
  );
}
