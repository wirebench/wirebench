// @vitest-environment node
import { WirebenchError, secretPseudoRef } from '@wirebench/engine';
import type { GetSecret } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { workspaceSecretLabel } from '../src/main/secret-resolver.js';
import { sshScopeOf, sshSecretsFor } from '../src/main/ssh-window.js';
import type { SshWindowScope } from '../src/main/ssh-window.js';
import { WindowScopes } from '../src/main/window-scope.js';

/** A store holding `pw-<workspace>` under each workspace's `pw` label. */
function store() {
  const byLabel = new Map([
    [workspaceSecretLabel('w1', 'pw'), 'k1'],
    [workspaceSecretLabel('w2', 'pw'), 'k2'],
  ]);
  const values = new Map([
    ['k1', 'pw-w1'],
    ['k2', 'pw-w2'],
  ]);
  return {
    findByLabel: vi.fn((label: string) => Promise.resolve(byLabel.get(label) as never)),
    get: vi.fn((key: string) => Promise.resolve(values.get(key))),
  };
}

function scope(workspaceId: string | undefined, tag: string) {
  let open = workspaceId;
  const wrap = vi.fn((next: GetSecret): GetSecret => async (ref) => {
    const value = await next(ref);
    return value === undefined ? undefined : `${tag}:${value}`;
  });
  const missingValueError = vi.fn(() => new WirebenchError('team-secrets-pending', `${tag} waits`));
  const s: SshWindowScope = {
    workspace: { openWorkspaceId: () => open },
    secretSources: { wrap },
    teamSecrets: { missingValueError },
  };
  return {
    s,
    wrap,
    missingValueError,
    switchTo: (id: string) => {
      open = id;
    },
  };
}

const PW = secretPseudoRef('pw');

describe('sshScopeOf', () => {
  it('is the sending window, and an unknown or closed window is refused as no-window', () => {
    const scopes = new WindowScopes<string>();
    scopes.add(1, 'one');
    scopes.add(2, 'two');
    expect(sshScopeOf(scopes, { id: 2 })).toBe('two');
    expect(() => sshScopeOf(scopes, { id: 3 })).toThrow(expect.objectContaining({ code: 'no-window' }));
    scopes.remove(2);
    expect(() => sshScopeOf(scopes, { id: 2 })).toThrow(expect.objectContaining({ code: 'no-window' }));
  });
});

describe('sshSecretsFor', () => {
  it("each window reads its own workspace's secret through its own sources and team secrets", async () => {
    const st = store();
    const a = scope('w1', 'A');
    const b = scope('w2', 'B');
    const record = vi.fn();
    expect(await sshSecretsFor(st, a.s, record)(PW)).toBe('A:pw-w1');
    expect(await sshSecretsFor(st, b.s, record)(PW)).toBe('B:pw-w2');
    expect(a.wrap).toHaveBeenCalledTimes(1);
    expect(b.wrap).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith('pw-w1');
  });

  it("a missing value is refused by that window's team secrets, not another's", async () => {
    const a = scope('w1', 'A');
    const b = scope('w3', 'B'); // nothing stored for w3
    await expect(sshSecretsFor(store(), b.s, vi.fn())(PW)).rejects.toMatchObject({ message: 'B waits' });
    expect(b.missingValueError).toHaveBeenCalled();
    expect(a.missingValueError).not.toHaveBeenCalled();
  });

  it('stays bound to the workspace open when it was made', async () => {
    const a = scope('w1', 'A');
    const getter = sshSecretsFor(store(), a.s, vi.fn());
    a.switchTo('w2');
    expect(await getter(PW)).toBe('A:pw-w1');
  });
});
