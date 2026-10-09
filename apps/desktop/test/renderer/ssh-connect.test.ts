import { beforeEach, expect, it, vi } from 'vitest';

const connect = vi.fn();
const trustHostKey = vi.fn();
vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({ ssh: { connect, trustHostKey } }) }));
import { confirmTrust, connectToHost } from '../../src/renderer/features/ssh/connect.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';

const SIZE = { cols: 80, rows: 24 };
const NEW_KEY = {
  ok: false,
  error: {
    code: 'ssh-host-key-new',
    message: 'untrusted',
    details: { host: 'h:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' },
  },
};

beforeEach(() => {
  useHostsStore.setState({ sessions: {}, trustPrompt: null });
  useProblemsStore.setState({ items: [] });
  connect.mockReset();
  trustHostKey.mockReset();
});

it('a new host key opens the trust prompt; confirming trusts then connects', async () => {
  connect.mockResolvedValueOnce(NEW_KEY);
  expect(await connectToHost('a', SIZE)).toBeUndefined();
  expect(useHostsStore.getState().trustPrompt).toMatchObject({ hostId: 'a', fingerprint: 'SHA256:k' });
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
  expect(useHostsStore.getState().sessions['a']).toEqual({ sessionId: 's1', state: 'open' });
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
  await connectToHost('a', SIZE);
  expect(useHostsStore.getState().trustPrompt?.previous).toBe('SHA256:old');
});

it('any other error clears the connecting state and records a problem', async () => {
  connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
  await connectToHost('a', SIZE);
  expect(useHostsStore.getState().sessions['a']).toBeUndefined();
  expect(useProblemsStore.getState().items).toMatchObject([
    { groupId: 'ssh:a', source: 'hosts', problem: { code: 'ssh-auth-failed', message: 'nope' } },
  ]);
});

it('a trust refused because the key changed meanwhile reopens the prompt with the new details', async () => {
  connect.mockResolvedValueOnce(NEW_KEY);
  await connectToHost('a', SIZE);
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
  await connectToHost('a', SIZE);
  trustHostKey.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-host-key-unexpected', message: 'again' } });
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's2' } });
  expect(await confirmTrust(false)).toEqual({ sessionId: 's2' });
  expect(connect).toHaveBeenCalledTimes(2);
  expect(useProblemsStore.getState().items).toEqual([]);
});

it('any other trust failure records a problem', async () => {
  connect.mockResolvedValueOnce(NEW_KEY);
  await connectToHost('a', SIZE);
  trustHostKey.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-known-hosts-write', message: 'disk' } });
  expect(await confirmTrust(false)).toBeUndefined();
  expect(connect).toHaveBeenCalledTimes(1);
  expect(useProblemsStore.getState().items).toMatchObject([
    { groupId: 'ssh:a', source: 'hosts', problem: { code: 'ssh-known-hosts-write' } },
  ]);
});

it('a failure then a success leaves no problem for the host', async () => {
  connect.mockResolvedValueOnce({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
  await connectToHost('a', SIZE);
  connect.mockResolvedValueOnce({ ok: true, value: { sessionId: 's1' } });
  await connectToHost('a', SIZE);
  expect(useProblemsStore.getState().items).toEqual([]);
});

it('two failures leave exactly one problem for the host', async () => {
  connect.mockResolvedValue({ ok: false, error: { code: 'ssh-auth-failed', message: 'nope' } });
  await connectToHost('a', SIZE);
  await connectToHost('a', SIZE);
  expect(useProblemsStore.getState().items).toHaveLength(1);
});

it('a host that is open or connecting is not connected twice', async () => {
  useHostsStore.setState({ sessions: { a: { sessionId: 's1', state: 'open' }, b: { state: 'connecting' } } });
  expect(await connectToHost('a', SIZE)).toEqual({ sessionId: 's1' });
  expect(await connectToHost('b', SIZE)).toBeUndefined();
  expect(connect).not.toHaveBeenCalled();
});

it('a rejected connect clears the connecting state and records a problem', async () => {
  connect.mockRejectedValueOnce(new Error('bridge down'));
  expect(await connectToHost('a', SIZE)).toBeUndefined();
  expect(useHostsStore.getState().sessions['a']).toBeUndefined();
  expect(useProblemsStore.getState().items).toMatchObject([
    { groupId: 'ssh:a', problem: { code: 'ssh-connect-failed', message: 'bridge down' } },
  ]);
});
