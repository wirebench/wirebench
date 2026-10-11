// @vitest-environment node
/**
 * `request.variables` (#340): what the editor may complete, explain and mark for one request, built
 * from the scopes its send would expand against. Never a secret's value.
 */
import { describe, expect, it } from 'vitest';
import {
  createProject,
  createWorkspace,
  createWorkspaceEnvironment,
  resolveScopes,
  resolveWorkspaceScopes,
} from '@wirebench/engine';
import type { Environment, Project } from '@wirebench/engine';
import { requestVariables } from '../src/main/request-variables.js';

function environment(id: string, slug: string, properties: Record<string, string>): Environment {
  return { id, name: slug, slug, order: 0, endpoints: {}, properties, disabledProperties: [] };
}

function project(): Project {
  return {
    ...createProject('Shop', { id: 'p1' }),
    properties: { host: 'project.example', base: 'https://${host}', apiKey: '${secret:api_key}' },
    environments: [environment('e1', 'dev', { host: 'dev.example', port: '8080' })],
    activeEnvironmentId: 'e1',
  };
}

describe('requestVariables', () => {
  it('lists each scope in chain order, expanding values and marking shadowed names', () => {
    const shop = project();
    const scopes = resolveScopes(shop, 'e1', { region: 'eu' }, { HOME: '/home/me' });
    const { entries } = requestVariables({
      scopes,
      located: { project: shop, environmentId: 'e1' },
      secretNames: [],
    });
    expect(entries.filter((entry) => entry.scope !== 'System')).toEqual([
      {
        name: 'host',
        scope: 'Env',
        value: 'dev.example',
        masked: false,
        shadowed: false,
        edit: { kind: 'environment', id: 'e1' },
      },
      {
        name: 'port',
        scope: 'Env',
        value: '8080',
        masked: false,
        shadowed: false,
        edit: { kind: 'environment', id: 'e1' },
      },
      {
        name: 'host',
        scope: 'Project',
        value: 'project.example',
        masked: false,
        shadowed: true,
        edit: { kind: 'project', projectId: 'p1' },
      },
      // Expanded as the send would: the shorthand inside reaches the environment's host.
      {
        name: 'base',
        scope: 'Project',
        value: 'https://dev.example',
        masked: false,
        shadowed: false,
        edit: { kind: 'project', projectId: 'p1' },
      },
      {
        name: 'apiKey',
        scope: 'Project',
        masked: true,
        secretName: 'api_key',
        shadowed: false,
        edit: { kind: 'project', projectId: 'p1' },
      },
      { name: 'region', scope: 'Global', value: 'eu', masked: false, shadowed: false, edit: { kind: 'globals' } },
    ]);
  });

  it('sends System names only, masked, and masks a value that reads one', () => {
    const shop = { ...project(), properties: { home: '${#System#HOME}/x' } };
    const scopes = resolveScopes(shop, undefined, {}, { HOME: '/home/me' });
    const { entries } = requestVariables({ scopes, located: { project: shop }, secretNames: [] });
    expect(entries).toContainEqual({ name: 'HOME', scope: 'System', masked: true, shadowed: false });
    expect(entries).toContainEqual({
      name: 'home',
      scope: 'Project',
      masked: true,
      shadowed: false,
      edit: { kind: 'project', projectId: 'p1' },
    });
    expect(JSON.stringify(entries)).not.toContain('/home/me');
  });

  it('shows a value that generates a dynamic one as written, not as one sample', () => {
    const shop = { ...project(), properties: { requestId: 'req-${$guid}' } };
    const scopes = resolveScopes(shop, undefined, {}, {});
    const { entries } = requestVariables({ scopes, located: { project: shop }, secretNames: [] });
    expect(entries).toContainEqual(
      expect.objectContaining({ name: 'requestId', value: 'req-${$guid}', masked: false }),
    );
  });

  it('never carries a secret value, whatever the scopes hold', () => {
    const shop = project();
    const scopes = { ...resolveScopes(shop, 'e1', {}, {}), secrets: { api_key: 'TOPSECRET' } };
    const answer = requestVariables({ scopes, located: { project: shop }, secretNames: ['api_key', 'other'] });
    expect(JSON.stringify(answer)).not.toContain('TOPSECRET');
    expect(answer.secretNames).toEqual(['api_key', 'other']);
  });

  it('points an Env entry at the linked project environment when that defines it, else the workspace one', () => {
    const shop = project();
    const workspace = {
      ...createWorkspace('Team', { id: 'w1' }),
      environments: [
        {
          ...createWorkspaceEnvironment('dev', new Set(), { id: 'we1' }),
          properties: { token: 't', host: 'ws.example' },
        },
      ],
      activeEnvironmentId: 'we1',
      properties: { team: 'blue' },
    };
    const scopes = resolveWorkspaceScopes({ workspace, project: shop, globals: {}, system: {} });
    const { entries } = requestVariables({
      scopes,
      located: { project: shop, workspace: { workspace, projectSlug: 'shop' }, environmentId: 'we1' },
      secretNames: [],
    });
    const env = entries.filter((entry) => entry.scope === 'Env');
    expect(env.find((entry) => entry.name === 'host')?.edit).toEqual({ kind: 'environment', id: 'e1' });
    expect(env.find((entry) => entry.name === 'host')?.value).toBe('dev.example');
    expect(env.find((entry) => entry.name === 'token')?.edit).toEqual({ kind: 'environment', id: 'we1' });
    expect(entries.find((entry) => entry.scope === 'Workspace')).toEqual({
      name: 'team',
      scope: 'Workspace',
      value: 'blue',
      masked: false,
      shadowed: false,
      edit: { kind: 'workspace' },
    });
  });
});

describe('variablesFor', () => {
  it('answers nothing for a request no open project holds', async () => {
    const { variablesFor } = await import('../src/main/ipc/request.js');
    const deps = { project: { projectId: () => undefined } } as unknown as Parameters<typeof variablesFor>[0];
    await expect(variablesFor(deps, 'r1')).resolves.toEqual({ entries: [], secretNames: [] });
  });

  it('lists the stored secret names of the request’s project, sorted and once each', async () => {
    const { variablesFor } = await import('../src/main/ipc/request.js');
    const shop = project();
    const asked: (string | undefined)[] = [];
    const deps = {
      project: {
        projectId: () => 'p1',
        scopesFor: () => resolveScopes(shop, 'e1', {}, {}),
        runContextFor: () => ({ project: shop, environmentId: 'e1' }),
      },
      secretNamesFor: (projectId: string | undefined) => {
        asked.push(projectId);
        return Promise.resolve(['zeta', 'api_key', 'zeta']);
      },
    } as unknown as Parameters<typeof variablesFor>[0];
    const answer = await variablesFor(deps, 'r1');
    expect(asked).toEqual(['p1']);
    expect(answer.secretNames).toEqual(['api_key', 'zeta']);
    expect(answer.entries.map((entry) => `${entry.scope}:${entry.name}`)).toContain('Env:host');
  });
});
