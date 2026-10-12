import { describe, expect, it } from 'vitest';
import { PREFERENCE_NUMBER_LIMITS } from '@wirebench/engine';
import { PREFERENCE_LIMITS } from '../src/renderer/state/preference-limits.js';

/** The renderer restates the engine's limits (it cannot import them); this keeps the copy honest. */
describe('PREFERENCE_LIMITS', () => {
  it('matches the engine limits exactly', () => {
    expect(PREFERENCE_LIMITS).toEqual(PREFERENCE_NUMBER_LIMITS);
  });
});
