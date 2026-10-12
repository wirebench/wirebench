import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { openSftp } from '../../src/index.js';
import type { SftpSession } from '../../src/index.js';
import { sftpServerPath, startSshFixture } from '../helpers/ssh-fixture.js';
import type { SshFixture } from '../helpers/ssh-fixture.js';

const accept = () => Promise.resolve('accept' as const);
const hop = (port: number, password: string) => ({
  address: '127.0.0.1',
  port,
  user: 'tester',
  auth: { kind: 'password' as const, password },
  keepAlive: 0,
  connectTimeout: 5,
});
const serverPath = sftpServerPath();
const isRoot = process.getuid?.() === 0;

if (serverPath === undefined) {
  if (process.env.CI !== undefined && process.platform === 'linux') {
    it('an OpenSSH sftp-server is installed', () => {
      expect.fail('CI on Linux must have an OpenSSH sftp-server (package openssh-sftp-server)');
    });
  } else {
    console.warn('Skipping the SFTP integration tests: no OpenSSH sftp-server found');
  }
}

const open: SshFixture[] = [];
const roots: string[] = [];
let session: SftpSession | undefined;
afterEach(async () => {
  session?.close();
  session = undefined;
  await Promise.all(open.splice(0).map((f) => f.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function tempRoot(): string {
  // realpath: macOS's temp folder is behind a symlink, and the server reports the resolved path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wirebench-sftp-')));
  roots.push(root);
  return root;
}
async function fixture(
  password: string,
  more: { allowForwardOut?: boolean; sftp?: { root: string } | 'refuse' } = {},
): Promise<SshFixture> {
  const f = await startSshFixture({ password: { user: 'tester', password }, ...more });
  open.push(f);
  return f;
}
async function sftpAt(root: string): Promise<SftpSession> {
  const f = await fixture('pw', { sftp: { root } });
  session = await openSftp({ hops: [hop(f.port, 'pw')], verifyHostKey: accept });
  return session;
}
async function roundTrip(s: SftpSession, path: string, bytes: Buffer): Promise<Buffer> {
  await pipeline(Readable.from([bytes]), s.writeStream(path, {}));
  const chunks: Buffer[] = [];
  await pipeline(
    s.readStream(path),
    new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk);
        done();
      },
    }),
  );
  return Buffer.concat(chunks);
}

describe.skipIf(serverPath === undefined)('openSftp', () => {
  it("realpath('.') is the root", async () => {
    const root = tempRoot();
    const s = await sftpAt(root);
    expect(await s.realpath('.')).toBe(root);
  });
  it('lists a file, a folder, a link to the folder and a dangling link', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'file.txt'), 'hello');
    mkdirSync(join(root, 'folder'));
    symlinkSync('folder', join(root, 'link'));
    symlinkSync('missing', join(root, 'dangling'));
    const s = await sftpAt(root);
    const entries = [...(await s.list(root))].sort((a, b) => a.name.localeCompare(b.name));
    expect(entries.map((e) => [e.name, e.type, e.targetType])).toEqual([
      ['dangling', 'symlink', 'other'],
      ['file.txt', 'file', undefined],
      ['folder', 'dir', undefined],
      ['link', 'symlink', 'dir'],
    ]);
    expect(entries.find((e) => e.name === 'file.txt')).toMatchObject({ size: 5 });
  });
  it('lists a folder of 2 000 files in one call', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'many'));
    for (let i = 0; i < 2000; i += 1) writeFileSync(join(root, 'many', `f${i}`), '');
    const s = await sftpAt(root);
    expect((await s.list(join(root, 'many'))).length).toBe(2000);
  });
  it('stats a file, and a missing path is sftp-not-found', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'abc');
    const s = await sftpAt(root);
    expect(await s.stat(join(root, 'a.txt'))).toMatchObject({ name: 'a.txt', type: 'file', size: 3 });
    await expect(s.stat(join(root, 'nope'))).rejects.toMatchObject({ code: 'sftp-not-found' });
  });
  it('mkdir twice is sftp-exists', async () => {
    const root = tempRoot();
    const s = await sftpAt(root);
    await s.mkdir(join(root, 'd'));
    expect(existsSync(join(root, 'd'))).toBe(true);
    await expect(s.mkdir(join(root, 'd'))).rejects.toMatchObject({
      code: 'sftp-exists',
      details: { path: join(root, 'd'), op: 'mkdir' },
    });
  });
  it('rename onto an existing name is sftp-exists and leaves both files intact', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a'), 'A');
    writeFileSync(join(root, 'b'), 'B');
    const s = await sftpAt(root);
    await expect(s.rename(join(root, 'a'), join(root, 'b'))).rejects.toMatchObject({ code: 'sftp-exists' });
    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('A');
    expect(readFileSync(join(root, 'b'), 'utf8')).toBe('B');
    await s.rename(join(root, 'a'), join(root, 'c'));
    expect(readFileSync(join(root, 'c'), 'utf8')).toBe('A');
  });
  it('remove refuses a non-empty folder without recursive and empties it with, never following a link', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, 'keep.txt'), 'keep');
    mkdirSync(join(root, 'd', 'inner'), { recursive: true });
    writeFileSync(join(root, 'd', 'inner', 'x'), 'x');
    symlinkSync(outside, join(root, 'd', 'link'));
    const s = await sftpAt(root);
    await expect(s.remove(join(root, 'd'), { recursive: false })).rejects.toMatchObject({
      code: 'sftp-failed',
      details: { op: 'remove' },
    });
    await s.remove(join(root, 'd'), { recursive: true });
    expect(existsSync(join(root, 'd'))).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
  });
  it('chmod changes the permission bits', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'p'), '');
    const s = await sftpAt(root);
    await s.chmod(join(root, 'p'), 0o640);
    expect((await s.stat(join(root, 'p'))).mode).toBe(0o640);
  });
  it('5 MB round-trips byte for byte', async () => {
    const root = tempRoot();
    const s = await sftpAt(root);
    const bytes = randomBytes(5 * 1024 * 1024);
    expect((await roundTrip(s, join(root, 'big.bin'), bytes)).equals(bytes)).toBe(true);
    expect(readFileSync(join(root, 'big.bin')).equals(bytes)).toBe(true);
  });
  it('round-trips through a jump hop', async () => {
    const root = tempRoot();
    const inner = await fixture('in', { sftp: { root } });
    const outer = await fixture('out', { allowForwardOut: true });
    session = await openSftp({ hops: [hop(outer.port, 'out'), hop(inner.port, 'in')], verifyHostKey: accept });
    const bytes = randomBytes(5 * 1024 * 1024);
    expect((await roundTrip(session, join(root, 'via.bin'), bytes)).equals(bytes)).toBe(true);
  });
  it('a server that refuses the subsystem is sftp-unavailable', async () => {
    const f = await fixture('pw', { sftp: 'refuse' });
    await expect(openSftp({ hops: [hop(f.port, 'pw')], verifyHostKey: accept })).rejects.toMatchObject({
      code: 'sftp-unavailable',
      details: { host: `127.0.0.1:${f.port}` },
    });
  });
  // root reads any folder, so the refusal cannot be provoked.
  it.skipIf(isRoot)('listing a folder the server may not read is sftp-permission-denied', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'locked'));
    chmodSync(join(root, 'locked'), 0o000);
    try {
      const s = await sftpAt(root);
      await expect(s.list(join(root, 'locked'))).rejects.toMatchObject({
        code: 'sftp-permission-denied',
        details: { path: join(root, 'locked'), op: 'list' },
      });
    } finally {
      chmodSync(join(root, 'locked'), 0o700);
    }
  });
  it('close() fires onClose once', async () => {
    const root = tempRoot();
    const s = await sftpAt(root);
    let fired = 0;
    s.onClose(() => {
      fired += 1;
    });
    s.close();
    s.close();
    await new Promise((r) => setTimeout(r, 200));
    expect(fired).toBe(1);
  });
});
