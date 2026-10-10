import { describe, expect, it } from 'vitest';
import { EMPTY_HOSTS_FILE, parseHostsFile, resolveHost, type HostsFile } from '../../../src/index.js';
import { applySshConfigImport } from '../../../src/openssh-config/apply.js';
import { loadSshConfig } from '../../../src/openssh-config/load.js';
import { planSshConfigImport, slugId, type SshConfigImportPlan } from '../../../src/openssh-config/plan.js';
import { memoryIo } from './memory-io.js';

const MAIN = '/home/u/.ssh/config';
async function plan(text: string, existing: HostsFile = EMPTY_HOSTS_FILE, secrets: string[] = []) {
  const document = await loadSshConfig(MAIN, memoryIo({ [MAIN]: text }));
  return planSshConfigImport({ document, existing, existingSecretNames: secrets });
}
const host = (p: SshConfigImportPlan, alias: string) => {
  const found = p.hosts.find((h) => h.alias === alias);
  if (!found) throw new Error(`no ${alias}`);
  return found;
};
const merged = (p: SshConfigImportPlan, existing: HostsFile = EMPTY_HOSTS_FILE) =>
  applySshConfigImport(p, { groupName: 'SSH config', importDuplicates: [], keys: {} }, existing);

const EXISTING = parseHostsFile(`
version: 1
hosts:
  - id: web
    name: web
    address: web.example.com
    ssh: { user: deploy, auth: { agent: true } }
  - id: ssh-config
    name: taken
    address: t.example.com
`);

describe('fields (P3)', () => {
  it('maps HostName, Port, User, ServerAliveInterval and ConnectTimeout', async () => {
    const p = await plan(
      'Host api\n  HostName %h.internal%%x\n  Port 2222\n  User ops\n  ServerAliveInterval 0\n  ConnectTimeout 5\n',
    );
    expect(host(p, 'api')).toMatchObject({
      id: 'api',
      status: 'new',
      address: 'api.internal%x',
      ssh: { port: 2222, user: 'ops', keepAlive: 0, connectTimeout: 5 },
    });
  });
  it('uses the alias as the address when there is no HostName', async () => {
    expect(host(await plan('Host db.example.com\n'), 'db.example.com').address).toBe('db.example.com');
  });
  it('skips a host whose HostName uses another % token', async () => {
    expect(host(await plan('Host a\n  HostName %n.x\n'), 'a')).toMatchObject({ status: 'skipped' });
  });
  it('leaves ConnectTimeout none and a bad Port unset, with a note for the port', async () => {
    const p = await plan('Host a\n  ConnectTimeout none\n  Port 99999\n');
    expect(host(p, 'a').ssh).toEqual({});
    expect(p.report.notes).toContain('a: Port is not a number from 1 to 65535; not imported');
  });
  it('refuses a file with no host', async () => {
    await expect(plan('Host *\n  User x\n')).rejects.toMatchObject({ code: 'ssh-config-empty' });
  });
});

describe('report (P3, P8)', () => {
  it('counts ignored options and lists the rest by keyword, file and line, never the value', async () => {
    const p = await plan(
      [
        'Host a',
        '  IdentitiesOnly yes',
        '  LocalForward 8080 MARKER-1:80',
        '  SetEnv TOKEN=MARKER-2',
        '  ProxyCommand nc -X MARKER-3 %h %p',
        'Host b',
        '  IdentitiesOnly yes',
        'Match exec "MARKER-4"',
        '  User m',
        '',
      ].join('\n'),
    );
    expect(p.report.ignored).toEqual([{ keyword: 'identitiesonly', count: 2 }]);
    expect(p.report.skipped).toEqual([
      { file: '~/.ssh/config', line: 3, keyword: 'localforward', why: 'not imported' },
      { file: '~/.ssh/config', line: 4, keyword: 'setenv', why: 'not imported' },
      {
        file: '~/.ssh/config',
        line: 5,
        keyword: 'proxycommand',
        why: 'not imported; the host will probably not connect the way it does today',
      },
      { file: '~/.ssh/config', line: 8, keyword: 'match', why: 'Match block not applied (1 line)' },
    ]);
    expect(JSON.stringify(p)).not.toMatch(/MARKER/);
  });
});

describe('group defaults (M1)', () => {
  it('puts Host * values on the group and leaves them off hosts that share them', async () => {
    const p = await plan('Host root-box\n  User root\nHost web\nHost *\n  User deploy\n  Port 22\n');
    expect(p.group).toMatchObject({ id: 'ssh-config', name: 'SSH config', ssh: { user: 'deploy', port: 22 } });
    expect(host(p, 'web').ssh).toEqual({});
    expect(host(p, 'root-box').ssh).toEqual({ user: 'root' });
  });
  it('gives the same result with Host * first when no host sets the field', async () => {
    const p = await plan('Host *\n  User deploy\nHost web\n');
    expect(p.group.ssh.user).toBe('deploy');
    expect(host(p, 'web').ssh).toEqual({});
  });
  it('keeps a Host * value off the group when a host excluded from it has none', async () => {
    const p = await plan('Host bastion web\nHost * !bastion\n  User deploy\n');
    expect(p.group.ssh.user).toBeUndefined();
    expect(host(p, 'web').ssh.user).toBe('deploy');
    const file = merged(p);
    expect(resolveHost(file, 'bastion').incomplete).toEqual({ field: 'user' });
  });
});

describe('ids (M2)', () => {
  it('slugs aliases', () => {
    expect(slugId('Web.Prod_1')).toBe('web-prod-1');
    expect(slugId('!!!')).toBe('host');
  });
  it('suffixes clashes with existing ids and within the import, and the group id', async () => {
    const p = await plan('Host Web web.\nHost WEB-\n', EXISTING);
    expect(p.group.id).toBe('ssh-config-2');
    expect(p.hosts.map((h) => [h.alias, h.id, h.idChangedFrom])).toEqual([
      ['Web', 'web-2', 'web'],
      ['web.', 'web-3', 'web'],
      ['WEB-', 'web-4', 'web'],
    ]);
  });
});

describe('keys (M4)', () => {
  it('makes one row per key file, proposes a free secret name, and defaults everything to the agent', async () => {
    const p = await plan(
      'Host a b\n  IdentityFile ~/.ssh/id_ed25519\nHost c\n  IdentityFile %d/.ssh/work-key.pem\n',
      EMPTY_HOSTS_FILE,
      ['ssh_key_id_ed25519'],
    );
    expect(p.keys).toEqual([
      {
        ref: 'k1',
        path: '/home/u/.ssh/id_ed25519',
        display: '~/.ssh/id_ed25519',
        hosts: ['a', 'b'],
        proposedSecret: 'ssh_key_id_ed25519_2',
      },
      {
        ref: 'k2',
        path: '/home/u/.ssh/work-key.pem',
        display: '~/.ssh/work-key.pem',
        hosts: ['c'],
        proposedSecret: 'ssh_key_work_key_pem',
      },
    ]);
    expect(p.group.ssh.auth).toEqual({ kind: 'agent' });
    expect(host(p, 'a').ssh.auth).toEqual({ kind: 'key', ref: 'k1' });
  });
  it('puts a key every host shares on the group', async () => {
    const p = await plan('Host a b\nHost *\n  IdentityFile ~/.ssh/id_rsa\n  IdentityFile ~/.ssh/other\n');
    expect(p.group.ssh.auth).toEqual({ kind: 'key', ref: 'k1' });
    expect(host(p, 'a').ssh.auth).toBeUndefined();
    expect(p.keys[0]?.hosts).toEqual(['ssh-config']);
    expect(p.report.notes).toContain('a: only the first IdentityFile is used; 1 more not carried');
  });
  it('does not map a key path with a token it cannot expand, and notes agent hosts', async () => {
    const p = await plan('Host a\n  IdentityFile ~/.ssh/%r\nHost b\n');
    expect(p.keys).toEqual([]);
    expect(p.report.notes).toEqual(
      expect.arrayContaining([
        "a: IdentityFile ~/.ssh/%r could not be resolved to a file; the host uses the group's authentication",
        'Authenticate through the SSH agent (no IdentityFile): a, b',
      ]),
    );
  });
});

describe('jumps (M5, M6)', () => {
  it('maps ProxyJump to an alias and a recognised ProxyCommand', async () => {
    const p = await plan(
      'Host bastion\nHost a\n  ProxyJump bastion\nHost b\n  ProxyCommand ssh -q -W %h:%p bastion\nHost c\n  ProxyJump none\n',
    );
    expect(host(p, 'a').ssh.jump).toBe('bastion');
    expect(host(p, 'b').ssh.jump).toBe('bastion');
    expect(host(p, 'c').ssh.jump).toBeUndefined();
  });
  it('maps a two-hop chain whose middle hop already jumps through the first', async () => {
    const p = await plan('Host outer\nHost inner\n  ProxyJump outer\nHost t\n  ProxyJump outer,inner\n');
    expect(host(p, 't').ssh.jump).toBe('inner');
    expect(resolveHost(merged(p), 't').ssh.jump.value).toBe('inner');
  });
  it('creates hosts for hops that name no alias, chained', async () => {
    const p = await plan('Host t\n  ProxyJump ops@gw.example.com:2222,inner.example.com\n');
    expect(host(p, 'ops@gw.example.com:2222')).toMatchObject({
      id: 'gw-example-com',
      status: 'created-for-jump',
      address: 'gw.example.com',
      ssh: { user: 'ops', port: 2222 },
    });
    expect(host(p, 'inner.example.com')).toMatchObject({ id: 'inner-example-com', ssh: { jump: 'gw-example-com' } });
    expect(host(p, 't').ssh.jump).toBe('inner-example-com');
  });
  it('imports a target without a jump when the chain does not fit', async () => {
    const p = await plan('Host outer\nHost inner\nHost t\n  ProxyJump outer,inner\n');
    expect(host(p, 't').ssh.jump).toBeUndefined();
    expect(p.report.notes).toContain('t: the jump chain outer,inner does not fit hosts.yaml; imported without a jump');
  });
  it('drops a jump that would loop', async () => {
    const p = await plan('Host a\n  ProxyJump b\nHost b\n  ProxyJump a\n');
    const jumps = p.hosts.map((h) => h.ssh.jump);
    expect(jumps.filter((j) => j !== undefined)).toHaveLength(1);
    expect(() => merged(p)).not.toThrow();
  });
  it('does not let Host * make a host jump through itself', async () => {
    const p = await plan('Host bastion web\nHost *\n  ProxyJump bastion\n');
    expect(host(p, 'web').ssh.jump).toBe('bastion');
    expect(host(p, 'bastion').ssh.jump).toBeUndefined();
  });
});

describe('duplicates (M3)', () => {
  it('marks a host with the same address, port and user as an existing one, and jumps to the existing id', async () => {
    const p = await plan('Host web\n  HostName WEB.example.com\n  User deploy\nHost x\n  ProxyJump web\n', EXISTING);
    expect(host(p, 'web')).toMatchObject({ status: 'duplicate', duplicateOf: 'web', id: 'web-2' });
    expect(host(p, 'x').ssh.jump).toBe('web');
  });
});
