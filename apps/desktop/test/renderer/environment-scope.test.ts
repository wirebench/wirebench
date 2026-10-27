import { describe, expect, it } from 'vitest';
import {
  activeEnvironmentFor,
  appliesToProject,
  environmentsForProject,
  environmentsLeftWithoutProject,
  switcherEnvironments,
  switcherGroups,
} from '../../src/renderer/state/environment-scope.js';
import type { WorkspaceEnvironmentWire } from '@wirebench/wire/wire-base';
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

  it("switcherGroups puts every-project environments first, then the project's own, each in order", () => {
    const later = environment('e-all-2', 0);
    const workspace = workspaceWire({ environments: [everywhere, nowhere, billingOnly, later] });
    const groups = switcherGroups(workspace, 'p-billing');
    expect(groups.allProjects.map((e) => e.id)).toEqual(['e-all-2', 'e-all']);
    expect(groups.project.map((e) => e.id)).toEqual(['e-billing']);
    // One flat list for `env.next`, in the menu's order.
    expect(switcherEnvironments(workspace, 'p-billing').map((e) => e.id)).toEqual(['e-all-2', 'e-all', 'e-billing']);
    expect(switcherGroups(workspace, 'p-crm').project).toEqual([]);
  });

  it('environmentsLeftWithoutProject names only scopes that removing the project empties', () => {
    const shared = environment('e-shared', 3, ['p-billing', 'p-crm']);
    const unknownToo = environment('e-unknown', 4, ['p-billing', 'p-not-pulled']);
    const projects = ['p-billing', 'p-crm'].map((id) => ({
      id,
      name: id,
      slug: id,
      source: 'internal' as const,
      dir: `/tmp/${id}`,
      status: 'ready' as const,
    }));
    const workspace = workspaceWire({ projects, environments: [everywhere, nowhere, billingOnly, shared, unknownToo] });
    // An id this machine does not know is ignored on read, so that scope shows as *No project* too.
    expect(environmentsLeftWithoutProject(workspace, 'p-billing').map((e) => e.id)).toEqual(['e-billing', 'e-unknown']);
    // Already *No project*, every-project and still-shared scopes are not news.
    expect(environmentsLeftWithoutProject(workspace, 'p-crm')).toEqual([]);
  });
});
