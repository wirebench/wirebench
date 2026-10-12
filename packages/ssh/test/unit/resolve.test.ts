import { describe, expect, it } from 'vitest';
import { jumpChain, listResolvedHosts, parseHostsFile, resolveHost, resolveSettings } from '../../src/index.js';
import type { HostsFile } from '../../src/index.js';

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
  it('an unknown target is ssh-host-unknown; an unknown hop on the way is ssh-jump-unknown', () => {
    expect(() => resolveHost(FILE, 'nope')).toThrow(expect.objectContaining({ code: 'ssh-host-unknown' }));
    expect(() => resolveSettings(FILE, 'nope')).toThrow(expect.objectContaining({ code: 'ssh-host-unknown' }));
    expect(() => jumpChain(FILE, 'nope')).toThrow(expect.objectContaining({ code: 'ssh-host-unknown' }));
    // Parsing refuses a dangling jump; a model built in code can still carry one.
    const dangling: HostsFile = {
      version: 1,
      groups: [],
      hosts: [{ id: 'a', name: 'a', address: 'a', tags: [], ssh: { jump: 'gone' } }],
    };
    expect(() => jumpChain(dangling, 'a')).toThrow(
      expect.objectContaining({ code: 'ssh-jump-unknown', details: { id: 'gone' } }),
    );
  });
});

describe('resolveHost forwards', () => {
  const RULES = parseHostsFile(`
version: 1
groups:
  - id: prod
    name: Production
    forwards:
      - { id: grafana, type: local, port: 3000, target: "localhost:3000", bind: 0.0.0.0 }
      - { id: pg, type: local, port: 5432, target: "db:5432" }
      - { id: socks, type: dynamic, port: 1080 }
    groups:
      - id: eu
        name: EU
        forwards:
          - { id: socks, enabled: false }
        hosts:
          - id: db-1
            name: db-1
            address: 10.0.1.7
            forwards:
              - { id: grafana, type: local, port: 3001, target: "localhost:3000" }
              - { id: pg, enabled: false }
              - { id: hook, type: remote, port: 8080, target: "localhost:3000", autoStart: true }
          - id: db-2
            name: db-2
            address: 10.0.1.8
            forwards:
              - { id: socks, type: dynamic, port: 1081 }
              - { id: own, type: dynamic, port: 1082, enabled: false }
hosts:
  - { id: bare, name: bare, address: 10.9.9.9 }
`);
  const forward = (host: string, id: string) => resolveHost(RULES, host).forwards.find((f) => f.rule.id === id);

  it('a group rule reaches a host two levels down, with the defaults filled', () => {
    expect(forward('db-2', 'pg')).toEqual({
      rule: {
        id: 'pg',
        type: 'local',
        port: 5432,
        bind: '127.0.0.1',
        target: { host: 'db', port: 5432 },
        autoStart: false,
      },
      from: { group: 'prod' },
      enabled: true,
    });
  });

  it('a nearer rule with the same id replaces the farther one whole', () => {
    // The group's bind 0.0.0.0 does not survive a host rule without bind.
    expect(forward('db-1', 'grafana')).toEqual({
      rule: {
        id: 'grafana',
        type: 'local',
        port: 3001,
        bind: '127.0.0.1',
        target: { host: 'localhost', port: 3000 },
        autoStart: false,
      },
      from: 'host',
      enabled: true,
    });
  });

  it('an off form on a host switches the inherited rule off and keeps it as the rule', () => {
    expect(forward('db-1', 'pg')).toMatchObject({
      rule: { port: 5432 },
      from: { group: 'prod' },
      enabled: false,
      offBy: 'host',
    });
  });

  it('an off form on a subgroup switches it off below; a host full rule turns it back on', () => {
    expect(forward('db-1', 'socks')).toMatchObject({ from: { group: 'prod' }, enabled: false, offBy: { group: 'eu' } });
    expect(forward('db-2', 'socks')).toEqual({
      rule: { id: 'socks', type: 'dynamic', port: 1081, bind: '127.0.0.1', autoStart: false },
      from: 'host',
      enabled: true,
    });
  });

  it('a full rule with enabled: false is off by its own level', () => {
    expect(forward('db-2', 'own')).toMatchObject({ from: 'host', enabled: false, offBy: 'host' });
  });

  it('a remote rule binds the server loopback by default and keeps autoStart', () => {
    expect(forward('db-1', 'hook')?.rule).toEqual({
      id: 'hook',
      type: 'remote',
      port: 8080,
      bind: 'localhost',
      target: { host: 'localhost', port: 3000 },
      autoStart: true,
    });
  });

  it('keeps first-definition order, new ids appended', () => {
    expect(resolveHost(RULES, 'db-1').forwards.map((f) => f.rule.id)).toEqual(['grafana', 'pg', 'socks', 'hook']);
    expect(resolveHost(RULES, 'db-2').forwards.map((f) => f.rule.id)).toEqual(['grafana', 'pg', 'socks', 'own']);
  });

  it('a host with no rules anywhere has none', () => {
    expect(resolveHost(RULES, 'bare').forwards).toEqual([]);
    expect(resolveHost(FILE, 'api-1').forwards).toEqual([]);
  });
});
