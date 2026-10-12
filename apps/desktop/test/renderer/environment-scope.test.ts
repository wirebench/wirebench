import { describe, expect, it } from 'vitest';
import {
  activeEnvironmentFor,
  appliesToProject,
  environmentsForProject,
} from '../../src/renderer/state/environment-scope.js';
import type { WorkspaceEnvironmentWire } from '../../src/shared/wire-base.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

function environment(id: string, order: number, projects?: string[], name = id): WorkspaceEnvironmentWire {
  return {
    id,
    name,
    slug: id,
    order,
    properties: {},
    endpoints: {},
    disabled: [],
    ...(projects !== undefined ? { projects } : {}),
  };
}

// The same cases as the engine's `environments.test.ts`: the renderer keeps its own copy of the rule.
const everywhere = environment('e-all', 1);
const nowhere = environment('e-none', 2, []);
const billingOnly = environment('e-billing', 0, ['p-billing']);

describe('environment scope (renderer)', () => {
  it('appliesToProject: absent is every project, [] is none, a list is exactly those', () => {
    expect(appliesToProject(everywhere, 'anything')).toBe(true);
    expect(appliesToProject(nowhere, 'p-billing')).toBe(false);
    expect(appliesToProject(billingOnly, 'p-billing')).toBe(true);
    expect(appliesToProject(billingOnly, 'p-crm')).toBe(false);
  });

  it('environmentsForProject lists the applicable environments in order', () => {
    const workspace = workspaceWire({ environments: [everywhere, nowhere, billingOnly] });
    expect(environmentsForProject(workspace, 'p-billing').map((e) => e.id)).toEqual(['e-billing', 'e-all']);
    expect(environmentsForProject(workspace, 'p-crm').map((e) => e.id)).toEqual(['e-all']);
  });

  it('environmentsForProject breaks an order tie by name', () => {
    const workspace = workspaceWire({
      environments: [environment('e-z', 0, undefined, 'Zeta'), environment('e-a', 0, undefined, 'Alpha')],
    });
    expect(environmentsForProject(workspace, 'p').map((e) => e.id)).toEqual(['e-a', 'e-z']);
  });

  it('activeEnvironmentFor is undefined for a missing, deleted or out-of-scope entry', () => {
    const workspace = workspaceWire({
      environments: [everywhere, billingOnly],
      activeEnvironments: { 'p-billing': 'e-billing', 'p-crm': 'e-billing', 'p-old': 'e-deleted', 'p-all': 'e-all' },
    });
    expect(activeEnvironmentFor(workspace, 'p-billing')?.id).toBe('e-billing');
    expect(activeEnvironmentFor(workspace, 'p-all')?.id).toBe('e-all');
    expect(activeEnvironmentFor(workspace, 'p-missing')).toBeUndefined();
    expect(activeEnvironmentFor(workspace, 'p-old')).toBeUndefined();
    expect(activeEnvironmentFor(workspace, 'p-crm')).toBeUndefined();
    expect(activeEnvironmentFor(workspace, '__proto__')).toBeUndefined();
  });

  it('activeEnvironmentFor is undefined with no workspace or no project', () => {
    expect(activeEnvironmentFor(null, 'p-billing')).toBeUndefined();
    const workspace = workspaceWire({ environments: [everywhere], activeEnvironments: { p: 'e-all' } });
    expect(activeEnvironmentFor(workspace, undefined)).toBeUndefined();
  });
});
