import { describe, expect, it } from 'vitest';
import {
  defaultBind,
  isNetworkBind,
  isOffForm,
  parseHostsFile,
  parseTarget,
  serializeHostsFile,
  SshModelError,
} from '../../src/index.js';

/** The example of the forwarding design, D1. */
const SPEC_EXAMPLE = `
version: 1
groups:
  - id: prod
    name: Production
    ssh: { user: deploy, auth: { key: '\${secret:prod_key}' } }
    forwards:
      - id: grafana
        type: local
        port: 3000
        target: localhost:3000
    hosts:
      - id: db-1
        name: db-1
        address: 10.0.1.7
        forwards:
          - id: pg
            type: local
            port: 5432
            target: localhost:5432
            autoStart: true
          - id: grafana
            enabled: false
hosts:
  - id: bastion
    name: bastion
    address: bastion.example.com
    ssh: { user: ops, auth: { agent: true } }
    forwards:
      - id: socks
        type: dynamic
        port: 1080
      - id: hook
        type: remote
        port: 8080
        target: localhost:3000
`;

function expectCode(fn: () => unknown, code: string): SshModelError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SshModelError);
    expect((error as SshModelError).code).toBe(code);
    return error as SshModelError;
  }
  throw new Error(`expected ${code}`);
}

/** A file with one root host whose forwards list is `rules` (YAML flow mappings). */
const hostWith = (...rules: string[]): string =>
  `version: 1\nhosts:\n  - id: a\n    name: a\n    address: a\n    forwards:\n${rules.map((r) => `      - ${r}\n`).join('')}`;

describe('forwards in hosts.yaml', () => {
  it('accepts the design example', () => {
    const file = parseHostsFile(SPEC_EXAMPLE);
    expect(file.groups[0]?.forwards).toEqual([{ id: 'grafana', type: 'local', port: 3000, target: 'localhost:3000' }]);
    expect(file.groups[0]?.hosts[0]?.forwards).toEqual([
      { id: 'pg', type: 'local', port: 5432, target: 'localhost:5432', autoStart: true },
      { id: 'grafana', enabled: false },
    ]);
    expect(file.hosts[0]?.forwards).toEqual([
      { id: 'socks', type: 'dynamic', port: 1080 },
      { id: 'hook', type: 'remote', port: 8080, target: 'localhost:3000' },
    ]);
  });

  it('accepts a full rule of each type, and every bind and target form', () => {
    const file = parseHostsFile(
      hostWith(
        '{ id: l, type: local, port: 1, bind: localhost, target: "db:5432" }',
        '{ id: r, type: remote, port: 65535, bind: 10.0.0.1, target: "[fe80::1]:22" }',
        '{ id: d, type: dynamic, port: 1080, bind: "::1" }',
        '{ id: n, type: dynamic, port: 1081, bind: 0.0.0.0, autoStart: true, enabled: false }',
      ),
    );
    expect(file.hosts[0]?.forwards?.map((f) => f.id)).toEqual(['l', 'r', 'd', 'n']);
  });

  it.each([
    ['dynamic with a target', '{ id: x, type: dynamic, port: 1080, target: "db:1" }', 'target'],
    ['local without a target', '{ id: x, type: local, port: 5432 }', 'target'],
    ['remote without a target', '{ id: x, type: remote, port: 8080 }', 'target'],
    ['port 0', '{ id: x, type: dynamic, port: 0 }', 'port'],
    ['port 65536', '{ id: x, type: dynamic, port: 65536 }', 'port'],
    ['port 1.5', '{ id: x, type: dynamic, port: 1.5 }', 'port'],
    ['a host-name bind', '{ id: x, type: dynamic, port: 1080, bind: db.internal }', 'bind'],
    ['a target without a port', '{ id: x, type: local, port: 1, target: db }', 'target'],
    ['a target port out of range', '{ id: x, type: local, port: 1, target: "db:70000" }', 'target'],
    ['a malformed IPv6 target', '{ id: x, type: local, port: 1, target: "[nope]:22" }', 'target'],
    ['a secret token as target', '{ id: x, type: local, port: 1, target: "${secret:k}:22" }', 'target'],
    ['an unknown key', '{ id: x, type: dynamic, port: 1080, colour: red }', 'colour'],
    ['an unknown type', '{ id: x, type: socks, port: 1080 }', 'type'],
    ['a bad id', '{ id: "Bad Id", type: dynamic, port: 1080 }', 'id'],
    ['an enabled rule with no type', '{ id: x, enabled: true }', 'type'],
    ['an off form with an extra key', '{ id: x, enabled: false, autoStart: true }', 'type'],
  ])('refuses %s with ssh-forward-invalid naming the field', (_label, rule, field) => {
    const e = expectCode(() => parseHostsFile(hostWith(rule)), 'ssh-forward-invalid');
    expect(e.details).toMatchObject({ path: `hosts[0].forwards[0].${field}`, field });
    expect(e.message).toContain(field);
  });

  it('names the rule in an invalid rule inside a group', () => {
    const e = expectCode(
      () =>
        parseHostsFile(
          `version: 1\ngroups:\n  - id: g\n    name: g\n    forwards:\n      - { id: ok, type: dynamic, port: 1 }\n      - { id: pg, type: local, port: 5432 }\n`,
        ),
      'ssh-forward-invalid',
    );
    expect(e.details).toMatchObject({ path: 'groups[0].forwards[1].target', field: 'target', id: 'pg' });
  });

  it('refuses the same id twice in one list, but not across levels', () => {
    const e = expectCode(
      () =>
        parseHostsFile(
          hostWith('{ id: pg, type: local, port: 5432, target: "db:5432" }', '{ id: pg, type: dynamic, port: 1080 }'),
        ),
      'ssh-forward-duplicate-id',
    );
    expect(e.details).toMatchObject({ id: 'pg', level: 'a' });
    expect(() =>
      parseHostsFile(
        `version: 1\ngroups:\n  - id: g\n    name: g\n    forwards: [{ id: pg, type: dynamic, port: 1 }]\n    hosts:\n      - { id: h, name: h, address: h, forwards: [{ id: pg, type: dynamic, port: 2 }] }\n`,
      ),
    ).not.toThrow();
  });

  it('refuses an off form with no rule of that id above it', () => {
    const e = expectCode(
      () =>
        parseHostsFile(
          `version: 1\ngroups:\n  - id: g\n    name: g\n    forwards: [{ id: pg, type: dynamic, port: 1 }]\n    hosts:\n      - { id: h, name: h, address: h, forwards: [{ id: pgg, enabled: false }] }\n`,
        ),
      'ssh-forward-unknown',
    );
    expect(e.details).toMatchObject({ id: 'pgg', level: 'h', lookedIn: ['g'] });
    expectCode(() => parseHostsFile(hostWith('{ id: x, enabled: false }')), 'ssh-forward-unknown');
    // A rule on the same level does not count: an off form switches off a rule from above.
    expectCode(
      () => parseHostsFile(hostWith('{ id: x, type: dynamic, port: 1 }', '{ id: x2, enabled: false }')),
      'ssh-forward-unknown',
    );
  });

  it('accepts an off form for a rule two levels up, on a host or a group', () => {
    const file = parseHostsFile(`
version: 1
groups:
  - id: top
    name: top
    forwards: [{ id: pg, type: local, port: 5432, target: "db:5432" }]
    groups:
      - id: mid
        name: mid
        groups:
          - id: low
            name: low
            forwards: [{ id: pg, enabled: false }]
        hosts:
          - { id: h, name: h, address: h, forwards: [{ id: pg, enabled: false }] }
`);
    expect(file.groups[0]?.groups[0]?.hosts[0]?.forwards).toEqual([{ id: 'pg', enabled: false }]);
  });
});

describe('serialising forwards', () => {
  it('round-trips the design example', () => {
    const file = parseHostsFile(SPEC_EXAMPLE);
    expect(parseHostsFile(serializeHostsFile(file))).toEqual(file);
  });

  it('writes forwards after ssh, keys in order, defaults omitted', () => {
    const file = parseHostsFile(
      hostWith(
        '{ enabled: true, autoStart: false, bind: 127.0.0.1, target: "db:5432", port: 5432, type: local, id: pg }',
        '{ id: hook, type: remote, port: 8080, target: "x:1", bind: localhost }',
        '{ id: s, type: dynamic, port: 1080, bind: 0.0.0.0, autoStart: true, enabled: false }',
      ).replace('    forwards:', '    ssh: { user: me }\n    forwards:'),
    );
    const text = serializeHostsFile(file);
    expect(text.indexOf('ssh:')).toBeLessThan(text.indexOf('forwards:'));
    expect(text).toContain('- id: pg\n        type: local\n        port: 5432\n        target: db:5432\n');
    expect(text).toContain('- id: hook\n        type: remote\n        port: 8080\n        target: x:1\n');
    expect(text).toContain(
      '- id: s\n        type: dynamic\n        port: 1080\n        bind: 0.0.0.0\n        autoStart: true\n        enabled: false\n',
    );
    expect(text).not.toContain('127.0.0.1');
    expect(text).not.toContain('localhost');
    expect(parseHostsFile(text)).toEqual(file);
  });

  it('writes no forwards key for an entry without rules', () => {
    const file = parseHostsFile(
      `version: 1\ngroups:\n  - { id: g, name: g, forwards: [] }\nhosts:\n  - { id: a, name: a, address: a }\n`,
    );
    const text = serializeHostsFile(file);
    expect(text).not.toContain('forwards');
    expect(parseHostsFile(text)).toEqual(file);
  });
});

describe('rule helpers', () => {
  it('isOffForm tells the off form from a full rule switched off', () => {
    expect(isOffForm({ id: 'x', enabled: false })).toBe(true);
    expect(isOffForm({ id: 'x', type: 'dynamic', port: 1, enabled: false })).toBe(false);
  });

  it('parseTarget reads host:port and [v6]:port', () => {
    expect(parseTarget('db:5432')).toEqual({ host: 'db', port: 5432 });
    expect(parseTarget('10.0.0.1:22')).toEqual({ host: '10.0.0.1', port: 22 });
    expect(parseTarget('[fe80::1]:22')).toEqual({ host: 'fe80::1', port: 22 });
    expectCode(() => parseTarget('db'), 'ssh-forward-invalid');
    expectCode(() => parseTarget('fe80::1:22'), 'ssh-forward-invalid');
    expectCode(() => parseTarget('db:0'), 'ssh-forward-invalid');
  });

  it('defaultBind is loopback here for local and dynamic, the server loopback for remote', () => {
    expect(defaultBind('local')).toBe('127.0.0.1');
    expect(defaultBind('dynamic')).toBe('127.0.0.1');
    expect(defaultBind('remote')).toBe('localhost');
  });

  it('isNetworkBind is false only for loopback', () => {
    for (const bind of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) expect(isNetworkBind(bind)).toBe(false);
    for (const bind of ['0.0.0.0', '::', '192.168.1.4', '128.0.0.1']) expect(isNetworkBind(bind)).toBe(true);
  });
});
