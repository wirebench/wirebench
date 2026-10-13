import { readFileSync } from 'node:fs';
import type { Client } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dialChain } from '../../src/index.js';
import type { DialledChain, HopCredentials } from '../../src/index.js';
import { sshdPath, startOpenSshServer } from '../helpers/openssh-server.js';
import type { OpenSshServer } from '../helpers/openssh-server.js';

const fixture = (name: string): string => readFileSync(new URL(`../fixtures/certs/${name}`, import.meta.url), 'utf8');
const accept = () => Promise.resolve('accept' as const);

function canExec(client: Client): Promise<boolean> {
  return new Promise((resolve) => {
    client.exec('true', (error, channel) => {
      if (error) return resolve(false);
      channel.on('exit', (code: number | null) => resolve(code === 0));
      channel.on('close', () => resolve(false));
      channel.resume();
    });
  });
}

// A real OpenSSH server trusting the test CA: the check that matters is the one OpenSSH makes of the
// signature, which an ssh2 test server would not. Skipped where no sshd is installed (Windows, some CI images).
describe.skipIf(sshdPath() === undefined)('certificate sign-in against OpenSSH', { timeout: 30_000 }, () => {
  let server: OpenSshServer;
  let chain: DialledChain | undefined;
  beforeAll(async () => {
    server = await startOpenSshServer();
  });
  afterAll(async () => {
    await server.close();
  });
  afterEach(() => {
    chain?.endAll();
    chain = undefined;
  });

  const hop = (key: string, certificate: string, passphrase?: string): HopCredentials => ({
    address: '127.0.0.1',
    port: server.port,
    user: server.user,
    auth: { kind: 'key', privateKey: fixture(key), certificate, ...(passphrase ? { passphrase } : {}) },
    keepAlive: 0,
    connectTimeout: 10,
  });

  it.each(['user_ed25519', 'user_ecdsa', 'user_rsa'])('signs in with the %s key and its certificate', async (key) => {
    chain = await dialChain({ hops: [hop(key, server.certify(key))], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
  });

  it('opens an encrypted key with its passphrase', async () => {
    const certificate = server.certify('user_locked');
    chain = await dialChain({ hops: [hop('user_locked', certificate, 'cert pass')], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
  });

  it('refuses a certificate for another principal when the key alone is not let in', async () => {
    const certificate = server.certify('user_ecdsa', { principals: 'someone-else' });
    await expect(dialChain({ hops: [hop('user_ecdsa', certificate)], verifyHostKey: accept })).rejects.toMatchObject({
      code: 'ssh-auth-failed',
      details: { method: 'certificate' },
    });
  });

  it('falls back to the key alone when the server refuses the certificate', async () => {
    server.authorize('user_rsa');
    const certificate = server.certify('user_rsa', { principals: 'someone-else' });
    chain = await dialChain({ hops: [hop('user_rsa', certificate)], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
  });
});
