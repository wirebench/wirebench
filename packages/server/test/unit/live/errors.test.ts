import { describe, expect, it } from 'vitest';
import { LIVE_REFUSED_CODES } from '@wirebench/engine';
import { LIVE_TOO_MANY_SUBSCRIPTIONS, liveOriginRefused } from '../../../src/live/errors.js';
import { toProblem } from '../../../src/problem.js';

describe('live errors (live-updates §3.5)', () => {
  it('refuses a foreign Origin as 403 live-origin-refused', () => {
    expect(toProblem(liveOriginRefused())).toEqual({
      status: 403,
      body: { code: 'live-origin-refused', message: 'Live updates do not accept connections from another site.' },
    });
  });

  it('spells the too-many-subscriptions refusal as the wire union has it', () => {
    expect(LIVE_TOO_MANY_SUBSCRIPTIONS).toBe('live-too-many-subscriptions');
    expect(LIVE_REFUSED_CODES).toContain(LIVE_TOO_MANY_SUBSCRIPTIONS);
  });
});
