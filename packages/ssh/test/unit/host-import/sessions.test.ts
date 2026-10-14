import { describe, expect, it } from 'vitest';
import { EMPTY_HOSTS_FILE, parseHostsFile, resolveHost } from '../../../src/index.js';
import { planSessionImport, type ImportedSession, type SessionSource } from '../../../src/host-import/sessions.js';
import { applySshConfigImport } from '../../../src/openssh-config/apply.js';

const HOME = '/home/u';
const session = (over: Partial<ImportedSession> & { name: string }): ImportedSession => ({
  line: 1,
  folder: [],
  address: `${over.name}.example.com`,
  ...over,
});
const source = (sessions: ImportedSession[], over: Partial<SessionSource> = {}): SessionSource => ({
  format: 'csv',
  sessions,
  skipped: [],
  ignored: [],
  notes: [],
  passwords: 0,
  ...over,
});
const plan = (src: SessionSource, existing = EMPTY_HOSTS_FILE, secrets: string[] = []) =>
  planSessionImport({ source: src, file: 'hosts.csv', home: HOME, existing, existingSecretNames: secrets });
const apply = (p: ReturnType<typeof plan>, existing = EMPTY_HOSTS_FILE) =>
  applySshConfigImport(p, { groupName: p.group.name, importDuplicates: [], keys: {} }, existing);

describe('planSessionImport', () => {
  it('names the group after the format and plans one host per session', () => {
    const p = plan(source([session({ name: 'Web 1', address: 'web1.example.com', port: 2222, user: 'ops' })]));
    expect(p.group).toMatchObject({ id: 'csv', name: 'CSV', ssh: { auth: { kind: 'agent' } } });
    expect(p.hosts).toEqual([
      expect.objectContaining({
        alias: 'Web 1',
        id: 'web-1',
        status: 'new',
        address: 'web1.example.com',
        ssh: { port: 2222, user: 'ops' },
      }),
    ]);
  });

  it('turns folders into nested subgroups inside the one new group', () => {
    const p = plan(
      source([
        session({ name: 'a', folder: ['Production', 'Web'] }),
        session({ name: 'b', folder: ['Production'] }),
        session({ name: 'c' }),
      ]),
    );
    expect(p.folders).toEqual([
      { id: 'production', name: 'Production', path: 'Production' },
      { id: 'web', name: 'Web', parent: 'production', path: 'Production / Web' },
    ]);
    const file = apply(p);
    expect(file.groups).toHaveLength(1);
    const top = file.groups[0];
    expect(top?.hosts.map((h) => h.id)).toEqual(['c']);
    expect(top?.groups[0]).toMatchObject({ id: 'production', hosts: [{ id: 'b' }], groups: [{ id: 'web' }] });
    expect(top?.groups[0]?.groups[0]?.hosts.map((h) => h.id)).toEqual(['a']);
  });

  it('carries tags and forwards, giving each forward a unique id', () => {
    const p = plan(
      source([
        session({
          name: 'db',
          tags: ['prod', 'db'],
          forwards: [
            { type: 'local', port: 5432, target: 'localhost:5432' },
            { type: 'local', port: 5432, bind: '0.0.0.0', target: 'replica:5432' },
            { type: 'dynamic', port: 1080 },
          ],
        }),
      ]),
    );
    const file = apply(p);
    const host = file.groups[0]?.hosts[0];
    expect(host?.tags).toEqual(['prod', 'db']);
    expect(host?.forwards).toEqual([
      { id: 'local-5432', type: 'local', port: 5432, target: 'localhost:5432' },
      { id: 'local-5432-2', type: 'local', port: 5432, bind: '0.0.0.0', target: 'replica:5432' },
      { id: 'dynamic-1080', type: 'dynamic', port: 1080 },
    ]);
  });

  it('reports a forward hosts.yaml would refuse instead of importing it', () => {
    const p = plan(
      source([session({ name: 'x', line: 7, forwards: [{ type: 'local', port: 80, target: 'bad target' }] })]),
    );
    expect(p.hosts[0]?.forwards).toBeUndefined();
    expect(p.report.skipped).toEqual([
      { file: 'hosts.csv', line: 7, keyword: 'forward', why: 'x: a local forward on port 80 is not valid here' },
    ]);
  });

  it('makes a key row for an absolute key file, and keeps .ppk and foreign paths on the agent', () => {
    const p = plan(
      source([
        session({ name: 'a', keyFile: '/home/u/.ssh/id_a' }),
        session({ name: 'b', keyFile: '/home/u/.ssh/id_a' }),
        session({ name: 'c', keyFile: 'C:\\Users\\me\\c.ppk' }),
        session({ name: 'd', keyFile: 'C:\\Users\\me\\.ssh\\id_d' }),
      ]),
    );
    expect(p.keys).toEqual([
      {
        ref: 'k1',
        path: '/home/u/.ssh/id_a',
        display: '~/.ssh/id_a',
        hosts: ['a', 'b'],
        proposedSecret: 'ssh_key_id_a',
      },
    ]);
    expect(p.hosts.find((h) => h.id === 'a')?.ssh.auth).toEqual({ kind: 'key', ref: 'k1' });
    expect(p.hosts.find((h) => h.id === 'c')?.ssh.auth).toBeUndefined();
    expect(p.report.notes).toContain(
      'c: its key is a PuTTY .ppk file; convert it to OpenSSH format to store it. The host uses the SSH agent',
    );
    expect(p.report.notes).toContain('d: its key file is not a path on this computer; the host uses the SSH agent');
  });

  it('marks duplicates of existing hosts by address, port and user', () => {
    const existing = parseHostsFile(`
version: 1
hosts:
  - { id: web, name: web, address: web.example.com, ssh: { user: deploy } }
`);
    const p = plan(
      source([session({ name: 'web', user: 'deploy' }), session({ name: 'web2', address: 'web.example.com' })]),
      existing,
    );
    expect(p.hosts.map((h) => [h.id, h.status, h.duplicateOf])).toEqual([
      ['web-2', 'duplicate', 'web'],
      ['web2', 'new', undefined],
    ]);
  });

  it('resolves a jump to another session by name or folder path, or creates a host for it', () => {
    const p = plan(
      source([
        session({ name: 'bastion', folder: ['Edge'] }),
        session({ name: 'app', jump: 'Edge/bastion' }),
        session({ name: 'db', jump: 'BASTION' }),
        session({ name: 'cache', jump: 'admin@gw.example.com:2200' }),
      ]),
    );
    const jumps = Object.fromEntries(p.hosts.map((h) => [h.id, h.ssh.jump]));
    expect(jumps).toMatchObject({ app: 'bastion', db: 'bastion', cache: 'gw-example-com' });
    expect(p.hosts.find((h) => h.id === 'gw-example-com')).toMatchObject({
      status: 'created-for-jump',
      address: 'gw.example.com',
      ssh: { user: 'admin', port: 2200 },
    });
    const file = apply(p);
    expect(resolveHost(file, 'cache').ssh.jump.value).toBe('gw-example-com');
  });

  it('matches a user@host:port hop to the session at that address before creating a host', () => {
    const p = plan(
      source([
        session({ name: 'bastion', address: 'bastion.example.com', port: 2222, user: 'ops' }),
        session({ name: 'web', jump: 'ops@bastion.example.com:2222' }),
        session({ name: 'api', jump: 'bastion.example.com:2222' }),
      ]),
    );
    expect(p.hosts.map((h) => [h.id, h.ssh.jump])).toEqual([
      ['bastion', undefined],
      ['web', 'bastion'],
      ['api', 'bastion'],
    ]);
  });

  it('drops a jump that loops, with a note', () => {
    const p = plan(source([session({ name: 'a', jump: 'b' }), session({ name: 'b', jump: 'a' })]));
    expect(p.hosts.filter((h) => h.ssh.jump !== undefined)).toHaveLength(1);
    expect(p.report.notes.some((n) => n.endsWith('its jump chain loops; imported without a jump'))).toBe(true);
    expect(() => apply(p)).not.toThrow();
  });

  it('always says that passwords are never imported, with a count when the file held some', () => {
    expect(plan(source([session({ name: 'a' })])).report.notes).toContain('Passwords are never imported');
    expect(plan(source([session({ name: 'a' })], { passwords: 2 })).report.notes).toContain(
      'Saved passwords in 2 sessions were not imported: passwords are never imported',
    );
  });

  it('adds the source file to the parser’s skipped lines', () => {
    const p = plan(
      source([session({ name: 'a' })], { skipped: [{ line: 3, keyword: 'telnet', why: 'not an SSH session' }] }),
    );
    expect(p.report.skipped).toEqual([{ file: 'hosts.csv', line: 3, keyword: 'telnet', why: 'not an SSH session' }]);
  });

  it('refuses a source with no session', () => {
    expect(() => plan(source([]))).toThrow(/no SSH session/);
  });
});
