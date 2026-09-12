import { describe, expect, it } from 'vitest';
import {
  linkedEnvironment,
  resolveWorkspaceEndpoint,
  resolveWorkspaceScopes,
} from '../../../src/workspace/environments.js';
import {
  createInterface,
  createProject,
  type Environment,
  type Interface,
  type Project,
} from '../../../src/project/model.js';
import type { Workspace, WorkspaceEnvironment } from '../../../src/workspace/model.js';
import { WORKSPACE_FORMAT_VERSION } from '../../../src/workspace/model.js';

const projectEnv: Environment = {
  id: 'penv-1',
  name: 'QA',
  slug: 'qa',
  order: 0,
  endpoints: { calculator: 'https://qa.project.test/soap' },
  properties: { name: 'proj-env-name', onlyProjectEnv: 'p-env-value' },
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
  project = { ...project, interfaces: [iface], properties: { name: 'proj-name' }, environments };
  return { project, iface };
}

function fixtureWorkspace(activeEnv: WorkspaceEnvironment | undefined, overrides?: Partial<Workspace>): Workspace {
  return {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    id: 'ws-1',
    name: 'Workspace',
    createdAt: '2026-01-01T00:00:00.000Z',
    properties: { name: 'ws-name', onlyWorkspace: 'w-value' },
    ...(activeEnv !== undefined ? { activeEnvironmentId: activeEnv.id } : {}),
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
};

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
