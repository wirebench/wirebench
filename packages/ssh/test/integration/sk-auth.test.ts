import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dialChain, generateKey, parseSkPrivateKey, skPublicBlob, skSign } from '../../src/index.js';
import type { ConnectProgress, DialledChain, GeneratedKey, HopCredentials, SkKey } from '../../src/index.js';
import { SshReader, sshString, uint32 } from '../../src/sk-key.js';
import { SoftAuthenticator, softTransport } from '../helpers/fido-authenticator.js';
import { sshdPath, startOpenSshServer } from '../helpers/openssh-server.js';
import type { OpenSshServer } from '../helpers/openssh-server.js';

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

const logLines = (events: readonly ConnectProgress[]): string[] =>
  events.flatMap((e) => (e.kind === 'log' ? [e.line] : []));

/**
 * A minimal ssh-agent on a Unix socket holding one sk key, signing through the software authenticator as
 * OpenSSH's agent does with a real one: it answers the listing, and a sign request with the whole sk blob.
 */
async function startSkAgent(
  key: SkKey,
  authenticator: SoftAuthenticator,
): Promise<{ socket: string; close: () => Promise<void> }> {
  const dir = mkdtempSync(join(tmpdir(), 'wb-agent-'));
  const socket = join(dir, 'agent.sock');
  const blob = skPublicBlob(key);
  const reply = (payload: Buffer): Buffer => Buffer.concat([uint32(payload.length), payload]);
  const server = net.createServer((conn) => {
    let buffered = Buffer.alloc(0);
    conn.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4 || buffered.length < 4 + buffered.readUInt32BE(0)) return;
      const message = buffered.subarray(4, 4 + buffered.readUInt32BE(0));
      buffered = Buffer.alloc(0);
      if (message[0] === 11) {
        conn.write(reply(Buffer.concat([Buffer.from([12]), uint32(1), sshString(blob), sshString('agent sk')])));
      } else if (message[0] === 13) {
        const reader = new SshReader(message.subarray(1));
        reader.string();
        const data = Buffer.from(reader.string());
        skSign(key, data, { transport: softTransport(authenticator) }).then(
          (signature) => conn.write(reply(Buffer.concat([Buffer.from([14]), sshString(signature)]))),
          () => conn.write(reply(Buffer.from([5]))),
        );
      } else {
        conn.write(reply(Buffer.from([5])));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  return {
    socket,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// OpenSSH's own check of the sk signature is the one that matters; skipped where no sshd is installed.
describe.skipIf(sshdPath() === undefined)('security key sign-in against OpenSSH', { timeout: 30_000 }, () => {
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

  const hop = (auth: HopCredentials['auth']): HopCredentials => ({
    address: '127.0.0.1',
    port: server.port,
    user: server.user,
    auth,
    keepAlive: 0,
    connectTimeout: 10,
  });

  const make = (
    authenticator: SoftAuthenticator,
    algorithm: 'ed25519-sk' | 'ecdsa-sk',
    extra: { pin?: string; verifyRequired?: boolean; passphrase?: string } = {},
  ): Promise<GeneratedKey> =>
    generateKey({ algorithm, comment: 'test@sk', transport: softTransport(authenticator), ...extra });

  it.each(['ed25519-sk', 'ecdsa-sk'] as const)('signs in with a stored %s key after a touch', async (algorithm) => {
    const authenticator = new SoftAuthenticator();
    const key = await make(authenticator, algorithm);
    server.authorizeLine(key.publicKey);
    const events: ConnectProgress[] = [];
    chain = await dialChain({
      hops: [hop({ kind: 'key', privateKey: key.privateKey, label: 'yubi' })],
      verifyHostKey: accept,
      fido: softTransport(authenticator),
      onProgress: (event) => events.push(event),
    });
    expect(await canExec(chain.client)).toBe(true);
    const lines = logLines(events);
    expect(lines).toContain('Waiting for you to touch the security key');
    expect(lines.some((line) => line.startsWith('Signing with security key yubi'))).toBe(true);
  });

  it('opens an encrypted sk key with its passphrase', async () => {
    const authenticator = new SoftAuthenticator();
    const key = await make(authenticator, 'ed25519-sk', { passphrase: 'sk pass' });
    server.authorizeLine(key.publicKey);
    chain = await dialChain({
      hops: [hop({ kind: 'key', privateKey: key.privateKey, passphrase: 'sk pass' })],
      verifyHostKey: accept,
      fido: softTransport(authenticator),
    });
    expect(await canExec(chain.client)).toBe(true);
  });

  it('signs with the PIN for a verify-required key, and asks for it when it is missing', async () => {
    const authenticator = new SoftAuthenticator({ pin: '4321' });
    const key = await make(authenticator, 'ed25519-sk', { pin: '4321', verifyRequired: true });
    server.authorizeLine(`verify-required ${key.publicKey}`);
    const dial = (pin?: string): Promise<DialledChain> =>
      dialChain({
        hops: [hop({ kind: 'key', privateKey: key.privateKey, ...(pin === undefined ? {} : { pin }) })],
        verifyHostKey: accept,
        fido: softTransport(authenticator),
      });
    await expect(dial()).rejects.toMatchObject({ code: 'ssh-sk-pin', details: { reason: 'required', hop: 0 } });
    await expect(dial('0000')).rejects.toMatchObject({ code: 'ssh-sk-pin', details: { reason: 'wrong', retries: 7 } });
    chain = await dial('4321');
    expect(await canExec(chain.client)).toBe(true);
  });

  it('fails with what the key said when it is not touched or not plugged in', async () => {
    const holder = new SoftAuthenticator();
    const key = await make(holder, 'ecdsa-sk');
    server.authorizeLine(key.publicKey);
    const untouched = new SoftAuthenticator({ touch: 'never' });
    for (const [id, credential] of holder.credentials) untouched.credentials.set(id, credential);
    const dial = (transport: ReturnType<typeof softTransport>): Promise<DialledChain> =>
      dialChain({ hops: [hop({ kind: 'key', privateKey: key.privateKey })], verifyHostKey: accept, fido: transport });
    await expect(dial(softTransport(untouched))).rejects.toMatchObject({
      code: 'ssh-sk-not-touched',
      details: { host: `127.0.0.1:${String(server.port)}` },
    });
    await expect(dial(softTransport())).rejects.toMatchObject({ code: 'ssh-sk-no-device' });
  });

  it.skipIf(process.platform === 'win32')('signs with an sk key the agent holds, which ssh2 alone skips', async () => {
    const authenticator = new SoftAuthenticator();
    const generated = await make(authenticator, 'ed25519-sk');
    server.authorizeLine(generated.publicKey);
    const key = parseSkPrivateKey(generated.privateKey);
    if (!key) throw new Error('not an sk key');
    const agent = await startSkAgent(key, authenticator);
    try {
      const events: ConnectProgress[] = [];
      chain = await dialChain({
        hops: [hop({ kind: 'agent', socket: agent.socket })],
        verifyHostKey: accept,
        onProgress: (event) => events.push(event),
      });
      expect(await canExec(chain.client)).toBe(true);
      expect(logLines(events)).toContain('The agent holds 1 security key');
    } finally {
      chain?.endAll();
      chain = undefined;
      await agent.close();
    }
  });
});
