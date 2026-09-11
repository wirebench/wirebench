/**
 * The prompts behind "Add WSS Username Token…" and "Add WS-Timestamp…". Both write the entry
 * into the envelope *text* through `wss-actions.ts`; neither touches the request's outgoing
 * configuration.
 *
 * The password typed here goes straight into the secret store via {@link SecretField}: this
 * component only ever holds the resulting `secretRef`, and the header that comes back has the
 * password masked (see `main/ipc/wss.ts`).
 */

import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { SecretField } from '../../components/secret-field.js';
import { insertWssEntry } from './wss-actions.js';

const FIELD = 'mt-1 h-row w-full rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default';

export interface WssEntryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly requestId: string;
}

/** Asks for a username, a password and a password type, then inserts the token. */
export function WssUsernameTokenDialog({ open, onOpenChange, requestId }: WssEntryDialogProps) {
  const [username, setUsername] = useState('');
  const [passwordType, setPasswordType] = useState<'text' | 'digest' | 'none'>('digest');
  const [passwordRef, setPasswordRef] = useState<string | undefined>(undefined);
  // A password typed but never explicitly saved is stored on submit rather than dropped.
  const flushPassword = useRef<(() => Promise<string | undefined>) | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setUsername('');
      setPasswordType('digest');
      setPasswordRef(undefined);
    }
  }, [open]);

  const submit = (): void => {
    onOpenChange(false);
    void (async () => {
      const ref = (await flushPassword.current?.()) ?? passwordRef;
      await insertWssEntry(
        requestId,
        { kind: 'username-token', username, passwordType, addNonce: true, addCreated: true },
        ref,
      );
    })();
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="wss-username-token-dialog"
          className="fixed top-1/2 left-1/2 w-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Add WSS Username Token</Dialog.Title>
          <label className="mt-3 block text-sm text-fg-muted" htmlFor="wss-username">
            Username
          </label>
          <input
            id="wss-username"
            aria-label="WSS username"
            autoFocus
            className={FIELD}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit();
              }
            }}
          />
          <p className="mt-3 text-sm text-fg-muted">Password</p>
          <div className="mt-1">
            <SecretField
              label="WS-Security password"
              value={passwordRef}
              onChange={setPasswordRef}
              registerFlush={(flush) => {
                flushPassword.current = flush;
              }}
            />
          </div>
          <label className="mt-3 block text-sm text-fg-muted" htmlFor="wss-password-type">
            Password type
          </label>
          <select
            id="wss-password-type"
            aria-label="WSS password type"
            className={FIELD}
            value={passwordType}
            onChange={(event) => {
              setPasswordType(event.target.value as 'text' | 'digest' | 'none');
            }}
          >
            <option value="digest">Digest</option>
            <option value="text">Text</option>
            <option value="none">None</option>
          </select>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button variant="primary" data-testid="wss-username-token-submit" onClick={submit}>
              Add
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Asks for the time-to-live, then inserts the timestamp. */
export function WsTimestampDialog({ open, onOpenChange, requestId }: WssEntryDialogProps) {
  const [ttl, setTtl] = useState('300');
  const [milliseconds, setMilliseconds] = useState(false);

  useEffect(() => {
    if (open) {
      setTtl('300');
      setMilliseconds(false);
    }
  }, [open]);

  const submit = (): void => {
    onOpenChange(false);
    void insertWssEntry(requestId, {
      kind: 'timestamp',
      timeToLiveSeconds: Math.max(0, Number(ttl) || 0),
      millisecondPrecision: milliseconds,
    });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="wss-timestamp-dialog"
          className="fixed top-1/2 left-1/2 w-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Add WS-Timestamp</Dialog.Title>
          <label className="mt-3 block text-sm text-fg-muted" htmlFor="wss-ttl">
            Time to live (seconds)
          </label>
          <input
            id="wss-ttl"
            aria-label="Time to live (seconds)"
            type="number"
            min={0}
            autoFocus
            className={FIELD}
            value={ttl}
            onChange={(event) => {
              setTtl(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit();
              }
            }}
          />
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={milliseconds}
              onChange={(event) => {
                setMilliseconds(event.target.checked);
              }}
            />
            Millisecond precision
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button variant="primary" data-testid="wss-timestamp-submit" onClick={submit}>
              Add
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
