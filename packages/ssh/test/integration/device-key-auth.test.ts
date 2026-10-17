import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Client } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  SshModelError,
  dialChain,
  ecdsaP256Blob,
  encodeDeviceKey,
  publicKeyLine,
  setDeviceKeySigner,
  sshRsaBlobFromSpki,
} from '../../src/index.js';
import type { ConnectProgress, DeviceKeySigner, DialledChain, HopCredentials } from '../../src/index.js';
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

/** A device key whose "hardware" is a key pair in this process: what the desktop's helper would answer. */
function softDeviceKey(kind: 'p256' | 'rsa'): { block: string; line: string; privateKey: KeyObject } {
  if (kind === 'p256') {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const point = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
    const line = publicKeyLine(ecdsaP256Blob(point), 'test@enclave');
    const block = encodeDeviceKey({
      platform: 'macos-secure-enclave',
      device: 'test-mac',
      publicKey: line,
      handle: 'AA',
    });
    return { block, line, privateKey };
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const line = publicKeyLine(sshRsaBlobFromSpki(publicKey.export({ format: 'der', type: 'spki' })), 'test@hello');
  const block = encodeDeviceKey({ platform: 'windows-hello', device: 'test-pc', publicKey: line, handle: 'wb-test' });
  return { block, line, privateKey };
}

/** Signs as the hardware does: P-256 r‖s, or RSA PKCS#1 v1.5 over SHA-256. */
const softSigner = (privateKey: KeyObject, reasons: string[] = []): DeviceKeySigner => ({
  sign: (key, data, reason) => {
    reasons.push(reason);
    return Promise.resolve(
      key.keyType === 'ssh-rsa'
        ? sign('sha256', data, privateKey)
        : sign('sha256', data, { key: privateKey, dsaEncoding: 'ieee-p1363' }),
    );
  },
});

// OpenSSH's own check of the signature is the one that matters; skipped where no sshd is installed.
describe.skipIf(sshdPath() === undefined)('device key sign-in against OpenSSH', { timeout: 30_000 }, () => {
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

  const hop = (privateKey: string, extra: { certificate?: string } = {}): HopCredentials => ({
    address: '127.0.0.1',
    port: server.port,
    user: server.user,
    auth: { kind: 'key', privateKey, label: 'id_ecdsa_device', ...extra },
    keepAlive: 0,
    connectTimeout: 10,
  });

  it.each(['p256', 'rsa'] as const)('signs in with a %s device key through the signer', async (kind) => {
    const { block, line, privateKey } = softDeviceKey(kind);
    server.authorizeLine(line);
    const events: ConnectProgress[] = [];
    const reasons: string[] = [];
    chain = await dialChain({
      hops: [hop(block)],
      verifyHostKey: accept,
      deviceKeys: softSigner(privateKey, reasons),
      onProgress: (event) => events.push(event),
    });
    expect(await canExec(chain.client)).toBe(true);
    expect(reasons).toEqual([`sign in to ${server.user}@127.0.0.1`]);
    const lines = events.flatMap((e) => (e.kind === 'log' ? [e.line] : []));
    const words = kind === 'p256' ? 'Touch ID or your password' : 'Windows Hello';
    expect(lines).toContain(`Confirm with ${words} to sign in with device key id_ecdsa_device`);
  });

  it('is unavailable without a signer, before any network', async () => {
    const { block } = softDeviceKey('p256');
    await expect(dialChain({ hops: [hop(block)], verifyHostKey: accept })).rejects.toMatchObject({
      code: 'ssh-device-key-unavailable',
      details: { key: 'id_ecdsa_device', hop: 0 },
    });
  });

  it('signs through the process signer when the options name none', async () => {
    const { block, line, privateKey } = softDeviceKey('p256');
    server.authorizeLine(line);
    setDeviceKeySigner(softSigner(privateKey));
    try {
      chain = await dialChain({ hops: [hop(block)], verifyHostKey: accept });
      expect(await canExec(chain.client)).toBe(true);
    } finally {
      setDeviceKeySigner(undefined);
    }
  });

  it('refuses a certificate for a device key', async () => {
    const { block, privateKey } = softDeviceKey('p256');
    await expect(
      dialChain({
        hops: [hop(block, { certificate: 'x' })],
        verifyHostKey: accept,
        deviceKeys: softSigner(privateKey),
      }),
    ).rejects.toMatchObject({ code: 'ssh-cert-invalid' });
  });

  it.each([
    ['ssh-device-key-missing', 'SSH key id_ecdsa_device lives on another device (made on test-mac)'],
    ['ssh-device-key-cancelled', 'The prompt was cancelled'],
  ] as const)('fails the connect with the signer’s %s', async (code, message) => {
    const { block, line } = softDeviceKey('p256');
    server.authorizeLine(line);
    const refusing: DeviceKeySigner = { sign: () => Promise.reject(new SshModelError(code, message)) };
    await expect(dialChain({ hops: [hop(block)], verifyHostKey: accept, deviceKeys: refusing })).rejects.toMatchObject({
      code,
      message: `127.0.0.1:${String(server.port)}: ${message}`,
    });
  });
});
