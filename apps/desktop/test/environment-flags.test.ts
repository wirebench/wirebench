// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { applyColorAndProtection } from '../src/main/environment-flags.js';
import {
  environmentPatchSchema,
  workspaceChangeSchema,
  workspaceEnvironmentPatchSchema,
} from '../src/shared/wire-base.js';

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

describe('workspace environment patch scope (#468)', () => {
  it('accepts a project list, an empty one, and null for every project', () => {
    expect(workspaceEnvironmentPatchSchema.parse({ projects: ['p1', 'p2'] })).toEqual({ projects: ['p1', 'p2'] });
    expect(workspaceEnvironmentPatchSchema.parse({ projects: [] })).toEqual({ projects: [] });
    expect(workspaceEnvironmentPatchSchema.parse({ projects: null })).toEqual({ projects: null });
    expect(workspaceEnvironmentPatchSchema.safeParse({ projects: 'p1' }).success).toBe(false);
    // The environment file refuses an empty id, so the wire does too: it would not load again.
    expect(workspaceEnvironmentPatchSchema.safeParse({ projects: [''] }).success).toBe(false);
    expect(workspaceEnvironmentPatchSchema.safeParse({ projects: ['p1', ''] }).success).toBe(false);
  });
});

describe('workspace environment creation scope (#468)', () => {
  it('accepts a new environment with or without a project list, and refuses an empty id', () => {
    const add = (extra: object) =>
      workspaceChangeSchema.safeParse({ kind: 'add-workspace-environment', name: 'QA', ...extra });
    expect(add({}).success).toBe(true);
    expect(add({ projects: ['p1'] }).data).toEqual({ kind: 'add-workspace-environment', name: 'QA', projects: ['p1'] });
    expect(add({ projects: [''] }).success).toBe(false);
    expect(add({ projects: null }).success).toBe(false);
  });
});
