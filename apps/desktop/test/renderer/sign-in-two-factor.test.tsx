import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignInDialog } from '../../src/renderer/features/account/sign-in-dialog.js';
import { groupedKey } from '../../src/renderer/features/account/two-factor/second-step.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const META = {
  name: 'wirebench-server',
  version: '1',
  apiVersion: 1,
  publicUrl: 'https://wb.test',
  auth: { local: true, oidc: false },
  capabilities: [],
};
const ACCOUNT = {
  url: 'https://wb.test',
  userId: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  deviceName: 'Mac',
  signedOut: false,
  addedAt: '2026-11-07T12:00:00.000Z',
};
const CODES = Array.from({ length: 10 }, (_, i) => `aaaa${String(i)}-bbbbb`);
const SETUP = {
  uri: 'otpauth://totp/x',
  qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
  secret: 'ABCDEFGHIJKLMNOP',
};
const ok = (value: unknown) => ({ ok: true, value });
const fail = (code: string, message = code) => ({ ok: false, error: { code, message } });

/** Opens the dialog, reaches the methods, and types a password; `account` stubs the channels. */
async function passwordStep(account: Record<string, unknown>): Promise<void> {
  installWirebenchApi({
    account: {
      probe: vi.fn().mockResolvedValue(ok({ url: 'https://wb.test', meta: META })),
      cancelTwoFactor: vi.fn().mockResolvedValue(ok({ done: true })),
      ...account,
    },
  });
  render(<SignInDialog />);
  act(() => {
    useUiStore.getState().openSignInDialog();
  });
  await screen.findByTestId('sign-in-dialog');
  await userEvent.type(screen.getByTestId('sign-in-url'), 'https://wb.test');
  await userEvent.click(screen.getByTestId('sign-in-continue'));
  await screen.findByTestId('sign-in-methods');
  await userEvent.type(screen.getByTestId('sign-in-email'), 'alice@example.com');
  await userEvent.type(screen.getByTestId('sign-in-password'), 'correct horse battery');
  await userEvent.click(screen.getByTestId('sign-in-submit'));
}

const step = (methods: string[], setup = false) => vi.fn().mockResolvedValue(ok({ twoFactor: { methods, setup } }));

describe('the sign-in dialog’s second step (two-step sign-in spec §4.2, §4.3)', () => {
  beforeEach(() => {
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({ signInDialog: { open: false, url: undefined } });
    showToast.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it('asks for the authenticator code after the password, and signs in with it', async () => {
    const verifyTwoFactor = vi.fn().mockResolvedValue(ok({ account: ACCOUNT }));
    await passwordStep({ signInLocal: step(['totp', 'recovery']), verifyTwoFactor });
    await screen.findByTestId('two-factor-step');
    expect(screen.queryByTestId('two-factor-passkey')).toBeNull();
    await userEvent.type(screen.getByTestId('two-factor-code'), '123456');
    await userEvent.click(screen.getByTestId('two-factor-verify'));
    expect(verifyTwoFactor).toHaveBeenCalledWith({ method: 'totp', code: '123456' });
    await waitFor(() => expect(screen.queryByTestId('sign-in-dialog')).toBeNull());
    expect(showToast).toHaveBeenCalledWith('Signed in as alice@example.com');
  });

  it('a wrong code keeps the field and shows the message; a recovery code is the other way in', async () => {
    const verifyTwoFactor = vi
      .fn()
      .mockResolvedValueOnce(fail('identity-two-factor-invalid', 'That code did not work. Check it and try again.'))
      .mockResolvedValueOnce(ok({ account: ACCOUNT }));
    await passwordStep({ signInLocal: step(['totp', 'recovery']), verifyTwoFactor });
    await screen.findByTestId('two-factor-step');
    await userEvent.type(screen.getByTestId('two-factor-code'), '000000');
    await userEvent.click(screen.getByTestId('two-factor-verify'));
    expect((await screen.findByTestId('two-factor-error')).textContent).toBe(
      'That code did not work. Check it and try again.',
    );
    expect(screen.getByTestId<HTMLInputElement>('two-factor-code').value).toBe('000000');
    await userEvent.click(screen.getByTestId('two-factor-switch'));
    expect(screen.getByText('Recovery code')).toBeTruthy();
    await userEvent.type(screen.getByTestId('two-factor-code'), 'abcde-fghij');
    await userEvent.click(screen.getByTestId('two-factor-verify'));
    expect(verifyTwoFactor).toHaveBeenLastCalledWith({ method: 'recovery', code: 'abcde-fghij' });
  });

  it('an ended challenge goes back to the password with its message', async () => {
    await passwordStep({
      signInLocal: step(['totp']),
      verifyTwoFactor: vi.fn().mockResolvedValue(fail('identity-two-factor-expired', 'This sign-in has expired.')),
    });
    await screen.findByTestId('two-factor-step');
    await userEvent.type(screen.getByTestId('two-factor-code'), '123456');
    await userEvent.click(screen.getByTestId('two-factor-verify'));
    await screen.findByTestId('sign-in-methods');
    expect(screen.getByTestId('sign-in-error').textContent).toBe('This sign-in has expired.');
  });

  it('a passkey waits for the browser, and Cancel ends it without a message', async () => {
    let settle: (value: unknown) => void = () => undefined;
    const startTwoFactorPasskey = vi.fn(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    const cancelSignIn = vi.fn(() => {
      settle(fail('account-sign-in-cancelled'));
      return Promise.resolve(ok({ cancelled: true }));
    });
    await passwordStep({ signInLocal: step(['passkey', 'recovery']), startTwoFactorPasskey, cancelSignIn });
    await userEvent.click(await screen.findByTestId('two-factor-passkey'));
    expect((await screen.findByTestId('two-factor-waiting')).textContent).toContain('Finish in your browser');
    await userEvent.click(screen.getByTestId('two-factor-cancel-passkey'));
    await screen.findByTestId('two-factor-step');
    expect(screen.queryByTestId('two-factor-error')).toBeNull();
  });

  it('Back drops the second step in main', async () => {
    const cancelTwoFactor = vi.fn().mockResolvedValue(ok({ done: true }));
    await passwordStep({ signInLocal: step(['totp']), cancelTwoFactor });
    await screen.findByTestId('two-factor-step');
    await userEvent.click(screen.getByTestId('sign-in-back'));
    await screen.findByTestId('sign-in-methods');
    expect(cancelTwoFactor).toHaveBeenCalled();
  });

  it('the required setup shows the QR code and key, then the codes once, then signs in', async () => {
    const twoFactorSetupConfirm = vi.fn().mockResolvedValue(ok({ account: ACCOUNT, recoveryCodes: CODES }));
    await passwordStep({
      signInLocal: step([], true),
      twoFactorSetupStart: vi.fn().mockResolvedValue(ok(SETUP)),
      twoFactorSetupConfirm,
    });
    await screen.findByTestId('two-factor-setup');
    const qr = await screen.findByTestId<HTMLImageElement>('two-factor-qr');
    expect(qr.src.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    expect(screen.getByTestId('two-factor-key').textContent).toBe('ABCD EFGH IJKL MNOP');
    await userEvent.type(screen.getByTestId('two-factor-setup-code'), '123456');
    await userEvent.click(screen.getByTestId('two-factor-setup-verify'));
    expect(twoFactorSetupConfirm).toHaveBeenCalledWith({ code: '123456' });
    const list = await screen.findByTestId('recovery-codes-list');
    expect(list.querySelectorAll('li')).toHaveLength(10);
    expect(screen.getByTestId<HTMLAnchorElement>('recovery-codes-download').download).toBe(
      'wirebench-recovery-codes.txt',
    );
    // Still open: the sign-in finishes only once the codes are saved.
    expect(screen.getByTestId('sign-in-dialog')).toBeTruthy();
    await userEvent.click(screen.getByTestId('recovery-codes-saved'));
    await waitFor(() => expect(screen.queryByTestId('sign-in-dialog')).toBeNull());
  });

  it('groups the key in fours', () => {
    expect(groupedKey('ABCDEFGHIJ')).toBe('ABCD EFGH IJ');
  });
});
