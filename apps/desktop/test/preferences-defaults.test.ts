import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES } from '@wirebench/engine';
import { DEFAULT_PREFERENCES_WIRE } from '../src/renderer/state/preferences-defaults.js';
import { preferencesWireSchema } from '../src/shared/wire-types.js';

/**
 * The renderer can import neither the engine's Node-only main entry nor a runtime value out of
 * `shared/wire-types.ts` (zod compiles validators, which its CSP forbids), so the preference
 * defaults are restated in `renderer/state/preferences-defaults.ts`. This keeps the copy honest.
 */
describe('DEFAULT_PREFERENCES_WIRE', () => {
  it('matches the engine defaults exactly', () => {
    expect(DEFAULT_PREFERENCES_WIRE).toEqual(DEFAULT_PREFERENCES);
  });

  it('satisfies the wire schema', () => {
    expect(preferencesWireSchema.safeParse(DEFAULT_PREFERENCES_WIRE).success).toBe(true);
  });
});
