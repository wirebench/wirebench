import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import type { IpcError } from '../../../shared/ipc.js';
import type { AccountWire, ServerMetaWire } from '../../../shared/wire-types.js';
import { signInErrorMessage } from '../../state/account.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore } from '../../state/ui.js';

/**
 * Restated from the engine's `MIN_PASSWORD_LENGTH`: the renderer must not import a value from
 * the engine's Node-only entry. `sign-in-dialog.test.tsx` keeps the copy honest.
 */
export const MIN_PASSWORD_LENGTH = 12;

type Step = 'server' | 'methods' | 'waiting' | 'code' | 'password';

const INPUT_CLASS =
  'mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';

/** Accepts a bare invitation code or a whole invitation link, and returns just the code. */
function extractInvitationSecret(input: string): string {
  return input.trim().replace(/^.*\/invite\//, '');
}

/**
 * *Sign in to a server…* (identity spec §3.8): the server's URL first, then whatever
 * `meta.auth` allows — a local form, a *Continue with <provider>* button, and behind *Have an
 * invitation code?* the accept flow. Every secret typed here lives in this component's state,
 * crosses the bridge once, and is cleared when the dialog closes.
 */
export function SignInDialog() {
  const open = useUiStore((state) => state.signInDialog.open);
  const initialUrl = useUiStore((state) => state.signInDialog.url);
  const setOpen = useUiStore((state) => state.setSignInDialogOpen);
  const [step, setStep] = useState<Step>('server');
  const [url, setUrl] = useState('');
  const [meta, setMeta] = useState<ServerMetaWire | undefined>(undefined);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [invitedEmail, setInvitedEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const clearSecrets = (): void => {
    setPassword('');
    setCode('');
    setNewPassword('');
    setConfirmPassword('');
  };

  useEffect(() => {
    if (open) {
      setStep('server');
      setUrl(initialUrl ?? '');
      setMeta(undefined);
      setEmail('');
      setInvitedEmail('');
      setDisplayName('');
      setError(undefined);
      setBusy(false);
      clearSecrets();
    } else {
      clearSecrets();
    }
    // `clearSecrets` is a plain closure over setters, which never change, so it is safe to
    // leave out of the dependency list below.
  }, [open, initialUrl]);

  const failed = (ipcError: IpcError): void => {
    setError(signInErrorMessage(ipcError));
  };

  const finished = (account: AccountWire): void => {
    clearSecrets();
    setOpen(false);
    showToast(`Signed in as ${account.email}`);
  };

  const probe = async (): Promise<void> => {
    if (busy || url.trim().length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.probe({ url });
    setBusy(false);
    if (!result.ok) {
      failed(result.error);
      return;
    }
    setUrl(result.value.url);
    setMeta(result.value.meta);
    setStep('methods');
  };

  const signInLocal = async (): Promise<void> => {
    if (busy || email.trim().length === 0 || password.length === 0) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.signInLocal({ url, email: email.trim(), password });
    setBusy(false);
    if (!result.ok) {
      failed(result.error);
      return;
    }
    finished(result.value.account);
  };

  const startOidc = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setStep('waiting');
    const result = await ipc().account.startOidc({ url });
    setBusy(false);
    if (!result.ok) {
      setStep('methods');
      failed(result.error);
      return;
    }
    finished(result.value.account);
  };

  const cancelOidc = (): void => {
    void ipc().account.cancelSignIn(undefined);
  };

  /** Escape while waiting for the browser cancels the sign-in instead of closing the dialog. */
  const onEscapeKeyDown = (): void => {
    if (step === 'waiting') {
      cancelOidc();
    }
  };

  const lookup = async (): Promise<void> => {
    if (busy || code.trim().length === 0) return;
    const secret = extractInvitationSecret(code);
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.lookupInvitation({ url, secret });
    setBusy(false);
    if (!result.ok) {
      failed(result.error);
      return;
    }
    setCode(secret);
    setInvitedEmail(result.value.email);
    setStep('password');
  };

  const passwordLongEnough = newPassword.length >= MIN_PASSWORD_LENGTH;
  const passwordsMatch = newPassword === confirmPassword;
  const canAccept = displayName.trim().length > 0 && passwordLongEnough && passwordsMatch && !busy;

  const accept = async (): Promise<void> => {
    if (!canAccept) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().account.acceptInvitation({
      url,
      secret: code.trim(),
      displayName: displayName.trim(),
      password: newPassword,
    });
    setBusy(false);
    if (!result.ok) {
      failed(result.error);
      return;
    }
    finished(result.value.account);
  };

  const onEnter = (action: () => void) => (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      action();
    }
  };

  const providerName = meta?.auth.oidcDisplayName ?? 'OIDC';

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="sign-in-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
          onEscapeKeyDown={onEscapeKeyDown}
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Sign in to a server</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            {step === 'server' ? (
              'The address of your team’s Wirebench Server.'
            ) : (
              <span data-testid="sign-in-server">{url}</span>
            )}
          </Dialog.Description>

          {step === 'server' && (
            <>
              <label className={LABEL_CLASS} htmlFor="sign-in-url">
                Server URL
              </label>
              <input
                id="sign-in-url"
                data-testid="sign-in-url"
                autoFocus
                placeholder="https://wirebench.example.com"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                onKeyDown={onEnter(() => void probe())}
                className={INPUT_CLASS}
              />
            </>
          )}

          {step === 'methods' && meta !== undefined && (
            <div data-testid="sign-in-methods">
              {meta.auth.local && (
                <>
                  <label className={LABEL_CLASS} htmlFor="sign-in-email">
                    Email
                  </label>
                  <input
                    id="sign-in-email"
                    data-testid="sign-in-email"
                    autoFocus
                    autoComplete="username"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    className={INPUT_CLASS}
                  />
                  <label className={LABEL_CLASS} htmlFor="sign-in-password">
                    Password
                  </label>
                  <input
                    id="sign-in-password"
                    data-testid="sign-in-password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    onKeyDown={onEnter(() => void signInLocal())}
                    className={INPUT_CLASS}
                  />
                  <div className="mt-3 flex justify-end">
                    <Button
                      variant="primary"
                      data-testid="sign-in-submit"
                      disabled={busy || email.trim().length === 0 || password.length === 0}
                      onClick={() => void signInLocal()}
                    >
                      {busy ? 'Signing in…' : 'Sign in'}
                    </Button>
                  </div>
                </>
              )}
              {meta.auth.oidc && (
                <div className={meta.auth.local ? 'mt-3 border-t border-hairline pt-3' : 'mt-3'}>
                  <Button
                    data-testid="sign-in-oidc"
                    disabled={busy}
                    onClick={() => void startOidc()}
                    className="w-full justify-center"
                  >
                    Continue with {providerName}
                  </Button>
                </div>
              )}
              <button
                type="button"
                data-testid="sign-in-have-code"
                className="mt-3 text-xs text-accent hover:underline"
                onClick={() => {
                  setError(undefined);
                  setStep('code');
                }}
              >
                Have an invitation code?
              </button>
            </div>
          )}

          {step === 'waiting' && (
            <div data-testid="sign-in-waiting" className="mt-3 text-sm text-fg-subtle">
              Waiting for the browser… Finish signing in with {providerName}, then come back here.
            </div>
          )}

          {step === 'code' && (
            <>
              <label className={LABEL_CLASS} htmlFor="sign-in-code">
                Invitation code
              </label>
              <input
                id="sign-in-code"
                data-testid="sign-in-code"
                autoFocus
                value={code}
                onChange={(event) => setCode(event.target.value)}
                onKeyDown={onEnter(() => void lookup())}
                className={`${INPUT_CLASS} font-mono`}
              />
              <p className="mt-1 text-xs text-fg-subtle">The code from the invitation link, or paste the whole link.</p>
            </>
          )}

          {step === 'password' && (
            <>
              <p data-testid="sign-in-invited-email" className="mt-3 text-sm text-fg-default">
                Creating the account for <span className="font-medium">{invitedEmail}</span>.
              </p>
              <label className={LABEL_CLASS} htmlFor="sign-in-display-name">
                Display name
              </label>
              <input
                id="sign-in-display-name"
                data-testid="sign-in-display-name"
                autoFocus
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className={INPUT_CLASS}
              />
              <label className={LABEL_CLASS} htmlFor="sign-in-new-password">
                Choose a password
              </label>
              <input
                id="sign-in-new-password"
                data-testid="sign-in-new-password"
                type="password"
                autoComplete="new-password"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                className={INPUT_CLASS}
              />
              <p
                data-testid="sign-in-password-hint"
                className={`mt-1 text-xs ${newPassword.length > 0 && !passwordLongEnough ? 'text-status-danger' : 'text-fg-subtle'}`}
              >
                At least {MIN_PASSWORD_LENGTH} characters.
              </p>
              <label className={LABEL_CLASS} htmlFor="sign-in-confirm-password">
                Confirm password
              </label>
              <input
                id="sign-in-confirm-password"
                data-testid="sign-in-confirm-password"
                type="password"
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                onKeyDown={onEnter(() => void accept())}
                className={INPUT_CLASS}
              />
              {confirmPassword.length > 0 && !passwordsMatch && (
                <p role="alert" className="mt-1 text-xs text-status-danger">
                  The passwords do not match.
                </p>
              )}
            </>
          )}

          {error !== undefined && (
            <p role="alert" data-testid="sign-in-error" className="mt-3 text-xs text-status-danger">
              {error}
            </p>
          )}

          <div className="mt-4 flex items-center justify-between">
            <div>
              {step !== 'server' && step !== 'waiting' && (
                <Button
                  variant="ghost"
                  data-testid="sign-in-back"
                  disabled={busy}
                  onClick={() => {
                    setError(undefined);
                    clearSecrets();
                    if (step === 'password') setStep('code');
                    else if (step === 'code') setStep('methods');
                    else setStep('server');
                  }}
                >
                  Back
                </Button>
              )}
            </div>
            <div className="flex gap-2">
              {step === 'waiting' ? (
                <Button data-testid="sign-in-cancel" onClick={cancelOidc}>
                  Cancel
                </Button>
              ) : (
                <Dialog.Close asChild>
                  <Button data-testid="sign-in-close">Close</Button>
                </Dialog.Close>
              )}
              {step === 'server' && (
                <Button
                  variant="primary"
                  data-testid="sign-in-continue"
                  disabled={busy || url.trim().length === 0}
                  onClick={() => void probe()}
                >
                  {busy ? 'Checking…' : 'Continue'}
                </Button>
              )}
              {step === 'code' && (
                <Button
                  variant="primary"
                  data-testid="sign-in-code-continue"
                  disabled={busy || code.trim().length === 0}
                  onClick={() => void lookup()}
                >
                  {busy ? 'Checking…' : 'Continue'}
                </Button>
              )}
              {step === 'password' && (
                <Button
                  variant="primary"
                  data-testid="sign-in-accept"
                  disabled={!canAccept}
                  onClick={() => void accept()}
                >
                  {busy ? 'Creating…' : 'Create account'}
                </Button>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
