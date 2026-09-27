import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  subscribeToTeamSecrets,
  TEAM_SECRETS_OFF_STATUS,
  useTeamSecretsStore,
} from '../../src/renderer/state/team-secrets.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { TeamSecretsStatusWire } from '../../src/shared/wire-types.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const ON: TeamSecretsStatusWire = { ...TEAM_SECRETS_OFF_STATUS, on: true, authority: 'signed', canManage: true };

/** Resolves once its `resolve` is called — lets a test hold a channel reply in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('useTeamSecretsStore', () => {
  afterEach(() => {
    showToast.mockClear();
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

  it('toasts the error message when an action fails', async () => {
    const approve = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'team-secrets-damaged', message: 'The team secrets log is damaged.' },
    });
    installWirebenchApi({ teamSecrets: { approve } });
    await useTeamSecretsStore.getState().run('approve', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(showToast).toHaveBeenCalledWith('The team secrets log is damaged.');
  });

  it('toasts a failed request for access and keeps the status it had (M4)', async () => {
    const requestAccess = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'team-secrets-rate-limited',
        message: 'Too many requests for team secrets access. Try again in a few minutes.',
      },
    });
    installWirebenchApi({ teamSecrets: { requestAccess } });
    useTeamSecretsStore.setState({ status: ON });
    await useTeamSecretsStore.getState().run('requestAccess');
    expect(showToast).toHaveBeenCalledWith('Too many requests for team secrets access. Try again in a few minutes.');
    expect(useTeamSecretsStore.getState().status).toEqual(ON);
  });

  it('toasts the error message when refresh fails', async () => {
    const status = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'team-secrets-damaged', message: 'The team secrets log is damaged.' },
    });
    installWirebenchApi({ teamSecrets: { status } });
    await useTeamSecretsStore.getState().refresh();
    expect(showToast).toHaveBeenCalledWith('The team secrets log is damaged.');
  });

  it('drops a run() answer that lands after the open workspace has switched', async () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'ws-1', share: { kind: 'git', managed: true } }) });
    const { promise, resolve } = deferred<{ ok: true; value: TeamSecretsStatusWire }>();
    const approve = vi.fn().mockReturnValue(promise);
    installWirebenchApi({ teamSecrets: { approve } });

    const running = useTeamSecretsStore.getState().run('approve', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'ws-2', share: { kind: 'git', managed: true } }) });
    resolve({ ok: true, value: ON });
    await running;

    expect(useTeamSecretsStore.getState().status.on).toBe(false);
    expect(useTeamSecretsStore.getState().busy).toBe(false);
  });

  it('drops a refresh() answer that lands after the open workspace has switched', async () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'ws-1', share: { kind: 'git', managed: true } }) });
    const { promise, resolve } = deferred<{ ok: true; value: TeamSecretsStatusWire }>();
    const status = vi.fn().mockReturnValue(promise);
    installWirebenchApi({ teamSecrets: { status } });

    const running = useTeamSecretsStore.getState().refresh();
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'ws-2', share: { kind: 'git', managed: true } }) });
    resolve({ ok: true, value: ON });
    await running;

    expect(useTeamSecretsStore.getState().status.on).toBe(false);
  });
});

describe('subscribeToTeamSecrets', () => {
  afterEach(() => {
    useTeamSecretsStore.getState().reset();
    useWorkspaceStore.setState({ workspace: null });
  });

  it('resets on a workspace switch, and its unsubscribe drops both listeners', () => {
    useTeamSecretsStore.setState({ status: ON });
    const offChanged = vi.fn();
    const offWorkspace = vi.fn();
    const listeners = new Map<string, (payload: unknown) => void>();
    let registrations = 0;
    const status = vi.fn().mockResolvedValue({ ok: true, value: TEAM_SECRETS_OFF_STATUS });
    installWirebenchApi({
      teamSecrets: { status },
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        registrations += 1;
        return registrations === 1 ? offChanged : offWorkspace;
      }),
    });

    const unsubscribe = subscribeToTeamSecrets();
    // `lastWorkspaceId` starts `null`; a switch to a real id counts as a switch and resets.
    listeners.get('workspace.changed')?.({ workspace: workspaceWire({ id: 'ws-1' }) });
    expect(useTeamSecretsStore.getState().status).toEqual(TEAM_SECRETS_OFF_STATUS);

    unsubscribe();
    expect(offChanged).toHaveBeenCalled();
    expect(offWorkspace).toHaveBeenCalled();
  });

  it('applies teamSecrets.changed only for the open workspace', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ id: 'ws-1', share: { kind: 'git', managed: true } }) });
    const listeners = new Map<string, (payload: unknown) => void>();
    installWirebenchApi({
      teamSecrets: { status: vi.fn().mockResolvedValue({ ok: true, value: TEAM_SECRETS_OFF_STATUS }) },
      on: vi.fn().mockImplementation((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return vi.fn();
      }),
    });

    const unsubscribe = subscribeToTeamSecrets();
    listeners.get('teamSecrets.changed')?.({ workspaceId: 'ws-2', status: ON });
    expect(useTeamSecretsStore.getState().status.on).toBe(false);
    listeners.get('teamSecrets.changed')?.({ workspaceId: 'ws-1', status: ON });
    expect(useTeamSecretsStore.getState().status.on).toBe(true);

    unsubscribe();
  });
});
