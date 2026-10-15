import { beforeEach, describe, expect, it } from 'vitest';
import {
  isQuickHostId,
  parseQuickTarget,
  quickHostName,
  quickTargetName,
  useQuickHostsStore,
} from '../../src/renderer/features/ssh/quick-hosts.js';

describe('parseQuickTarget (#537)', () => {
  it('reads user, host and port', () => {
    expect(parseQuickTarget('ops@db.example:2222')).toEqual({ address: 'db.example', port: 2222, user: 'ops' });
    expect(parseQuickTarget('  10.0.0.7 ')).toEqual({ address: '10.0.0.7', port: 22 });
    expect(parseQuickTarget('root@[fe80::1]:22')).toEqual({ address: 'fe80::1', port: 22, user: 'root' });
    expect(parseQuickTarget('localhost')).toEqual({ address: 'localhost', port: 22 });
  });

  it('a bare word reads as a search, unless a user or a port says it is a server', () => {
    expect(parseQuickTarget('prod')).toBeUndefined();
    expect(parseQuickTarget('me@prod')).toEqual({ address: 'prod', port: 22, user: 'me' });
    expect(parseQuickTarget('prod:2200')).toEqual({ address: 'prod', port: 2200 });
  });

  it('refuses what is no server', () => {
    for (const text of [
      '',
      'two words.example',
      'a@b@c.example',
      'h.example:0',
      'h.example:70000',
      '-x.example',
      'h/x.y',
    ]) {
      expect(parseQuickTarget(text)).toBeUndefined();
    }
  });
});

describe('quick hosts', () => {
  beforeEach(() => {
    useQuickHostsStore.setState({ targets: {} });
  });

  it('names a server as typed, the port only when it is not 22', () => {
    expect(quickTargetName({ address: 'h.example', port: 22, user: 'me' })).toBe('me@h.example');
    expect(quickTargetName({ address: 'fe80::1', port: 2222 })).toBe('[fe80::1]:2222');
  });

  it('the same server keeps its id; another gets its own', () => {
    const add = useQuickHostsStore.getState().add;
    const first = add({ address: 'h.example', port: 22 });
    expect(isQuickHostId(first)).toBe(true);
    expect(add({ address: 'h.example', port: 22 })).toBe(first);
    expect(add({ address: 'h.example', port: 22, user: 'me' })).not.toBe(first);
    expect(quickHostName(first)).toBe('h.example');
    expect(quickHostName('saved-host')).toBeUndefined();
  });
});
