import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const secretNames = vi.fn();
const setSecret = vi.fn();
const knownHosts = vi.fn();
const sshKeys = vi.fn();
const generateKey = vi.fn();
const installKey = vi.fn();
const trustHostKey = vi.fn();
const attachCertificate = vi.fn();
const deviceKeyStatus = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({
    ssh: {
      listHosts,
      saveHosts,
      secretNames,
      setSecret,
      knownHosts,
      keys: sshKeys,
      generateKey,
      installKey,
      trustHostKey,
      attachCertificate,
      deviceKeyStatus,
    },
  }),
}));
import { SshHome } from '../../src/renderer/features/ssh/ssh-home.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { keyTypeLabel, useKeyInstall } from '../../src/renderer/features/ssh/ssh-keys.js';

const defaults = {
  user: { value: 'ops', from: 'host' },
  port: { value: 22, from: 'default' },
  auth: { value: { kind: 'password', secret: 'web_pw' }, from: 'host' },
  jump: { value: undefined, from: 'default' },
  keepAlive: { value: 15, from: 'default' },
  connectTimeout: { value: 20, from: 'default' },
  forwardAgent: { value: false, from: 'default' },
  proxy: { value: undefined, from: 'default' },
} as const;
const FILE = {
  version: 1 as const,
  groups: [],
  hosts: [
    {
      id: 'web',
      name: 'web',
      address: '10.0.0.9',
      tags: [],
      ssh: { user: 'ops', auth: { kind: 'password' as const, secret: 'web_pw' } },
    },
  ],
};
const RESOLVED = [
  {
    id: 'web',
    name: 'web',
    address: '10.0.0.9',
    tags: [],
    path: [],
    protected: { value: false, from: 'default' as const },
    ssh: defaults,
    forwards: [],
    env: [],
  },
];
const KEY = {
  name: 'deploy',
  locked: false,
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:fff',
  publicKey: 'ssh-ed25519 AAAAC3Nz me@machine',
  passphraseSecret: 'deploy_passphrase',
};

beforeEach(() => {
  vi.clearAllMocks();
  secretNames.mockResolvedValue({
    ok: true,
    value: {
      names: [
        { name: 'deploy', local: true, external: false },
        { name: 'deploy_passphrase', local: true, external: false },
        { name: 'old', local: true, external: false },
        { name: 'web_pw', local: true, external: false },
      ],
    },
  });
  sshKeys.mockResolvedValue({ ok: true, value: { keys: [KEY, { name: 'old', locked: true }] } });
  saveHosts.mockImplementation((request: { file: typeof FILE }) =>
    Promise.resolve({ ok: true, value: { file: request.file, resolved: RESOLVED, problems: [] } }),
  );
  useHostsStore.setState({ file: FILE, resolved: RESOLVED, problems: [], loaded: true, homeView: 'keychain' });
  useKeyInstall.setState({ target: null });
  deviceKeyStatus.mockResolvedValue({
    ok: true,
    value: { supported: false },
  });
});
afterEach(cleanup);

describe('keyTypeLabel', () => {
  it('shortens OpenSSH key types', () => {
    expect(keyTypeLabel('ssh-ed25519')).toBe('ed25519');
    expect(keyTypeLabel('ecdsa-sha2-nistp384')).toBe('ecdsa 384');
    expect(keyTypeLabel('ssh-rsa')).toBe('rsa');
    expect(keyTypeLabel('sk-ssh-ed25519@openssh.com')).toBe('ed25519-sk');
    expect(keyTypeLabel('sk-ecdsa-sha2-nistp256@openssh.com')).toBe('ecdsa-sk');
  });
});

describe('Keychain keys', () => {
  it('shows a key by its type and fingerprint, copies its public key, and marks a locked one', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<SshHome />);
    const row = await screen.findByTestId('secret-row-deploy');
    await vi.waitFor(() => {
      expect(row.textContent).toContain('ed25519 · SHA256:fff');
    });
    // One action shows; the rest are behind ⋯.
    expect(
      within(row)
        .getAllByRole('button')
        .map((b) => b.textContent || b.getAttribute('aria-label')),
    ).toEqual(['Install on host…', 'More actions for deploy']);
    await userEvent.click(within(row).getByRole('button', { name: 'More actions for deploy' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Copy public key' }));
    expect(writeText).toHaveBeenCalledWith(KEY.publicKey);
    const locked = screen.getByTestId('secret-row-old');
    expect(locked.textContent).toContain('locked key');
    expect(within(locked).queryByRole('button', { name: 'More actions for old' })).toBeNull();
    expect(within(locked).getByRole('button', { name: 'Set value…' })).toBeDefined();
    expect(
      within(screen.getByTestId('secret-row-web_pw')).queryByRole('button', { name: 'Install on host…' }),
    ).toBeNull();
  });

  it('Generate key… sends the type, size and passphrase to main and lists the new key', async () => {
    generateKey.mockResolvedValue({ ok: true, value: { ...KEY, name: 'ci' } });
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: /Generate key/ }));
    const dialog = await screen.findByTestId('generate-key-dialog');
    // Ed25519 has one size: no size picker until another type is chosen.
    expect(within(dialog).queryByLabelText('Key size')).toBeNull();
    await userEvent.clear(within(dialog).getByLabelText('Secret name'));
    await userEvent.type(within(dialog).getByLabelText('Secret name'), 'ci');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'RSA' }));
    await userEvent.selectOptions(within(dialog).getByLabelText('Key size'), '3072');
    await userEvent.type(within(dialog).getByLabelText('Passphrase (optional)'), 'pp');
    await userEvent.type(within(dialog).getByLabelText('Repeat passphrase'), 'px');
    expect(within(dialog).getByRole('button', { name: 'Generate' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByText('The passphrases differ.')).toBeDefined();
    await userEvent.clear(within(dialog).getByLabelText('Repeat passphrase'));
    await userEvent.type(within(dialog).getByLabelText('Repeat passphrase'), 'pp');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(generateKey).toHaveBeenCalledWith({ name: 'ci', algorithm: 'rsa', bits: 3072, passphrase: 'pp' });
    await vi.waitFor(() => {
      expect(screen.queryByTestId('generate-key-dialog')).toBeNull();
    });
    expect(secretNames).toHaveBeenCalledTimes(2);
  });

  it('Generate key… makes a security key with its PIN, asks for the touch, and needs the PIN to verify every sign-in', async () => {
    let finish: (value: unknown) => void = () => undefined;
    generateKey.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: /Generate key/ }));
    const dialog = await screen.findByTestId('generate-key-dialog');
    expect(within(dialog).queryByTestId('generate-key-security')).toBeNull();
    await userEvent.clear(within(dialog).getByLabelText('Secret name'));
    await userEvent.type(within(dialog).getByLabelText('Secret name'), 'yubi');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Security key (ECDSA)' }));
    expect(within(dialog).getByTestId('generate-key-security')).toBeDefined();
    await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Ask for the PIN at every sign-in' }));
    expect(within(dialog).getByRole('button', { name: 'Generate' })).toHaveProperty('disabled', true);
    await userEvent.type(within(dialog).getByLabelText('Security key PIN (if it has one)'), '2468');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(generateKey).toHaveBeenCalledWith({
      name: 'yubi',
      algorithm: 'ecdsa-sk',
      pin: '2468',
      verifyRequired: true,
    });
    expect(within(dialog).getByRole('status').textContent).toBe('Touch your security key when it blinks.');
    finish({ ok: true, value: { ...KEY, name: 'yubi', keyType: 'sk-ecdsa-sha2-nistp256@openssh.com' } });
    await vi.waitFor(() => {
      expect(screen.queryByTestId('generate-key-dialog')).toBeNull();
    });
  });

  it('Generate key… starts with a free OpenSSH name that follows the type, and says why Generate is off', async () => {
    generateKey.mockResolvedValue({ ok: true, value: { ...KEY, name: 'id_rsa' } });
    secretNames.mockResolvedValue({
      ok: true,
      value: { names: [{ name: 'id_ed25519', local: true, external: false }] },
    });
    render(<SshHome />);
    await screen.findByTestId('secret-row-id_ed25519');
    await userEvent.click(screen.getByRole('button', { name: /Generate key/ }));
    const dialog = await screen.findByTestId('generate-key-dialog');
    const name = within(dialog).getByLabelText<HTMLInputElement>('Secret name');
    // id_ed25519 is taken, so the next free one; selected, so typing replaces it.
    expect(name.value).toBe('id_ed25519_2');
    expect(name.selectionStart).toBe(0);
    expect(name.selectionEnd).toBe('id_ed25519_2'.length);
    expect(within(dialog).queryByTestId('generate-key-name-problem')).toBeNull();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'RSA' }));
    expect(name.value).toBe('id_rsa');
    await userEvent.clear(name);
    expect(within(dialog).getByRole('button', { name: 'Generate' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByTestId('generate-key-name-problem').textContent).toBe('Name is required');
    await userEvent.type(name, '9x');
    expect(within(dialog).getByTestId('generate-key-name-problem').textContent).toContain('not starting with a digit');
    // A typed name stays when the type changes.
    await userEvent.clear(name);
    await userEvent.type(name, 'ci');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Ed25519' }));
    expect(name.value).toBe('ci');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(generateKey).toHaveBeenCalledWith({ name: 'ci', algorithm: 'ed25519' });
  });

  it('Generate key… shows main refusing a taken name and keeps the dialog open', async () => {
    generateKey.mockResolvedValue({
      ok: false,
      error: { code: 'ssh-secret-exists', message: 'A secret named deploy already exists; choose another name' },
    });
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: /Generate key/ }));
    const dialog = await screen.findByTestId('generate-key-dialog');
    await userEvent.clear(within(dialog).getByLabelText('Secret name'));
    await userEvent.type(within(dialog).getByLabelText('Secret name'), 'deploy');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(generateKey).toHaveBeenCalledWith({ name: 'deploy', algorithm: 'ed25519' });
    expect((await within(dialog).findByRole('alert')).textContent).toContain('already exists');
  });
});

describe('Install public key on host', () => {
  it("shows a key's certificate: key ID, principals and validity window, and a badge when expired", async () => {
    const certificate = {
      secret: 'deploy_cert',
      keyId: 'alice@example',
      serial: '42',
      principals: ['alice', 'deploy'],
      validAfter: 0,
      validBefore: 1,
      window: 'from 2000-01-01 00:00:00 UTC to 2001-01-01 00:00:00 UTC',
      validity: 'expired',
      caFingerprint: 'SHA256:ca',
      matchesKey: true,
    };
    sshKeys.mockResolvedValue({ ok: true, value: { keys: [{ ...KEY, certificate }] } });
    render(<SshHome />);
    const line = await screen.findByTestId('certificate-deploy_cert');
    expect(line.textContent).toBe(
      'Certificate alice@example · alice, deploy · from 2000-01-01 00:00:00 UTC to 2001-01-01 00:00:00 UTC' + 'expired',
    );
    const row = screen.getByTestId('secret-row-deploy');
    await userEvent.click(within(row).getByRole('button', { name: 'More actions for deploy' }));
    expect(await screen.findByRole('menuitem', { name: 'Replace certificate…' })).toBeDefined();
  });

  it('Attach certificate… sends the pasted text to main, shows a refusal, and lists the key again on success', async () => {
    attachCertificate
      .mockResolvedValueOnce({
        ok: false,
        error: { code: 'ssh-cert-mismatch', message: 'This certificate was issued for another key than deploy' },
      })
      .mockResolvedValueOnce({ ok: true, value: KEY });
    render(<SshHome />);
    const row = await screen.findByTestId('secret-row-deploy');
    await userEvent.click(await within(row).findByRole('button', { name: 'More actions for deploy' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Attach certificate…' }));
    const dialog = await screen.findByTestId('attach-certificate-dialog');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Certificate' }),
      'ssh-ed25519-cert-v01@openssh.com AAAA',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Attach' }));
    expect(attachCertificate).toHaveBeenCalledWith({
      secret: 'deploy',
      certificate: 'ssh-ed25519-cert-v01@openssh.com AAAA',
    });
    expect((await within(dialog).findByRole('alert')).textContent).toContain('another key');
    const listings = sshKeys.mock.calls.length;
    await userEvent.click(within(dialog).getByRole('button', { name: 'Attach' }));
    await vi.waitFor(() => {
      expect(screen.queryByTestId('attach-certificate-dialog')).toBeNull();
    });
    expect(sshKeys.mock.calls.length).toBeGreaterThan(listings);
  });

  it('installs from the key row, then switches the host to the key with its passphrase', async () => {
    installKey.mockResolvedValue({ ok: true, value: { result: 'added' } });
    render(<SshHome />);
    const row = await screen.findByTestId('secret-row-deploy');
    await userEvent.click(await within(row).findByRole('button', { name: 'Install on host…' }));
    const dialog = await screen.findByTestId('install-key-dialog');
    expect(dialog.textContent).toContain('Signs in with password web_pw');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect(installKey).toHaveBeenCalledWith({ secret: 'deploy', hostId: 'web' });
    expect((await within(dialog).findByTestId('install-key-result')).textContent).toBe(
      'Added to ~/.ssh/authorized_keys on web.',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Switch' }));
    await vi.waitFor(() => {
      expect(saveHosts).toHaveBeenCalled();
    });
    const saved = (saveHosts.mock.calls[0]![0] as { file: typeof FILE }).file.hosts[0]!;
    expect(saved.ssh).toEqual({
      user: 'ops',
      auth: { kind: 'key', secret: 'deploy', passphraseSecret: 'deploy_passphrase' },
    });
    expect((await within(dialog).findByTestId('install-key-result')).textContent).toBe('web now signs in with deploy.');
  });

  it('from a host menu: trusts a new host key on request and installs again; Not now leaves the host', async () => {
    installKey
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: 'ssh-host-key-new',
          message: 'untrusted',
          details: { host: '10.0.0.9:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:host' },
        },
      })
      .mockResolvedValueOnce({ ok: true, value: { result: 'present' } });
    trustHostKey.mockResolvedValue({ ok: true, value: {} });
    render(<SshHome />);
    useKeyInstall.getState().open({ hostId: 'web' });
    const dialog = await screen.findByTestId('install-key-dialog');
    await vi.waitFor(() => {
      expect(within(dialog).getByRole('option', { name: 'deploy (ed25519)' })).toBeDefined();
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('SHA256:host');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Trust and install' }));
    expect(trustHostKey).toHaveBeenCalledWith({
      host: '10.0.0.9:22',
      keyType: 'ssh-ed25519',
      fingerprint: 'SHA256:host',
      replace: false,
    });
    expect((await within(dialog).findByTestId('install-key-result')).textContent).toBe('web already has this key.');
    expect(installKey).toHaveBeenCalledTimes(2);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByTestId('install-key-dialog')).toBeNull();
    expect(saveHosts).not.toHaveBeenCalled();
  });

  it('shows a failed install and lets the user try again', async () => {
    installKey.mockResolvedValue({
      ok: false,
      error: { code: 'ssh-install-failed', message: '10.0.0.9:22: the key could not be added' },
    });
    render(<SshHome />);
    useKeyInstall.getState().open({ secret: 'deploy', hostId: 'web' });
    const dialog = await screen.findByTestId('install-key-dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Install' }));
    expect((await within(dialog).findByRole('alert')).textContent).toContain('could not be added');
    expect(within(dialog).getByRole('button', { name: 'Install' })).toHaveProperty('disabled', false);
  });
});

describe('device keys (#428)', () => {
  const ENCLAVE = { supported: true, platform: 'macos-secure-enclave', keyType: 'ecdsa-sha2-nistp256' } as const;

  it('offers a device key where the hardware makes one: no passphrase, the recovery warning, its own name', async () => {
    deviceKeyStatus.mockResolvedValue({ ok: true, value: ENCLAVE });
    generateKey.mockResolvedValue({ ok: true, value: { ...KEY, name: 'id_ecdsa_device' } });
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: /Generate key/ }));
    const dialog = await screen.findByTestId('generate-key-dialog');
    const choice = await within(dialog).findByRole('radio', { name: 'Device key (This Mac’s Secure Enclave)' });
    expect(choice).toHaveProperty('disabled', false);
    expect(within(dialog).queryByTestId('generate-key-device-notes')).toBeNull();
    await userEvent.click(choice);
    expect(within(dialog).getByLabelText('Secret name')).toHaveProperty('value', 'id_ecdsa_device');
    expect(within(dialog).queryByLabelText('Passphrase (optional)')).toBeNull();
    const notes = within(dialog).getByTestId('generate-key-device-notes');
    expect(notes.textContent).toContain('Touch ID or your password');
    expect(within(notes).getByRole('note').textContent).toContain('cannot be copied off this device or recovered');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Generate' }));
    expect(generateKey).toHaveBeenCalledWith({ name: 'id_ecdsa_device', algorithm: 'device' });
  });

  it('disables the device key choice and says why where there is none', async () => {
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: /Generate key/ }));
    const dialog = await screen.findByTestId('generate-key-dialog');
    expect(await within(dialog).findByTestId('generate-key-device-unavailable')).toBeDefined();
    expect(within(dialog).getByRole('radio', { name: 'Device key' })).toHaveProperty('disabled', true);
    expect(within(dialog).getByTestId('generate-key-device-unavailable').textContent).toBe(
      'Device keys need macOS with a Secure Enclave or Windows Hello.',
    );
  });

  it('adds what this computer lacks when main says', async () => {
    deviceKeyStatus.mockResolvedValue({
      ok: true,
      value: { supported: false, platform: 'macos-secure-enclave', reason: 'This Mac has no Secure Enclave' },
    });
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: /Generate key/ }));
    const dialog = await screen.findByTestId('generate-key-dialog');
    expect((await within(dialog).findByTestId('generate-key-device-unavailable')).textContent).toBe(
      'Device keys need macOS with a Secure Enclave or Windows Hello. This Mac has no Secure Enclave.',
    );
  });

  it('marks a device key as this device’s or another device’s', async () => {
    sshKeys.mockResolvedValue({
      ok: true,
      value: {
        keys: [
          { ...KEY, device: { platform: 'macos-secure-enclave', madeOn: 'work-laptop', here: true } },
          {
            ...KEY,
            name: 'old',
            device: { platform: 'macos-secure-enclave', madeOn: 'other-mac', here: false },
          },
        ],
      },
    });
    render(<SshHome />);
    expect((await screen.findByTestId('device-key-deploy')).textContent).toBe('this device');
    expect((await screen.findByTestId('device-key-old')).textContent).toBe('other device (other-mac)');
  });
});
