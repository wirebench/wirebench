import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapMosh } from '../../src/index.js';
import type { ConnectProgress } from '../../src/index.js';
import { startSshFixture } from '../helpers/ssh-fixture.js';
import type { SshFixture } from '../helpers/ssh-fixture.js';

const accept = () => Promise.resolve('accept' as const);
const hop = (port: number) => ({
  address: '127.0.0.1',
  port,
  user: 'tester',
  auth: { kind: 'password' as const, password: 'pw' },
  keepAlive: 0,
  connectTimeout: 5,
});
const KEY = 'ABCDEFGHIJKLMNOPQRSTUV';

let fixture: SshFixture | undefined;
let home: string | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

/** A stand-in mosh-server: records its arguments and prints what the real one does. */
function fakeServer(dir: string, body: string): string {
  const path = join(dir, 'fake-mosh-server');
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe.skipIf(process.platform === 'win32')('bootstrapMosh', () => {
  it('starts the server over SSH and answers its port and key', async () => {
    home = mkdtempSync(join(tmpdir(), 'wb-mosh-'));
    const server = fakeServer(
      home,
      `printf '\\r\\nMOSH CONNECT 60004 ${KEY}\\r\\n'\necho '[mosh-server detached, pid = 1]' >&2`,
    );
    fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, exec: { home } });
    const events: ConnectProgress[] = [];
    const endpoint = await bootstrapMosh({
      hops: [hop(fixture.port)],
      verifyHostKey: accept,
      mosh: { server, ports: '60004:60010' },
      env: { STAGE: 'blue sky' },
      onProgress: (e) => events.push(e),
    });
    expect(endpoint).toEqual({ port: 60004, key: KEY });
    expect(readFileSync(join(home, 'args'), 'utf8').split('\n')).toEqual([
      'new',
      '-s',
      '-c',
      '256',
      '-l',
      'LANG=C.UTF-8',
      '-l',
      'STAGE=blue sky',
      '-p',
      '60004:60010',
      '',
    ]);
    expect(events.some((e) => e.kind === 'phase' && e.phase === 'shell' && e.state === 'done')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('is mosh-server-missing when the command is not there', async () => {
    home = mkdtempSync(join(tmpdir(), 'wb-mosh-'));
    fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, exec: { home } });
    await expect(
      bootstrapMosh({ hops: [hop(fixture.port)], verifyHostKey: accept, mosh: { server: 'no-such-mosh-server' } }),
    ).rejects.toMatchObject({ code: 'mosh-server-missing' });
  });

  it('is mosh-bootstrap-failed with what the server said', async () => {
    home = mkdtempSync(join(tmpdir(), 'wb-mosh-'));
    const server = fakeServer(home, `echo 'mosh-server: Network is unreachable' >&2\nexit 1`);
    fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, exec: { home } });
    await expect(
      bootstrapMosh({ hops: [hop(fixture.port)], verifyHostKey: accept, mosh: { server } }),
    ).rejects.toMatchObject({
      code: 'mosh-bootstrap-failed',
      details: { serverSaid: 'mosh-server: Network is unreachable' },
    });
  });

  it('passes the sign-in refusal through', async () => {
    fixture = await startSshFixture({ password: { user: 'tester', password: 'other' } });
    await expect(bootstrapMosh({ hops: [hop(fixture.port)], verifyHostKey: accept })).rejects.toMatchObject({
      code: 'ssh-auth-failed',
    });
  });
});
