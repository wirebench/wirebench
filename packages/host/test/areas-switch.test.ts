// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { HandlerTable } from '../src/ipc/register.js';
import {
  enabledAreasFromEnv,
  hostsOnFileChange,
  hostsOnWorkspaceChange,
  localTerminalFromEnv,
  parseAreaSwitches,
  registerEnabledAreaChannels,
  resolveAreas,
  serialFromEnv,
  telnetFromEnv,
} from '../src/areas.js';
import { Redactor } from '../src/host/redactor.js';

/** Registering only fills this table; nothing is bound, so no handler is called. */
const table = new HandlerTable(new Redactor());

/** The channel names registering the enabled areas leaves behind; no handler is called. */
function channelsFor(env: string): string[] {
  table.clear();
  const environment = { WIREBENCH_AREAS: env };
  registerEnabledAreaChannels(table, enabledAreasFromEnv(environment), {
    localTerminal: localTerminalFromEnv(environment) ? {} : undefined,
  } as never);
  return [...table.keys()];
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

describe('resolveAreas (#360)', () => {
  it('with no policy and no variable every area and sub-switch is on', () => {
    const run = resolveAreas({ env: {} });
    expect(run.enabled).toEqual(['explorer', 'environments', 'search', 'history', 'wss', 'ssh']);
    expect(run.localTerminal).toBe(true);
    expect(run.telnet).toBe(true);
    expect(run.serial).toBe(true);
    expect(run.states.map((state) => state.id)).toEqual([
      'explorer',
      'environments',
      'search',
      'history',
      'wss',
      'ssh',
      'local-terminal',
      'telnet',
      'serial',
    ]);
    expect(run.states.every((state) => state.enabled && !state.policy)).toBe(true);
  });

  it('the managed policy wins over WIREBENCH_AREAS=ssh=on, and takes the sub-switches with it', () => {
    const run = resolveAreas({ policy: ['ssh'], env: { WIREBENCH_AREAS: 'ssh=on' } });
    expect(run.enabled).not.toContain('ssh');
    expect(run.localTerminal).toBe(false);
    expect(run.telnet).toBe(false);
    expect(run.serial).toBe(false);
    const ssh = run.states.find((state) => state.id === 'ssh');
    expect(ssh).toMatchObject({ enabled: false, policy: true, preference: true, reason: { by: 'policy' } });
    expect(run.states.find((state) => state.id === 'telnet')).toMatchObject({
      enabled: false,
      policy: false,
      reason: { by: 'requires', feature: 'ssh' },
    });
  });

  it('a policy entry for a sub-switch leaves the SSH area on', () => {
    const run = resolveAreas({ policy: ['telnet'], env: {} });
    expect(run.enabled).toContain('ssh');
    expect(run.telnet).toBe(false);
    expect(run.serial).toBe(true);
    expect(run.states.find((state) => state.id === 'telnet')).toMatchObject({ policy: true, reason: { by: 'policy' } });
  });

  it('the variable alone still switches off, with the preference reason', () => {
    const run = resolveAreas({ env: { WIREBENCH_AREAS: 'wss=off' } });
    expect(run.enabled).toEqual(['explorer', 'environments', 'search', 'history', 'ssh']);
    expect(run.states.find((state) => state.id === 'wss')).toMatchObject({
      policy: false,
      reason: { by: 'preference' },
    });
  });

  it('a policy id with no descriptor, and an unknown variable id, change nothing', () => {
    const run = resolveAreas({ policy: ['graphql'], env: { WIREBENCH_AREAS: 'nope=off' } });
    expect(run.enabled).toHaveLength(6);
  });

  it('agrees with the shared filter enabledAreaIds for every variable value', () => {
    for (const env of ['', 'ssh=off', 'wss=off,history=off', 'local-terminal=off', 'explorer=off']) {
      expect(resolveAreas({ env: { WIREBENCH_AREAS: env } }).enabled).toEqual(
        enabledAreasFromEnv({ WIREBENCH_AREAS: env }),
      );
    }
  });

  it('registers no ssh.* channel when the policy switches the area off, whatever the variable says', () => {
    table.clear();
    const run = resolveAreas({ policy: ['ssh'], env: { WIREBENCH_AREAS: 'ssh=on' } });
    registerEnabledAreaChannels(table, run.enabled, { localTerminal: run.localTerminal ? {} : undefined } as never);
    expect([...table.keys()].filter((n) => n.startsWith('ssh.') || n.startsWith('localTerminal.'))).toEqual([]);
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
      'sessionLog.teamList',
      'sessionLog.teamRead',
    ]);
  });
  it('the SSH area registers its terminalShare.* channels (#429)', () => {
    expect(channelsFor('').filter((n) => n.startsWith('terminalShare.'))).toHaveLength(13);
    expect(channelsFor('ssh=off').filter((n) => n.startsWith('terminalShare.'))).toEqual([]);
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

describe('the Telnet switch (#425)', () => {
  it('is on with the SSH area, off with it, and telnet=off switches it off on its own', () => {
    expect(telnetFromEnv({})).toBe(true);
    expect(telnetFromEnv({ WIREBENCH_AREAS: 'ssh=off' })).toBe(false);
    const env = { WIREBENCH_AREAS: 'telnet=off' };
    expect(telnetFromEnv(env)).toBe(false);
    expect(enabledAreasFromEnv(env)).toContain('ssh');
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

describe('the serial switch (#426)', () => {
  it('is on with the SSH area, off with it, and serial=off switches it off on its own', () => {
    expect(serialFromEnv({})).toBe(true);
    expect(serialFromEnv({ WIREBENCH_AREAS: 'ssh=off' })).toBe(false);
    const env = { WIREBENCH_AREAS: 'serial=off' };
    expect(serialFromEnv(env)).toBe(false);
    expect(telnetFromEnv(env)).toBe(true);
    expect(enabledAreasFromEnv(env)).toContain('ssh');
  });
});
