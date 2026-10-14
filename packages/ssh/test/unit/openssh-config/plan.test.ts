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
        '  SendEnv MARKER-2',
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
      { file: '~/.ssh/config', line: 4, keyword: 'sendenv', why: 'not imported' },
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

describe('SetEnv', () => {
  it('maps every NAME=value of every line; the first value of a name wins', async () => {
    const p = await plan('Host a\n  SetEnv LANG=C.UTF-8 APP_PROFILE=eu\n  SetEnv APP_PROFILE=us EMPTY= "MSG=a b"\n');
    expect(host(p, 'a').env).toEqual({ LANG: 'C.UTF-8', APP_PROFILE: 'eu', EMPTY: '', MSG: 'a b' });
    expect(p.report.skipped).toEqual([]);
    expect(p.report.notes).toContain(
      'SetEnv values are written to hosts.yaml as they are; replace any secret among them with ${secret:NAME}',
    );
  });
  it('puts a Host * variable every host shares on the group; a host keeps the ones that differ', async () => {
    const p = await plan('Host a\n  SetEnv APP=a\nHost b\nHost *\n  SetEnv APP=all LANG=C\n');
    expect(p.group.env).toEqual({ APP: 'all', LANG: 'C' });
    expect(host(p, 'a').env).toEqual({ APP: 'a' });
    expect(host(p, 'b').env).toBeUndefined();
    const file = merged(p);
    expect(resolveHost(file, 'a').env.map((v) => [v.name, v.value])).toEqual([
      ['APP', 'a'],
      ['LANG', 'C'],
    ]);
    expect(resolveHost(file, 'b').env.map((v) => [v.name, v.value])).toEqual([
      ['APP', 'all'],
      ['LANG', 'C'],
    ]);
  });
  it('skips an entry that is not NAME=value or holds a secret token, with a note that never quotes it', async () => {
    const p = await plan('Host a\n  SetEnv BAD-NAME=MARKER-1 NOEQUALS GOOD=1 "T=\${secret:MARKER2}"\n');
    expect(host(p, 'a').env).toEqual({ GOOD: '1' });
    expect(p.report.notes).toContain('a: 3 SetEnv entries are not a NAME=value Wirebench can store; not imported');
    expect(JSON.stringify(p.report)).not.toMatch(/MARKER/);
  });
  it('writes no env when there is no SetEnv', async () => {
    const p = await plan('Host a\n  User u\n');
    expect(host(p, 'a').env).toBeUndefined();
    expect(p.group.env).toBeUndefined();
    expect(p.report.notes.some((n) => n.includes('SetEnv'))).toBe(false);
  });
});

describe('ForwardAgent', () => {
  it('maps yes and no; a host leaves out what equals the group', async () => {
    const p = await plan('Host a\n  ForwardAgent yes\nHost b\n  ForwardAgent no\nHost c\n');
    expect(host(p, 'a').ssh.forwardAgent).toBe(true);
    expect(host(p, 'b').ssh.forwardAgent).toBeUndefined();
    expect(host(p, 'c').ssh.forwardAgent).toBeUndefined();
    expect(p.group.ssh.forwardAgent).toBeUndefined();
    expect(p.report.skipped).toEqual([]);
    const file = merged(p);
    expect(resolveHost(file, 'a').ssh.forwardAgent.value).toBe(true);
    expect(resolveHost(file, 'b').ssh.forwardAgent.value).toBe(false);
  });
  it('puts Host * yes on the group; a host that says no keeps false', async () => {
    const p = await plan('Host a\n  ForwardAgent no\nHost b\nHost *\n  ForwardAgent yes\n');
    expect(p.group.ssh.forwardAgent).toBe(true);
    expect(host(p, 'a').ssh.forwardAgent).toBe(false);
    expect(host(p, 'b').ssh.forwardAgent).toBeUndefined();
    const file = merged(p);
    expect(resolveHost(file, 'a').ssh.forwardAgent).toEqual({ value: false, from: 'host' });
    expect(resolveHost(file, 'b').ssh.forwardAgent).toEqual({ value: true, from: { group: 'ssh-config' } });
  });
  it('notes a socket path or variable instead of yes or no, without quoting it', async () => {
    const p = await plan('Host a\n  ForwardAgent /tmp/MARKER.sock\n');
    expect(host(p, 'a').ssh.forwardAgent).toBeUndefined();
    expect(p.report.notes).toContain('a: ForwardAgent is not yes or no; not imported');
    expect(JSON.stringify(p.report)).not.toMatch(/MARKER/);
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
    expect(slugId(`-${'-'.repeat(50_000)}a${'.'.repeat(50_000)}`)).toBe('a');
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

describe('certificates (#421)', () => {
  it('carries CertificateFile with its key: a key with another certificate is another row', async () => {
    const p = await plan(
      'Host a\n  IdentityFile ~/.ssh/id\n  CertificateFile ~/.ssh/id-cert.pub\nHost b\n  IdentityFile ~/.ssh/id\n',
    );
    expect(p.keys).toEqual([
      {
        ref: 'k1',
        path: '/home/u/.ssh/id',
        display: '~/.ssh/id',
        certificate: { path: '/home/u/.ssh/id-cert.pub', display: '~/.ssh/id-cert.pub' },
        hosts: ['a'],
        proposedSecret: 'ssh_key_id',
      },
      { ref: 'k2', path: '/home/u/.ssh/id', display: '~/.ssh/id', hosts: ['b'], proposedSecret: 'ssh_key_id_2' },
    ]);
    expect(p.report.skipped.map((s) => s.keyword)).not.toContain('certificatefile');
  });
  it('puts a key and certificate every host shares on the group', async () => {
    const p = await plan('Host a b\nHost *\n  IdentityFile ~/.ssh/id\n  CertificateFile ~/.ssh/id-cert.pub\n');
    expect(p.group.ssh.auth).toEqual({ kind: 'key', ref: 'k1' });
    expect(p.keys[0]?.certificate?.display).toBe('~/.ssh/id-cert.pub');
    expect(host(p, 'a').ssh.auth).toBeUndefined();
  });
  it('notes a certificate it cannot use', async () => {
    const p = await plan(
      'Host a\n  CertificateFile ~/.ssh/c-cert.pub\nHost b\n  IdentityFile ~/.ssh/k\n  CertificateFile ~/.ssh/%r\n',
    );
    expect(p.keys).toHaveLength(1);
    expect(p.keys[0]?.certificate).toBeUndefined();
    expect(p.report.notes).toEqual(
      expect.arrayContaining([
        'a: CertificateFile without an IdentityFile is not imported',
        'b: CertificateFile ~/.ssh/%r could not be resolved to a file; the key is used without it',
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

describe('proxies (#417)', () => {
  it('maps nc -X 5 and -X connect ProxyCommands, with the default ports and a -P user', async () => {
    const p = await plan(
      [
        'Host s',
        '  ProxyCommand nc -X 5 -x socks.corp:1081 %h %p',
        'Host h',
        '  ProxyCommand /usr/bin/nc -x web.corp -X connect -P alice %h %p',
        'Host d',
        '  ProxyCommand nc -x [2001:db8::1] %h %p',
        '',
      ].join('\n'),
    );
    expect(host(p, 's').ssh.proxy).toEqual({ type: 'socks5', host: 'socks.corp', port: 1081 });
    expect(host(p, 'h').ssh.proxy).toEqual({ type: 'http', host: 'web.corp', port: 3128, user: 'alice' });
    expect(host(p, 'd').ssh.proxy).toEqual({ type: 'socks5', host: '2001:db8::1', port: 1080 });
    expect(p.report.skipped).toEqual([]);
    expect(p.report.notes.some((n) => n.includes("h: the proxy's password"))).toBe(true);
    const file = merged(p);
    expect(resolveHost(file, 'h').ssh.proxy.value).toEqual({
      type: 'http',
      host: 'web.corp',
      port: 3128,
      user: 'alice',
    });
  });
  it('puts a Host * proxy every host shares on the group', async () => {
    const p = await plan('Host a\nHost b\nHost *\n  ProxyCommand nc -X 5 -x p.corp:1080 %h %p\n');
    expect(p.group.ssh.proxy).toEqual({ type: 'socks5', host: 'p.corp', port: 1080 });
    expect(host(p, 'a').ssh.proxy).toBeUndefined();
    expect(resolveHost(merged(p), 'b').ssh.proxy.value).toMatchObject({ host: 'p.corp' });
  });
  it('skips a form it cannot read safely: SOCKS4, another tool, extra flags, -P with SOCKS5', async () => {
    const p = await plan(
      [
        'Host a',
        '  ProxyCommand nc -X 4 -x p:1080 %h %p',
        'Host b',
        '  ProxyCommand ncat --proxy p:1080 --proxy-type socks5 %h %p',
        'Host c',
        '  ProxyCommand nc -w 5 -X 5 -x p:1080 %h %p',
        'Host d',
        '  ProxyCommand nc -X 5 -P bob -x p:1080 %h %p',
        '',
      ].join('\n'),
    );
    for (const alias of ['a', 'b', 'c', 'd']) expect(host(p, alias).ssh.proxy).toBeUndefined();
    expect(p.report.skipped.map((s) => s.line)).toEqual([2, 4, 6, 8]);
  });
});
