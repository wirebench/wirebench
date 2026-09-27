// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { channels, events } from '../src/shared/ipc.js';
import { registerTeamSecretsChannels } from '../src/main/ipc/team-secrets.js';
import { TEAM_SECRETS_OFF } from '../src/main/team-secrets-service.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function service() {
  const answer = () => Promise.resolve(TEAM_SECRETS_OFF);
  return {
    status: vi.fn(answer),
    turnOn: vi.fn(answer),
    requestAccess: vi.fn(answer),
    approve: vi.fn(answer),
    decline: vi.fn(answer),
    remove: vi.fn(answer),
    grantAdmin: vi.fn(answer),
    revokeAdmin: vi.fn(answer),
    restoreMine: vi.fn(answer),
    dismissReplaced: vi.fn(answer),
  };
}

beforeEach(() => {
  handlers.clear();
});

describe('teamSecrets channels', () => {
  it('registers one handler per channel', () => {
    registerTeamSecretsChannels(service());
    expect([...handlers.keys()].filter((name) => name.startsWith('teamSecrets.')).sort()).toEqual(
      Object.values(channels.teamSecrets)
        .map((channel) => channel.name)
        .sort(),
    );
  });

  const ROUTES: readonly [
    channel: string,
    payload: unknown,
    method: keyof ReturnType<typeof service>,
    args: unknown[],
  ][] = [
    ['teamSecrets.status', undefined, 'status', []],
    ['teamSecrets.turnOn', undefined, 'turnOn', [{ commit: true }]],
    ['teamSecrets.requestAccess', undefined, 'requestAccess', []],
    ['teamSecrets.approve', { keyId: KEY }, 'approve', [KEY]],
    ['teamSecrets.decline', { keyId: KEY }, 'decline', [KEY]],
    ['teamSecrets.remove', { keyId: KEY }, 'remove', [KEY]],
    ['teamSecrets.grantAdmin', { keyId: KEY }, 'grantAdmin', [KEY]],
    ['teamSecrets.revokeAdmin', { keyId: KEY }, 'revokeAdmin', [KEY]],
    ['teamSecrets.restoreMine', { entryId: KEY }, 'restoreMine', [KEY]],
    ['teamSecrets.dismissReplaced', { entryId: KEY }, 'dismissReplaced', [KEY]],
  ];

  it('covers every channel in the routing table', () => {
    expect(ROUTES.map(([channel]) => channel).sort()).toEqual(
      Object.values(channels.teamSecrets)
        .map((channel) => channel.name)
        .sort(),
    );
  });

  it.each(ROUTES)('routes %s to the service', async (channel, payload, method, args) => {
    const team = service();
    registerTeamSecretsChannels(team);
    expect(await invoke(channel, payload)).toEqual({ ok: true, value: TEAM_SECRETS_OFF });
    expect(team[method]).toHaveBeenCalledWith(...args);
    for (const [name, other] of Object.entries(team)) {
      if (name !== method) {
        expect(other).not.toHaveBeenCalled();
      }
    }
  });

  it('refuses a malformed entry id before it reaches the service', async () => {
    const team = service();
    registerTeamSecretsChannels(team);
    for (const channel of ['teamSecrets.restoreMine', 'teamSecrets.dismissReplaced']) {
      const result = (await invoke(channel, { entryId: '../values/x' })) as { ok: boolean };
      expect(result.ok).toBe(false);
    }
    expect(team.restoreMine).not.toHaveBeenCalled();
    expect(team.dismissReplaced).not.toHaveBeenCalled();
  });

  it('answers a failed request for access with its error, for the renderer to show (M4)', async () => {
    const team = service();
    team.requestAccess.mockRejectedValueOnce(
      new WirebenchError(
        'team-secrets-rate-limited',
        'Too many requests for team secrets access. Try again in a few minutes.',
      ),
    );
    registerTeamSecretsChannels(team);
    expect(await invoke('teamSecrets.requestAccess')).toMatchObject({
      ok: false,
      error: {
        code: 'team-secrets-rate-limited',
        message: 'Too many requests for team secrets access. Try again in a few minutes.',
      },
    });
  });

  it('refuses a malformed key id before it reaches the service', async () => {
    const team = service();
    registerTeamSecretsChannels(team);
    const result = (await invoke('teamSecrets.approve', { keyId: '../../etc' })) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(team.approve).not.toHaveBeenCalled();
  });

  it('carries no value on any answer schema', () => {
    expect(events.teamSecrets.changed.name).toBe('teamSecrets.changed');
    for (const channel of Object.values(channels.teamSecrets)) {
      expect(JSON.stringify(channel.response.safeParse({ ...TEAM_SECRETS_OFF, value: 'x' }).data)).not.toContain(
        '"value"',
      );
    }
  });
});
