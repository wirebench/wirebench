import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTeamSecretsStore, TEAM_SECRETS_OFF_STATUS } from '../../src/renderer/state/team-secrets.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { TeamSecretsStatusWire } from '../../src/shared/wire-types.js';

const ON: TeamSecretsStatusWire = { ...TEAM_SECRETS_OFF_STATUS, on: true, authority: 'signed', canManage: true };

describe('useTeamSecretsStore', () => {
  afterEach(() => {
    useTeamSecretsStore.getState().reset();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('applies a change for the open workspace only', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'ws-1', share: { kind: 'git', managed: true } }) });
    useTeamSecretsStore.getState().applyChanged('ws-2', ON);
    expect(useTeamSecretsStore.getState().status.on).toBe(false);
    useTeamSecretsStore.getState().applyChanged('ws-1', ON);
    expect(useTeamSecretsStore.getState().status.on).toBe(true);
  });

  it('runs an action with its id and takes the answer', async () => {
    const approve = vi.fn().mockResolvedValue({ ok: true, value: ON });
    installWirebenchApi({ teamSecrets: { approve } });
    await useTeamSecretsStore.getState().run('approve', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(approve).toHaveBeenCalledWith({ keyId: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' });
    expect(useTeamSecretsStore.getState().status).toEqual(ON);
  });
});
