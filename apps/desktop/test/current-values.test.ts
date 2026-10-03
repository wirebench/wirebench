// @vitest-environment node
/**
 * The current-value store (cookie jar spec §5.1): a value only for a committed variable, kept per
 * workspace, carried by a rename, dropped with its variable or environment.
 */
import { describe, expect, it } from 'vitest';
import { CurrentValuesStore } from '../src/main/current-values.js';
import type { CurrentValuesStateWire, ProjectWire, ScopeKeyWire, WorkspaceWire } from '../src/shared/wire-types.js';

const WORKSPACE: ScopeKeyWire = { scope: 'workspace' };

type Environments = readonly { readonly id: string; readonly properties: Record<string, string> }[];

/** Only what the store reads: the id, the properties and each environment's. */
function workspace(properties: Record<string, string>, environments: Environments = [], id = 'w1'): WorkspaceWire {
  return { id, properties, disabled: [], environments } as unknown as WorkspaceWire;
}

function project(properties: Record<string, string>, environments: Environments = []): ProjectWire {
  return { properties, disabledProperties: [], environments } as unknown as ProjectWire;
}

describe('CurrentValuesStore', () => {
  it('keeps a value only for a committed variable, and none equal to the committed one', () => {
    const changes: CurrentValuesStateWire[] = [];
    const store = new CurrentValuesStore((state) => changes.push(state));
    store.syncWorkspace(workspace({ host: 'a.test' }));
    expect(() => store.set(WORKSPACE, 'nope', 'x')).toThrow(/no committed value/);
    expect(store.set(WORKSPACE, 'host', 'mine.test')).toEqual({
      scopes: [{ key: WORKSPACE, values: { host: 'mine.test' } }],
    });
    expect(store.set(WORKSPACE, 'host', 'a.test')).toEqual({ scopes: [] });
    expect(changes.at(-1)).toEqual({ scopes: [] });
  });

  it('carries a value through a rename, and drops it with a deleted variable', () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ host: 'a.test', port: '80' }));
    store.set(WORKSPACE, 'host', 'mine.test');
    store.set(WORKSPACE, 'port', '8080');
    store.syncWorkspace(workspace({ server: 'a.test', port: '80' }));
    expect(store.state()).toEqual({ scopes: [{ key: WORKSPACE, values: { port: '8080', server: 'mine.test' } }] });
    store.syncWorkspace(workspace({ server: 'a.test' }));
    expect(store.state()).toEqual({ scopes: [{ key: WORKSPACE, values: { server: 'mine.test' } }] });
  });

  it('carries a value through a rename made as a remove and then a set, but no further', () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ host: 'a.test' }));
    store.set(WORKSPACE, 'host', 'mine.test');
    store.syncWorkspace(workspace({}));
    expect(store.state()).toEqual({ scopes: [] });
    store.syncWorkspace(workspace({ server: 'a.test' }));
    expect(store.state()).toEqual({ scopes: [{ key: WORKSPACE, values: { server: 'mine.test' } }] });

    store.syncWorkspace(workspace({}));
    store.syncWorkspace(workspace({ other: 'x' }));
    store.syncWorkspace(workspace({ server: 'a.test' }));
    expect(store.state()).toEqual({ scopes: [] });
  });

  it('keeps the value of a disabled variable', () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ host: 'a.test' }));
    store.set(WORKSPACE, 'host', 'mine.test');
    store.syncWorkspace({ ...workspace({ host: 'a.test' }), disabled: ['host'] });
    expect(store.state().scopes).toHaveLength(1);
  });

  it("keeps each workspace's values across switches, and forgets a deleted workspace's", () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ host: 'a.test' }, [], 'w1'));
    store.set(WORKSPACE, 'host', 'mine.test');
    store.syncWorkspace(workspace({ host: 'b.test' }, [], 'w2'));
    expect(store.state()).toEqual({ scopes: [] });
    store.syncWorkspace(workspace({ host: 'a.test' }, [], 'w1'));
    expect(store.state().scopes).toHaveLength(1);
    store.forgetWorkspace('w1');
    expect(store.state()).toEqual({ scopes: [] });
  });

  it('resets one value, or every value of a scope', () => {
    const store = new CurrentValuesStore();
    store.syncWorkspace(workspace({ a: '1', b: '2' }));
    store.set(WORKSPACE, 'a', 'x');
    store.set(WORKSPACE, 'b', 'y');
    expect(store.reset(WORKSPACE, 'a')).toEqual({ scopes: [{ key: WORKSPACE, values: { b: 'y' } }] });
    expect(store.reset(WORKSPACE)).toEqual({ scopes: [] });
  });

  it('hands a send the overlays of its project, and drops an environment with its values', () => {
    const store = new CurrentValuesStore();
    store.syncGlobals({ properties: { who: 'me' }, disabled: [] });
    store.syncWorkspace(workspace({ org: 'acme' }, [{ id: 'e1', properties: { base: 'e1.test' } }]));
    store.syncProject('p1', project({ tenant: 't' }, [{ id: 'pe1', properties: { user: 'u' } }]));
    store.set({ scope: 'global' }, 'who', 'you');
    store.set({ scope: 'workspaceEnvironment', environmentId: 'e1' }, 'base', 'mine.test');
    store.set({ scope: 'project', projectId: 'p1' }, 'tenant', 'beta');
    store.set({ scope: 'projectEnvironment', projectId: 'p1', environmentId: 'pe1' }, 'user', 'bob');

    expect(store.overlaysFor('p1')).toEqual({
      global: { who: 'you' },
      workspaceEnvironments: { e1: { base: 'mine.test' } },
      project: { tenant: 'beta' },
      projectEnvironments: { pe1: { user: 'bob' } },
    });
    expect(store.overlaysFor('p2')).toEqual({
      global: { who: 'you' },
      workspaceEnvironments: { e1: { base: 'mine.test' } },
    });

    // A closing project keeps its values; a deleted environment takes its own with it.
    store.syncProject('p1', null);
    expect(store.overlaysFor('p1').project).toEqual({ tenant: 'beta' });
    store.syncWorkspace(workspace({ org: 'acme' }));
    expect(store.overlaysFor('p2')).toEqual({ global: { who: 'you' } });
  });
});
