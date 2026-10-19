import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setSecret = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { setSecret } }) }));
import { ConnectScreen, failingLine } from '../../src/renderer/features/ssh/connect-screen.js';
import { beginAttempt, noteFailed, useConnectStore } from '../../src/renderer/features/ssh/connect-store.js';
import type { ConnectError } from '../../src/renderer/features/ssh/connect-errors.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useQuickHostsStore } from '../../src/renderer/features/ssh/quick-hosts.js';
import type { HostsFileWire, ResolvedHostWire } from '../../src/shared/ssh-wire.js';

const from = 'host' as const;
function resolved(user: string | undefined): ResolvedHostWire {
  return {
    id: 'box',
    name: 'box',
    address: '127.0.0.1',
    tags: [],
    path: [],
    protected: { value: false, from: 'default' },
    ssh: {
      user: { value: user, from },
      port: { value: 2222, from },
      auth: { value: { kind: 'password', secret: 'box_pw' }, from },
      jump: { value: undefined, from: 'default' },
      keepAlive: { value: 30, from: 'default' },
      connectTimeout: { value: 10, from: 'default' },
      forwardAgent: { value: false, from: 'default' },
      proxy: { value: undefined, from: 'default' },
    },
    ...(user === undefined ? { incomplete: { field: 'user' as const } } : {}),
    forwards: [],
    env: [],
  };
}
const FILE: HostsFileWire = {
  version: 1,
  groups: [],
  hosts: [{ id: 'box', name: 'box', address: '127.0.0.1', tags: [], ssh: { port: 2222 } }],
};

/** A failed attempt on pane `pa`, as the store holds it. */
function failed(error: ConnectError) {
  const attemptId = beginAttempt('pa', 'terminal');
  noteFailed('pa', attemptId, error);
  return useConnectStore.getState().views['pa'];
}

function show(error: ConnectError, onRetry = vi.fn()) {
  render(
    <ConnectScreen
      hostId="box"
      purpose="terminal"
      view={failed(error)}
      onRetry={onRetry}
      onEditHost={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  return onRetry;
}

const isPrimary = (name: string) => screen.getByRole('button', { name }).className.includes('bg-accent');

beforeEach(() => {
  useConnectStore.setState({ views: {}, attempts: {}, users: {} });
  useHostsStore.setState({ resolved: [resolved('tester')], file: FILE });
  setSecret.mockReset();
});
afterEach(cleanup);

describe('a serial console with no port picked yet (#688)', () => {
  beforeEach(() => {
    const host = resolved('tester');
    useHostsStore.setState({ resolved: [{ ...host, ssh: { ...host.ssh, protocol: { value: 'serial', from } } }] });
  });

  it('asks for the port as a step: no red, no Retry, no log, no Host settings', () => {
    show({ code: 'serial-device-unset', message: 'x', details: { hostId: 'box' } });
    expect(screen.getByTestId('connect-screen').getAttribute('data-state')).toBe('choose-port');
    expect(screen.getByRole('heading', { name: 'Choose the port for box' })).toBeTruthy();
    expect(screen.getByTestId('connect-serial-device')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Use and connect' })).toBeTruthy();
    for (const gone of ['Retry', 'Edit host', 'Show log', 'Hide log']) {
      expect(screen.queryByRole('button', { name: gone }), gone).toBeNull();
    }
    expect(screen.queryByText('Host settings')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a port that was set and has gone stays a failure, with Retry and the log', () => {
    show({ code: 'serial-device-missing', message: 'x', details: { device: 'COM3' } });
    expect(screen.getByTestId('connect-screen').getAttribute('data-state')).toBe('failed');
    expect(screen.getByRole('alert').textContent).toMatch(/COM3 is not on this computer/);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide log' })).toBeTruthy();
    expect(screen.getByTestId('connect-serial-device')).toBeTruthy();
  });
});

describe('the connection screen fixes a failure in place (#532)', () => {
  it('a network failure keeps Retry the main button and asks for nothing', () => {
    show({ code: 'ssh-connect-failed', message: 'x', details: { reason: 'refused', phase: 'tcp' } });
    expect(isPrimary('Retry')).toBe(true);
    expect(screen.queryByTestId('connect-password')).toBeNull();
    expect(screen.queryByTestId('connect-sign-in')).toBeNull();
  });

  it('a refused password asks for it inline, stores it under the host secret, then retries', async () => {
    const onRetry = show({ code: 'ssh-auth-failed', message: 'x', details: { user: 'tester', tried: ['password'] } });
    expect(isPrimary('Retry')).toBe(false);
    const field = screen.getByLabelText('Password for tester');
    expect(field).toHaveProperty('type', 'password');
    setSecret.mockResolvedValue({ ok: true, value: {} });
    fireEvent.change(field, { target: { value: 'right-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and retry' }));
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledOnce();
    });
    expect(setSecret).toHaveBeenCalledWith({ name: 'box_pw', value: 'right-pw' });
    // Nothing of the value stays on the screen.
    expect(screen.getByLabelText('Password for tester')).toHaveProperty('value', '');
    expect(document.body.textContent).not.toContain('right-pw');
  });

  it('no stored password is a sign-in step: Connect uses it once and stores nothing (#721)', () => {
    const onPassword = vi.fn();
    const onRetry = vi.fn();
    render(
      <ConnectScreen
        hostId="box"
        purpose="terminal"
        view={failed({ code: 'secret-missing', message: 'x', details: { name: 'box_pw' } })}
        onRetry={onRetry}
        onPassword={onPassword}
        onEditHost={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId('connect-screen').getAttribute('data-state')).toBe('sign-in');
    expect(screen.getByRole('heading', { name: 'Sign in to box' })).toBeTruthy();
    expect(screen.queryByText('Host settings')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    for (const gone of ['Retry', 'Show log', 'Hide log']) {
      expect(screen.queryByRole('button', { name: gone }), gone).toBeNull();
    }
    expect(screen.getByLabelText<HTMLInputElement>('Remember on this machine').checked).toBe(false);
    fireEvent.change(screen.getByLabelText('Password for tester'), { target: { value: 'once-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onPassword).toHaveBeenCalledWith('once-pw');
    expect(setSecret).not.toHaveBeenCalled();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('Remember on this machine stores the password, then retries (#721)', async () => {
    const onPassword = vi.fn();
    const onRetry = vi.fn();
    render(
      <ConnectScreen
        hostId="box"
        purpose="terminal"
        view={failed({ code: 'secret-missing', message: 'x', details: { name: 'box_pw' } })}
        onRetry={onRetry}
        onPassword={onPassword}
        onEditHost={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    setSecret.mockResolvedValue({ ok: true, value: {} });
    fireEvent.click(screen.getByLabelText('Remember on this machine'));
    fireEvent.change(screen.getByLabelText('Password for tester'), { target: { value: 'kept-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledOnce();
    });
    expect(setSecret).toHaveBeenCalledWith({ name: 'box_pw', value: 'kept-pw' });
    expect(onPassword).not.toHaveBeenCalled();
  });

  it('a refused store says why and does not retry', async () => {
    const onRetry = show({ code: 'ssh-auth-failed', message: 'x' });
    setSecret.mockResolvedValue({ ok: false, error: { code: 'secret-store-failed', message: 'The store is locked' } });
    fireEvent.change(screen.getByLabelText('Password for tester'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and retry' }));
    expect(await screen.findByText('The store is locked')).toBeTruthy();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a host with no user shows no steps and asks who to sign in as; unsaved, it signs this pane in', () => {
    useHostsStore.setState({ resolved: [resolved(undefined)] });
    const save = vi.fn();
    useHostsStore.setState({ save });
    const onRetry = show({ code: 'ssh-host-incomplete', message: 'x', details: { hostId: 'box', field: 'user' } });
    expect(screen.getByText('Host settings')).toBeTruthy();
    expect(screen.getByRole('list', { hidden: true }).className).toContain('hidden');
    expect(isPrimary('Retry')).toBe(false);
    fireEvent.change(screen.getByLabelText('Sign in as'), { target: { value: 'tester' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(useConnectStore.getState().users).toEqual({ pa: 'tester' });
    expect(save).not.toHaveBeenCalled();
  });

  it('Save to host writes the user into the host through the hosts file, then connects', async () => {
    useHostsStore.setState({ resolved: [resolved(undefined)] });
    const save = vi.fn().mockResolvedValue(true);
    useHostsStore.setState({ save });
    const onRetry = show({ code: 'ssh-host-incomplete', message: 'x', details: { hostId: 'box', field: 'user' } });
    fireEvent.change(screen.getByLabelText('Sign in as'), { target: { value: 'tester' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save to host' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledOnce();
    });
    expect(save).toHaveBeenCalledWith({
      ...FILE,
      hosts: [{ ...FILE.hosts[0], ssh: { port: 2222, user: 'tester' } }],
    });
    expect(useConnectStore.getState().users).toEqual({});
  });

  it('a user with a space is refused before anything connects', () => {
    useHostsStore.setState({ resolved: [resolved(undefined)] });
    const onRetry = show({ code: 'ssh-host-incomplete', message: 'x', details: { hostId: 'box', field: 'user' } });
    fireEvent.change(screen.getByLabelText('Sign in as'), { target: { value: 'a b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(screen.getByText('Enter a user name without spaces.')).toBeTruthy();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a setting with no inline fix makes Edit host the main button', () => {
    show({ code: 'ssh-jump-unknown', message: 'x' });
    expect(isPrimary('Edit host')).toBe(true);
    expect(isPrimary('Retry')).toBe(false);
  });

  it('the failed log pins its summary above the lines (#590)', () => {
    show({ code: 'ssh-auth-failed', message: 'x' });
    const log = screen.getByTestId('connect-log');
    expect(log.firstElementChild?.getAttribute('data-testid')).toBe('connect-log-summary');
    expect(screen.getByTestId('connect-log-summary').textContent).toContain('refused the password');
    // Main flagged no line here, so none is marked: the summary says what failed.
    expect(log.querySelectorAll('[data-failing="true"]')).toHaveLength(0);
  });

  it('a failure with nothing logged shows its summary alone, without "Nothing logged yet." (S67)', () => {
    show({ code: 'ssh-auth-failed', message: 'x' });
    expect(screen.getByTestId('connect-log').textContent).not.toContain('Nothing logged yet.');
  });
});

describe('a quick connect (#716)', () => {
  it('names the typed user@address:port, never the internal id', () => {
    const id = useQuickHostsStore.getState().add({ address: '127.0.0.1', port: 35481, user: 'nobody' });
    useHostsStore.setState({ resolved: [] });
    render(
      <ConnectScreen
        hostId={id}
        purpose="terminal"
        view={failed({ code: 'ssh-auth-failed', message: 'x' })}
        onRetry={vi.fn()}
        onEditHost={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const screenText = screen.getByTestId('connect-screen').textContent ?? '';
    expect(screenText).toContain('nobody@127.0.0.1:35481');
    expect(screenText).not.toContain('quick-');
  });
});

describe('failingLine', () => {
  const line = (text: string, error?: true) => ({ at: 1, text, ...(error ? { error } : {}) });
  it('is the last line main flagged', () => {
    expect(failingLine([line('a'), line('Auth failed', true), line('b'), line('Late', true)])).toBe(3);
    expect(failingLine([line('a'), line('Auth failed', true), line('b')])).toBe(1);
  });
  it('is none when main flagged nothing', () => {
    expect(failingLine([line('a')])).toBeUndefined();
  });
});

describe('the connection screen and identities (#416)', () => {
  const IDENTITY_FILE: HostsFileWire = {
    version: 1,
    identities: [{ id: 'ops', name: 'Ops', auth: { kind: 'password', secret: 'ops_pw' } }],
    groups: [],
    hosts: [{ id: 'box', name: 'box', address: '127.0.0.1', tags: [], ssh: { port: 2222, identity: 'ops' } }],
  };
  /** `box` signing in through identity `ops`, which gives it its password and, unless `user`, no user. */
  function throughIdentity(user: string | undefined): ResolvedHostWire {
    const host = resolved(user);
    return {
      ...host,
      ssh: {
        ...host.ssh,
        identity: { value: 'ops', from: 'host' },
        auth: { value: { kind: 'password', secret: 'ops_pw' }, from: { identity: 'ops' } },
      },
    };
  }

  it('a refused password from an identity is saved for the identity, and says so', async () => {
    useHostsStore.setState({ resolved: [throughIdentity('tester')], file: IDENTITY_FILE });
    const onRetry = show({ code: 'ssh-auth-failed', message: 'x', details: { user: 'tester', tried: ['password'] } });
    expect(screen.getByText('Saved for the identity Ops: every host that uses it signs in with it.')).toBeTruthy();
    setSecret.mockResolvedValue({ ok: true, value: {} });
    fireEvent.change(screen.getByLabelText('Password for tester'), { target: { value: 'new-pw' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save and retry' }));
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledOnce();
    });
    expect(setSecret).toHaveBeenCalledWith({ name: 'ops_pw', value: 'new-pw' });
  });

  it('a host whose identity has no user offers saving the user to the identity', async () => {
    useHostsStore.setState({ resolved: [throughIdentity(undefined)], file: IDENTITY_FILE });
    const save = vi.fn().mockResolvedValue(true);
    useHostsStore.setState({ save });
    const onRetry = show({ code: 'ssh-host-incomplete', message: 'x', details: { hostId: 'box', field: 'user' } });
    fireEvent.change(screen.getByLabelText('Sign in as'), { target: { value: 'tester' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Save to identity Ops' }));
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => {
      expect(onRetry).toHaveBeenCalledOnce();
    });
    expect(save).toHaveBeenCalledWith({
      ...IDENTITY_FILE,
      identities: [{ id: 'ops', name: 'Ops', auth: { kind: 'password', secret: 'ops_pw' }, user: 'tester' }],
    });
  });
});
