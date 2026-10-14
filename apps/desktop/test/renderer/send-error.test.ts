/**
 * How a failed send reads: a plain title, a tone that is neutral for the person's own choice, and a
 * hint per code — the timeout's limit, each unresolved reference, or one line for the rest.
 */
import { describe, expect, it } from 'vitest';
import {
  describeSendError,
  formatLimit,
  isChosenOutcome,
  referenceText,
} from '../../src/renderer/features/request-editor/send-error.js';

describe('describeSendError', () => {
  it('names every unresolved reference from the details, once each', () => {
    const view = describeSendError({
      code: 'rest-unresolved-properties',
      message: '"/pets" has property references nothing resolves: ${petId}, ${#Env#token}',
      details: { path: '/pets', unresolved: ['${petId}', '${#Env#token}', '${petId}'] },
    });
    expect(view.title).toBe('Unresolved variables');
    expect(view.tone).toBe('danger');
    expect(view.hint).toEqual({ kind: 'unresolved', refs: ['${petId}', '${#Env#token}'] });
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
      tone: 'neutral',
      hint: undefined,
    });
    expect(describeSendError({ code: 'send-declined', message: 'x' }).tone).toBe('neutral');
  });

  it('falls back to a plain title for a code it does not know', () => {
    expect(describeSendError({ code: 'secret-missing', message: 'x' })).toEqual({
      title: 'Send failed',
      tone: 'danger',
      hint: undefined,
    });
  });
});

describe('isChosenOutcome', () => {
  it('is true only for a cancel and a declined send', () => {
    expect(isChosenOutcome('aborted')).toBe(true);
    expect(isChosenOutcome('send-declined')).toBe(true);
    expect(isChosenOutcome('timeout')).toBe(false);
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
