import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));
const browserTab = vi.hoisted(() => ({ value: false }));
vi.mock('../../src/renderer/lib/capabilities.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isBrowserTab: () => browserTab.value,
}));
const startRegistration = vi.hoisted(() => vi.fn());
vi.mock('@simplewebauthn/browser', () => ({ startRegistration }));

const { TwoFactorSection, addPasskeyUrl, PASSWORD_SIGN_IN_OFF } =
  await import('../../src/renderer/features/preferences/user/two-factor-section.js');
const { readUserDeepLink } = await import('../../src/renderer/features/preferences/user/user-link.js');
const { defaultPasskeyName } = await import('../../src/renderer/features/preferences/user/passkey-register.js');

const URL_A = 'https://wb.test';
const ok = (value: unknown) => ({ ok: true, value });
const fail = (code: string, message = code) => ({ ok: false, error: { code, message } });
const OFF = { available: true, enabled: false, required: false, totp: null, passkeys: [], recoveryCodesLeft: 0 };
const ON = {
  available: true,
  enabled: true,
  required: false,
  totp: { addedAt: '2026-11-01T10:00:00.000Z' },
  passkeys: [],
  recoveryCodesLeft: 7,
};
const CODES = Array.from({ length: 10 }, (_, i) => `aaaa${String(i)}-bbbbb`);
const SETUP = { uri: 'otpauth://totp/x', qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"/>', secret: 'ABCDEFGH' };

function stub(account: Record<string, unknown>) {
  installWirebenchApi({ account });
}

describe('User settings → Password, two-step sign-in (two-step sign-in spec §5)', () => {
  beforeEach(() => {
    browserTab.value = false;
    showToast.mockReset();
    startRegistration.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it('says it applies to password sign-in when the person has none, and offers nothing', async () => {
    stub({ twoFactorStatus: vi.fn().mockResolvedValue(ok({ available: false })) });
    render(<TwoFactorSection url={URL_A} />);
    expect((await screen.findByTestId('two-factor-unavailable')).textContent).toBe(PASSWORD_SIGN_IN_OFF);
    expect(screen.queryByTestId('two-factor-totp-setup')).toBeNull();
  });

  it('off: Set up, and no recovery codes yet', async () => {
    stub({ twoFactorStatus: vi.fn().mockResolvedValue(ok(OFF)) });
    render(<TwoFactorSection url={URL_A} />);
    expect((await screen.findByTestId('two-factor-status')).textContent).toBe('Off');
    expect(screen.getByTestId('two-factor-totp-setup')).toBeTruthy();
    expect(screen.queryByTestId('two-factor-codes-left')).toBeNull();
  });

  it('on and required: the codes left, and the last method cannot be removed', async () => {
    stub({ twoFactorStatus: vi.fn().mockResolvedValue(ok({ ...ON, required: true })) });
    render(<TwoFactorSection url={URL_A} />);
    expect((await screen.findByTestId('two-factor-status')).textContent).toContain('Required on this server');
    expect(screen.getByTestId('two-factor-codes-left').textContent).toBe('7 of 10 left');
    expect(screen.getByTestId<HTMLButtonElement>('two-factor-totp-remove').disabled).toBe(true);
  });

  it('sets up an authenticator after the password, then shows the codes once', async () => {
    const twoFactorStatus = vi.fn().mockResolvedValueOnce(ok(OFF)).mockResolvedValue(ok(ON));
    const setUpTotp = vi.fn().mockResolvedValue(ok(SETUP));
    const confirmTotp = vi.fn().mockResolvedValue(ok({ recoveryCodes: CODES }));
    stub({ twoFactorStatus, setUpTotp, confirmTotp });
    render(<TwoFactorSection url={URL_A} />);
    await userEvent.click(await screen.findByTestId('two-factor-totp-setup'));
    await userEvent.type(screen.getByTestId('two-factor-password'), 'correct horse battery');
    await userEvent.click(screen.getByTestId('two-factor-prompt-confirm'));
    expect(setUpTotp).toHaveBeenCalledWith({ url: URL_A, password: 'correct horse battery' });
    expect(await screen.findByTestId('two-factor-qr')).toBeTruthy();
    await userEvent.type(screen.getByTestId('two-factor-totp-code'), '123456');
    await userEvent.click(screen.getByTestId('two-factor-totp-verify'));
    expect(confirmTotp).toHaveBeenCalledWith({ url: URL_A, code: '123456' });
    expect((await screen.findByTestId('recovery-codes-list')).querySelectorAll('li')).toHaveLength(10);
    await userEvent.click(screen.getByTestId('recovery-codes-saved'));
    expect((await screen.findByTestId('two-factor-status')).textContent).toBe('On');
    expect(screen.queryByTestId('recovery-codes-list')).toBeNull();
  });

  it('removing the last method asks first, and a wrong password says so', async () => {
    const removeTotp = vi
      .fn()
      .mockResolvedValueOnce(fail('identity-invalid-credentials', 'The email or password is not right.'))
      .mockResolvedValue(ok({ done: true }));
    stub({ twoFactorStatus: vi.fn().mockResolvedValue(ok(ON)), removeTotp });
    render(<TwoFactorSection url={URL_A} />);
    await userEvent.click(await screen.findByTestId('two-factor-totp-remove'));
    expect(screen.getByTestId('two-factor-last-method').textContent).toContain('turns two-step sign-in off');
    expect(removeTotp).not.toHaveBeenCalled();
    await userEvent.type(screen.getByTestId('two-factor-password'), 'wrong one');
    await userEvent.click(screen.getByTestId('two-factor-prompt-confirm'));
    expect((await screen.findByTestId('two-factor-error')).textContent).toBe('The email or password is not right.');
    // The password field is cleared after every answer.
    expect(screen.getByTestId<HTMLInputElement>('two-factor-password').value).toBe('');
    await userEvent.type(screen.getByTestId('two-factor-password'), 'correct horse battery');
    await userEvent.click(screen.getByTestId('two-factor-prompt-confirm'));
    await waitFor(() => expect(screen.queryByTestId('two-factor-prompt')).toBeNull());
    expect(removeTotp).toHaveBeenLastCalledWith({ url: URL_A, password: 'correct horse battery' });
  });

  it('adds a passkey in the browser client, with WebAuthn in the page', async () => {
    browserTab.value = true;
    const passkeyOptions = vi.fn().mockResolvedValue(ok({ challenge: 'abc', rp: { id: 'wb.test' } }));
    const addPasskey = vi
      .fn()
      .mockResolvedValue(
        ok({ passkey: { id: 'p1', name: 'Chrome on macOS', createdAt: '2026-11-07T12:00:00.000Z', lastUsedAt: null } }),
      );
    startRegistration.mockResolvedValue({ id: 'cred', response: {} });
    stub({ twoFactorStatus: vi.fn().mockResolvedValue(ok(ON)), passkeyOptions, addPasskey });
    render(<TwoFactorSection url={URL_A} />);
    await userEvent.click(await screen.findByTestId('two-factor-passkey-add'));
    await userEvent.type(screen.getByTestId('two-factor-password'), 'correct horse battery');
    await userEvent.click(screen.getByTestId('two-factor-prompt-confirm'));
    await waitFor(() => expect(addPasskey).toHaveBeenCalled());
    expect(passkeyOptions).toHaveBeenCalledWith({ url: URL_A, password: 'correct horse battery' });
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'abc', rp: { id: 'wb.test' } } });
    expect(addPasskey.mock.calls[0]![0]).toMatchObject({ url: URL_A, response: { id: 'cred' } });
  });

  it('a passkey prompt the person closes adds nothing', async () => {
    browserTab.value = true;
    const addPasskey = vi.fn();
    startRegistration.mockRejectedValue(Object.assign(new Error('closed'), { name: 'NotAllowedError' }));
    stub({
      twoFactorStatus: vi.fn().mockResolvedValue(ok(ON)),
      passkeyOptions: vi.fn().mockResolvedValue(ok({ challenge: 'abc' })),
      addPasskey,
    });
    render(<TwoFactorSection url={URL_A} />);
    await userEvent.click(await screen.findByTestId('two-factor-passkey-add'));
    await userEvent.type(screen.getByTestId('two-factor-password'), 'correct horse battery');
    await userEvent.click(screen.getByTestId('two-factor-prompt-confirm'));
    expect((await screen.findByTestId('two-factor-error')).textContent).toBe('The passkey was not added.');
    expect(addPasskey).not.toHaveBeenCalled();
  });

  it('the desktop opens the browser client to add a passkey', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    stub({ twoFactorStatus: vi.fn().mockResolvedValue(ok(ON)) });
    render(<TwoFactorSection url={URL_A} />);
    await userEvent.click(await screen.findByTestId('two-factor-passkey-add-browser'));
    expect(open).toHaveBeenCalledWith(`${URL_A}/?panel=user&page=password&add=passkey`, '_blank', 'noopener');
    expect(screen.queryByTestId('two-factor-passkey-add')).toBeNull();
    open.mockRestore();
  });

  it('reads the browser client’s User settings address', () => {
    expect(addPasskeyUrl('https://wb.test/')).toBe('https://wb.test/?panel=user&page=password&add=passkey');
    expect(readUserDeepLink('?panel=user&page=password&add=passkey')).toEqual({ page: 'password', addPasskey: true });
    expect(readUserDeepLink('?panel=user&page=nope')).toEqual({ addPasskey: false });
    expect(readUserDeepLink('?panel=team')).toBeUndefined();
  });

  it('names a passkey after the browser and system', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36';
    expect(defaultPasskeyName(mac)).toBe('Chrome on macOS');
    expect(defaultPasskeyName('Mozilla/5.0 (Windows NT 10.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on Windows');
  });
});
