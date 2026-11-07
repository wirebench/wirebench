/**
 * User settings → Password, the two-step sign-in section (two-step sign-in spec §5): the status, the authenticator,
 * the passkeys and the recovery codes. Every change but a rename asks for the current password first, typed here and
 * sent once with that change; new recovery codes are shown once and kept nowhere. Adding a passkey runs WebAuthn in the
 * browser client only; the desktop opens the browser client at this page for it.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AccountTotpSetupWire, AccountTwoFactorStatusWire } from '@shared/wire-base.js';
import { Button } from '../../../components/button.js';
import { SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { isBrowserTab } from '../../../lib/capabilities.js';
import { ipc } from '../../../state/ipc-client.js';
import { RecoveryCodes } from '../../account/two-factor/recovery-codes.js';
import { TotpKey } from '../../account/two-factor/second-step.js';
import { addPasskey, defaultPasskeyName } from './passkey-register.js';
import { USER_INPUT } from './profile-page.js';

export const PASSWORD_SIGN_IN_OFF = 'Two-step sign-in applies to password sign-in, which is off on this server.';
export const REQUIRED_REFUSAL = 'This server requires two-step sign-in.';
const LAST_METHOD = 'This is your last method: removing it turns two-step sign-in off and deletes your recovery codes.';

/** What the password prompt is about to do. */
type Pending =
  | { readonly kind: 'totp-setup' }
  | { readonly kind: 'totp-remove' }
  | { readonly kind: 'codes' }
  | { readonly kind: 'passkey-add' }
  | { readonly kind: 'passkey-remove'; readonly id: string; readonly name: string };

const PROMPTS: Readonly<Record<Pending['kind'], string>> = {
  'totp-setup': 'Set up an authenticator app',
  'totp-remove': 'Remove the authenticator app',
  codes: 'Make new recovery codes',
  'passkey-add': 'Add a passkey',
  'passkey-remove': 'Remove the passkey',
};

/** The browser client's address of this page, for the desktop's *Add a passkey* (spec §5.2). */
export const addPasskeyUrl = (server: string): string =>
  `${server.replace(/\/+$/, '')}/?panel=user&page=password&add=passkey`;

const date = (iso: string): string => new Date(iso).toLocaleDateString();

export function TwoFactorSection(props: { readonly url: string; readonly addPasskeyNow?: boolean }) {
  const { url } = props;
  const [status, setStatus] = useState<AccountTwoFactorStatusWire | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState<Pending | undefined>(
    props.addPasskeyNow === true && isBrowserTab() ? { kind: 'passkey-add' } : undefined,
  );
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<AccountTotpSetupWire | undefined>(undefined);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<readonly string[] | undefined>(undefined);
  const [renaming, setRenaming] = useState<{ readonly id: string; readonly name: string } | undefined>(undefined);

  const load = useCallback(async (): Promise<void> => {
    const result = await ipc().account.twoFactorStatus({ url });
    if (result.ok) setStatus(result.value);
    else setError(result.error.message);
  }, [url]);

  useEffect(() => {
    void load();
  }, [load]);

  const cancel = (): void => {
    setPending(undefined);
    setPassword('');
    setError(undefined);
  };

  /** Runs the pending change with the password just typed; the password is cleared whatever the answer. */
  const run = async (): Promise<void> => {
    if (pending === undefined || busy || password.length === 0) return;
    setBusy(true);
    setError(undefined);
    const typed = password;
    setPassword('');
    let failure: string | undefined;
    switch (pending.kind) {
      case 'totp-setup': {
        const result = await ipc().account.setUpTotp({ url, password: typed });
        if (result.ok) setSetup(result.value);
        else failure = result.error.message;
        break;
      }
      case 'totp-remove': {
        const result = await ipc().account.removeTotp({ url, password: typed });
        if (!result.ok) failure = result.error.message;
        break;
      }
      case 'codes': {
        const result = await ipc().account.regenerateRecoveryCodes({ url, password: typed });
        if (result.ok) setCodes(result.value.recoveryCodes);
        else failure = result.error.message;
        break;
      }
      case 'passkey-add': {
        const result = await addPasskey(url, typed, defaultPasskeyName());
        if (!result.ok) failure = result.message;
        else if (result.recoveryCodes !== undefined) setCodes(result.recoveryCodes);
        break;
      }
      case 'passkey-remove': {
        const result = await ipc().account.removePasskey({ url, id: pending.id, password: typed });
        if (!result.ok) failure = result.error.message;
        break;
      }
    }
    setBusy(false);
    setError(failure);
    if (failure === undefined) {
      setPending(undefined);
      // A setup's secret is pending until its first code: nothing about the status moved yet.
      if (pending.kind !== 'totp-setup') await load();
    }
  };

  const confirm = async (): Promise<void> => {
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    const result = await ipc().account.confirmTotp({ url, code: code.trim() });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setCode('');
    setSetup(undefined);
    setError(undefined);
    if (result.value.recoveryCodes !== undefined) setCodes(result.value.recoveryCodes);
    await load();
  };

  const rename = async (): Promise<void> => {
    if (renaming === undefined || renaming.name.trim().length === 0) return;
    const result = await ipc().account.renamePasskey({ url, id: renaming.id, name: renaming.name.trim() });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setRenaming(undefined);
    await load();
  };

  if (status === undefined)
    return (
      <SettingsGroup title="Two-step sign-in">
        <SettingsItem>
          <p className="text-sm text-fg-subtle">{error ?? 'Loading…'}</p>
        </SettingsItem>
      </SettingsGroup>
    );

  if (!status.available)
    return (
      <SettingsGroup title="Two-step sign-in">
        <SettingsItem>
          <p data-testid="two-factor-unavailable" className="text-sm text-fg-subtle">
            {PASSWORD_SIGN_IN_OFF}
          </p>
        </SettingsItem>
      </SettingsGroup>
    );

  if (codes !== undefined)
    return (
      <SettingsGroup title="Two-step sign-in">
        <SettingsItem>
          <RecoveryCodes codes={codes} server={url} onSaved={() => setCodes(undefined)} />
        </SettingsItem>
      </SettingsGroup>
    );

  /** Removing the one method left turns two-step sign-in off: refused while required, asked about otherwise. */
  const isLast = (status.totp !== null ? 1 : 0) + status.passkeys.length === 1;
  const removeLocked = isLast && status.required;
  const ask = (next: Pending): void => {
    setError(undefined);
    setPassword('');
    setPending(next);
  };

  return (
    <SettingsGroup
      title="Two-step sign-in"
      hint="A second step after your password: an authenticator app or a passkey."
    >
      <SettingsItem>
        <p data-testid="two-factor-status" className="text-sm text-fg-default">
          {status.enabled ? 'On' : 'Off'}
          {status.required && <span className="ml-2 text-xs text-fg-subtle">Required on this server</span>}
        </p>

        <div className="mt-4">
          <p className="text-sm font-medium text-fg-default">Authenticator app</p>
          {status.totp !== null ? (
            <div className="mt-1 flex items-center gap-3">
              <span data-testid="two-factor-totp-added" className="text-xs text-fg-subtle">
                Added {date(status.totp.addedAt)}
              </span>
              <Button
                data-testid="two-factor-totp-remove"
                disabled={busy || removeLocked}
                title={removeLocked ? REQUIRED_REFUSAL : undefined}
                onClick={() => ask({ kind: 'totp-remove' })}
              >
                Remove
              </Button>
            </div>
          ) : setup === undefined ? (
            <Button
              data-testid="two-factor-totp-setup"
              className="mt-2"
              disabled={busy}
              onClick={() => ask({ kind: 'totp-setup' })}
            >
              Set up
            </Button>
          ) : (
            <div data-testid="two-factor-totp-confirm">
              <TotpKey setup={setup} />
              <label className="mt-3 block text-sm text-fg-subtle" htmlFor="two-factor-totp-code">
                Enter the 6-digit code from your app.
              </label>
              <input
                id="two-factor-totp-code"
                data-testid="two-factor-totp-code"
                autoComplete="one-time-code"
                inputMode="numeric"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                className={`${USER_INPUT} mt-1 font-mono`}
              />
              <div className="mt-2 flex gap-2">
                <Button
                  variant="primary"
                  data-testid="two-factor-totp-verify"
                  disabled={busy || code.trim().length === 0}
                  onClick={() => void confirm()}
                >
                  Verify
                </Button>
                <Button
                  onClick={() => {
                    setSetup(undefined);
                    setCode('');
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-4">
          <p className="text-sm font-medium text-fg-default">Passkeys</p>
          <ul data-testid="two-factor-passkeys" className="mt-1">
            {status.passkeys.map((passkey) =>
              renaming?.id === passkey.id ? (
                <li key={passkey.id} className="flex items-center gap-3 py-1 text-sm">
                  <input
                    data-testid={`two-factor-passkey-name-${passkey.id}`}
                    value={renaming.name}
                    onChange={(event) => setRenaming({ id: passkey.id, name: event.target.value })}
                    className={`${USER_INPUT} w-48`}
                  />
                  <Button data-testid={`two-factor-passkey-save-${passkey.id}`} onClick={() => void rename()}>
                    Save
                  </Button>
                  <Button onClick={() => setRenaming(undefined)}>Cancel</Button>
                </li>
              ) : (
                <li key={passkey.id} className="flex items-center gap-3 py-1 text-sm">
                  <span className="text-fg-default">{passkey.name}</span>
                  <span className="text-xs text-fg-subtle">
                    Added {date(passkey.createdAt)}
                    {passkey.lastUsedAt !== null && ` · Last used ${date(passkey.lastUsedAt)}`}
                  </span>
                  <Button
                    data-testid={`two-factor-passkey-rename-${passkey.id}`}
                    onClick={() => setRenaming({ id: passkey.id, name: passkey.name })}
                  >
                    Rename
                  </Button>
                  <Button
                    data-testid={`two-factor-passkey-remove-${passkey.id}`}
                    disabled={busy || removeLocked}
                    title={removeLocked ? REQUIRED_REFUSAL : undefined}
                    onClick={() => ask({ kind: 'passkey-remove', id: passkey.id, name: passkey.name })}
                  >
                    Remove
                  </Button>
                </li>
              ),
            )}
          </ul>
          {isBrowserTab() ? (
            <Button
              data-testid="two-factor-passkey-add"
              className="mt-2"
              disabled={busy}
              onClick={() => ask({ kind: 'passkey-add' })}
            >
              Add a passkey
            </Button>
          ) : (
            <Button
              data-testid="two-factor-passkey-add-browser"
              className="mt-2"
              onClick={() => window.open(addPasskeyUrl(url), '_blank', 'noopener')}
            >
              Add a passkey in your browser
            </Button>
          )}
        </div>

        {status.enabled && (
          <div className="mt-4">
            <p className="text-sm font-medium text-fg-default">Recovery codes</p>
            <div className="mt-1 flex items-center gap-3">
              <span data-testid="two-factor-codes-left" className="text-xs text-fg-subtle">
                {status.recoveryCodesLeft} of 10 left
              </span>
              <Button data-testid="two-factor-codes-new" disabled={busy} onClick={() => ask({ kind: 'codes' })}>
                Make new codes
              </Button>
            </div>
            {status.recoveryCodesLeft === 0 && (
              <p className="mt-1 text-xs text-status-danger">You have no recovery codes left. Make a new set.</p>
            )}
          </div>
        )}

        {pending !== undefined && (
          <div data-testid="two-factor-prompt" className="mt-4 rounded border border-hairline p-3">
            <p className="text-sm text-fg-default">
              {PROMPTS[pending.kind]}
              {pending.kind === 'passkey-remove' && ` “${pending.name}”`}
            </p>
            {(pending.kind === 'totp-remove' || pending.kind === 'passkey-remove') && isLast && (
              <p data-testid="two-factor-last-method" className="mt-1 text-xs text-fg-subtle">
                {LAST_METHOD}
              </p>
            )}
            <label className="mt-2 block text-sm text-fg-subtle" htmlFor="two-factor-password">
              Your current password
            </label>
            <input
              id="two-factor-password"
              data-testid="two-factor-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void run();
                }
              }}
              className={`${USER_INPUT} mt-1`}
            />
            <div className="mt-2 flex gap-2">
              <Button
                variant="primary"
                data-testid="two-factor-prompt-confirm"
                disabled={busy || password.length === 0}
                onClick={() => void run()}
              >
                Continue
              </Button>
              <Button data-testid="two-factor-prompt-cancel" onClick={cancel}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {error !== undefined && (
          <p role="alert" data-testid="two-factor-error" className="mt-3 text-sm text-status-danger">
            {error}
          </p>
        )}
      </SettingsItem>
    </SettingsGroup>
  );
}
