import { describe, expect, it } from 'vitest';
import { WorkspaceError } from '../../../src/errors.js';
import {
  activeEnvironmentFor,
  appliesToProject,
  assertEnvironmentInScope,
  environmentsForProject,
  isProtectedEnvironment,
  linkedEnvironment,
  resolveWorkspaceEndpoint,
  resolveWorkspaceScopes,
  workspaceForProject,
} from '../../../src/workspace/environments.js';
import { createProject, type Environment, type Project } from '../../../src/project/model.js';
import { createInterface, type Interface } from '../../../src/soap/model.js';
import type { Workspace, WorkspaceEnvironment } from '../../../src/workspace/model.js';
import { WORKSPACE_FORMAT_VERSION } from '../../../src/workspace/model.js';
import { expand } from '../../../src/project/properties.js';

const projectEnv: Environment = {
  id: 'penv-1',
  name: 'QA',
  slug: 'qa',
  order: 0,
  endpoints: { calculator: 'https://qa.project.test/soap' },
  properties: { name: 'proj-env-name', onlyProjectEnv: 'p-env-value' },
  disabledProperties: [],
};

function fixtureProject(environments: readonly Environment[] = []): { project: Project; iface: Interface } {
  let project = createProject('Demo', { id: 'proj-1' });
  const iface = createInterface('Calculator', {
    id: 'iface-1',
    slug: 'calculator',
    definitionUrl: 'https://example.test/calc.wsdl',
    endpoints: [{ id: 'ep-default', name: 'Default', url: 'https://default.test/soap', authMode: 'override' }],
    defaultEndpointId: 'ep-default',
  });
  project = {
    ...project,
    containers: { ...project.containers, soap: [iface] },
    properties: { name: 'proj-name' },
    environments,
  };
  return { project, iface };
}

function fixtureWorkspace(activeEnv: WorkspaceEnvironment | undefined, overrides?: Partial<Workspace>): Workspace {
  return {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    id: 'ws-1',
    name: 'Workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    properties: { name: 'ws-name', onlyWorkspace: 'w-value' },
    disabledProperties: [],
    ...(activeEnv !== undefined ? { activeEnvironmentId: activeEnv.id } : {}),
    activeEnvironments: {},
    projects: [{ id: 'proj-1', slug: 'demo', source: 'internal' }],
    environments: activeEnv !== undefined ? [activeEnv] : [],
    ...overrides,
  };
}

const workspaceEnv: WorkspaceEnvironment = {
  id: 'wenv-1',
  name: 'QA',
  slug: 'qa',
  order: 0,
  properties: { name: 'ws-env-name', onlyWorkspaceEnv: 'w-env-value' },
  endpoints: { 'demo/calculator': 'https://qa.workspace.test/soap' },
  disabledProperties: [],
};

describe('isProtectedEnvironment', () => {
  it('is false with no environment, and for one that is not protected', () => {
    const { project } = fixtureProject([projectEnv]);
    expect(isProtectedEnvironment(project, undefined)).toBe(false);
    expect(isProtectedEnvironment(project, workspaceEnv)).toBe(false);
    expect(isProtectedEnvironment(project, projectEnv)).toBe(false);
  });

  it('is true for a protected environment, project or workspace', () => {
    const { project } = fixtureProject([]);
    expect(isProtectedEnvironment(project, { ...workspaceEnv, protected: true })).toBe(true);
    expect(isProtectedEnvironment(project, { ...projectEnv, protected: true })).toBe(true);
  });

  it('is true for a workspace environment whose linked project environment is protected', () => {
    const { project } = fixtureProject([{ ...projectEnv, protected: true }]);
    expect(isProtectedEnvironment(project, workspaceEnv)).toBe(true);
  });
});

describe('linkedEnvironment', () => {
  it('finds the project environment whose slug matches the workspace environment', () => {
    const { project } = fixtureProject([projectEnv]);
    expect(linkedEnvironment(project, workspaceEnv)).toBe(projectEnv);
  });

  it('returns undefined when no project environment has that slug', () => {
    const { project } = fixtureProject([]);
    expect(linkedEnvironment(project, workspaceEnv)).toBeUndefined();
  });

  it('returns undefined when workspaceEnv is undefined', () => {
    const { project } = fixtureProject([projectEnv]);
    expect(linkedEnvironment(project, undefined)).toBeUndefined();
  });
});

describe('resolveWorkspaceScopes', () => {
  it('omits env entirely when there is no active workspace environment and no linked project environment', () => {
    const { project } = fixtureProject([]);
    const workspace = fixtureWorkspace(undefined);
    const scopes = resolveWorkspaceScopes({ workspace, project, globals: { g: 'g-value' } });
    expect(scopes.env).toBeUndefined();
    expect(scopes.workspace).toEqual(workspace.properties);
    expect(scopes.project).toEqual(project.properties);
    expect(scopes.global).toEqual({ g: 'g-value' });
  });

  it('uses the active workspace environment properties when there is no linked project environment', () => {
    const { project } = fixtureProject([]);
    const workspace = fixtureWorkspace(workspaceEnv);
    const scopes = resolveWorkspaceScopes({ workspace, project, globals: {} });
    expect(scopes.env).toEqual(workspaceEnv.properties);
  });

  it('project environment properties win over workspace environment properties on the same key', () => {
    const { project } = fixtureProject([projectEnv]);
    const workspace = fixtureWorkspace(workspaceEnv);
    const scopes = resolveWorkspaceScopes({ workspace, project, globals: {} });
    expect(scopes.env).toEqual({
      name: 'proj-env-name',
      onlyWorkspaceEnv: 'w-env-value',
      onlyProjectEnv: 'p-env-value',
    });
  });

  it('passes system through when given', () => {
    const { project } = fixtureProject([]);
    const workspace = fixtureWorkspace(undefined);
    const scopes = resolveWorkspaceScopes({ workspace, project, globals: {}, system: { X: 'y' } });
    expect(scopes.system).toEqual({ X: 'y' });
  });

  it('excludes properties disabled on the workspace and the project from their scopes', () => {
    const { project } = fixtureProject([]);
    const disabledProject = { ...project, disabledProperties: ['name'] };
    const workspace = fixtureWorkspace(undefined, { disabledProperties: ['name'] });
    const scopes = resolveWorkspaceScopes({ workspace, project: disabledProject, globals: {} });
    expect(scopes.workspace).toEqual({ onlyWorkspace: 'w-value' });
    expect(scopes.project).toEqual({});
  });

  it('a value disabled only in the workspace environment still falls through to the enabled linked project environment value', () => {
    const { project } = fixtureProject([projectEnv]);
    const disabledWorkspaceEnv: WorkspaceEnvironment = { ...workspaceEnv, disabledProperties: ['name'] };
    const workspace = fixtureWorkspace(disabledWorkspaceEnv);
    const scopes = resolveWorkspaceScopes({ workspace, project, globals: {} });
    expect(scopes.env).toEqual({
      onlyWorkspaceEnv: 'w-env-value',
      onlyProjectEnv: 'p-env-value',
      name: 'proj-env-name',
    });
    expect(expand('${name}', scopes).text).toBe('proj-env-name');
  });

  it('is unresolved when disabled in both the workspace environment and the linked project environment', () => {
    const { project } = fixtureProject([{ ...projectEnv, disabledProperties: ['name'] }]);
    const disabledWorkspaceEnv: WorkspaceEnvironment = { ...workspaceEnv, disabledProperties: ['name'] };
    const workspace = fixtureWorkspace(disabledWorkspaceEnv);
    const scopes = resolveWorkspaceScopes({ workspace, project, globals: {} });
    expect(scopes.env).toEqual({ onlyWorkspaceEnv: 'w-env-value', onlyProjectEnv: 'p-env-value' });
    const result = expand('${#Env#name}', scopes);
    expect(result.text).toBe('${#Env#name}');
    expect(result.unresolved).toEqual([expect.objectContaining({ scope: 'Env', name: 'name', code: 'missing' })]);
  });
});

describe('resolveWorkspaceEndpoint', () => {
  it('linked project environment override wins over everything', () => {
    const { project, iface } = fixtureProject([projectEnv]);
    const workspace = fixtureWorkspace(workspaceEnv);
    const result = resolveWorkspaceEndpoint({
      workspace,
      project,
      projectSlug: 'demo',
      iface,
      request: { endpointUrl: 'https://custom.test/soap' },
    });
    expect(result).toMatchObject({ url: 'https://qa.project.test/soap', source: 'environment' });
    expect(result.endpoint).toBeUndefined();
  });

  it('falls to the workspace environment override when linked env has none for this interface', () => {
    const { project, iface } = fixtureProject([{ ...projectEnv, endpoints: {} }]);
    const workspace = fixtureWorkspace(workspaceEnv);
    const result = resolveWorkspaceEndpoint({
      workspace,
      project,
      projectSlug: 'demo',
      iface,
      request: {},
    });
    expect(result).toMatchObject({ url: 'https://qa.workspace.test/soap', source: 'workspace-environment' });
    expect(result.endpoint).toBeUndefined();
  });

  it('applies the workspace environment override even with no linked project environment', () => {
    const { project, iface } = fixtureProject([]);
    const workspace = fixtureWorkspace(workspaceEnv);
    const result = resolveWorkspaceEndpoint({ workspace, project, projectSlug: 'demo', iface, request: {} });
    expect(result).toMatchObject({ url: 'https://qa.workspace.test/soap', source: 'workspace-environment' });
  });

  it('delegates to resolveEndpoint precedence when nothing active', () => {
    const { project, iface } = fixtureProject([]);
    const workspace = fixtureWorkspace(undefined);
    const result = resolveWorkspaceEndpoint({
      workspace,
      project,
      projectSlug: 'demo',
      iface,
      request: { endpointUrl: 'https://custom.test/soap' },
    });
    expect(result).toMatchObject({ url: 'https://custom.test/soap', source: 'request-custom' });
  });

  it('falls through to interface default when nothing else matches', () => {
    const { project, iface } = fixtureProject([]);
    const workspace = fixtureWorkspace(undefined);
    const result = resolveWorkspaceEndpoint({ workspace, project, projectSlug: 'demo', iface, request: {} });
    expect(result).toMatchObject({ url: 'https://default.test/soap', source: 'interface-default' });
    expect(result.endpoint).toBeDefined();
  });
});

describe('project scope', () => {
  const everywhere: WorkspaceEnvironment = { ...workspaceEnv, id: 'e-all', name: 'All', slug: 'all', order: 2 };
  const billingOnly: WorkspaceEnvironment = {
    ...workspaceEnv,
    id: 'e-billing',
    name: 'Billing QA',
    slug: 'billing-qa',
    order: 0,
    projects: ['p-billing', 'p-gone'],
  };
  const nowhere: WorkspaceEnvironment = {
    ...workspaceEnv,
    id: 'e-none',
    name: 'Off',
    slug: 'off',
    order: 1,
    projects: [],
  };

  it('appliesToProject: absent is every project, [] is none, a list is exactly those', () => {
    expect(appliesToProject(everywhere, 'anything')).toBe(true);
    expect(appliesToProject(nowhere, 'p-billing')).toBe(false);
    expect(appliesToProject(billingOnly, 'p-billing')).toBe(true);
    expect(appliesToProject(billingOnly, 'p-crm')).toBe(false);
  });

  it('environmentsForProject lists the applicable environments in order', () => {
    const workspace = fixtureWorkspace(undefined, { environments: [everywhere, nowhere, billingOnly] });
    expect(environmentsForProject(workspace, 'p-billing').map((e) => e.id)).toEqual(['e-billing', 'e-all']);
    expect(environmentsForProject(workspace, 'p-crm').map((e) => e.id)).toEqual(['e-all']);
  });

  it('activeEnvironmentFor is undefined for a missing, deleted or out-of-scope entry', () => {
    const workspace = fixtureWorkspace(undefined, {
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

  it('workspaceForProject resolves each project against its own active environment', () => {
    const alpha: WorkspaceEnvironment = {
      ...workspaceEnv,
      id: 'e-a',
      slug: 'a',
      endpoints: { 'demo/calculator': 'https://a.test/soap' },
      projects: ['proj-1'],
    };
    const beta: WorkspaceEnvironment = {
      ...workspaceEnv,
      id: 'e-b',
      slug: 'b',
      endpoints: { 'demo/calculator': 'https://b.test/soap' },
    };
    const workspace = fixtureWorkspace(undefined, {
      environments: [alpha, beta],
      activeEnvironments: { 'proj-1': 'e-a', 'proj-2': 'e-b', 'proj-3': 'e-a' },
    });
    const { project, iface } = fixtureProject([]);
    const resolve = (projectId: string) =>
      resolveWorkspaceEndpoint({
        workspace: workspaceForProject(workspace, projectId),
        project,
        projectSlug: 'demo',
        iface,
        request: {},
      });
    expect(resolve('proj-1')).toMatchObject({ url: 'https://a.test/soap', source: 'workspace-environment' });
    expect(resolve('proj-2')).toMatchObject({ url: 'https://b.test/soap', source: 'workspace-environment' });
    // proj-3's entry is out of scope for e-a, so nothing is active for it.
    expect(resolve('proj-3').source).toBe('interface-default');
    expect(workspaceForProject(workspace, 'proj-3').activeEnvironmentId).toBeUndefined();
  });

  it('assertEnvironmentInScope throws environment-out-of-scope with the name and project', () => {
    const workspace = fixtureWorkspace(undefined, { environments: [everywhere, billingOnly] });
    expect(() => assertEnvironmentInScope(workspace, 'e-all', 'p-crm')).not.toThrow();
    expect(() => assertEnvironmentInScope(workspace, 'e-billing', 'p-billing')).not.toThrow();
    try {
      assertEnvironmentInScope(workspace, 'e-billing', 'p-crm');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkspaceError);
      expect((error as WorkspaceError).code).toBe('environment-out-of-scope');
      expect((error as WorkspaceError).details).toEqual({ environmentName: 'Billing QA', projectId: 'p-crm' });
    }
    expect(() => assertEnvironmentInScope(workspace, 'nope', 'p-crm')).toThrow(
      expect.objectContaining({ code: 'environment-not-found' }),
    );
  });
});
