import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const setSecret = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { setSecret } }) }));
import { ConnectScreen, failingLine } from '../../src/renderer/features/ssh/connect-screen.js';
import { beginAttempt, noteFailed, useConnectStore } from '../../src/renderer/features/ssh/connect-store.js';
import type { ConnectError } from '../../src/renderer/features/ssh/connect-errors.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
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
      proxy: { value: undefined, from: 'default' },
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

  it('the failed log marks the failing line', () => {
    show({ code: 'ssh-auth-failed', message: 'x' });
    const marked = screen.getByTestId('connect-log').querySelectorAll('[data-failing="true"]');
    expect(marked).toHaveLength(1);
    expect(marked[0]?.textContent).toContain('refused the password');
  });
});

describe('failingLine', () => {
  const line = (text: string, error?: true) => ({ at: 1, text, ...(error ? { error } : {}) });
  it('is the last line main flagged, ahead of the sentence the screen added', () => {
    const lines = [line('a'), line('Auth failed', true), line('b'), line('The sentence', true)];
    expect(failingLine(lines, 'The sentence')).toBe(1);
  });
  it('falls back to the sentence when main flagged nothing', () => {
    expect(failingLine([line('a'), line('The sentence', true)], 'The sentence')).toBe(1);
    expect(failingLine([line('a')], 'The sentence')).toBeUndefined();
  });
});
