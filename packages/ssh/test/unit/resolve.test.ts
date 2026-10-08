import { describe, expect, it } from 'vitest';
import { jumpChain, listResolvedHosts, parseHostsFile, resolveHost } from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
groups:
  - id: prod
    name: Production
    ssh: { user: deploy, port: 2222, jump: bastion, auth: { key: '\${secret:prod_key}' } }
    groups:
      - id: eu
        name: EU
        ssh: { user: eu-deploy }
        hosts:
          - { id: api-1, name: api-1, address: 10.0.1.5, ssh: { auth: { password: '\${secret:api1_pw}' } } }
          - { id: api-2, name: api-2, address: 10.0.1.6 }
hosts:
  - { id: bastion, name: bastion, address: bastion.example.com, ssh: { user: ops, auth: { agent: true } } }
  - { id: bare, name: bare, address: 10.9.9.9 }
`);

describe('resolveHost', () => {
  it('nearer group wins, host wins over group, defaults are marked', () => {
    const host = resolveHost(FILE, 'api-1');
    expect(host.path).toEqual(['prod', 'eu']);
    expect(host.ssh.user).toEqual({ value: 'eu-deploy', from: { group: 'eu' } });
    expect(host.ssh.port).toEqual({ value: 2222, from: { group: 'prod' } });
    expect(host.ssh.auth).toEqual({ value: { kind: 'password', password: '${secret:api1_pw}' }, from: 'host' });
    expect(host.ssh.jump).toEqual({ value: 'bastion', from: { group: 'prod' } });
    expect(host.ssh.keepAlive).toEqual({ value: 15, from: 'default' });
    expect(host.incomplete).toBeUndefined();
  });
  it('auth is replaced whole, never merged', () => {
    expect(resolveHost(FILE, 'api-2').ssh.auth).toEqual({
      value: { kind: 'key', key: '${secret:prod_key}' },
      from: { group: 'prod' },
    });
  });
  it('a host with no user or auth anywhere is incomplete', () => {
    expect(resolveHost(FILE, 'bare').incomplete).toEqual({ field: 'user' });
  });
  it('jumpChain lists the hops outermost first and ends with the target', () => {
    expect(jumpChain(FILE, 'api-1').map((h) => h.id)).toEqual(['bastion', 'api-1']);
    expect(jumpChain(FILE, 'bastion').map((h) => h.id)).toEqual(['bastion']);
  });
  it('listResolvedHosts keeps document order', () => {
    expect(listResolvedHosts(FILE).map((h) => h.id)).toEqual(['api-1', 'api-2', 'bastion', 'bare']);
  });
  it('an inherited jump that loops is refused at parse time', () => {
    expect(() =>
      parseHostsFile(
        `version: 1\ngroups:\n  - id: g\n    name: g\n    ssh: { jump: a }\n    hosts:\n      - { id: a, name: a, address: a }\n`,
      ),
    ).toThrow(/loops/);
  });
  it('a group id or unknown id is not a host', () => {
    expect(() => resolveHost(FILE, 'prod')).toThrow(/not a host/);
  });
});
