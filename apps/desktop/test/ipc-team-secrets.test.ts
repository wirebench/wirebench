// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('registers one handler per channel and routes each to the service', async () => {
    const team = service();
    registerTeamSecretsChannels(team);

    expect([...handlers.keys()].filter((name) => name.startsWith('teamSecrets.')).sort()).toEqual(
      Object.values(channels.teamSecrets)
        .map((channel) => channel.name)
        .sort(),
    );
    expect(await invoke('teamSecrets.status')).toEqual({ ok: true, value: TEAM_SECRETS_OFF });
    await invoke('teamSecrets.turnOn');
    await invoke('teamSecrets.approve', { keyId: KEY });
    await invoke('teamSecrets.remove', { keyId: KEY });
    await invoke('teamSecrets.restoreMine', { entryId: KEY });
    expect(team.turnOn).toHaveBeenCalledWith({ commit: true });
    expect(team.approve).toHaveBeenCalledWith(KEY);
    expect(team.remove).toHaveBeenCalledWith(KEY);
    expect(team.restoreMine).toHaveBeenCalledWith(KEY);
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
