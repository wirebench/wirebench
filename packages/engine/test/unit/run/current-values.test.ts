/**
 * Current values in resolution (cookie jar spec §5.2): each overlay lands on its own scope, under the
 * command line's `--var`, never on a disabled variable, and it stays a template.
 */
import { describe, expect, it, vi } from 'vitest';
import { createProject } from '#core/project/model';
import type { Environment, Project } from '#core/project/model';
import { expand } from '#core/project/properties';
import { scopesFor, type RunContext } from '#core/run/context';
import { overlayCurrent } from '#core/run/current-values';
import { createWorkspace, createWorkspaceEnvironment } from '#core/workspace/model';
import { testHost } from '../../helpers/send-host.js';

function environment(id: string, properties: Record<string, string>, disabled: string[] = []): Environment {
  return { id, name: id, slug: id, order: 0, endpoints: {}, properties, disabledProperties: disabled };
}

const project: Project = {
  ...createProject('P', { id: 'p1' }),
  properties: { tenant: 'acme', region: 'eu' },
  environments: [
    environment('dev', { host: 'dev.test', user: 'alice' }, ['user']),
    environment('uat', { host: 'uat.test' }),
  ],
};

function context(extra: Partial<RunContext> = {}): RunContext {
  return { project, projectDir: '/tmp/p', environmentId: 'dev', overrides: {}, host: testHost(), ...extra };
}

describe('overlayCurrent', () => {
  it('replaces only the names the scope defines', () => {
    expect(overlayCurrent({ a: '1', b: '2' }, { a: 'x', c: 'y' })).toEqual({ a: 'x', b: '2' });
  });

  it('hands the same map back when there is nothing to lay over it', () => {
    const properties = { a: '1' };
    expect(overlayCurrent(properties, undefined)).toBe(properties);
    expect(overlayCurrent(properties, { other: 'x' })).toBe(properties);
  });
});

describe('scopesFor with current values', () => {
  it('lays each overlay over its own scope, the run environment by id', () => {
    const scopes = scopesFor(
      context({
        current: {
          project: { tenant: 'beta' },
          projectEnvironments: { dev: { host: 'mine.test' }, uat: { host: 'never.test' } },
        },
      }),
    );
    expect(scopes.project).toEqual({ tenant: 'beta', region: 'eu' });
    expect(scopes.env).toEqual({ host: 'mine.test' });
  });

  it('lets a --var override win over a current value', () => {
    const scopes = scopesFor(
      context({ overrides: { host: 'cli.test' }, current: { projectEnvironments: { dev: { host: 'mine.test' } } } }),
    );
    expect(scopes.env?.['host']).toBe('cli.test');
  });

  it("does not apply a disabled variable's current value", () => {
    const scopes = scopesFor(context({ current: { projectEnvironments: { dev: { user: 'bob' } } } }));
    expect(scopes.env).toEqual({ host: 'dev.test' });
  });

  it('keeps a current value a template, expanded like a committed one', () => {
    const scopes = scopesFor(context({ current: { project: { tenant: '${#Project#region}-team' } } }));
    expect(expand('${#Project#tenant}', scopes).text).toBe('eu-team');
  });

  it('lays the workspace, its environment and the globals inside a workspace', () => {
    const stage = {
      ...createWorkspaceEnvironment('Stage', new Set<string>(), { id: 'ws-stage' }),
      properties: { base: 'stage.test' },
    };
    const workspace = { ...createWorkspace('W', { id: 'w1' }), properties: { org: 'acme' }, environments: [stage] };
    const scopes = scopesFor(
      context({
        environmentId: 'ws-stage',
        workspace: { workspace, projectSlug: 'p' },
        globals: { who: 'me' },
        current: {
          workspace: { org: 'beta' },
          workspaceEnvironments: { 'ws-stage': { base: 'mine.test' } },
          global: { who: 'you', ghost: 'never' },
        },
      }),
    );
    expect(scopes.workspace).toEqual({ org: 'beta' });
    expect(scopes.env).toEqual({ base: 'mine.test' });
    expect(scopes.global).toEqual({ who: 'you' });
  });

  it('changes nothing without current values', () => {
    // Each call's Dynamic scope takes the time it was made: one clock for both, or a millisecond
    // between them fails the comparison.
    vi.useFakeTimers({ now: new Date('2026-10-11T12:00:00Z') });
    try {
      expect(scopesFor(context())).toEqual(scopesFor(context({ current: {} })));
    } finally {
      vi.useRealTimers();
    }
  });
});
