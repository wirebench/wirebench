import { describe, expect, it } from 'vitest';
import { jumpChain, listResolvedHosts, parseHostsFile, resolveHost } from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
identities:
  - { id: deploy, name: Deploy, user: deploy, auth: { agent: true } }
  - { id: auth-only, name: Agent, auth: { agent: true } }
groups:
  - id: prod
    name: Production
    ssh: { user: ops, keepAlive: 30 }
    hosts:
      - { id: api, name: api, address: 10.0.0.1 }
      - { id: own, name: own, address: 10.0.0.2, ssh: { user: me, keepAlive: 5, connectTimeout: 9 } }
  - id: team
    name: Team
    ssh: { identity: deploy }
    hosts:
      - { id: web, name: web, address: 10.0.1.1 }
  - id: agent
    name: Agent
    ssh: { identity: auth-only }
    hosts:
      - { id: build, name: build, address: 10.0.2.1, ssh: { jump: gate } }
hosts:
  - { id: bare, name: bare, address: 10.9.9.9 }
  - { id: gate, name: gate, address: gate.example.com, ssh: { auth: { agent: true } } }
`);

const PREFS = { user: 'alice', keepAlive: 60, connectTimeout: 45 };

describe('Preferences → SSH as the last level (#571)', () => {
  it('fills a host no level sets, marked preferences', () => {
    const ssh = resolveHost(FILE, 'bare', PREFS).ssh;
    expect(ssh.user).toEqual({ value: 'alice', from: 'preferences' });
    expect(ssh.keepAlive).toEqual({ value: 60, from: 'preferences' });
    expect(ssh.connectTimeout).toEqual({ value: 45, from: 'preferences' });
    expect(ssh.port).toEqual({ value: 22, from: 'default' });
  });
  it('a group wins over Preferences, the host over both', () => {
    const api = resolveHost(FILE, 'api', PREFS).ssh;
    expect(api.user).toEqual({ value: 'ops', from: { group: 'prod' } });
    expect(api.keepAlive).toEqual({ value: 30, from: { group: 'prod' } });
    expect(api.connectTimeout).toEqual({ value: 45, from: 'preferences' });
    const own = resolveHost(FILE, 'own', PREFS).ssh;
    expect(own.user).toEqual({ value: 'me', from: 'host' });
    expect(own.keepAlive).toEqual({ value: 5, from: 'host' });
    expect(own.connectTimeout).toEqual({ value: 9, from: 'host' });
  });
  it("an identity's user wins over Preferences; one without a user passes on to it", () => {
    expect(resolveHost(FILE, 'web', PREFS).ssh.user).toEqual({ value: 'deploy', from: { identity: 'deploy' } });
    const build = resolveHost(FILE, 'build', PREFS);
    expect(build.ssh.user).toEqual({ value: 'alice', from: 'preferences' });
    expect(build.incomplete).toBeUndefined();
  });
  it('a default user completes a host that has a way to sign in', () => {
    expect(resolveHost(FILE, 'gate').incomplete).toEqual({ field: 'user' });
    expect(resolveHost(FILE, 'gate', PREFS).incomplete).toBeUndefined();
    expect(resolveHost(FILE, 'bare', PREFS).incomplete).toEqual({ field: 'auth' });
  });
  it('jump hosts on the chain resolve against the same defaults', () => {
    expect(jumpChain(FILE, 'build', PREFS).map((h) => [h.id, h.ssh.user.value, h.ssh.keepAlive.value])).toEqual([
      ['gate', 'alice', 60],
      ['build', 'alice', 60],
    ]);
  });
  it('without defaults, or with a field unset, the built-in values apply', () => {
    const ssh = resolveHost(FILE, 'bare').ssh;
    expect(ssh.user).toEqual({ value: undefined, from: 'default' });
    expect(ssh.keepAlive).toEqual({ value: 15, from: 'default' });
    expect(ssh.connectTimeout).toEqual({ value: 20, from: 'default' });
    const partial = resolveHost(FILE, 'bare', { keepAlive: 0 }).ssh;
    expect(partial.keepAlive).toEqual({ value: 0, from: 'preferences' });
    expect(partial.user).toEqual({ value: undefined, from: 'default' });
    expect(partial.connectTimeout).toEqual({ value: 20, from: 'default' });
  });
  it('listResolvedHosts passes the defaults to every host', () => {
    expect(listResolvedHosts(FILE, PREFS).find((h) => h.id === 'bare')?.ssh.user.value).toBe('alice');
  });
});
