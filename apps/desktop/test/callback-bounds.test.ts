// @vitest-environment node
import { CALLBACK_LIMITS, CI_TOKEN_NAME_MAX_LENGTH } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import {
  CALLBACK_BOUNDS,
  secondsText,
  waitingText,
  withinMsOf,
} from '../src/renderer/features/sequence/callback-text.js';
import { CI_TOKEN_NAME_MAX } from '../src/renderer/state/ci-token-bounds.js';

describe('values the renderer restates (callback-assertion §5)', () => {
  it('match the engine', () => {
    expect(CALLBACK_BOUNDS).toEqual({ ...CALLBACK_LIMITS });
    expect(CI_TOKEN_NAME_MAX).toBe(CI_TOKEN_NAME_MAX_LENGTH);
  });

  it('write and read seconds', () => {
    expect(secondsText(30_000)).toBe('30 s');
    expect(secondsText(2_500)).toBe('2.5 s');
    expect(withinMsOf('45')).toBe(45_000);
    expect(withinMsOf('0.2')).toBe(1_000);
    expect(withinMsOf('9999')).toBe(300_000);
    expect(withinMsOf('soon')).toBeUndefined();
    expect(withinMsOf('')).toBeUndefined();
  });

  it('say what a step waits for', () => {
    expect(waitingText([{ catchUrl: 'orders-hook', withinMs: 30_000 }])).toBe('waiting for orders-hook… (up to 30 s)');
    expect(
      waitingText([
        { catchUrl: 'orders-hook', withinMs: 30_000 },
        { catchUrl: 'refunds-hook', withinMs: 60_000 },
      ]),
    ).toBe('waiting for orders-hook, refunds-hook… (up to 60 s)');
  });
});
