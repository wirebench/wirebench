import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MIN_PASSWORD_LENGTH as ENGINE_MIN } from '@wirebench/engine';
import { MIN_PASSWORD_LENGTH, SignInDialog } from '../../src/renderer/features/account/sign-in-dialog.js';
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
  auth: { local: true, oidc: true, oidcDisplayName: 'Corp SSO' },
  capabilities: [],
};
const ACCOUNT = {
  url: 'https://wb.test',
  userId: 'u1',
  email: 'alice@example.com',
  displayName: 'Alice',
  deviceName: 'Mac',
  signedOut: false,
  addedAt: '2026-09-24T12:00:00.000Z',
};
const ok = (value: unknown) => ({ ok: true, value });
const fail = (code: string, message = code) => ({ ok: false, error: { code, message } });

async function openDialog(url?: string): Promise<void> {
  render(<SignInDialog />);
  act(() => {
    useUiStore.getState().openSignInDialog(url);
  });
  await screen.findByTestId('sign-in-dialog');
}

/** Types a URL and gets to the method step against `meta`. */
async function reachMethods(meta: unknown = META): Promise<ReturnType<typeof vi.fn>> {
  const probe = vi.fn().mockResolvedValue(ok({ url: 'https://wb.test', meta }));
  installWirebenchApi({ account: { probe } });
  await openDialog();
  await userEvent.type(screen.getByTestId('sign-in-url'), 'https://WB.test/');
  await userEvent.click(screen.getByTestId('sign-in-continue'));
  await screen.findByTestId('sign-in-methods');
  return probe;
}

describe('SignInDialog', () => {
  beforeEach(() => {
    installWirebenchApi();
    useAccountStore.setState({ servers: [], loaded: true });
    useUiStore.setState({ signInDialog: { open: false, url: undefined } });
    showToast.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it('restates the engine’s minimum password length', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(ENGINE_MIN);
  });

  it('is closed until opened, and starts on the server step with a given URL prefilled', async () => {
    render(<SignInDialog />);
    expect(screen.queryByTestId('sign-in-dialog')).toBeNull();
    act(() => {
      useUiStore.getState().openSignInDialog('https://known.test');
    });
    await screen.findByTestId('sign-in-dialog');
    expect(screen.getByTestId<HTMLInputElement>('sign-in-url').value).toBe('https://known.test');
  });

  it('shows the probe’s failure inline and stays on the server step', async () => {
    installWirebenchApi({ account: { probe: vi.fn().mockResolvedValue(fail('server-not-wirebench')) } });
    await openDialog();
    await userEvent.type(screen.getByTestId('sign-in-url'), 'https://example.com');
    await userEvent.click(screen.getByTestId('sign-in-continue'));
    expect((await screen.findByTestId('sign-in-error')).textContent).toBe('That address is not a Wirebench Server.');
    expect(screen.getByTestId('sign-in-url')).toBeTruthy();
  });

  it('builds the method step from meta.auth: local form, an SSO button with the display name, and the invitation link', async () => {
    const probe = await reachMethods();
    expect(probe).toHaveBeenCalledWith({ url: 'https://WB.test/' });
    expect(screen.getByTestId('sign-in-email')).toBeTruthy();
    expect(screen.getByTestId('sign-in-oidc').textContent).toBe('Continue with Corp SSO');
    expect(screen.getByTestId('sign-in-have-code')).toBeTruthy();
    expect(screen.getByTestId('sign-in-server').textContent).toContain('https://wb.test');
  });

  it('hides the local form when the server has only OIDC', async () => {
    await reachMethods({ ...META, auth: { local: false, oidc: true } });
    expect(screen.queryByTestId('sign-in-email')).toBeNull();
    expect(screen.getByTestId('sign-in-oidc').textContent).toBe('Continue with OIDC');
  });

  it('local: sends the email and password once, closes and toasts on success; maps a refusal inline', async () => {
    const signInLocal = vi
      .fn()
      .mockResolvedValueOnce(fail('identity-invalid-credentials'))
      .mockResolvedValueOnce(ok({ account: ACCOUNT }));
    await reachMethods();
    installWirebenchApi({ account: { signInLocal, probe: vi.fn() } });
    await userEvent.type(screen.getByTestId('sign-in-email'), 'alice@example.com');
    await userEvent.type(screen.getByTestId('sign-in-password'), 'wrong-password!');
    await userEvent.click(screen.getByTestId('sign-in-submit'));
    expect((await screen.findByTestId('sign-in-error')).textContent).toBe('Wrong email or password.');
    expect(signInLocal).toHaveBeenCalledWith({
      url: 'https://wb.test',
      email: 'alice@example.com',
      password: 'wrong-password!',
    });

    await userEvent.click(screen.getByTestId('sign-in-submit'));
    await waitFor(() => expect(useUiStore.getState().signInDialog.open).toBe(false));
    expect(showToast).toHaveBeenCalledWith('Signed in as alice@example.com');
  });

  it('OIDC: shows Waiting for the browser… with Cancel, and Cancel calls account.cancelSignIn', async () => {
    let settle!: (value: unknown) => void;
    const startOidc = vi.fn().mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const cancelSignIn = vi.fn().mockResolvedValue(ok({ cancelled: true }));
    await reachMethods();
    installWirebenchApi({ account: { startOidc, cancelSignIn, probe: vi.fn() } });
    await userEvent.click(screen.getByTestId('sign-in-oidc'));
    await screen.findByTestId('sign-in-waiting');
    expect(startOidc).toHaveBeenCalledWith({ url: 'https://wb.test' });
    await userEvent.click(screen.getByTestId('sign-in-cancel'));
    expect(cancelSignIn).toHaveBeenCalled();
    settle(fail('account-sign-in-cancelled'));
    expect((await screen.findByTestId('sign-in-error')).textContent).toBe('Sign-in cancelled.');
    expect(screen.getByTestId('sign-in-methods')).toBeTruthy();
  });

  it('SAML: the button shows with meta.auth.saml and its display name, and is absent otherwise', async () => {
    await reachMethods({ ...META, auth: { ...META.auth, saml: true, samlDisplayName: 'Contoso' } });
    expect(screen.getByTestId('sign-in-saml').textContent).toBe('Continue with Contoso');
    cleanup();
    await reachMethods({ ...META, auth: { local: false, oidc: false, saml: true } });
    expect(screen.getByTestId('sign-in-saml').textContent).toBe('Continue with SSO');
    cleanup();
    await reachMethods();
    expect(screen.queryByTestId('sign-in-saml')).toBeNull();
  });

  it('SAML: runs account.startSaml with the shared waiting step and cancel, and signs in', async () => {
    let settle!: (value: unknown) => void;
    const startSaml = vi.fn().mockReturnValue(new Promise((resolve) => (settle = resolve)));
    const cancelSignIn = vi.fn().mockResolvedValue(ok({ cancelled: true }));
    await reachMethods({ ...META, auth: { ...META.auth, saml: true, samlDisplayName: 'Contoso' } });
    installWirebenchApi({ account: { startSaml, cancelSignIn, probe: vi.fn() } });
    await userEvent.click(screen.getByTestId('sign-in-saml'));
    expect((await screen.findByTestId('sign-in-waiting')).textContent).toContain('Contoso');
    expect(startSaml).toHaveBeenCalledWith({ url: 'https://wb.test' });
    await userEvent.click(screen.getByTestId('sign-in-cancel'));
    expect(cancelSignIn).toHaveBeenCalled();
    settle(ok({ account: ACCOUNT }));
    await waitFor(() => expect(useUiStore.getState().signInDialog.open).toBe(false));
  });

  it.each([
    ['identity-not-invited', 'No account or open invitation exists for this email. Ask a server admin to invite you.'],
    ['identity-saml-refused', "The identity provider's response was not accepted."],
    ['identity-saml-no-email', 'The identity provider did not send an email address for this account.'],
    ['licensing-feature-required', 'SAML sign-in needs an Enterprise license on this server. Ask a server admin.'],
  ])('SAML: %s shows its message', async (code, message) => {
    await reachMethods({ ...META, auth: { ...META.auth, saml: true } });
    installWirebenchApi({ account: { startSaml: vi.fn().mockResolvedValue(fail(code)), probe: vi.fn() } });
    await userEvent.click(screen.getByTestId('sign-in-saml'));
    expect((await screen.findByTestId('sign-in-error')).textContent).toBe(message);
  });

  it('invitation: looks the code up, asks for a name and matching password of the minimum length, then accepts', async () => {
    const lookupInvitation = vi
      .fn()
      .mockResolvedValue(ok({ email: 'bob@example.com', methods: { local: true, oidc: true } }));
    const acceptInvitation = vi.fn().mockResolvedValue(ok({ account: { ...ACCOUNT, email: 'bob@example.com' } }));
    await reachMethods();
    installWirebenchApi({ account: { lookupInvitation, acceptInvitation, probe: vi.fn() } });
    await userEvent.click(screen.getByTestId('sign-in-have-code'));
    await userEvent.type(screen.getByTestId('sign-in-code'), 'S'.repeat(43));
    await userEvent.click(screen.getByTestId('sign-in-code-continue'));
    expect((await screen.findByTestId('sign-in-invited-email')).textContent).toContain('bob@example.com');
    expect(lookupInvitation).toHaveBeenCalledWith({ url: 'https://wb.test', secret: 'S'.repeat(43) });

    await userEvent.type(screen.getByTestId('sign-in-display-name'), 'Bob');
    await userEvent.type(screen.getByTestId('sign-in-new-password'), 'short');
    await userEvent.type(screen.getByTestId('sign-in-confirm-password'), 'short');
    expect(screen.getByTestId('sign-in-accept').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('sign-in-password-hint').textContent).toContain('12');
    // Too short is told by an icon and by the field's own state, not by the hint's colour alone (#803).
    expect(screen.getByTestId('sign-in-password-hint').querySelector('svg')).not.toBeNull();
    expect(screen.getByTestId('sign-in-new-password').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByTestId('sign-in-new-password').getAttribute('aria-describedby')).toBe('sign-in-password-hint');
    await userEvent.clear(screen.getByTestId('sign-in-new-password'));
    await userEvent.type(screen.getByTestId('sign-in-new-password'), 'correct horse battery');
    expect(screen.getByTestId('sign-in-password-hint').querySelector('svg')).toBeNull();
    expect(screen.getByTestId('sign-in-new-password').getAttribute('aria-invalid')).toBe('false');
    await userEvent.clear(screen.getByTestId('sign-in-confirm-password'));
    await userEvent.type(screen.getByTestId('sign-in-confirm-password'), 'correct horse battery');
    await waitFor(() => expect(screen.getByTestId('sign-in-accept').hasAttribute('disabled')).toBe(false));
    await userEvent.click(screen.getByTestId('sign-in-accept'));
    await waitFor(() =>
      expect(acceptInvitation).toHaveBeenCalledWith({
        url: 'https://wb.test',
        secret: 'S'.repeat(43),
        displayName: 'Bob',
        password: 'correct horse battery',
      }),
    );
    await waitFor(() => expect(useUiStore.getState().signInDialog.open).toBe(false));
  });

  it('Back returns to the server step and clears what was typed', async () => {
    await reachMethods();
    await userEvent.type(screen.getByTestId('sign-in-password'), 'secret-secret-1');
    await userEvent.click(screen.getByTestId('sign-in-back'));
    await screen.findByTestId('sign-in-url');
    await userEvent.click(screen.getByTestId('sign-in-continue'));
    await screen.findByTestId('sign-in-methods');
    expect(screen.getByTestId<HTMLInputElement>('sign-in-password').value).toBe('');
  });
});
