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
});
afterEach(cleanup);

describe('keyTypeLabel', () => {
  it('shortens OpenSSH key types', () => {
    expect(keyTypeLabel('ssh-ed25519')).toBe('ed25519');
    expect(keyTypeLabel('ecdsa-sha2-nistp384')).toBe('ecdsa 384');
    expect(keyTypeLabel('ssh-rsa')).toBe('rsa');
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
    await userEvent.click(within(row).getByRole('button', { name: 'Copy public key' }));
    expect(writeText).toHaveBeenCalledWith(KEY.publicKey);
    expect(await within(row).findByRole('button', { name: 'Copied' })).toBeDefined();
    const locked = screen.getByTestId('secret-row-old');
    expect(locked.textContent).toContain('locked key');
    expect(within(locked).queryByRole('button', { name: 'Copy public key' })).toBeNull();
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

  it('Generate key… shows main refusing a taken name and keeps the dialog open', async () => {
    generateKey.mockResolvedValue({
      ok: false,
      error: { code: 'ssh-secret-exists', message: 'A secret named deploy already exists; choose another name' },
    });
    render(<SshHome />);
    await userEvent.click(screen.getByRole('button', { name: /Generate key/ }));
    const dialog = await screen.findByTestId('generate-key-dialog');
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
    expect(within(row).getByRole('button', { name: 'Replace certificate…' })).toBeDefined();
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
    await userEvent.click(await within(row).findByRole('button', { name: 'Attach certificate…' }));
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
