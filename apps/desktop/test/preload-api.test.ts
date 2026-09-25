import { describe, expect, it, vi } from 'vitest';
import { buildApi } from '../src/preload/build-api.js';

describe('buildApi', () => {
  it('wires app.version to invoke with the channel name', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { version: '0.1.0', electron: '44.0.0', node: '24.0.0' } });
    const api = buildApi(invoke, vi.fn());

    await api.app.version(undefined);

    expect(invoke).toHaveBeenCalledWith('app.version', undefined);
  });

  it('wires the Wirebench Server workspace channels to invoke with their names', async () => {
    const invoke = vi.fn<(name: string, request: unknown) => Promise<unknown>>().mockResolvedValue({
      ok: true,
      value: { workspaces: [] },
    });
    const api = buildApi(invoke, vi.fn());

    await api.workspace.serverTargets({ url: 'https://wirebench.example.test', teamId: 'T1' });
    await api.workspace.teamWorkspaces(undefined);
    await api.workspace.joinFromServer({ url: 'https://wirebench.example.test', workspaceId: 'W1' });
    await api.workspace.shareToServer({
      url: 'https://wirebench.example.test',
      teamId: 'T1',
      teamName: 'Payments QA',
      target: { kind: 'new', name: 'Team', defaultRole: 'viewer' },
    });

    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'workspace.serverTargets',
      'workspace.teamWorkspaces',
      'workspace.joinFromServer',
      'workspace.shareToServer',
    ]);
  });

  it('exposes only the channel/event surface, never ipcRenderer itself', () => {
    const api = buildApi(vi.fn(), vi.fn());

    expect(Object.keys(api).sort()).toEqual([
      'account',
      'api',
      'app',
      'attachments',
      'definition',
      'dialogs',
      'env',
      'exchanges',
      'fs',
      'git',
      'globals',
      'history',
      'keystores',
      'log',
      'oauth2',
      'on',
      'preferences',
      'project',
      'request',
      'search',
      'secretScan',
      'secrets',
      'snapshot',
      'ssl',
      'sync',
      'team',
      'theme',
      'validate',
      'workspace',
      'wsa',
      'wsi',
      'wss',
      'xml',
      'xpath',
    ]);
    expect('ipcRenderer' in api).toBe(false);
  });

  it('defaults env to a non-e2e dark build, and carries whatever the caller passes', () => {
    expect(buildApi(vi.fn(), vi.fn()).env).toEqual({ e2e: false, osTheme: 'dark' });
    expect(buildApi(vi.fn(), vi.fn(), { e2e: true, osTheme: 'light' }).env).toEqual({
      e2e: true,
      osTheme: 'light',
    });
  });

  it('exposes secrets.set/replace/exists/delete/list but never secrets.get', () => {
    const api = buildApi(vi.fn(), vi.fn());

    expect(Object.keys(api.secrets).sort()).toEqual([
      'delete',
      'exists',
      'getShowSecrets',
      'list',
      'replace',
      'set',
      'setShowSecrets',
    ]);
    expect('get' in api.secrets).toBe(false);
  });

  it('exposes secretScan.scan/keep/move, the autosave hold/release and tokens/setValue, none of which answers with a value', () => {
    const api = buildApi(vi.fn(), vi.fn());

    expect(Object.keys(api.secretScan).sort()).toEqual([
      'hold',
      'keep',
      'move',
      'release',
      'scan',
      'setValue',
      'tokens',
    ]);
  });

  it('registers event listeners via the injected on() and returns its unsubscribe', () => {
    const unsubscribe = vi.fn();
    const on = vi.fn().mockReturnValue(unsubscribe);
    const api = buildApi(vi.fn(), on);
    const listener = vi.fn();

    const result = api.on('app.ready', listener);

    expect(on).toHaveBeenCalledWith('app.ready', listener);
    expect(result).toBe(unsubscribe);
  });
});
