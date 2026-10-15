import { describe, expect, it } from 'vitest';
import {
  jumpChain,
  listResolvedHosts,
  parseHostsFile,
  resolveHost,
  resolveSettings,
  serializeHostsFile,
} from '../../src/index.js';

const FILE = parseHostsFile(`
version: 1
identities:
  - id: deploy
    name: Deploy user
    user: deploy
    auth: { key: '\${secret:deploy_key}', passphrase: '\${secret:deploy_pass}' }
  - id: admin
    name: Personal admin
    user: me
    auth: { agent: true }
  - id: name-only
    name: Name only
    user: someone
groups:
  - id: prod
    name: Production
    ssh: { identity: deploy }
    groups:
      - id: db
        name: Databases
        ssh: { user: postgres }
        hosts:
          - { id: db1, name: db1, address: 10.0.1.1 }
          - { id: db2, name: db2, address: 10.0.1.2, ssh: { identity: admin } }
    hosts:
      - { id: web, name: web, address: 10.0.0.2 }
      - { id: web-root, name: web-root, address: 10.0.0.3, ssh: { user: root } }
      - { id: web-pw, name: web-pw, address: 10.0.0.4, ssh: { auth: { password: '\${secret:web_pw}' } } }
  - id: lab
    name: Lab
    ssh: { user: lab, auth: { agent: true } }
    hosts:
      - { id: box, name: box, address: 10.9.0.1, ssh: { identity: deploy } }
      - { id: partial, name: partial, address: 10.9.0.2, ssh: { identity: name-only } }
hosts:
  - { id: solo, name: solo, address: 10.0.0.9, ssh: { identity: admin, user: other } }
  - { id: bare, name: bare, address: 10.0.0.10 }
  - { id: hop-target, name: hop-target, address: 10.0.0.11, ssh: { identity: admin, jump: web } }
`);

const DEPLOY_KEY = { kind: 'key', key: '${secret:deploy_key}', passphrase: '${secret:deploy_pass}' };

describe('identities: resolution order', () => {
  it('a group naming an identity gives its hosts its user and auth', () => {
    const web = resolveHost(FILE, 'web').ssh;
    expect(web.user).toEqual({ value: 'deploy', from: { identity: 'deploy' } });
    expect(web.auth).toEqual({ value: DEPLOY_KEY, from: { identity: 'deploy' } });
    expect(web.identity).toEqual({ value: 'deploy', from: { group: 'prod' } });
  });

  it('the host level wins over the identity, one field at a time', () => {
    const root = resolveHost(FILE, 'web-root').ssh;
    expect(root.user).toEqual({ value: 'root', from: 'host' });
    expect(root.auth.from).toEqual({ identity: 'deploy' });
    const pw = resolveHost(FILE, 'web-pw').ssh;
    expect(pw.user.from).toEqual({ identity: 'deploy' });
    expect(pw.auth).toEqual({ value: { kind: 'password', password: '${secret:web_pw}' }, from: 'host' });
  });

  it('an explicit field on the same level as the identity wins over it', () => {
    const solo = resolveHost(FILE, 'solo').ssh;
    expect(solo.user).toEqual({ value: 'other', from: 'host' });
    expect(solo.auth).toEqual({ value: { kind: 'agent' }, from: { identity: 'admin' } });
  });

  it('a nearer group setting the field wins over a farther group identity', () => {
    const db1 = resolveHost(FILE, 'db1').ssh;
    expect(db1.user).toEqual({ value: 'postgres', from: { group: 'db' } });
    expect(db1.auth.from).toEqual({ identity: 'deploy' });
  });

  it('a host identity wins over a group that sets the field itself', () => {
    const box = resolveHost(FILE, 'box').ssh;
    expect(box.user).toEqual({ value: 'deploy', from: { identity: 'deploy' } });
    expect(box.auth).toEqual({ value: DEPLOY_KEY, from: { identity: 'deploy' } });
    const db2 = resolveHost(FILE, 'db2').ssh;
    expect(db2.user).toEqual({ value: 'me', from: { identity: 'admin' } });
    expect(db2.identity).toEqual({ value: 'admin', from: 'host' });
  });

  it('a field the identity leaves unset falls through to the levels further out', () => {
    const partial = resolveHost(FILE, 'partial').ssh;
    expect(partial.user).toEqual({ value: 'someone', from: { identity: 'name-only' } });
    expect(partial.auth).toEqual({ value: { kind: 'agent' }, from: { group: 'lab' } });
  });

  it('nothing on any level leaves the default: no user, no auth, incomplete', () => {
    const bare = resolveHost(FILE, 'bare');
    expect(bare.ssh.user).toEqual({ value: undefined, from: 'default' });
    expect(bare.ssh.identity).toEqual({ value: undefined, from: 'default' });
    expect(bare.incomplete).toEqual({ field: 'user' });
  });

  it('a host signing in through an identity is complete', () => {
    expect(resolveHost(FILE, 'web').incomplete).toBeUndefined();
  });

  it('resolveSettings and each hop of a jump chain use the identities too', () => {
    expect(resolveSettings(FILE, 'web')).toMatchObject({ user: 'deploy', auth: DEPLOY_KEY, identity: 'deploy' });
    const [hop, target] = jumpChain(FILE, 'hop-target');
    expect(hop?.ssh.user.value).toBe('deploy');
    expect(target?.ssh.user.value).toBe('me');
  });

  it('editing the identity changes every host that uses it', () => {
    const edited = parseHostsFile(serializeHostsFile(FILE).replace('user: deploy\n', 'user: release\n'));
    const users = listResolvedHosts(edited)
      .filter((h) => typeof h.ssh.user.from === 'object' && 'identity' in h.ssh.user.from)
      .map((h) => [h.id, h.ssh.user.value]);
    expect(users).toEqual([
      ['db2', 'me'],
      ['web', 'release'],
      ['web-pw', 'release'],
      ['box', 'release'],
      ['partial', 'someone'],
      ['hop-target', 'me'],
    ]);
  });
});

describe('identities: the file', () => {
  it('round-trips, and a file without identities writes none', () => {
    expect(parseHostsFile(serializeHostsFile(FILE))).toEqual(FILE);
    const plain = parseHostsFile('version: 1\nhosts:\n  - { id: a, name: a, address: a }\n');
    expect(plain.identities).toBeUndefined();
    expect(serializeHostsFile(plain)).not.toMatch(/identities/);
  });

  it('refuses an unknown identity id when the file is read', () => {
    const bad = 'version: 1\nhosts:\n  - { id: a, name: a, address: a, ssh: { identity: ghost } }\n';
    expect(() => parseHostsFile(bad)).toThrow(
      expect.objectContaining({ code: 'ssh-identity-unknown', details: { id: 'a', identity: 'ghost' } }),
    );
  });

  it('refuses an unknown identity on a group too', () => {
    const bad = 'version: 1\ngroups:\n  - { id: g, name: g, ssh: { identity: ghost } }\n';
    expect(() => parseHostsFile(bad)).toThrow(expect.objectContaining({ code: 'ssh-identity-unknown' }));
  });

  it('refuses an identity id listed twice', () => {
    const bad = 'version: 1\nidentities:\n  - { id: x, name: X, user: a }\n  - { id: x, name: Y, user: b }\n';
    expect(() => parseHostsFile(bad)).toThrow(expect.objectContaining({ code: 'ssh-duplicate-id' }));
  });

  it('an identity id may equal a host id: they are separate names', () => {
    const ok =
      'version: 1\nidentities:\n  - { id: a, name: A, user: u }\nhosts:\n  - { id: a, name: a, address: a, ssh: { identity: a } }\n';
    expect(resolveHost(parseHostsFile(ok), 'a').ssh.user.value).toBe('u');
  });

  it('refuses a literal credential in an identity, naming the path, never the value', () => {
    const bad = 'version: 1\nidentities:\n  - { id: x, name: X, user: u, auth: { password: MARKER-hunter2 } }\n';
    let caught: unknown;
    try {
      parseHostsFile(bad);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'ssh-literal-secret', details: { path: 'identities[0].auth.password' } });
    expect(JSON.stringify(caught)).not.toContain('MARKER');
    expect((caught as Error).message).not.toContain('MARKER');
  });

  it('refuses an identity id that is not a workspace id', () => {
    const bad = 'version: 1\nidentities:\n  - { id: Bad Id, name: X, user: u }\n';
    expect(() => parseHostsFile(bad)).toThrow(expect.objectContaining({ code: 'ssh-hosts-invalid' }));
  });
});
