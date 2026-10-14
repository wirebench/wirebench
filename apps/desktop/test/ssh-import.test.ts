// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { HostsService } from '../src/main/hosts-service.js';
import { isEncryptedKey, SshImportService, type SshImportFs } from '../src/main/ssh-import.js';
import { sshImportPreviewSchema } from '../src/shared/ssh-wire.js';
import type { SshImportPreview } from '../src/shared/ssh-wire.js';

const HOME = '/home/u';
const CONFIG = '/home/u/.ssh/config';
const KEY =
  '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU=\nMARKER-KEY\n-----END OPENSSH PRIVATE KEY-----\n';
// `openssh-key-v1\0` then a length-prefixed cipher name `aes256-ctr`.
const ENCRYPTED_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${Buffer.concat([
  Buffer.from('openssh-key-v1\0', 'latin1'),
  Buffer.from([0, 0, 0, 10]),
  Buffer.from('aes256-ctr', 'latin1'),
]).toString('base64')}\n-----END OPENSSH PRIVATE KEY-----\n`;

type Entry = string | { dir: true } | { size: number };
function fakeFs(files: Record<string, Entry>): SshImportFs & { reads: string[] } {
  const reads: string[] = [];
  const get = (path: string): Entry => {
    const entry = files[path];
    if (entry === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    return entry;
  };
  return {
    reads,
    realpath: (path) => Promise.resolve().then(() => (get(path), path)),
    stat: (path) =>
      Promise.resolve().then(() => {
        const entry = get(path);
        return {
          isFile: () => typeof entry === 'string' || 'size' in entry,
          size: typeof entry === 'string' ? entry.length : 'size' in entry ? entry.size : 0,
        };
      }),
    readFile: (path) =>
      Promise.resolve().then(() => {
        reads.push(path);
        return get(path) as string;
      }),
    readBytes: (path) =>
      Promise.resolve().then(() => {
        reads.push(path);
        return Buffer.from(get(path) as string);
      }),
    glob: () => Promise.resolve([]),
  };
}

function setup(files: Record<string, Entry>, options: { hostsYaml?: string; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-import-'));
  if (options.hostsYaml !== undefined) writeFileSync(join(dir, 'hosts.yaml'), options.hostsYaml);
  const hosts = new HostsService({ treeDir: () => dir });
  const secrets = { names: vi.fn().mockResolvedValue([]), set: vi.fn().mockResolvedValue(undefined) };
  const pick = vi.fn().mockResolvedValue(undefined);
  const fs = fakeFs(files);
  const service = new SshImportService({ home: () => HOME, pick, hosts, secrets, fs, now: options.now ?? (() => 0) });
  return { service, secrets, pick, fs, dir };
}
const A = { id: 1 };
const B = { id: 2 };
const asPreview = (value: unknown): SshImportPreview => value as SshImportPreview;
const apply = (previewId: string, keys: { ref: string; choice: never }[] = []) => ({
  previewId,
  groupName: 'SSH config',
  importDuplicates: [],
  keys,
});

describe('SshImportService.preview', () => {
  it('reads ~/.ssh/config for user-config and answers key rows without paths', async () => {
    const { service, fs } = setup({ [CONFIG]: 'Host web\n  IdentityFile ~/.ssh/id_ed25519\n' });
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    expect(preview.source).toBe('~/.ssh/config');
    expect(preview.keys).toEqual([
      { ref: 'k1', display: '~/.ssh/id_ed25519', hosts: ['web'], proposedSecret: 'ssh_key_id_ed25519' },
    ]);
    expect(fs.reads).toEqual([CONFIG]); // the key file is never opened by a preview
  });

  it('a SetEnv value stays in main: the preview passes the channel schema and carries no value', async () => {
    const { service, dir } = setup({ [CONFIG]: 'Host web\n  SetEnv TOKEN=MARKER-ENV\nHost *\n  SetEnv LANG=C\n' });
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    expect(sshImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(JSON.stringify(preview)).not.toContain('MARKER-ENV');
    await service.apply(A, apply(preview.previewId));
    const written = readFileSync(join(dir, 'hosts.yaml'), 'utf8');
    expect(written).toContain('TOKEN: MARKER-ENV');
    expect(written).toContain('LANG: C');
  });

  it('ForwardAgent yes passes the channel schema and is written to the host', async () => {
    const { service, dir } = setup({ [CONFIG]: 'Host web\n  ForwardAgent yes\nHost db\n' });
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    expect(sshImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(preview.hosts.find((h) => h.alias === 'web')?.ssh.forwardAgent).toBe(true);
    await service.apply(A, apply(preview.previewId));
    expect(readFileSync(join(dir, 'hosts.yaml'), 'utf8').match(/forwardAgent: true/g)).toHaveLength(1);
  });

  it('uses the picker for pick, and a cancelled pick is a cancellation', async () => {
    const { service, pick } = setup({ '/srv/other': 'Host a\n' });
    expect(await service.preview(A, { source: 'pick' })).toEqual({ cancelled: true });
    pick.mockResolvedValueOnce('/srv/other');
    expect(asPreview(await service.preview(A, { source: 'pick' })).source).toBe('/srv/other');
  });

  it('refuses a config that is not a regular file, too big, or missing, naming the errno', async () => {
    for (const [entry, errno] of [
      [{ dir: true }, 'ENOTFILE'],
      [{ size: 2 * 1024 * 1024 }, 'EFBIG'],
    ] as const) {
      const { service } = setup({ [CONFIG]: entry });
      await expect(service.preview(A, { source: 'user-config' })).rejects.toMatchObject({
        code: 'ssh-config-unreadable',
        details: { file: '~/.ssh/config', errno },
      });
    }
    await expect(setup({}).service.preview(A, { source: 'user-config' })).rejects.toMatchObject({
      code: 'ssh-config-unreadable',
      details: { errno: 'ENOENT' },
    });
  });

  it('refuses while hosts.yaml has problems, so an import never overwrites it', async () => {
    const { service } = setup({ [CONFIG]: 'Host a\n' }, { hostsYaml: 'version: 1\nhosts: nope\n' });
    await expect(service.preview(A, { source: 'user-config' })).rejects.toMatchObject({ code: 'ssh-hosts-invalid' });
  });

  it('turns an empty config into ssh-config-empty', async () => {
    const { service } = setup({ [CONFIG]: '# nothing\n' });
    await expect(service.preview(A, { source: 'user-config' })).rejects.toMatchObject({ code: 'ssh-config-empty' });
  });
});

describe('SshImportService.apply', () => {
  const files = {
    [CONFIG]: 'Host web\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n',
    '/home/u/.ssh/id_ed25519': KEY,
  };

  it('with the agent default, never opens the key file and writes hosts.yaml', async () => {
    const { service, fs, secrets, dir } = setup(files);
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    const result = await service.apply(A, apply(preview.previewId));
    expect(fs.reads).toEqual([CONFIG]);
    expect(secrets.set).not.toHaveBeenCalled();
    expect(result.groupId).toBe('ssh-config');
    expect(result.stored).toEqual([]);
    expect(readFileSync(join(dir, 'hosts.yaml'), 'utf8')).toContain('agent: true');
  });

  it('stores a chosen key as a secret and writes only its reference; the key text appears in no answer', async () => {
    const { service, secrets, dir } = setup(files);
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    const result = await service.apply(
      A,
      apply(preview.previewId, [{ ref: 'k1', choice: { kind: 'store', secret: 'web_key' } as never }]),
    );
    expect(secrets.set).toHaveBeenCalledWith('web_key', KEY);
    expect(result.stored).toEqual(['web_key']);
    expect(JSON.stringify(result)).not.toContain('MARKER-KEY');
    const yaml = readFileSync(join(dir, 'hosts.yaml'), 'utf8');
    expect(yaml).toContain('${secret:web_key}');
    expect(yaml).not.toContain('MARKER-KEY');
  });

  it('adds a passphrase reference for an encrypted key', async () => {
    const { service, dir } = setup({ ...files, '/home/u/.ssh/id_ed25519': ENCRYPTED_KEY });
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    await service.apply(A, apply(preview.previewId, [{ ref: 'k1', choice: { kind: 'store', secret: 'k' } as never }]));
    expect(readFileSync(join(dir, 'hosts.yaml'), 'utf8')).toContain('${secret:k_passphrase}');
  });

  it('refuses a public key or an unreadable key and writes nothing', async () => {
    for (const key of ['ssh-ed25519 AAAAC3Nza MARKER-PUB', { dir: true } as const]) {
      const { service, secrets, dir } = setup({ ...files, '/home/u/.ssh/id_ed25519': key });
      const preview = asPreview(await service.preview(A, { source: 'user-config' }));
      const error: unknown = await service
        .apply(A, apply(preview.previewId, [{ ref: 'k1', choice: { kind: 'store', secret: 'k' } as never }]))
        .catch((e: unknown) => e);
      expect(error).toMatchObject({ code: 'ssh-key-unreadable', details: { file: '~/.ssh/id_ed25519' } });
      expect(JSON.stringify(error)).not.toContain('MARKER-PUB');
      expect(String((error as Error).message)).not.toContain('MARKER-PUB');
      expect(secrets.set).not.toHaveBeenCalled();
      expect(() => readFileSync(join(dir, 'hosts.yaml'))).toThrow();
    }
  });

  describe('CertificateFile (#421)', () => {
    const CERT = 'ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29t alice@test\n';
    const certFiles = {
      [CONFIG]:
        'Host web\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n  CertificateFile ~/.ssh/id_ed25519-cert.pub\n',
      '/home/u/.ssh/id_ed25519': KEY,
      '/home/u/.ssh/id_ed25519-cert.pub': CERT,
    };

    it('shows the certificate on the key row and stores it as <secret>_cert with the key', async () => {
      const { service, secrets, dir } = setup(certFiles);
      const preview = asPreview(await service.preview(A, { source: 'user-config' }));
      expect(preview.keys[0]?.certificate).toBe('~/.ssh/id_ed25519-cert.pub');
      const result = await service.apply(
        A,
        apply(preview.previewId, [{ ref: 'k1', choice: { kind: 'store', secret: 'web_key' } as never }]),
      );
      expect(secrets.set).toHaveBeenCalledWith('web_key_cert', CERT.trim());
      expect(result.stored).toEqual(['web_key', 'web_key_cert']);
      expect(readFileSync(join(dir, 'hosts.yaml'), 'utf8')).toContain('certificate: ${secret:web_key_cert}');
    });

    it('keeps a <secret>_cert that already exists, and reads nothing for the agent', async () => {
      const { service, secrets, fs, dir } = setup(certFiles);
      secrets.names.mockResolvedValue([{ name: 'team_key_cert' }]);
      const preview = asPreview(await service.preview(A, { source: 'user-config' }));
      await service.apply(
        A,
        apply(preview.previewId, [{ ref: 'k1', choice: { kind: 'existing', secret: 'team_key' } as never }]),
      );
      expect(secrets.set).not.toHaveBeenCalled();
      expect(fs.reads).toEqual([CONFIG]);
      expect(readFileSync(join(dir, 'hosts.yaml'), 'utf8')).toContain('certificate: ${secret:team_key_cert}');

      const agent = setup(certFiles);
      const again = asPreview(await agent.service.preview(A, { source: 'user-config' }));
      await agent.service.apply(A, apply(again.previewId, [{ ref: 'k1', choice: { kind: 'agent' } as never }]));
      expect(agent.fs.reads).toEqual([CONFIG]);
    });

    it('refuses a certificate file that is not a certificate, and writes nothing', async () => {
      const { service, secrets, dir } = setup({ ...certFiles, '/home/u/.ssh/id_ed25519-cert.pub': 'ssh-ed25519 AAAA' });
      const preview = asPreview(await service.preview(A, { source: 'user-config' }));
      await expect(
        service.apply(A, apply(preview.previewId, [{ ref: 'k1', choice: { kind: 'store', secret: 'k' } as never }])),
      ).rejects.toMatchObject({ code: 'ssh-key-unreadable', details: { file: '~/.ssh/id_ed25519-cert.pub' } });
      expect(secrets.set).not.toHaveBeenCalled();
      expect(() => readFileSync(join(dir, 'hosts.yaml'))).toThrow();
    });
  });

  it("refuses another window's preview, an expired one, and a second apply", async () => {
    let now = 0;
    const { service } = setup(files, { now: () => now });
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    await expect(service.apply(B, apply(preview.previewId))).rejects.toMatchObject({ code: 'ssh-import-expired' });
    now = 11 * 60 * 1000;
    await expect(service.apply(A, apply(preview.previewId))).rejects.toMatchObject({ code: 'ssh-import-expired' });
    now = 0;
    const again = asPreview(await service.preview(A, { source: 'user-config' }));
    await service.apply(A, apply(again.previewId));
    await expect(service.apply(A, apply(again.previewId))).rejects.toMatchObject({ code: 'ssh-import-expired' });
  });

  it('refuses when hosts.yaml gained a clashing id since the preview', async () => {
    const { service, dir } = setup(files);
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    writeFileSync(join(dir, 'hosts.yaml'), 'version: 1\nhosts:\n  - { id: web, name: web, address: elsewhere }\n');
    await expect(service.apply(A, apply(preview.previewId))).rejects.toMatchObject({ code: 'ssh-import-stale' });
  });

  it('reports what was stored when a later key fails to store, and writes nothing', async () => {
    const config = 'Host a\n  IdentityFile ~/.ssh/a\nHost b\n  IdentityFile ~/.ssh/b\n';
    const { service, secrets, dir } = setup({ [CONFIG]: config, '/home/u/.ssh/a': KEY, '/home/u/.ssh/b': KEY });
    secrets.set.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('keychain locked'));
    const preview = asPreview(await service.preview(A, { source: 'user-config' }));
    await expect(
      service.apply(
        A,
        apply(preview.previewId, [
          { ref: 'k1', choice: { kind: 'store', secret: 'ka' } as never },
          { ref: 'k2', choice: { kind: 'store', secret: 'kb' } as never },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'ssh-key-unreadable', details: { stored: ['ka'] } });
    expect(() => readFileSync(join(dir, 'hosts.yaml'))).toThrow();
  });
});

describe('SshImportService session lists', () => {
  const REG = [
    'Windows Registry Editor Version 5.00',
    '',
    '[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\web]',
    '"HostName"="web.example.com"',
    '"UserName"="deploy"',
    '"PortForwardings"="L8080=localhost:80"',
    '"ProxyMethod"=dword:00000002',
    '"ProxyPassword"="MARKER-PASSWORD"',
    '',
  ].join('\r\n');
  const CSV = 'name,address,group,tags,password\ndb,db.example.com,Prod/Data,"prod, db",MARKER-PASSWORD\n';

  it("picks with the format's filters and refuses ~/.ssh/config for a session list", async () => {
    const { service, pick } = setup({});
    await service.preview(A, { source: 'pick', format: 'putty' });
    expect(pick).toHaveBeenCalledWith(A, {
      title: 'Choose a file of PuTTY sessions (.reg)',
      filters: [
        { name: 'PuTTY sessions (.reg)', extensions: ['reg'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    await expect(service.preview(A, { source: 'user-config', format: 'csv' })).rejects.toMatchObject({
      code: 'ssh-import-unreadable',
    });
  });

  it('reads a UTF-16 registry export and never carries a password into the preview or hosts.yaml', async () => {
    const { service, pick, dir, fs } = setup({});
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(REG, 'utf16le')]);
    fs.readBytes = () => Promise.resolve(bytes);
    fs.stat = () => Promise.resolve({ isFile: () => true, size: bytes.length });
    fs.realpath = (path) => Promise.resolve(path);
    pick.mockResolvedValueOnce('/home/u/putty.reg');
    const preview = asPreview(await service.preview(A, { source: 'pick', format: 'putty' }));
    expect(sshImportPreviewSchema.parse(preview)).toEqual(preview);
    expect(preview.group.name).toBe('PuTTY');
    expect(preview.hosts).toEqual([
      expect.objectContaining({ id: 'web', address: 'web.example.com', ssh: { user: 'deploy' }, forwards: 1 }),
    ]);
    expect(preview.report.notes).toContain(
      'Saved passwords in 1 session were not imported: passwords are never imported',
    );
    expect(JSON.stringify(preview)).not.toContain('MARKER-PASSWORD');
    await service.apply(A, { ...apply(preview.previewId), groupName: 'PuTTY' });
    const written = readFileSync(join(dir, 'hosts.yaml'), 'utf8');
    expect(written).toContain('target: localhost:80');
    expect(written).not.toContain('MARKER-PASSWORD');
  });

  it("shows a CSV row's folder and tags, and writes the folders as subgroups of the one new group", async () => {
    const { service, pick, dir } = setup({ '/home/u/hosts.csv': CSV });
    pick.mockResolvedValueOnce('/home/u/hosts.csv');
    const preview = asPreview(await service.preview(A, { source: 'pick', format: 'csv' }));
    expect(preview.source).toBe('~/hosts.csv');
    expect(preview.hosts[0]).toMatchObject({ id: 'db', folder: 'Prod / Data', tags: ['prod', 'db'] });
    await service.apply(A, { ...apply(preview.previewId), groupName: 'Spreadsheet' });
    const written = readFileSync(join(dir, 'hosts.yaml'), 'utf8');
    expect(written).toMatch(/name: Spreadsheet[\s\S]*name: Prod[\s\S]*name: Data[\s\S]*address: db.example.com/);
    expect(written).not.toContain('MARKER-PASSWORD');
  });
});

describe('isEncryptedKey', () => {
  it('reads PEM headers and the OpenSSH cipher name', () => {
    expect(isEncryptedKey(KEY)).toBe(false);
    expect(isEncryptedKey(ENCRYPTED_KEY)).toBe(true);
    expect(isEncryptedKey('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n')).toBe(true);
    expect(isEncryptedKey('-----BEGIN ENCRYPTED PRIVATE KEY-----\n')).toBe(true);
    expect(isEncryptedKey('-----BEGIN RSA PRIVATE KEY-----\nMIIE\n')).toBe(false);
  });
});
