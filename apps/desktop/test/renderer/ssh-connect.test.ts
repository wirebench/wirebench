import { beforeEach, expect, it, vi } from 'vitest';

const connect = vi.fn();
const trustHostKey = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { connect, trustHostKey } }) }));
import { confirmTrust, connectToHost, connectWithPin } from '../../src/renderer/features/ssh/connect.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { readRecent } from '../../src/renderer/features/ssh/recent-connections.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { WorkspaceWire } from '@wirebench/wire/wire-base';
import type { ResolvedHostWire } from '@wirebench/wire/ssh-wire';
import { setSignInUser, useConnectStore } from '../../src/renderer/features/ssh/connect-store.js';
import { useQuickHostsStore } from '../../src/renderer/features/ssh/quick-hosts.js';

const SIZE = { cols: 80, rows: 24 };
const A = { paneId: 'pa', hostId: 'a' };
const B = { paneId: 'pb', hostId: 'b' };
const NEW_KEY = {
  ok: false,
  error: {
    code: 'ssh-host-key-new',
    message: 'untrusted',
    details: { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' },
  },
};

beforeEach(() => {
  useHostsStore.setState({ panes: {}, trustPrompt: null });
  useProblemsStore.setState({ items: [] });
  connect.mockReset();
  trustHostKey.mockReset();
  localStorage.clear();
  useWorkspaceStore.setState({ workspace: { id: 'w1' } as WorkspaceWire });
});

it('a connect that opens or fails is recorded in the recent connections; a trust prompt is not', async () => {
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1' } });
  await connectToHost(A, SIZE);
  connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
  await connectToHost(B, SIZE);
  expect(readRecent('w1')).toMatchObject([
    { hostId: 'b', outcome: 'failed' },
    { hostId: 'a', outcome: 'connected' },
  ]);
  useHostsStore.setState({ panes: {} });
  connect.mockResolvedValueOnce(NEW_KEY);
  await connectToHost(A, SIZE);
  expect(readRecent('w1')[0]?.hostId).toBe('b');
});

it('a new host key opens the trust prompt; confirming trusts then connects', async () => {
  connect.mockResolvedValueOnce(NEW_KEY);
  expect(await connectToHost(A, SIZE)).toBeUndefined();
  expect(useHostsStore.getState().trustPrompt).toMatchObject({ paneId: 'pa', hostId: 'a', fingerprint: 'SHA256:k' });
  expect(useHostsStore.getState().trustPrompt?.previous).toBeUndefined();
  trustHostKey.mockResolvedValueOnce({ ok: true, value: {} });
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1' } });
  expect(await confirmTrust(false)).toEqual({ sessionId: 's1' });
  expect(trustHostKey).toHaveBeenCalledWith({
    host: 'h:22',
    keyType: 'ssh-ed25519',
    fingerprint: 'SHA256:k',
    replace: false,
  });
  expect(useHostsStore.getState().trustPrompt).toBeNull();
  expect(useHostsStore.getState().panes['pa']).toEqual({ hostId: 'a', sessionId: 's1', state: 'open' });
});

it('a changed key carries the previous fingerprint', async () => {
  connect.mockResolvedValueOnce({
    ok: false,
    error: {
      code: 'ssh-host-key-changed',
      message: 'changed',
      details: { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k', previous: 'SHA256:old' },
    },
  });
  await connectToHost(A, SIZE);
  expect(useHostsStore.getState().trustPrompt?.previous).toBe('SHA256:old');
});

it('any other error clears the connecting state and records a problem', async () => {
  connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
  await connectToHost(A, SIZE);
  expect(useHostsStore.getState().panes['pa']).toBeUndefined();
  expect(useProblemsStore.getState().items).toMatchObject([
    { groupId: 'ssh:a', source: 'hosts', problem: { code: 'ssh-auth-failed', message: 'nope' } },
  ]);
});

it('a trust refused because the key changed meanwhile reopens the prompt with the new details', async () => {
  connect.mockResolvedValueOnce(NEW_KEY);
  await connectToHost(A, SIZE);
  trustHostKey.mockResolvedValueOnce({
    ok: false,
    error: {
      code: 'ssh-host-key-changed',
      message: 'changed',
      details: { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k', previous: 'SHA256:other' },
    },
  });
  expect(await confirmTrust(false)).toBeUndefined();
  expect(useHostsStore.getState().trustPrompt).toMatchObject({
    hostId: 'a',
    size: SIZE,
    previous: 'SHA256:other',
  });
  expect(useProblemsStore.getState().items).toEqual([]);
});

it('a trust main no longer expects retries the connect once', async () => {
  connect.mockResolvedValueOnce(NEW_KEY);
  await connectToHost(A, SIZE);
  trustHostKey.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-host-key-unexpected', message: 'again' } });
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's2' } });
  expect(await confirmTrust(false)).toEqual({ sessionId: 's2' });
  expect(connect).toHaveBeenCalledTimes(2);
  expect(useProblemsStore.getState().items).toEqual([]);
});

it('any other trust failure records a problem', async () => {
  connect.mockResolvedValueOnce(NEW_KEY);
  await connectToHost(A, SIZE);
  trustHostKey.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-known-hosts-write', message: 'disk' } });
  expect(await confirmTrust(false)).toBeUndefined();
  expect(connect).toHaveBeenCalledTimes(1);
  expect(useProblemsStore.getState().items).toMatchObject([
    { groupId: 'ssh:a', source: 'hosts', problem: { code: 'ssh-known-hosts-write' } },
  ]);
});

it('a failure then a success leaves no problem for the host', async () => {
  connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
  await connectToHost(A, SIZE);
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1' } });
  await connectToHost(A, SIZE);
  expect(useProblemsStore.getState().items).toEqual([]);
});

it('two failures leave exactly one problem for the host', async () => {
  connect.mockResolvedValue({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
  await connectToHost(A, SIZE);
  await connectToHost(A, SIZE);
  expect(useProblemsStore.getState().items).toHaveLength(1);
});

it('a pane that is open or connecting is not connected twice', async () => {
  useHostsStore.setState({
    panes: { pa: { hostId: 'a', sessionId: 's1', state: 'open' }, pb: { hostId: 'b', state: 'connecting' } },
  });
  expect(await connectToHost(A, SIZE)).toEqual({ sessionId: 's1' });
  expect(await connectToHost(B, SIZE)).toBeUndefined();
  expect(connect).not.toHaveBeenCalled();
});

it('a rejected connect clears the connecting state and records a problem', async () => {
  connect.mockRejectedValueOnce(new Error('bridge down'));
  expect(await connectToHost(A, SIZE)).toBeUndefined();
  expect(useHostsStore.getState().panes['pa']).toBeUndefined();
  expect(useProblemsStore.getState().items).toMatchObject([
    { groupId: 'ssh:a', problem: { code: 'ssh-connect-failed', message: 'bridge down' } },
  ]);
});

it('a security key PIN goes with the pane’s next connect only (#420)', async () => {
  connect.mockResolvedValue({
    ok: false,
    error: { code: 'ssh-sk-pin', message: 'pin', details: { reason: 'required' } },
  });
  connectWithPin('pa', '2468');
  await connectToHost(A, SIZE);
  expect(connect.mock.calls[0]?.[0]).toMatchObject({ hostId: 'a', skPin: '2468' });
  await connectToHost(B, SIZE);
  await connectToHost(A, SIZE);
  expect(connect.mock.calls[1]?.[0]).not.toHaveProperty('skPin');
  expect(connect.mock.calls[2]?.[0]).not.toHaveProperty('skPin');
});

it('a host with no user connects nothing and fails as a settings problem; a typed user is sent (#532)', async () => {
  useHostsStore.setState({
    resolved: [{ id: 'a', name: 'a', incomplete: { field: 'user' } } as unknown as ResolvedHostWire],
  });
  expect(await connectToHost(A, SIZE)).toBeUndefined();
  expect(connect).not.toHaveBeenCalled();
  expect(useConnectStore.getState().views['pa']?.outcome).toMatchObject({
    kind: 'failed',
    step: undefined,
    error: { code: 'ssh-host-incomplete', details: { hostId: 'a', field: 'user' } },
  });
  expect(useProblemsStore.getState().items).toMatchObject([{ problem: { code: 'ssh-host-incomplete' } }]);

  setSignInUser('pa', 'typed');
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1' } });
  expect(await connectToHost(A, SIZE)).toEqual({ sessionId: 's1' });
  expect(connect).toHaveBeenCalledWith(expect.objectContaining({ hostId: 'a', user: 'typed' }));
  setSignInUser('pa', undefined);
  useHostsStore.setState({ resolved: [] });
});

it('a one-off server connects with its target and stays out of the recent connections (#537)', async () => {
  const hostId = useQuickHostsStore.getState().add({ address: 'h.example', port: 2222, user: 'me' });
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1' } });
  expect(await connectToHost({ paneId: 'pq', hostId }, SIZE)).toEqual({ sessionId: 's1' });
  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({ hostId, quick: { address: 'h.example', port: 2222, user: 'me' } }),
  );
  expect(readRecent('w1')).toEqual([]);
});
