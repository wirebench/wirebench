import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateKey, installPublicKey } from '../../src/index.js';
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

let fixture: SshFixture | undefined;
let home: string | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});

describe.skipIf(process.platform === 'win32')('installPublicKey', () => {
  it('appends the key over the current sign-in, then finds it present', async () => {
    home = mkdtempSync(join(tmpdir(), 'wb-install-'));
    fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, exec: { home } });
    const key = await generateKey({ algorithm: 'ed25519', comment: 'wb test' });
    const options = { hops: [hop(fixture.port)], verifyHostKey: accept, publicKey: key.publicKey };
    expect(await installPublicKey(options)).toBe('added');
    expect(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8')).toBe(`${key.publicKey}\n`);
    expect(await installPublicKey(options)).toBe('present');
  });

  it('is ssh-install-failed when the remote command fails', async () => {
    home = mkdtempSync(join(tmpdir(), 'wb-install-'));
    // The fixture runs from `home`, but HOME points at a folder that is not there: making ~/.ssh fails.
    fixture = await startSshFixture({ password: { user: 'tester', password: 'pw' }, exec: { home } });
    rmSync(home, { recursive: true, force: true });
    const key = await generateKey({ algorithm: 'ed25519' });
    await expect(
      installPublicKey({ hops: [hop(fixture.port)], verifyHostKey: accept, publicKey: key.publicKey }),
    ).rejects.toMatchObject({ code: 'ssh-install-failed' });
  });

  it('passes the sign-in refusal through', async () => {
    fixture = await startSshFixture({ password: { user: 'tester', password: 'other' } });
    const key = await generateKey({ algorithm: 'ed25519' });
    await expect(
      installPublicKey({ hops: [hop(fixture.port)], verifyHostKey: accept, publicKey: key.publicKey }),
    ).rejects.toMatchObject({ code: 'ssh-auth-failed' });
  });
});
