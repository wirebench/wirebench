import { describe, expect, it } from 'vitest';
import { connectErrorKind, connectFix } from '../../src/renderer/features/ssh/connect-errors.js';
import type { ConnectError, SignIn } from '../../src/renderer/features/ssh/connect-errors.js';
import { failedView, startView } from '../../src/renderer/features/ssh/connect-progress.js';

const PASSWORD: SignIn = { hostId: 'box', user: 'tester', auth: { kind: 'password', secret: 'box_pw' } };
const KEY: SignIn = { hostId: 'box', user: 'tester', auth: { kind: 'key', secret: 'box_key' } };
const error = (code: string, details?: Record<string, unknown>): ConnectError => ({
  code,
  message: 'not shown',
  ...(details === undefined ? {} : { details }),
});

describe('connectErrorKind (#532)', () => {
  it.each([
    ['ssh-connect-failed', 'network'],
    ['ssh-auth-failed', 'auth'],
    ['ssh-cert-expired', 'auth'],
    ['ssh-host-incomplete', 'settings'],
    ['secret-missing', 'settings'],
    ['ssh-jump-unknown', 'settings'],
    ['ssh-jump-cycle', 'settings'],
    ['ssh-host-key-new', 'trust'],
    ['ssh-session-closed', 'other'],
    ['brand-new-code', 'other'],
  ])('%s is %s', (code, kind) => {
    expect(connectErrorKind(code)).toBe(kind);
  });
});

describe('connectFix (#532)', () => {
  it('a network failure keeps Retry primary and asks for nothing', () => {
    expect(connectFix(error('ssh-connect-failed', { reason: 'refused' }), PASSWORD)).toEqual({
      kind: 'network',
      retryPrimary: true,
    });
  });

  it('anything not auth or settings keeps Retry primary', () => {
    expect(connectFix(error('ssh-session-closed'), PASSWORD).retryPrimary).toBe(true);
    expect(connectFix(error('sftp-unavailable'), PASSWORD).retryPrimary).toBe(true);
  });

  it('a host with no user asks for one, with Retry secondary', () => {
    expect(connectFix(error('ssh-host-incomplete', { hostId: 'box', field: 'user' }), PASSWORD)).toEqual({
      kind: 'settings',
      retryPrimary: false,
      ask: 'user',
    });
  });

  it("a jump host's missing user is not asked for on the target's screen", () => {
    expect(connectFix(error('ssh-host-incomplete', { hostId: 'bastion', field: 'user' }), PASSWORD)).toEqual({
      kind: 'settings',
      retryPrimary: false,
    });
  });

  it('a missing sign-in method asks for nothing: it is chosen in the host settings', () => {
    expect(connectFix(error('ssh-host-incomplete', { hostId: 'box', field: 'auth' }), PASSWORD).ask).toBeUndefined();
  });

  it('a refused password asks for it again, for the user the server named', () => {
    expect(connectFix(error('ssh-auth-failed', { user: 'root', tried: ['password'] }), PASSWORD)).toEqual({
      kind: 'auth',
      retryPrimary: false,
      ask: 'password',
      secret: 'box_pw',
      user: 'root',
      missing: false,
    });
  });

  it("the host's user stands in when the refusal names none", () => {
    expect(connectFix(error('ssh-auth-failed'), PASSWORD)).toMatchObject({ ask: 'password', user: 'tester' });
  });

  it("the host's password secret missing on this machine asks for it", () => {
    expect(connectFix(error('secret-missing', { name: 'box_pw' }), PASSWORD)).toMatchObject({
      kind: 'settings',
      ask: 'password',
      secret: 'box_pw',
      missing: true,
    });
    // Another secret (an env variable's, say) is set in the settings.
    expect(connectFix(error('secret-missing', { name: 'token' }), PASSWORD).ask).toBeUndefined();
  });

  it('a refused key, a missing agent or a jump host refusal ask for no password', () => {
    expect(connectFix(error('ssh-auth-failed'), KEY)).toEqual({ kind: 'auth', retryPrimary: false });
    expect(connectFix(error('ssh-auth-failed', { agent: 'missing' }), PASSWORD).ask).toBeUndefined();
    expect(connectFix(error('ssh-auth-failed', { hop: 0, hops: 2 }), PASSWORD).ask).toBeUndefined();
  });

  it('without the host (gone from the file) it only places Retry', () => {
    expect(connectFix(error('ssh-auth-failed'), undefined)).toEqual({ kind: 'auth', retryPrimary: false });
  });
});

describe('failedView for a settings problem (#532)', () => {
  it('runs no step: every step is pending, the outcome names none and keeps the error', () => {
    const failure = error('ssh-host-incomplete', { hostId: 'box', field: 'user' });
    const view = failedView(startView('a1', 'terminal', 1000), failure, 1001);
    expect(view.steps.map((s) => s.state)).toEqual(['pending', 'pending', 'pending', 'pending', 'pending']);
    expect(view.outcome).toEqual({
      kind: 'failed',
      step: undefined,
      sentence: 'This host has no user to sign in as. Enter one to connect.',
      error: failure,
    });
  });
});
