import { beforeEach, expect, it, vi } from 'vitest';
import {
  __dispatchForTest as dispatch,
  attachTerminal,
  bytesToBase64,
  detachTerminal,
} from '../../src/renderer/features/ssh/terminal-session.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';

beforeEach(() => {
  useHostsStore.setState({ sessions: {} });
});

it('buffers data before attach, streams after, and forwards exit', () => {
  dispatch('ssh.data', { sessionId: 's', data: bytesToBase64(new Uint8Array([97, 98])) });
  const write = vi.fn();
  const exit = vi.fn();
  attachTerminal('s', { write, exit });
  expect(write).toHaveBeenCalledWith(new Uint8Array([97, 98]));
  dispatch('ssh.data', { sessionId: 's', data: bytesToBase64(new Uint8Array([99])) });
  expect(write).toHaveBeenLastCalledWith(new Uint8Array([99]));
  dispatch('ssh.exit', { sessionId: 's', code: 0 });
  expect(exit).toHaveBeenCalledWith(0);
  detachTerminal('s');
  expect(() => {
    dispatch('ssh.data', { sessionId: 's', data: 'ZA==' });
  }).not.toThrow();
  detachTerminal('s');
});

it('replays an exit that arrived before attach', () => {
  dispatch('ssh.exit', { sessionId: 't', code: null });
  const exit = vi.fn();
  attachTerminal('t', { write: vi.fn(), exit });
  expect(exit).toHaveBeenCalledWith(null);
  detachTerminal('t');
});

it('keeps at most 1 MiB of unattached output, dropping the oldest', () => {
  const chunk = (fill: number) => bytesToBase64(new Uint8Array(512 * 1024).fill(fill));
  dispatch('ssh.data', { sessionId: 'u', data: bytesToBase64(new Uint8Array([1])) });
  dispatch('ssh.data', { sessionId: 'u', data: chunk(2) });
  dispatch('ssh.data', { sessionId: 'u', data: chunk(3) });
  const write = vi.fn<(data: Uint8Array) => void>();
  attachTerminal('u', { write, exit: vi.fn() });
  expect(write.mock.calls.map(([data]) => [data[0], data.length])).toEqual([
    [2, 512 * 1024],
    [3, 512 * 1024],
  ]);
  detachTerminal('u');
});

it('drops events that arrive for a session after it was detached', () => {
  attachTerminal('v', { write: vi.fn(), exit: vi.fn() });
  detachTerminal('v');
  dispatch('ssh.data', { sessionId: 'v', data: bytesToBase64(new Uint8Array([7])) });
  dispatch('ssh.exit', { sessionId: 'v', code: 0 });
  const write = vi.fn();
  const exit = vi.fn();
  attachTerminal('v', { write, exit });
  expect(write).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  detachTerminal('v');
});

it('base64 round-trips UTF-8 input', () => {
  const bytes = new TextEncoder().encode('ls -la ✓');
  expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
});

it('a closed session marks its host closed and leaves other hosts alone', () => {
  useHostsStore.setState({
    sessions: { a: { sessionId: 's1', state: 'open' }, b: { sessionId: 's2', state: 'open' } },
  });
  useHostsStore.getState().noteSessionState('s1', 'closed');
  expect(useHostsStore.getState().sessions).toEqual({
    a: { sessionId: 's1', state: 'closed' },
    b: { sessionId: 's2', state: 'open' },
  });
});
