import { afterEach, describe, expect, it } from 'vitest';
import {
  beginAttempt,
  dropAttempt,
  failWaitingAttempt,
  noteConnected,
  noteFailed,
  noteProgress,
  noteTrust,
  useConnectStore,
} from '../../src/renderer/features/ssh/connect-store.js';

const LOG = { kind: 'log', hop: 0, hops: 1, host: 'h:22', at: 1, line: 'Resolving h' } as const;
const view = (key: string) => useConnectStore.getState().views[key];

afterEach(() => {
  useConnectStore.setState({ views: {}, attempts: {} });
});

describe('the connection screens store', () => {
  it("routes main's progress to the pane whose attempt it names", () => {
    const one = beginAttempt('pane-1', 'terminal');
    beginAttempt('pane-2', 'files');
    noteProgress(one, LOG);
    expect(view('pane-1')?.log.map((l) => l.text)).toEqual(['Resolving h']);
    expect(view('pane-2')?.log).toEqual([]);
    expect(view('pane-2')?.purpose).toBe('files');
  });

  it("a newer attempt on the pane takes the screen: the older one's progress and end are ignored", () => {
    const old = beginAttempt('pane-1', 'terminal');
    const current = beginAttempt('pane-1', 'terminal');
    noteProgress(old, LOG);
    noteFailed('pane-1', old, { code: 'ssh-auth-failed', message: 'x' });
    expect(view('pane-1')).toMatchObject({ attemptId: current, log: [], outcome: { kind: 'running' } });
    noteConnected('pane-1', current);
    expect(view('pane-1')?.outcome.kind).toBe('connected');
  });

  it('a prompt closed without trusting fails the attempt waiting on it, and only that one', () => {
    const id = beginAttempt('pane-1', 'terminal');
    failWaitingAttempt('pane-1', { code: 'ssh-host-key-new', message: '' });
    expect(view('pane-1')?.outcome.kind).toBe('running');
    noteTrust('pane-1', id, false);
    failWaitingAttempt('pane-1', { code: 'ssh-host-key-new', message: '', details: { host: 'h:22' } });
    expect(view('pane-1')?.outcome).toMatchObject({ kind: 'failed', step: 'host-key' });
  });

  it('dropping a screen forgets its attempt', () => {
    const id = beginAttempt('pane-1', 'terminal');
    dropAttempt('pane-1');
    expect(view('pane-1')).toBeUndefined();
    expect(useConnectStore.getState().attempts[id]).toBeUndefined();
    noteProgress(id, LOG);
    expect(view('pane-1')).toBeUndefined();
  });
});
