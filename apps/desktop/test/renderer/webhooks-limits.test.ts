import { describe, expect, it } from 'vitest';
import { CATCH_CONTENT_TYPE_PATTERN, catchUrlResponseSchema, HOOKS_LIMITS } from '@wirebench/engine';
import { CATCH_URL_LIMITS, PRINTABLE_ASCII } from '../../src/renderer/features/webhooks/limits.js';

describe('the settings dialog restates the server limits (webhook-capture §3.5)', () => {
  it('matches the engine', () => {
    expect(CATCH_URL_LIMITS).toMatchObject({
      maxNameLength: HOOKS_LIMITS.maxNameLength,
      maxContentTypeLength: HOOKS_LIMITS.maxContentTypeLength,
      maxResponseBodyBytes: HOOKS_LIMITS.maxResponseBodyBytes,
      maxDelayMs: HOOKS_LIMITS.maxDelayMs,
    });
    const status = catchUrlResponseSchema.shape.status;
    expect(
      [
        CATCH_URL_LIMITS.minStatus - 1,
        CATCH_URL_LIMITS.minStatus,
        CATCH_URL_LIMITS.maxStatus,
        CATCH_URL_LIMITS.maxStatus + 1,
      ].map((value) => status.safeParse(value).success),
    ).toEqual([false, true, true, false]);
  });

  it('matches the engine content-type pattern', () => {
    expect(PRINTABLE_ASCII.source).toBe(CATCH_CONTENT_TYPE_PATTERN.source);
  });
});
