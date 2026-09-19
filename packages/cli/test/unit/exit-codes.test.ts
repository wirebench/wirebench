import { describe, expect, it } from 'vitest';
import { ExitCode, exitCodeFor } from '../../src/exit-codes.js';

describe('exitCodeFor', () => {
  it('is 0 when everything passed', () => expect(exitCodeFor({ failed: 0, errored: 0 })).toBe(ExitCode.Ok));
  it('is 1 when an assertion failed', () =>
    expect(exitCodeFor({ failed: 1, errored: 0 })).toBe(ExitCode.AssertionFailed));
  it('is 3 when a request errored, even if another failed', () =>
    expect(exitCodeFor({ failed: 1, errored: 1 })).toBe(ExitCode.RunError));
});
