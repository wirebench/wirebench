import { describe, expect, it, vi } from 'vitest';
import { CATCH_URL_DEFAULT_RESPONSE, signWebhook } from '@wirebench/engine';
import type { SignatureScheme } from '@wirebench/engine';
import type { PublicCatchUrl } from '../../../src/hooks/repo.js';
import { seal } from '../../../src/hooks/secret-box.js';
import { verifyCapture } from '../../../src/hooks/verify.js';

const KEY = Buffer.alloc(32, 7);
const SECRET = 'abc123def456ghi789';
const HMAC: SignatureScheme = { kind: 'hmac', algorithm: 'sha256', encoding: 'hex', header: 'X-Signature' };
const BODY = Buffer.from('{"event":"order.created"}');
const NOW = new Date('2026-09-24T12:00:00.000Z');

const hook = (signature?: PublicCatchUrl['signature']): PublicCatchUrl => ({
  id: 'h1',
  workspaceId: 'w1',
  enabled: true,
  response: CATCH_URL_DEFAULT_RESPONSE,
  rejectUnverified: false,
  ...(signature !== undefined ? { signature } : {}),
});
const env = (secretKey?: Buffer) => ({ settings: secretKey === undefined ? {} : { secretKey }, now: () => NOW });
const log = () => ({ error: vi.fn() });
const headers = (secret = SECRET): [string, string][] => signWebhook(HMAC, secret, BODY).map(([n, v]) => [n, v]);

describe('verifyCapture (§3.3 step 1)', () => {
  it('is null when the catch URL checks nothing', () => {
    const logged = log();
    expect(verifyCapture(env(KEY), hook(), headers(), BODY, logged)).toBeNull();
    expect(logged.error).not.toHaveBeenCalled();
  });

  it('verifies with the opened secret, and fails a wrong one', () => {
    const signed = hook({ scheme: HMAC, sealedSecret: seal(KEY, SECRET) });
    expect(verifyCapture(env(KEY), signed, headers(), BODY, log())).toEqual({ verdict: 'verified' });
    expect(verifyCapture(env(KEY), signed, headers('zzz999yyy888xxx777'), BODY, log())).toEqual({
      verdict: 'failed',
      reason: 'mismatch',
    });
  });

  it('is key-error without a key, under the wrong key (logged without the secret), and for an unreadable scheme', () => {
    const signed = hook({ scheme: HMAC, sealedSecret: seal(Buffer.alloc(32, 9), SECRET) });
    expect(verifyCapture(env(), signed, headers(), BODY, log())).toEqual({ verdict: 'failed', reason: 'key-error' });
    const logged = log();
    expect(verifyCapture(env(KEY), signed, headers(), BODY, logged)).toEqual({
      verdict: 'failed',
      reason: 'key-error',
    });
    expect(logged.error).toHaveBeenCalledTimes(1);
    // The log call carries content (the hook id and the message) before we assert the secret is absent.
    expect(JSON.stringify(logged.error.mock.calls)).toContain('could not open a catch URL signature secret');
    expect(JSON.stringify(logged.error.mock.calls)).toContain('h1');
    expect(JSON.stringify(logged.error.mock.calls)).not.toContain(SECRET);
    const unreadable = hook({ scheme: undefined, sealedSecret: seal(KEY, SECRET) });
    expect(verifyCapture(env(KEY), unreadable, headers(), BODY, log())).toEqual({
      verdict: 'failed',
      reason: 'key-error',
    });
  });
});
