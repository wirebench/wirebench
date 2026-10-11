// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyColorAndProtection } from '../src/main/environment-flags.js';
import { environmentPatchSchema, workspaceEnvironmentPatchSchema } from '../src/shared/wire-base.js';

interface Env {
  readonly id: string;
  readonly color?: string;
  readonly protected?: boolean;
}

describe('applyColorAndProtection', () => {
  const base: Env = { id: 'e', color: 'red', protected: true };
  const bare: Env = { id: 'e' };

  it('keeps what an absent key had', () => {
    expect(applyColorAndProtection(base, {})).toEqual(base);
  });

  it('sets, clears with null, and drops protected when false', () => {
    expect(applyColorAndProtection(bare, { color: '#00aa11', protected: true })).toEqual({
      id: 'e',
      color: '#00aa11',
      protected: true,
    });
    expect(applyColorAndProtection(base, { color: null, protected: false })).toEqual({ id: 'e' });
  });
});

describe('environment patch colours', () => {
  it('accepts a palette name, #rrggbb and null, and refuses anything else', () => {
    for (const schema of [environmentPatchSchema, workspaceEnvironmentPatchSchema]) {
      expect(schema.safeParse({ color: 'teal' }).success).toBe(true);
      expect(schema.safeParse({ color: '#A1b2C3' }).success).toBe(true);
      expect(schema.safeParse({ color: null }).success).toBe(true);
      expect(schema.safeParse({ color: 'chartreuse' }).success).toBe(false);
      expect(schema.safeParse({ color: '#abc' }).success).toBe(false);
    }
  });
});
