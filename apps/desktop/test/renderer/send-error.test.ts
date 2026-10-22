/**
 * How a failed send reads: a plain title, a tone that is neutral for the person's own choice, and a
 * hint per code — the timeout's limit, each unresolved reference, or one line for the rest.
 */
import { describe, expect, it } from 'vitest';
import {
  describeSendError,
  formatLimit,
  isChosenOutcome,
  isProblemOutcome,
  sendProblemText,
  referenceText,
} from '../../src/renderer/features/request-editor/send-error.js';

describe('describeSendError', () => {
  it('names every unresolved reference from the details, once each', () => {
    const view = describeSendError({
      code: 'rest-unresolved-properties',
      message: '"/pets" has property references nothing resolves: ${petId}, ${#Env#token}',
      details: { path: '/pets', unresolved: ['${petId}', '${#Env#token}', '${petId}', '${'] },
    });
    expect(view.title).toBe('Unresolved variables');
    expect(view.tone).toBe('danger');
    expect(view.hint).toEqual({ kind: 'unresolved', refs: ['${petId}', '${#Env#token}'] });
    // The engine's message only repeats the hint, and sending again unchanged fails the same way (#747).
    expect(view.detail).toBeUndefined();
    expect(view.retryable).toBe(false);
  });

  it('reads an unclosed ${ as a syntax slip, not a missing value', () => {
    const view = describeSendError({
      code: 'rest-unresolved-properties',
      message: '"/x" has property references nothing resolves: ${$rand',
      details: { path: '/x', unresolved: ['${$rand', '${$rand', '${a${b}'] },
    });
    expect(view.title).toBe('Unclosed ${');
    expect(view.hint).toEqual({ kind: 'unclosed', fragments: ['${$rand', '${a${b}'] });
    // The engine's message names the fragment oddly; the hint says it better.
    expect(view.detail).toBeUndefined();
  });

  it('reads the references from the message when the details carry none', () => {
    const view = describeSendError({
      code: 'grpc-unresolved-properties',
      message: '"svc" has property references nothing resolves: ${host}',
    });
    expect(view.hint).toEqual({ kind: 'unresolved', refs: ['${host}'] });
  });

  it('carries the limit a timeout hit, and copes without one', () => {
    expect(describeSendError({ code: 'timeout', message: 'x', details: { timeoutMs: 30_000 } }).hint).toEqual({
      kind: 'timeout',
      timeoutMs: 30_000,
    });
    expect(describeSendError({ code: 'timeout', message: 'x' }).hint).toEqual({
      kind: 'timeout',
      timeoutMs: undefined,
    });
  });

  it('gives refused, DNS and TLS failures one line each', () => {
    for (const code of ['connection-refused', 'dns', 'tls']) {
      const view = describeSendError({ code, message: 'x' });
      expect(view.tone).toBe('danger');
      expect(view.hint?.kind).toBe('text');
    }
    expect(describeSendError({ code: 'connection-refused', message: 'x' }).title).toBe('Connection refused');
    expect(describeSendError({ code: 'dns', message: 'x' }).title).toBe('Host not found');
  });

  it('reads a cancel and a declined prompt as neutral, with no hint', () => {
    expect(describeSendError({ code: 'aborted', message: 'The request was aborted.' })).toEqual({
      title: 'Cancelled',
      headline: 'Cancelled',
      detail: undefined,
      tone: 'neutral',
      hint: undefined,
      retryable: true,
    });
    expect(describeSendError({ code: 'send-declined', message: 'x' }).tone).toBe('neutral');
  });

  it('falls back to a plain title for a code it does not know', () => {
    expect(describeSendError({ code: 'secret-missing', message: 'x' })).toEqual({
      title: 'Send failed',
      headline: 'Send failed',
      detail: 'x',
      tone: 'danger',
      hint: undefined,
      retryable: true,
    });
  });

  it('offers no Retry for a request that fails as written, and one for everything else (#747)', () => {
    for (const code of ['invalid-url', 'rest-url-incomplete']) {
      expect(describeSendError({ code, message: 'x' }).retryable, code).toBe(false);
    }
    const unclosed = describeSendError({
      code: 'rest-unresolved-properties',
      message: 'x',
      details: { unresolved: ['${$rand'] },
    });
    expect(unclosed.retryable).toBe(false);
    for (const code of [
      'connection-refused',
      'dns',
      'timeout',
      'tls-untrusted',
      'script-type-error',
      'secret-missing',
    ]) {
      expect(describeSendError({ code, message: 'x' }).retryable, code).toBe(true);
    }
  });

  it('puts the host and port to check in the headline, and keeps the title short', () => {
    const refused = describeSendError({
      code: 'connection-refused',
      message: 'Connection refused.',
      details: { code: 'ECONNREFUSED', target: '127.0.0.1:9' },
    });
    expect(refused.title).toBe('Connection refused');
    expect(refused.headline).toBe("Couldn't connect to 127.0.0.1:9");
    const dns = describeSendError({
      code: 'dns',
      message: 'DNS lookup failed.',
      details: { host: 'no-such-host.invalid' },
    });
    expect(dns.headline).toBe('Host no-such-host.invalid not found');
    // Without a target the headline is the title.
    expect(describeSendError({ code: 'connection-refused', message: 'x' }).headline).toBe('Connection refused');
  });

  it('drops a message that only restates the title, and the title it repeats', () => {
    for (const [code, message] of [
      ['connection-refused', 'Connection refused.'],
      ['dns', 'DNS lookup failed.'],
      ['timeout', 'The request timed out.'],
      ['aborted', 'The request was aborted.'],
      ['incomplete', 'Send failed.'],
    ] as const) {
      expect(describeSendError({ code, message }).detail).toBeUndefined();
    }
    expect(
      describeSendError({
        code: 'send-declined',
        message: 'Not sent: "production" is protected and the send was not confirmed',
      }).detail,
    ).toBe('"production" is protected and the send was not confirmed');
    expect(describeSendError({ code: 'network', message: 'socket hang up' }).detail).toBe('socket hang up');
  });
});

describe('isChosenOutcome', () => {
  it('is true only for a cancel and a declined send', () => {
    expect(isChosenOutcome('aborted')).toBe(true);
    expect(isChosenOutcome('send-declined')).toBe(true);
    expect(isChosenOutcome('timeout')).toBe(false);
  });
});

describe('isProblemOutcome', () => {
  it('leaves out a choice and a transport failure, and keeps what the project can fix (#635)', () => {
    for (const code of [
      'aborted',
      'send-declined',
      'connection-refused',
      'dns',
      'timeout',
      'tls',
      'proxy',
      'network',
    ]) {
      expect(isProblemOutcome(code), code).toBe(false);
    }
    // A variable nothing resolves is shown like a transport failure (#747): named in the panel, not counted.
    for (const code of ['rest-unresolved-properties', 'grpc-unresolved-properties', 'ws-unresolved-properties']) {
      expect(isProblemOutcome(code), code).toBe(false);
    }
    for (const code of ['rest-url-incomplete', 'invalid-url', 'script-type-error', 'tls-untrusted']) {
      expect(isProblemOutcome(code), code).toBe(true);
    }
  });
});

describe('sendProblemText', () => {
  it('leads with the plain title, not the code', () => {
    expect(sendProblemText({ code: 'rest-url-incomplete', message: 'The URL still needs a value for {id}' })).toBe(
      'Incomplete URL: The URL still needs a value for {id}',
    );
  });

  it('says the title once when the message only repeats it', () => {
    expect(sendProblemText({ code: 'invalid-url', message: 'Invalid URL.' })).toBe('Invalid URL');
    expect(sendProblemText({ code: 'invalid-url', message: '' })).toBe('Invalid URL');
  });
});

describe('formatLimit', () => {
  it('says a limit as a person would', () => {
    expect(formatLimit(800)).toBe('800 ms');
    expect(formatLimit(30_000)).toBe('30 s');
    expect(formatLimit(1500)).toBe('1.5 s');
  });
});

describe('referenceText', () => {
  it('wraps a bare name and leaves a written reference alone', () => {
    expect(referenceText('petId')).toBe('${petId}');
    expect(referenceText('${petId}')).toBe('${petId}');
  });
});
