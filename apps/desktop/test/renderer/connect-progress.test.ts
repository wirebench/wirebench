import { describe, expect, it } from 'vitest';
import type { SshConnectProgressWire } from '../../src/shared/ssh-wire.js';
import {
  connectedView,
  failedView,
  formatDuration,
  reduceProgress,
  startView,
  stepDuration,
  stepLabel,
  trustView,
} from '../../src/renderer/features/ssh/connect-progress.js';
import type { ConnectView } from '../../src/renderer/features/ssh/connect-progress.js';
import { connectFailureSentence } from '../../src/renderer/features/ssh/connect-errors.js';

type PhaseEvent = Extract<SshConnectProgressWire, { kind: 'phase' }>;

const HOST = '10.0.4.12:22';
const phase = (p: PhaseEvent['phase'], state: 'start' | 'done', at: number, extra: Partial<PhaseEvent> = {}) =>
  ({ kind: 'phase', phase: p, state, hop: 0, hops: 1, host: HOST, at, ...extra }) satisfies PhaseEvent;
const log = (line: string, at: number, extra: { hop?: number; hops?: number; host?: string } = {}) =>
  ({ kind: 'log', hop: 0, hops: 1, host: HOST, at, line, ...extra }) satisfies SshConnectProgressWire;

function fold(view: ConnectView, events: readonly SshConnectProgressWire[]): ConnectView {
  return events.reduce(reduceProgress, view);
}
const states = (view: ConnectView) => view.steps.map((s) => `${s.id}:${s.state}`);

/** A target-only connect up to the shell starting. */
const THROUGH_AUTH: SshConnectProgressWire[] = [
  phase('resolve', 'start', 1000),
  phase('resolve', 'done', 1010, { detail: '10.0.4.12' }),
  phase('tcp', 'start', 1010),
  phase('tcp', 'done', 1030, { detail: '10.0.4.12:22' }),
  phase('banner', 'start', 1030),
  phase('banner', 'done', 1050, { detail: 'OpenSSH_9.6' }),
  phase('host-key', 'start', 1050, { detail: 'ssh-ed25519 SHA256:abc' }),
  phase('host-key', 'done', 1055, { detail: 'trusted' }),
  phase('auth', 'start', 1055),
  phase('auth', 'start', 1056, { detail: 'key id_ed25519' }),
  phase('auth', 'done', 1100, { detail: 'key id_ed25519' }),
  phase('shell', 'start', 1100),
];

describe('the connect phase reducer', () => {
  it('starts with the address resolving and every later step pending', () => {
    const view = startView('a1', 'terminal', 1000);
    expect(states(view)).toEqual([
      'resolve:running',
      'connect:pending',
      'host-key:pending',
      'auth:pending',
      'shell:pending',
    ]);
    expect(view.outcome).toEqual({ kind: 'running' });
  });

  it('walks the steps in order, TCP and the banner together as Connecting, with durations', () => {
    const view = fold(startView('a1', 'terminal', 1000), THROUGH_AUTH);
    expect(states(view)).toEqual(['resolve:done', 'connect:done', 'host-key:done', 'auth:done', 'shell:running']);
    const [resolve, connect, hostKey, auth] = view.steps;
    expect(stepDuration(resolve!)).toBe(10);
    expect(connect).toMatchObject({ detail: 'OpenSSH_9.6' });
    expect(stepDuration(connect!)).toBe(40);
    expect(hostKey).toMatchObject({ detail: 'trusted' });
    expect(auth).toMatchObject({ detail: 'key id_ed25519' });
    expect(stepDuration(auth!)).toBe(45);
  });

  it('a step that never reported is closed when a later one starts', () => {
    const view = fold(startView('a1', 'terminal', 1000), [phase('auth', 'start', 1200)]);
    expect(states(view)).toEqual(['resolve:done', 'connect:done', 'host-key:done', 'auth:running', 'shell:pending']);
  });

  it('keeps the flag on a line that says what failed', () => {
    const view = reduceProgress(startView('a1', 'terminal', 1000), { ...log('password refused', 1001), error: true });
    expect(view.log).toEqual([{ at: 1001, text: 'password refused', error: true }]);
  });

  it("keeps the log in order and marks a jump host's lines with its address", () => {
    const view = fold(startView('a1', 'terminal', 1000), [
      log('Resolving bastion', 1001, { hop: 0, hops: 2, host: 'bastion:22' }),
      log('Server allows: publickey', 1002, { hop: 1, hops: 2 }),
    ]);
    expect(view.log).toEqual([
      { at: 1001, text: '[bastion:22] Resolving bastion' },
      { at: 1002, text: 'Server allows: publickey' },
    ]);
  });

  it("a jump host's stages read as Connecting, and the target's resolve does not reopen the first step", () => {
    const jump = { hop: 0, hops: 2, host: 'bastion:22' };
    const target = { hop: 1, hops: 2 };
    const view = fold(startView('a1', 'terminal', 1000), [
      phase('resolve', 'start', 1000, jump),
      phase('resolve', 'done', 1005, { ...jump, detail: '192.0.2.1' }),
      phase('tcp', 'start', 1005, jump),
      phase('auth', 'start', 1020, jump),
      phase('auth', 'done', 1040, jump),
      phase('resolve', 'start', 1040, target),
      phase('resolve', 'done', 1040, { ...target, detail: 'by the jump host' }),
      phase('tcp', 'start', 1040, { ...target, detail: 'through bastion:22' }),
    ]);
    expect(states(view)).toEqual([
      'resolve:done',
      'connect:running',
      'host-key:pending',
      'auth:pending',
      'shell:pending',
    ]);
    expect(view.steps[0]).toMatchObject({ detail: '192.0.2.1' });
    expect(view.steps[1]).toMatchObject({ detail: 'through bastion:22' });
  });

  it('connected: every step done and the outcome holds when', () => {
    const view = connectedView(fold(startView('a1', 'terminal', 1000), THROUGH_AUTH), 1120);
    expect(states(view).every((s) => s.endsWith(':done'))).toBe(true);
    expect(view.outcome).toEqual({ kind: 'connected', at: 1120 });
    expect(view.steps[4]).toMatchObject({ startedAt: 1100, endedAt: 1120 });
  });

  it('after the attempt ended, ignores stages but keeps log lines that land late', () => {
    const done = connectedView(startView('a1', 'terminal', 1000), 1100);
    expect(reduceProgress(done, phase('shell', 'start', 1200))).toBe(done);
    expect(reduceProgress(done, log('late', 1200)).log).toEqual([{ at: 1200, text: 'late' }]);
  });

  it('a refused port fails Connecting, leaves the rest pending and says what to do', () => {
    const running = fold(startView('a1', 'terminal', 1000), THROUGH_AUTH.slice(0, 3));
    const view = failedView(
      running,
      {
        code: 'ssh-connect-failed',
        message: '10.0.4.12:22: connect ECONNREFUSED 10.0.4.12:22',
        details: { host: HOST, hop: 0, hops: 1, reason: 'refused', phase: 'tcp' },
      },
      1040,
    );
    expect(states(view)).toEqual([
      'resolve:done',
      'connect:failed',
      'host-key:pending',
      'auth:pending',
      'shell:pending',
    ]);
    expect(view.outcome).toMatchObject({ kind: 'failed', step: 'connect' });
    const sentence = view.outcome.kind === 'failed' ? view.outcome.sentence : '';
    expect(sentence).toContain('refused the connection on port 22');
    expect(sentence).not.toContain('ECONNREFUSED');
    // The log ends with the same sentence, flagged as the error.
    expect(view.log.at(-1)).toEqual({ at: 1040, text: sentence, error: true });
  });

  it('an auth refusal fails Authenticating whatever ran last', () => {
    const view = failedView(startView('a1', 'terminal', 1000), { code: 'ssh-auth-failed', message: 'x' }, 1100);
    expect(view.outcome).toMatchObject({ kind: 'failed', step: 'auth' });
    expect(states(view).slice(0, 3)).toEqual(['resolve:done', 'connect:done', 'host-key:done']);
  });

  it("a failure on a jump host is laid on Connecting, not on the target's sign-in", () => {
    const resolved = fold(startView('a1', 'terminal', 1000), [phase('resolve', 'done', 1001)]);
    const view = failedView(
      resolved,
      { code: 'ssh-auth-failed', message: 'x', details: { host: 'bastion:22', hop: 0, hops: 2 } },
      1100,
    );
    expect(view.outcome).toMatchObject({ kind: 'failed', step: 'connect' });
  });

  it('a host key waits on the trust prompt; the step is held, not failed', () => {
    const view = trustView(fold(startView('a1', 'terminal', 1000), THROUGH_AUTH.slice(0, 7)), false, 1060);
    expect(states(view)).toEqual(['resolve:done', 'connect:done', 'host-key:waiting', 'auth:pending', 'shell:pending']);
    expect(view.outcome).toEqual({ kind: 'trust', changed: false });
  });

  it('names the last step after what it opens', () => {
    expect(stepLabel('shell', 'terminal')).toBe('Starting shell');
    expect(stepLabel('shell', 'files')).toBe('Starting SFTP');
  });

  it('formats durations in ms below a second and s above', () => {
    expect(formatDuration(12)).toBe('12 ms');
    expect(formatDuration(1400)).toBe('1.4 s');
    expect(formatDuration(12_000)).toBe('12 s');
  });
});

describe('the connect error mapping', () => {
  const sentence = (code: string, details: Record<string, unknown> = {}) =>
    connectFailureSentence({ code, message: 'raw library text', details }, 'terminal');

  it('never shows the raw message', () => {
    for (const code of ['ssh-connect-failed', 'ssh-auth-failed', 'something-new']) {
      expect(sentence(code, { host: HOST })).not.toContain('raw library text');
    }
  });

  it('DNS: the name could not be found', () => {
    expect(sentence('ssh-connect-failed', { host: 'db.internal:22', reason: 'dns' })).toBe(
      "The address db.internal could not be found. Check the host's address, your DNS or your VPN.",
    );
  });

  it('refused: nothing listens on the port', () => {
    expect(sentence('ssh-connect-failed', { host: HOST, reason: 'refused' })).toContain(
      '10.0.4.12:22 refused the connection on port 22',
    );
  });

  it('timeout: no answer after the configured seconds', () => {
    expect(sentence('ssh-connect-failed', { host: HOST, reason: 'timeout', timeout: 10 })).toMatch(
      /^No answer from 10\.0\.4\.12:22 after 10 s\./,
    );
  });

  it('host key mismatch: says it changed and to check before trusting', () => {
    expect(sentence('ssh-host-key-changed', { host: HOST, previous: 'SHA256:old' })).toContain(
      'changed since you last trusted it',
    );
  });

  it('auth rejected with another method allowed: names it', () => {
    expect(
      sentence('ssh-auth-failed', {
        host: HOST,
        user: 'deploy',
        tried: ['password'],
        allowed: ['publickey', 'password'],
      }),
    ).toBe("10.0.4.12:22 refused the password for deploy; it allows publickey. Change the host's sign-in method.");
  });

  it('no methods left: the key was refused and nothing else is allowed', () => {
    expect(
      sentence('ssh-auth-failed', {
        host: HOST,
        user: 'deploy',
        tried: ['publickey'],
        allowed: ['publickey'],
        key: 'id_ed25519',
        method: 'key',
      }),
    ).toBe(
      "10.0.4.12:22 refused key id_ed25519 for deploy and allows no other method (publickey). Check the key in the host's settings.",
    );
  });

  it('jump host failure: names the jump host and the target', () => {
    expect(sentence('ssh-connect-failed', { host: HOST, reason: 'jump', via: 'bastion:22', hop: 1, hops: 2 })).toBe(
      "The jump host bastion:22 could not open a connection to 10.0.4.12:22. Check the target's address and port from the jump host.",
    );
    expect(sentence('ssh-connect-failed', { host: 'bastion:22', reason: 'refused', hop: 0, hops: 2 })).toMatch(
      /^The jump host bastion:22 refused the connection/,
    );
  });

  it('a missing agent and a missing secret say what to set up', () => {
    expect(sentence('ssh-auth-failed', { agent: 'missing', method: 'agent' })).toMatch(/^No SSH agent is running/);
    expect(sentence('secret-missing', { name: 'box_pw' })).toContain('"box_pw" is not on this machine');
  });

  it('an unknown code falls back to a generic sentence', () => {
    expect(sentence('brand-new-code')).toBe('The connection could not be started. The log below shows how far it got.');
    expect(connectFailureSentence({ code: 'x', message: 'y' }, 'files')).toMatch(/^The file browser could not connect/);
  });
});
