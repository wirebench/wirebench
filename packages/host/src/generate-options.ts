/**
 * Turns the user's WSDL preferences into the engine's `GenerateOptions` — the one function
 * every request-generation path folds through, so "sample values" (or "type comments", or
 * "include optional") means the same thing whether the envelope came from importing a WSDL,
 * adding a request, Recreate, or `request.generate`.
 */

import type { Preferences } from '@wirebench/engine';

/** The `GenerateOptions` fields the WSDL preferences describe. */
export interface GenerateOptionsPatch {
  readonly includeOptional: boolean;
  readonly sampleValues: boolean;
  readonly typeComments: boolean;
}

/**
 * The `GenerateOptions` a fresh envelope should be built with, derived from `preferences.wsdl`.
 * `undefined` when no preferences are available — a handful of tests omit the preferences
 * service entirely, in which case the engine's own built-in defaults stand in exactly as they
 * did before this existed.
 */
export function generateOptionsFrom(preferences: Preferences | undefined): GenerateOptionsPatch | undefined {
  if (preferences === undefined) {
    return undefined;
  }
  const { includeOptional, sampleValues, typeComments } = preferences.wsdl;
  return { includeOptional, sampleValues, typeComments };
}
