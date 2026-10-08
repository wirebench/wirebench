import { useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { confirmTrust } from './connect.js';
import { useHostsStore } from './hosts-store.js';

/**
 * The trust-on-first-use prompt. A first-seen key is one click; a changed key shows both fingerprints and
 * needs a second, separate confirmation (the checkbox) before it replaces the stored one.
 */
export function TrustDialog() {
  const prompt = useHostsStore((s) => s.trustPrompt);
  // Keyed so a replacement prompt starts with the checkbox unticked.
  return <TrustDialogBody key={prompt === null ? 'none' : `${prompt.hostId}:${prompt.fingerprint}`} />;
}

function TrustDialogBody() {
  const [understood, setUnderstood] = useState(false);
  const prompt = useHostsStore((s) => s.trustPrompt);
  const cancelTrust = useHostsStore((s) => s.cancelTrust);
  const changed = prompt?.previous !== undefined;
  return (
    <AlertDialog.Root
      open={prompt !== null}
      onOpenChange={(open) => {
        // Trust clears the prompt before this runs, so a prompt still here was dismissed.
        if (!open) {
          cancelTrust();
          setUnderstood(false);
        }
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content
          data-testid="trust-dialog"
          className="fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <AlertDialog.Title className="text-md font-medium text-fg-default">
            {changed ? 'Host key changed' : 'Trust this host?'}
          </AlertDialog.Title>
          {prompt && (
            <AlertDialog.Description asChild>
              <div className="mt-1 flex flex-col gap-2 text-sm text-fg-subtle">
                <p>
                  {changed
                    ? `The key of ${prompt.host} has changed since you last connected. This can mean the host was reinstalled, or that something is intercepting the connection.`
                    : `${prompt.host} has not been seen before. Check the fingerprint with the host's owner before you trust it.`}
                </p>
                <div>
                  <div className="text-xs">{`${prompt.keyType}${changed ? ' (new)' : ''}`}</div>
                  <code className="font-mono text-xs break-all text-fg-default">{prompt.fingerprint}</code>
                </div>
                {prompt.previous !== undefined && (
                  <div>
                    <div className="text-xs">Previously trusted</div>
                    <code className="font-mono text-xs break-all text-fg-default">{prompt.previous}</code>
                  </div>
                )}
                {changed && (
                  <label className="flex items-center gap-2 text-fg-default">
                    <input
                      type="checkbox"
                      checked={understood}
                      onChange={(e) => {
                        setUnderstood(e.target.checked);
                      }}
                    />
                    I understand the key changed
                  </label>
                )}
              </div>
            </AlertDialog.Description>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" className="rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base">
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                disabled={changed && !understood}
                className="rounded bg-accent px-3 py-1.5 text-sm text-fg-on-accent disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => {
                  setUnderstood(false);
                  void confirmTrust(changed);
                }}
              >
                {changed ? 'Replace key and connect' : 'Trust and connect'}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
