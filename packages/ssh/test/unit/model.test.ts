// packages/ssh/test/unit/model.test.ts
import { describe, expect, it } from 'vitest';
import { EMPTY_HOSTS_FILE, parseHostsFile, serializeHostsFile, SshModelError } from '../../src/index.js';

const SAMPLE = `
version: 1
groups:
  - id: prod
    name: Production
    tags: [prod]
    ssh:
      user: deploy
      port: 22
      jump: bastion
      auth: { key: '\${secret:prod_key}' }
    groups:
      - id: eu
        name: EU
        hosts:
          - id: api-1
            name: api-1
            address: 10.0.1.5
            ssh:
              auth: { password: '\${secret:api1_pw}' }
hosts:
  - id: bastion
    name: bastion
    address: bastion.example.com
    tags: [jump]
    ssh:
      user: ops
      auth: { agent: true }
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

describe('parseHostsFile', () => {
  it('parses the sample into typed entries with defaults filled', () => {
    const file = parseHostsFile(SAMPLE);
    expect(file.groups[0]?.ssh.auth).toEqual({ kind: 'key', key: '${secret:prod_key}' });
    expect(file.groups[0]?.groups[0]?.hosts[0]?.tags).toEqual([]);
    expect(file.hosts[0]?.ssh.auth).toEqual({ kind: 'agent' });
  });
  it('an empty document is the empty file', () => {
    expect(parseHostsFile('')).toEqual(EMPTY_HOSTS_FILE);
    expect(parseHostsFile('version: 1\n')).toEqual(EMPTY_HOSTS_FILE);
  });
  it('refuses a literal password without echoing it', () => {
    const e = expectCode(
      () =>
        parseHostsFile(
          `version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { auth: { password: hunter2 } } }\n`,
        ),
      'ssh-literal-secret',
    );
    expect(e.details).toMatchObject({ path: 'hosts[0].ssh.auth.password' });
    expect(e.message).not.toContain('hunter2');
  });
  it('refuses a duplicate id across groups and hosts', () => {
    expectCode(
      () => parseHostsFile(`version: 1\ngroups:\n  - { id: x, name: g }\nhosts:\n  - { id: x, name: h, address: a }\n`),
      'ssh-duplicate-id',
    );
  });
  it('refuses unknown keys, a bad id, a bad version, and an auth with two methods', () => {
    expectCode(
      () => parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: a, colour: red }\n`),
      'ssh-hosts-invalid',
    );
    expectCode(
      () => parseHostsFile(`version: 1\nhosts:\n  - { id: 'Bad Id', name: a, address: a }\n`),
      'ssh-hosts-invalid',
    );
    expectCode(() => parseHostsFile(`version: 2\n`), 'ssh-hosts-invalid');
    expectCode(
      () =>
        parseHostsFile(
          `version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { auth: { agent: true, password: '\${secret:p}' } } }\n`,
        ),
      'ssh-hosts-invalid',
    );
  });
  it('refuses a jump that names no host, and a jump cycle', () => {
    expectCode(
      () => parseHostsFile(`version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { jump: nope } }\n`),
      'ssh-jump-unknown',
    );
    const e = expectCode(
      () =>
        parseHostsFile(
          `version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { jump: b } }\n  - { id: b, name: b, address: b, ssh: { jump: a } }\n`,
        ),
      'ssh-jump-cycle',
    );
    expect(e.details).toMatchObject({ cycle: ['a', 'b', 'a'] });
  });
  it('round-trips through serializeHostsFile', () => {
    const file = parseHostsFile(SAMPLE);
    expect(parseHostsFile(serializeHostsFile(file))).toEqual(file);
  });
});
