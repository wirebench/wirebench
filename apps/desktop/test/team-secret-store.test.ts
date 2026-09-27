// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { TEAM_KEY_LABEL_PREFIX, TEAM_REPLACED_LABEL_PREFIX } from '../src/main/secrets.js';
import { secretOfLabel, TeamSecretStore, teamSecretGetter } from '../src/main/team-secret-store.js';

const REF = 'sec_0123456789abcdef0123456789';

function rawStore() {
  const values = new Map<string, { value: string; label?: string }>();
  let next = 0;
  return {
    values,
    set: vi.fn((value: string, opts?: { label?: string }) => {
      const ref = `sec_${String(next++).padStart(26, '0')}`;
      values.set(ref, { value, ...(opts?.label !== undefined ? { label: opts.label } : {}) });
      return Promise.resolve(ref);
    }),
    replace: vi.fn((ref: string, value: string) => {
      values.set(ref, { ...values.get(ref), value });
      return Promise.resolve(ref);
    }),
    exists: vi.fn((ref: string) => Promise.resolve(values.has(ref))),
    delete: vi.fn((ref: string) => Promise.resolve(values.delete(ref))),
    findByLabel: vi.fn((label: string) => Promise.resolve([...values].find(([, entry]) => entry.label === label)?.[0])),
    list: vi.fn(() =>
      Promise.resolve(
        [...values].map(([ref, entry]) => ({
          ref,
          createdAt: '2026-09-26T10:00:00.000Z',
          ...(entry.label !== undefined ? { label: entry.label } : {}),
        })),
      ),
    ),
    isMachineOnly: vi.fn(() => Promise.resolve(false)),
  };
}

function service() {
  return {
    recordValue: vi.fn(() => Promise.resolve()),
    forget: vi.fn(() => Promise.resolve()),
  };
}

describe('secretOfLabel', () => {
  it('reads a token label as the token and anything else as the ref', () => {
    expect(secretOfLabel(REF, 'wirebench-secret:proj-1:api_token')).toEqual({
      token: { projectId: 'proj-1', name: 'api_token' },
    });
    expect(secretOfLabel(REF, 'Password')).toEqual({ ref: REF });
    expect(secretOfLabel(REF, undefined)).toEqual({ ref: REF });
  });
});

describe('TeamSecretStore', () => {
  it('stores the value on this machine first, then hands it to the vault', async () => {
    const raw = rawStore();
    const team = service();
    const store = new TeamSecretStore(raw, team);

    const ref = await store.set('hunter2', { label: 'Password' });
    await store.replace(ref, 'hunter3');
    // What the `${secret:name}` dialog (SecretScanSession.setValue) calls.
    await store.set('tok-1', { label: 'wirebench-secret:proj-1:api_token' });

    expect(raw.values.get(ref)?.value).toBe('hunter3');
    expect(team.recordValue.mock.calls).toEqual([
      [{ ref }, 'Password', 'hunter2'],
      [{ ref }, 'Password', 'hunter3'],
      [{ token: { projectId: 'proj-1', name: 'api_token' } }, 'api_token', 'tok-1'],
    ]);
  });

  it('forgets a deleted value, and never fails a save over the vault', async () => {
    const raw = rawStore();
    const team = service();
    team.recordValue.mockRejectedValue(new Error('disk full'));
    const log = vi.fn();
    const store = new TeamSecretStore(raw, team, log);

    const ref = await store.set('hunter2', { label: 'Password' });
    expect(await store.delete(ref)).toBe(true);

    expect(raw.values.has(ref)).toBe(false);
    expect(team.forget).toHaveBeenCalledWith({ ref }, 'Password');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('disk full'));
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2');
  });

  it('never hands a machine-only label to the vault, for either prefix (defense in depth)', async () => {
    const raw = rawStore();
    const team = service();
    const store = new TeamSecretStore(raw, team);

    await store.set('{"private":"k"}', { label: `${TEAM_KEY_LABEL_PREFIX}ws-1` });
    await store.set('old-value', { label: `${TEAM_REPLACED_LABEL_PREFIX}ws-1:E` });

    expect(team.recordValue).not.toHaveBeenCalled();
  });
});

describe('teamSecretGetter', () => {
  it('answers a stored value, refuses a value this machine waits for, and passes on a plain miss', async () => {
    const inner = vi.fn((ref: string) => Promise.resolve(ref === REF ? 'hunter2' : undefined));
    const waiting = { waitingFor: vi.fn((ref: string) => ref === 'sec_waitingwaitingwaitingwait') };
    const get = teamSecretGetter(inner, waiting, 'proj-1');

    expect(await get(REF)).toBe('hunter2');
    expect(await get('sec_missingmissingmissingmiss')).toBeUndefined();
    const refused = await get('sec_waitingwaitingwaitingwait').catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(WirebenchError);
    expect(refused).toMatchObject({
      code: 'team-secrets-pending',
      message: 'This machine is waiting for an admin to approve it for team secrets.',
    });
    expect(waiting.waitingFor).toHaveBeenCalledWith('sec_waitingwaitingwaitingwait', 'proj-1');
  });
});
