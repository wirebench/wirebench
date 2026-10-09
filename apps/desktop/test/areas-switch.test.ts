// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  enabledAreasFromEnv,
  hostsOnFileChange,
  hostsOnWorkspaceChange,
  parseAreaSwitches,
} from '../src/main/areas.js';

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
