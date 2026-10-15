import { describe, expect, it } from 'vitest';
import { hostsFileVersion, parseHostsFile, serializeHostsFile, SshModelError } from '../../src/index.js';

const HOSTS = `groups:
  - id: prod
    name: Production
    forwards:
      - { id: grafana, type: local, port: 3000, target: "localhost:3000" }
    hosts:
      - { id: db-1, name: db-1, address: 10.0.1.7, forwards: [{ id: pg, type: local, port: 5432, target: "localhost:5432" }] }
hosts:
  - { id: cache, name: cache, address: cache.example.com, forwards: [{ id: redis, type: local, port: 6379, target: "localhost:6379" }] }
`;

const v2 = (groups: string): string => `version: 2\n${HOSTS}forwardGroups:\n${groups}`;

const DEV = `  - id: dev
    name: Dev
    rules:
      - { host: db-1, rule: pg }
      - { host: cache, rule: redis }
`;

function expectCode(run: () => unknown, code: string): SshModelError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SshModelError);
    expect((error as SshModelError).code).toBe(code);
    return error as SshModelError;
  }
  throw new Error(`expected ${code}`);
}

describe('forwarding groups in hosts.yaml (#583)', () => {
  it('loads a version 1 file unchanged and writes it back as version 1', () => {
    const text = `version: 1\n${HOSTS}`;
    const file = parseHostsFile(text);
    expect(file.version).toBe(1);
    expect(file.forwardGroups).toBeUndefined();
    expect(serializeHostsFile(file)).toBe(serializeHostsFile(parseHostsFile(serializeHostsFile(file))));
    expect(serializeHostsFile(file)).toMatch(/^version: 1\n/);
    expect(serializeHostsFile(file)).not.toContain('forwardGroups');
  });

  it('reads groups of rules from different hosts, inherited rules included, and round-trips them', () => {
    const file = parseHostsFile(
      v2(`${DEV}  - id: dash\n    name: Dashboards\n    rules: [{ host: db-1, rule: grafana }]\n`),
    );
    expect(file.version).toBe(2);
    expect(file.forwardGroups).toEqual([
      {
        id: 'dev',
        name: 'Dev',
        rules: [
          { host: 'db-1', rule: 'pg' },
          { host: 'cache', rule: 'redis' },
        ],
      },
      { id: 'dash', name: 'Dashboards', rules: [{ host: 'db-1', rule: 'grafana' }] },
    ]);
    const written = serializeHostsFile(file);
    expect(written).toMatch(/^version: 2\n/);
    expect(parseHostsFile(written)).toEqual(file);
  });

  it('upgrades the written version when a group is added, and lowers it when the last one goes', () => {
    const file = parseHostsFile(`version: 1\n${HOSTS}`);
    const withGroup = {
      ...file,
      forwardGroups: [{ id: 'dev', name: 'Dev', rules: [{ host: 'cache', rule: 'redis' }] }],
    };
    expect(hostsFileVersion(withGroup)).toBe(2);
    expect(serializeHostsFile(withGroup)).toMatch(/^version: 2\n/);
    const none = { ...parseHostsFile(serializeHostsFile(withGroup)), forwardGroups: [] };
    expect(serializeHostsFile(none)).toMatch(/^version: 1\n/);
    expect(serializeHostsFile(none)).not.toContain('forwardGroups');
  });

  it('keeps an empty group (rules default to none)', () => {
    const file = parseHostsFile(v2('  - { id: later, name: Later }\n'));
    expect(file.forwardGroups).toEqual([{ id: 'later', name: 'Later', rules: [] }]);
    expect(serializeHostsFile(file)).toContain('rules: []');
  });

  it('refuses forwardGroups in a version 1 file', () => {
    const e = expectCode(() => parseHostsFile(`version: 1\n${HOSTS}forwardGroups:\n${DEV}`), 'ssh-hosts-invalid');
    expect(e.message).toContain('forwardGroups');
    expect(e.message).toContain('version: 2');
  });

  it('refuses an unknown version', () => {
    expectCode(() => parseHostsFile(`version: 3\n${HOSTS}`), 'ssh-hosts-invalid');
  });

  it('refuses a group id used twice', () => {
    const e = expectCode(
      () => parseHostsFile(v2('  - { id: dev, name: A, rules: [] }\n  - { id: dev, name: B, rules: [] }\n')),
      'ssh-forward-group-duplicate-id',
    );
    expect(e.details).toMatchObject({ id: 'dev' });
  });

  it('refuses a rule in two groups, or twice in one', () => {
    const two = expectCode(
      () => parseHostsFile(v2(`${DEV}  - id: other\n    name: Other\n    rules: [{ host: cache, rule: redis }]\n`)),
      'ssh-forward-group-member-twice',
    );
    expect(two.details).toMatchObject({ host: 'cache', rule: 'redis', groups: ['dev', 'other'] });
    expectCode(
      () =>
        parseHostsFile(
          v2('  - id: dev\n    name: Dev\n    rules: [{ host: cache, rule: redis }, { host: cache, rule: redis }]\n'),
        ),
      'ssh-forward-group-member-twice',
    );
  });

  it('allows one inherited rule on two hosts in two groups', () => {
    const text = `version: 2
groups:
  - id: web
    name: Web
    forwards: [{ id: admin, type: local, port: 8080, target: "localhost:80" }]
    hosts:
      - { id: w1, name: w1, address: w1 }
      - { id: w2, name: w2, address: w2 }
forwardGroups:
  - { id: a, name: A, rules: [{ host: w1, rule: admin }] }
  - { id: b, name: B, rules: [{ host: w2, rule: admin }] }
`;
    expect(() => parseHostsFile(text)).not.toThrow();
  });

  it('keeps a member whose host or rule has gone, so the file still loads', () => {
    const file = parseHostsFile(
      v2('  - id: dev\n    name: Dev\n    rules: [{ host: gone, rule: pg }, { host: cache, rule: old }]\n'),
    );
    expect(file.forwardGroups?.[0]?.rules).toHaveLength(2);
  });

  it('refuses a malformed member', () => {
    expectCode(() => parseHostsFile(v2('  - { id: dev, name: Dev, rules: [{ host: cache }] }\n')), 'ssh-hosts-invalid');
    expectCode(() => parseHostsFile(v2('  - { id: Dev, name: Dev }\n')), 'ssh-hosts-invalid');
    expectCode(() => parseHostsFile(v2('  - { id: dev, name: "" }\n')), 'ssh-hosts-invalid');
  });
});
