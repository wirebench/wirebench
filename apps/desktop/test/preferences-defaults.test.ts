import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, PALETTES } from '@wirebench/engine';
import { DEFAULT_PREFERENCES_WIRE } from '../src/renderer/state/preferences-defaults.js';
import { PALETTES as WIRE_PALETTES, preferencesWireSchema } from '@wirebench/wire/wire-base';
import { PALETTES as RENDERER_PALETTES } from '@wirebench/wire/palettes';

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

describe('PALETTES', () => {
  it('is one list in the engine, the wire schema and the renderer-safe module', () => {
    expect(WIRE_PALETTES).toEqual(PALETTES);
    expect(RENDERER_PALETTES).toBe(WIRE_PALETTES);
  });

  it('lets the wire schema carry every palette', () => {
    for (const palette of PALETTES) {
      const ui = { ...DEFAULT_PREFERENCES_WIRE.ui, palette };
      expect(preferencesWireSchema.safeParse({ ...DEFAULT_PREFERENCES_WIRE, ui }).success).toBe(true);
    }
  });
});
