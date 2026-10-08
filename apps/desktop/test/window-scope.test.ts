import { describe, expect, it } from 'vitest';
import { routeWorkspaces, runAsCaller, scoped, WindowScopes } from '../src/main/window-scope.js';
import type { WorkspaceService } from '../src/main/workspace-service.js';

interface FakeScope {
  readonly name: string;
  readonly workspace: WorkspaceService;
  readonly jar: { readonly owner: string; describe(): string };
}

/** A window whose workspace holds `entities`, all in one project named after the window. */
function fakeScope(name: string, entities: readonly string[]): FakeScope {
  const workspace = {
    projectId: (id: string) => (entities.includes(id) ? `${name}-project` : undefined),
    hostOfEntity: (id: string) => {
      if (!entities.includes(id)) throw new Error(`unknown-entity ${id}`);
      return { owner: name };
    },
    snapshot: () => ({ name }),
  } as unknown as WorkspaceService;
  return {
    name,
    workspace,
    jar: {
      owner: name,
      describe() {
        return `jar of ${this.owner}`;
      },
    },
  };
}

function twoWindows(): { scopes: WindowScopes<FakeScope>; router: WorkspaceService } {
  const scopes = new WindowScopes<FakeScope>();
  scopes.add(1, fakeScope('one', ['req-1']));
  scopes.add(2, fakeScope('two', ['req-2']));
  return { scopes, router: routeWorkspaces(scopes, (scope) => scope.workspace) };
}

describe('WindowScopes', () => {
  it("answers with the caller's scope, the only one without a caller, and none otherwise", () => {
    const scopes = new WindowScopes<string>();
    scopes.add(1, 'one');
    expect(scopes.callerOrOnly()).toBe('one');
    scopes.add(2, 'two');
    expect(scopes.callerOrOnly()).toBeUndefined();
    expect(() => scopes.current()).toThrow(expect.objectContaining({ code: 'no-window' }));
    expect(runAsCaller(2, () => scopes.current())).toBe('two');
    // A caller whose window has closed is not handed another window's scope.
    scopes.remove(2);
    expect(runAsCaller(2, () => scopes.callerOrOnly())).toBeUndefined();
  });

  it('keeps the caller through awaits and timers the call starts', async () => {
    const scopes = new WindowScopes<string>();
    scopes.add(1, 'one');
    scopes.add(2, 'two');
    const seen = await runAsCaller(2, async () => {
      await Promise.resolve();
      return await new Promise<string>((resolve) =>
        setTimeout(() => {
          resolve(scopes.current());
        }, 1),
      );
    });
    expect(seen).toBe('two');
  });
});

describe('routeWorkspaces', () => {
  it('routes an entity-addressed call to the window that holds the entity, whoever calls', () => {
    const { router } = twoWindows();
    expect(router.hostOfEntity('req-2')).toEqual({ owner: 'two' });
    expect(runAsCaller(1, () => router.hostOfEntity('req-2'))).toEqual({ owner: 'two' });
    expect(router.projectId('req-1')).toBe('one-project');
  });

  it("an id no window holds: `projectId` is undefined, anything else is the caller's refusal", () => {
    const { router } = twoWindows();
    expect(router.projectId('nowhere')).toBeUndefined();
    expect(() => runAsCaller(1, () => router.hostOfEntity('nowhere'))).toThrow('unknown-entity nowhere');
  });

  it("sends a workspace-level call to the caller's window, and refuses one with no caller among several", () => {
    const { router } = twoWindows();
    expect(runAsCaller(1, () => router.snapshot())).toEqual({ name: 'one' });
    expect(runAsCaller(2, () => router.snapshot())).toEqual({ name: 'two' });
    expect(() => router.snapshot()).toThrow(expect.objectContaining({ code: 'no-window' }));
  });

  it('is never mistaken for a promise', async () => {
    const { router } = twoWindows();
    await expect(Promise.resolve(router)).resolves.toBe(router);
  });
});

describe('scoped', () => {
  it("is the caller's own object, with its methods bound to it", () => {
    const { scopes } = twoWindows();
    const jar = scoped(scopes, (scope) => scope.jar);
    expect(runAsCaller(2, () => jar.describe())).toBe('jar of two');
    expect(runAsCaller(1, () => jar.owner)).toBe('one');
  });
});
