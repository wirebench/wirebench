// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  enabledAreasFromEnv,
  hostsOnFileChange,
  hostsOnWorkspaceChange,
  localTerminalFromEnv,
  parseAreaSwitches,
  registerEnabledAreaChannels,
} from '../src/main/areas.js';

const registered = vi.hoisted(() => new Set<string>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string) => {
      registered.add(name);
    },
  },
}));

/** The channel names registering the enabled areas leaves behind; no handler is called. */
function channelsFor(env: string): string[] {
  registered.clear();
  const environment = { WIREBENCH_AREAS: env };
  registerEnabledAreaChannels(enabledAreasFromEnv(environment), {
    localTerminal: localTerminalFromEnv(environment) ? {} : undefined,
  } as never);
  return [...registered];
}

describe('WIREBENCH_AREAS', () => {
  it('parses id=off and id=on pairs, ignoring blanks and case', () => {
    expect(parseAreaSwitches('ssh=off, wss=OFF ,history=on')).toEqual({ ssh: false, wss: false, history: true });
  });
  it('is empty when unset or malformed', () => {
    expect(parseAreaSwitches(undefined)).toEqual({});
    expect(parseAreaSwitches('ssh')).toEqual({});
    expect(parseAreaSwitches('ssh=maybe')).toEqual({});
  });
  it('enabledAreasFromEnv drops the switched-off area', () => {
    expect(enabledAreasFromEnv({ WIREBENCH_AREAS: 'wss=off' })).toEqual([
      'explorer',
      'environments',
      'search',
      'history',
      'ssh',
    ]);
  });
});

describe('area channels', () => {
  it('the SSH area registers its ssh.* and sftp.* channels', () => {
    const names = channelsFor('');
    expect(names).toContain('ssh.connect');
    expect(names).toEqual(
      expect.arrayContaining(['ssh.listSnippets', 'ssh.saveSnippets', 'ssh.runSnippet', 'ssh.previewSnippet']),
    );
    expect(names.filter((n) => n.startsWith('layout.')).sort()).toEqual([
      'layout.delete',
      'layout.list',
      'layout.rename',
      'layout.save',
    ]);
    expect(names.filter((n) => n.startsWith('sftp.')).sort()).toEqual([
      'sftp.cancel',
      'sftp.chmod',
      'sftp.close',
      'sftp.copy',
      'sftp.edit',
      'sftp.editReply',
      'sftp.endEdit',
      'sftp.list',
      'sftp.localHome',
      'sftp.mkdir',
      'sftp.open',
      'sftp.remove',
      'sftp.rename',
      'sftp.resolve',
      'sftp.retry',
    ]);
  });
  it('the SSH area registers its forward.* channels', () => {
    expect(
      channelsFor('')
        .filter((n) => n.startsWith('forward.'))
        .sort(),
    ).toEqual(['forward.freePort', 'forward.list', 'forward.start', 'forward.stop', 'forward.stopAll']);
  });
  it('the SSH area registers its sessionLog.* channels', () => {
    expect(
      channelsFor('')
        .filter((n) => n.startsWith('sessionLog.'))
        .sort(),
    ).toEqual([
      'sessionLog.delete',
      'sessionLog.list',
      'sessionLog.read',
      'sessionLog.reveal',
      'sessionLog.search',
      'sessionLog.setSwitch',
      'sessionLog.switches',
    ]);
  });
  it('with ssh=off no ssh.*, sftp.*, forward.*, layout.* or sessionLog.* channel exists', () => {
    expect(
      channelsFor('ssh=off').filter(
        (n) =>
          n.startsWith('ssh.') ||
          n.startsWith('sftp.') ||
          n.startsWith('forward.') ||
          n.startsWith('layout.') ||
          n.startsWith('sessionLog.'),
      ),
    ).toEqual([]);
  });
});

describe('the local terminal switch', () => {
  it('is on with the SSH area, and off with it', () => {
    expect(localTerminalFromEnv({})).toBe(true);
    expect(localTerminalFromEnv({ WIREBENCH_AREAS: 'ssh=off' })).toBe(false);
  });
  it('local-terminal=off switches it off on its own, leaving SSH on', () => {
    const env = { WIREBENCH_AREAS: 'local-terminal=off' };
    expect(localTerminalFromEnv(env)).toBe(false);
    expect(enabledAreasFromEnv(env)).toContain('ssh');
  });
  it('registers the localTerminal.* channels only while it is on', () => {
    const local = (env: string) =>
      channelsFor(env)
        .filter((n) => n.startsWith('localTerminal.'))
        .sort();
    expect(local('')).toEqual([
      'localTerminal.close',
      'localTerminal.open',
      'localTerminal.resize',
      'localTerminal.write',
    ]);
    expect(local('local-terminal=off')).toEqual([]);
    expect(channelsFor('local-terminal=off')).toContain('ssh.connect');
    expect(local('ssh=off')).toEqual([]);
  });
});

describe('hostsOnWorkspaceChange', () => {
  it('drops the cached hosts.yaml and tells the renderer when the ssh area is on', () => {
    const order: string[] = [];
    const hosts = { invalidate: vi.fn(() => order.push('invalidate')) };
    const notify = vi.fn(() => order.push('notify'));
    hostsOnWorkspaceChange(['explorer', 'ssh'], hosts, notify);
    expect(order).toEqual(['invalidate', 'notify']);
  });
  it('drops the cache but stays quiet when the ssh area is off', () => {
    const hosts = { invalidate: vi.fn() };
    const notify = vi.fn();
    hostsOnWorkspaceChange(['explorer'], hosts, notify);
    expect(hosts.invalidate).toHaveBeenCalledOnce();
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('hostsOnFileChange', () => {
  it('drops the cache always, and tells the renderer only when the ssh area is on', () => {
    const on = { invalidate: vi.fn() };
    const notifyOn = vi.fn();
    hostsOnFileChange(['explorer', 'ssh'], on, notifyOn);
    expect(on.invalidate).toHaveBeenCalledTimes(1);
    expect(notifyOn).toHaveBeenCalledTimes(1);

    const off = { invalidate: vi.fn() };
    const notifyOff = vi.fn();
    hostsOnFileChange(['explorer'], off, notifyOff);
    expect(off.invalidate).toHaveBeenCalledTimes(1);
    expect(notifyOff).not.toHaveBeenCalled();
  });
});
