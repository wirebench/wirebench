import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostsFileWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';

const listHosts = vi.fn();
const saveHosts = vi.fn();
const setHostOs = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
const setSecret = vi.fn(() => Promise.resolve({ ok: true, value: {} }));
const secretNames = vi.fn(() =>
  Promise.resolve({ ok: true, value: { names: [{ name: 'corp_proxy', local: true, external: false }] } }),
);
const knownHosts = vi.fn(() => Promise.resolve({ ok: true, value: { entries: [] } }));
const keys = vi.fn(() => Promise.resolve({ ok: true, value: { keys: [] } }));
vi.mock('../../src/renderer/state/ipc-client.js', () => ({
  ipc: () => ({ ssh: { listHosts, saveHosts, setHostOs, setSecret, secretNames, knownHosts, keys } }),
}));
import { connectFailureSentence } from '../../src/renderer/features/ssh/connect-errors.js';
import { HostDetails, sshCommandOf } from '../../src/renderer/features/ssh/host-details.js';
import { HostForm } from '../../src/renderer/features/ssh/host-dialog.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { cleanProxy, proxyProblem, proxyText } from '../../src/renderer/features/ssh/proxy-section.js';

const CORP_PROXY = {
  type: 'socks5',
  host: 'proxy.corp',
  port: 1080,
  user: 'me',
  passwordSecret: 'corp_proxy',
} as const;

const FILE: HostsFileWire = {
  version: 1,
  groups: [
    {
      id: 'corp',
      name: 'Corp',
      tags: [],
      ssh: { user: 'ops', auth: { kind: 'agent' }, proxy: CORP_PROXY },
      groups: [],
      hosts: [{ id: 'build', name: 'build', address: 'build.corp', tags: [], ssh: {} }],
    },
  ],
  hosts: [{ id: 'plain', name: 'plain', address: '10.0.0.1', tags: [], ssh: { user: 'u', auth: { kind: 'agent' } } }],
};

const resolvedHost = (
  id: string,
  address: string,
  proxy: ResolvedHostWire['ssh']['proxy'],
  jump: string | undefined = undefined,
): ResolvedHostWire => ({
  id,
  name: id,
  address,
  tags: [],
  path: [],
  protected: { value: false, from: 'default' },
  ssh: {
    user: { value: 'ops', from: 'host' },
    port: { value: 22, from: 'default' },
    auth: { value: { kind: 'agent' }, from: 'host' },
    jump: { value: jump, from: jump === undefined ? 'default' : 'host' },
    keepAlive: { value: 15, from: 'default' },
    connectTimeout: { value: 20, from: 'default' },
    forwardAgent: { value: false, from: 'default' },
    proxy,
  },
  forwards: [],
  env: [],
});

const RESOLVED: ResolvedHostWire[] = [
  resolvedHost('build', 'build.corp', { value: CORP_PROXY, from: { group: 'Corp' } }),
  resolvedHost('plain', '10.0.0.1', { value: undefined, from: 'default' }),
];

const saved = (): HostsFileWire => (saveHosts.mock.lastCall?.[0] as { file: HostsFileWire }).file;

beforeEach(() => {
  vi.clearAllMocks();
  saveHosts.mockImplementation(({ file }: { file: HostsFileWire }) =>
    Promise.resolve({ ok: true, value: { file, resolved: RESOLVED, problems: [] } }),
  );
  useHostsStore.setState({
    file: FILE,
    resolved: RESOLVED,
    problems: [],
    loaded: true,
    dialog: null,
    osByHost: {},
    homeView: 'hosts',
    panes: {},
  });
});
afterEach(() => {
  cleanup();
});

const edit = (id: string) => render(<HostForm file={FILE} dialog={{ mode: 'edit-host', id }} embedded />);
const section = () => screen.getByRole('group', { name: 'Proxy' });
const kind = () => within(section()).getByRole<HTMLSelectElement>('combobox', { name: 'Proxy' });
const save = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
};

describe('the proxy section of the host form', () => {
  it('offers the group proxy to inherit, and None writes proxy: false', async () => {
    edit('build');
    expect(kind().value).toBe('inherit');
    expect(within(section()).getByText('Inherit: SOCKS5 proxy.corp:1080 as me · from Corp')).toBeTruthy();
    await userEvent.selectOptions(kind(), 'none');
    await save();
    expect(saved().groups[0]!.hosts[0]!.ssh.proxy).toBe(false);
  });

  it('a host that inherits writes no proxy key', async () => {
    edit('build');
    await save();
    expect(saved().groups[0]!.hosts[0]!.ssh).not.toHaveProperty('proxy');
  });

  it('an HTTP proxy with a typed password stores the password as a secret and writes only its name', async () => {
    edit('plain');
    expect(kind().value).toBe('none');
    await userEvent.selectOptions(kind(), 'http');
    const port = within(section()).getByRole<HTMLInputElement>('spinbutton', { name: 'Proxy port' });
    expect(port.value).toBe('3128');
    // Save stays off until the proxy has a host.
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    await userEvent.type(within(section()).getByRole('textbox', { name: 'Proxy host' }), 'web.corp');
    await userEvent.type(within(section()).getByRole('textbox', { name: 'Proxy user' }), 'alice');
    await userEvent.type(within(section()).getByLabelText('Proxy password'), 'hunter2');
    await save();
    expect(setSecret).toHaveBeenCalledWith({ name: 'plain_proxy_password', value: 'hunter2' });
    expect(saved().hosts[0]!.ssh.proxy).toEqual({
      type: 'http',
      host: 'web.corp',
      port: 3128,
      user: 'alice',
      passwordSecret: 'plain_proxy_password',
    });
    expect(JSON.stringify(saved())).not.toContain('hunter2');
  });

  it('switching kind moves a default port to the new default and keeps a chosen one', async () => {
    edit('plain');
    await userEvent.selectOptions(kind(), 'socks5');
    const port = () => within(section()).getByRole<HTMLInputElement>('spinbutton', { name: 'Proxy port' });
    expect(port().value).toBe('1080');
    await userEvent.selectOptions(kind(), 'http');
    expect(port().value).toBe('3128');
    await userEvent.clear(port());
    await userEvent.type(port(), '8080');
    await userEvent.selectOptions(kind(), 'socks5');
    expect(port().value).toBe('8080');
  });
});

describe('proxy helpers', () => {
  it('name a proxy, find what blocks Save, and drop empty optional fields', () => {
    expect(proxyText({ type: 'http', host: '2001:db8::1', port: 3128 })).toBe('HTTP CONNECT [2001:db8::1]:3128');
    expect(proxyProblem({ type: 'http', host: ' ', port: 3128 })).toMatch(/needs a host/);
    expect(proxyProblem({ type: 'http', host: 'p', port: Number.NaN })).toMatch(/port/);
    expect(proxyProblem(false)).toBeUndefined();
    expect(cleanProxy({ type: 'socks5', host: ' p ', port: 1, user: '', passwordSecret: '' })).toEqual({
      type: 'socks5',
      host: 'p',
      port: 1,
    });
  });
});

describe('host details', () => {
  it('lists the proxy with its source and password secret, and the command carries the ProxyCommand', () => {
    useHostsStore.setState({ selectedHostId: 'build' });
    render(<HostDetails />);
    const row = screen.getByText('Proxy').parentElement!;
    expect(row.textContent).toContain('SOCKS5 proxy.corp:1080 as me');
    expect(row.textContent).toContain('from Corp');
    expect(screen.getByText('Proxy password').parentElement!.textContent).toContain('corp_proxy');
    expect(sshCommandOf(RESOLVED[0]!, undefined)).toBe(
      'ssh -o "ProxyCommand=nc -X 5 -x proxy.corp:1080 %h %p" ops@build.corp',
    );
  });
  it('a host reached through a jump host leaves its own proxy out of the command', () => {
    expect(sshCommandOf(resolvedHost('t', 't', { value: CORP_PROXY, from: 'host' }, 'build'), 'build.corp')).toBe(
      'ssh -J build.corp ops@t',
    );
  });
});

describe('the connection screen', () => {
  const sentence = (details: Record<string, unknown>) =>
    connectFailureSentence(
      {
        code: 'ssh-connect-failed',
        message: 'raw',
        details: { host: 'a:22', reason: 'proxy', proxy: 'p:1080', ...details },
      },
      'terminal',
    );
  it('says what the proxy did, never the raw message', () => {
    expect(sentence({ proxyReason: 'refused' })).toBe(
      "The proxy p:1080 refused the connection: nothing listens on that port. Check the proxy's address and port.",
    );
    expect(sentence({ proxyReason: 'refused', proxyDetail: '403 Forbidden' })).toMatch(
      /^The proxy p:1080 would not open a tunnel to a:22 \(403 Forbidden\)/,
    );
    expect(sentence({ proxyReason: 'auth' })).toMatch(/refused the sign-in\. Check the proxy user and password/);
    expect(sentence({ proxyReason: 'protocol', proxyType: 'http' })).toMatch(/did not answer as an HTTP proxy/);
    expect(sentence({ proxyReason: 'timeout', timeout: 20 })).toMatch(/^No answer from the proxy p:1080 after 20 s/);
    expect(sentence({ proxyReason: 'dns' })).toMatch(/^The proxy p:1080 could not be found/);
  });
});
