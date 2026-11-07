import { useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import type { IpcError } from '@shared/ipc.js';
import type { AccountWire, AccountTotpSetupWire, TwoFactorMethodWire } from '@shared/wire-base.js';
import { signInErrorMessage } from '../../../state/account.js';
import { ipc } from '../../../state/ipc-client.js';
import { RecoveryCodes } from './recovery-codes.js';

const INPUT_CLASS =
  'mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';

/** Refusals after which this sign-in cannot go on: back to the password, saying why. */
const ended = (code: string): boolean =>
  code === 'account-two-factor-expired' || code === 'identity-two-factor-expired' || code === 'identity-user-disabled';

export interface SecondStepProps {
  readonly methods: readonly TwoFactorMethodWire[];
  readonly onSignedIn: (account: AccountWire) => void;
  /** The sign-in ended (expired, used up): back to the password with `message`. */
  readonly onEnded: (message: string) => void;
}

/**
 * The sign-in dialog's second step (two-step sign-in spec §4.2): an authenticator code typed here, a recovery code
 * instead, or a passkey in the system browser, which the dialog waits on as it does for OIDC. The challenge stays in
 * main; this sends only what the person types.
 */
export function SecondStep(props: SecondStepProps) {
  const hasTotp = props.methods.includes('totp');
  const hasRecovery = props.methods.includes('recovery');
  const [mode, setMode] = useState<'totp' | 'recovery'>(hasTotp ? 'totp' : 'recovery');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const refused = (failure: IpcError): void => {
    if (ended(failure.code)) props.onEnded(signInErrorMessage(failure));
    else setError(signInErrorMessage(failure));
  };

  const verify = async (): Promise<void> => {
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.verifyTwoFactor({ method: mode, code: code.trim() });
    setBusy(false);
    if (result.ok) {
      setCode('');
      props.onSignedIn(result.value.account);
      return;
    }
    refused(result.error);
  };

  const passkey = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setWaiting(true);
    setError(undefined);
    const result = await ipc().account.startTwoFactorPasskey(undefined);
    setBusy(false);
    setWaiting(false);
    if (result.ok) {
      props.onSignedIn(result.value.account);
      return;
    }
    // Cancelling is the person's own choice: no message for it.
    if (result.error.code !== 'account-sign-in-cancelled') refused(result.error);
  };

  if (waiting)
    return (
      <div data-testid="two-factor-waiting" className="mt-3 text-sm text-fg-subtle">
        Finish in your browser… Use your passkey there, then come back here.
        <div className="mt-3 flex justify-end">
          <Button data-testid="two-factor-cancel-passkey" onClick={() => void ipc().account.cancelSignIn(undefined)}>
            Cancel
          </Button>
        </div>
      </div>
    );

  return (
    <div data-testid="two-factor-step">
      <p className="mt-3 text-sm text-fg-default">Two-step sign-in</p>
      {props.methods.includes('passkey') && (
        <Button
          data-testid="two-factor-passkey"
          disabled={busy}
          onClick={() => void passkey()}
          className="mt-3 w-full justify-center"
        >
          Use a passkey
        </Button>
      )}
      {(hasTotp || hasRecovery) && (
        <>
          <label className={LABEL_CLASS} htmlFor="two-factor-code">
            {mode === 'totp' ? 'Enter the 6-digit code from your authenticator app.' : 'Recovery code'}
          </label>
          <input
            id="two-factor-code"
            data-testid="two-factor-code"
            autoFocus
            autoComplete={mode === 'totp' ? 'one-time-code' : 'off'}
            inputMode={mode === 'totp' ? 'numeric' : 'text'}
            spellCheck={false}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void verify();
              }
            }}
            className={`${INPUT_CLASS} font-mono`}
          />
          <div className="mt-2 flex items-center justify-between">
            {hasTotp && hasRecovery ? (
              <button
                type="button"
                data-testid="two-factor-switch"
                className="text-xs text-accent hover:underline"
                onClick={() => {
                  setMode(mode === 'totp' ? 'recovery' : 'totp');
                  setCode('');
                  setError(undefined);
                }}
              >
                {mode === 'totp' ? 'Use a recovery code instead' : 'Use your authenticator app instead'}
              </button>
            ) : (
              <span />
            )}
            <Button
              variant="primary"
              data-testid="two-factor-verify"
              disabled={busy || code.trim().length === 0}
              onClick={() => void verify()}
            >
              {busy ? 'Checking…' : 'Verify'}
            </Button>
          </div>
        </>
      )}
      {error !== undefined && (
        <p role="alert" data-testid="two-factor-error" className="mt-3 text-xs text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** The key as the setup shows it: groups of four, for typing by hand. */
export const groupedKey = (secret: string): string => secret.replace(/(.{4})(?=.)/g, '$1 ');

export interface SetupStepProps {
  readonly server: string;
  readonly onSignedIn: (account: AccountWire) => void;
  readonly onEnded: (message: string) => void;
}

/**
 * The required setup at sign-in (two-step sign-in spec §4.3, plan ruling 5): the server requires two-step sign-in
 * and the person has no method, so they set up an authenticator here, then see their recovery codes; *I've saved
 * them* finishes the sign-in. A passkey can be added afterwards, from the browser.
 */
export function SetupStep(props: SetupStepProps) {
  const [setup, setSetup] = useState<AccountTotpSetupWire | undefined>(undefined);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<{ account: AccountWire; recoveryCodes: string[] } | undefined>(undefined);
  const { onEnded } = props;

  useEffect(() => {
    let live = true;
    void ipc()
      .account.twoFactorSetupStart(undefined)
      .then((result) => {
        if (!live) return;
        if (result.ok) setSetup(result.value);
        else onEnded(signInErrorMessage(result.error));
      });
    return () => {
      live = false;
    };
  }, [onEnded]);

  const confirm = async (): Promise<void> => {
    if (busy || code.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.twoFactorSetupConfirm({ code: code.trim() });
    setBusy(false);
    if (result.ok) {
      setCode('');
      setDone(result.value);
      return;
    }
    if (ended(result.error.code)) onEnded(signInErrorMessage(result.error));
    else setError(signInErrorMessage(result.error));
  };

  if (done !== undefined)
    return (
      <RecoveryCodes codes={done.recoveryCodes} server={props.server} onSaved={() => props.onSignedIn(done.account)} />
    );

  return (
    <div data-testid="two-factor-setup">
      <p className="mt-3 text-sm text-fg-default">Set up two-step sign-in</p>
      <p className="mt-1 text-xs text-fg-subtle">
        This server requires a second step after your password. Scan the code with an authenticator app.
      </p>
      {setup === undefined ? <p className="mt-3 text-xs text-fg-subtle">Preparing…</p> : <TotpKey setup={setup} />}
      <label className={LABEL_CLASS} htmlFor="two-factor-setup-code">
        Enter the 6-digit code from your app.
      </label>
      <input
        id="two-factor-setup-code"
        data-testid="two-factor-setup-code"
        autoComplete="one-time-code"
        inputMode="numeric"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            void confirm();
          }
        }}
        className={`${INPUT_CLASS} font-mono`}
      />
      {error !== undefined && (
        <p role="alert" data-testid="two-factor-setup-error" className="mt-3 text-xs text-status-danger">
          {error}
        </p>
      )}
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          data-testid="two-factor-setup-verify"
          disabled={busy || setup === undefined || code.trim().length === 0}
          onClick={() => void confirm()}
        >
          {busy ? 'Checking…' : 'Verify'}
        </Button>
      </div>
    </div>
  );
}

/** The QR code (an SVG through a `data:` URL, which the CSP allows) and the key as text, with *Copy*. */
export function TotpKey(props: { readonly setup: AccountTotpSetupWire }) {
  const copy = (): void => {
    void navigator.clipboard.writeText(props.setup.secret).then(
      () => showToast('Key copied'),
      () => showToast('Could not copy the key'),
    );
  };
  return (
    <div className="mt-3 flex items-center gap-4">
      <img
        data-testid="two-factor-qr"
        alt="QR code for your authenticator app"
        src={`data:image/svg+xml;utf8,${encodeURIComponent(props.setup.qrSvg)}`}
        className="h-36 w-36 rounded bg-white p-1"
      />
      <div className="min-w-0">
        <p className="text-xs text-fg-subtle">Or type this key:</p>
        <p data-testid="two-factor-key" className="mt-1 font-mono text-sm break-all text-fg-default">
          {groupedKey(props.setup.secret)}
        </p>
        <Button data-testid="two-factor-key-copy" onClick={copy} className="mt-2">
          Copy
        </Button>
      </div>
    </div>
  );
}
