import { sign as cryptoSign } from 'node:crypto';
import ssh2 from 'ssh2';
import type { AuthMethod, Client, ParsedKey } from 'ssh2';
import { certificateValidity, formatValidity, parseCertificate } from './certificate.js';
import type { SshCertificate } from './certificate.js';
import { SshModelError } from './errors.js';
import { fingerprintOf } from './known-hosts.js';

const { utils } = ssh2;

/**
 * Signing in with an OpenSSH user certificate (#421).
 *
 * ssh2 1.17 has no certificate support for client auth: given a certificate's type as the key algorithm it
 * also writes that type into the signature blob, where OpenSSH expects the plain algorithm (`ssh-ed25519`,
 * not `ssh-ed25519-cert-v01@openssh.com`), so the server refuses the signature. The one place that gets it
 * wrong is `Protocol.authPK`, so for a connection that offers a certificate that method is wrapped, on that
 * client's protocol object only: the certificate attempt goes to {@link certAuthPK}, which writes the same
 * USERAUTH_REQUEST with the certificate as the public key blob and the plain algorithm inside the signature;
 * every other request goes to the library's own method. ssh2 is pinned to an exact version for this: the shim
 * reads the protocol object's packet writer, session id and auth queue.
 */

/** The parts of ssh2's (private) protocol object the shim uses (also the sk shim, `sk-auth.ts`). */
export interface AuthProtocol {
  authPK(username: string, key: unknown, keyAlgo?: unknown, cbSign?: unknown): void;
  _authsQueue: string[];
  _kex: { sessionID: Buffer };
  _kexinit: unknown;
  _queue?: Buffer[];
  _cipher: { encrypt(packet: Buffer): void };
  _packetRW: { write: { allocStart: number; alloc(size: number): Buffer; finalize(packet: Buffer): Buffer } };
}

/** The algorithm named in the request (`pk`), the one inside the signature (`sig`) and its hash. */
interface Algorithms {
  readonly pk: string;
  readonly sig: string;
  readonly hash: string | null;
}

/** RSA signs with SHA-512 under the certificate's `rsa-sha2-512` name, as OpenSSH's client does. */
function algorithmsOf(cert: SshCertificate): Algorithms {
  switch (cert.keyType) {
    case 'ssh-ed25519':
      return { pk: cert.certType, sig: 'ssh-ed25519', hash: null };
    case 'ssh-rsa':
      return { pk: 'rsa-sha2-512-cert-v01@openssh.com', sig: 'rsa-sha2-512', hash: 'sha512' };
    case 'ecdsa-sha2-nistp256':
      return { pk: cert.certType, sig: cert.keyType, hash: 'sha256' };
    case 'ecdsa-sha2-nistp384':
      return { pk: cert.certType, sig: cert.keyType, hash: 'sha384' };
    default:
      return { pk: cert.certType, sig: cert.keyType, hash: 'sha512' };
  }
}

const sshString = (value: Buffer | string): Buffer => {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

/** An SSH mpint of the unsigned big-endian `bytes`. */
const mpint = (bytes: Buffer): Buffer => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return sshString(((trimmed[0] ?? 0) & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};

/** The signature in its SSH encoding (RFC 5656, 8332, 8709), without the algorithm name. */
function signatureOf(key: ParsedKey, algorithms: Algorithms, data: Buffer): Buffer {
  const pem = key.getPrivatePEM();
  if (algorithms.sig.startsWith('ecdsa-')) {
    const raw = cryptoSign(algorithms.hash, data, { key: pem, dsaEncoding: 'ieee-p1363' });
    const half = raw.length / 2;
    return Buffer.concat([mpint(raw.subarray(0, half)), mpint(raw.subarray(half))]);
  }
  return cryptoSign(algorithms.hash, data, pem);
}

/** As ssh2's own `sendPacket`: held back while a key exchange runs. */
export function sendAuthRequest(proto: AuthProtocol, payload: Buffer): void {
  const writer = proto._packetRW.write;
  const packet = writer.alloc(payload.length);
  packet.set(payload, writer.allocStart);
  proto._authsQueue.push('publickey');
  const finalized = writer.finalize(packet);
  if (proto._kexinit !== undefined) (proto._queue ??= []).push(finalized);
  else proto._cipher.encrypt(finalized);
}

/** USERAUTH_REQUEST (RFC 4252 §7) for the certificate: a query first, then (on PK_OK) the signed request. */
function certAuthPK(
  proto: AuthProtocol,
  username: string,
  cert: SshCertificate,
  key: ParsedKey,
  signed: boolean,
): void {
  const algorithms = algorithmsOf(cert);
  const request = Buffer.concat([
    Buffer.from([50]), // SSH_MSG_USERAUTH_REQUEST
    sshString(username),
    sshString('ssh-connection'),
    sshString('publickey'),
    Buffer.from([signed ? 1 : 0]),
    sshString(algorithms.pk),
    sshString(cert.blob),
  ]);
  if (!signed) return sendAuthRequest(proto, request);
  const signature = signatureOf(key, algorithms, Buffer.concat([sshString(proto._kex.sessionID), request]));
  sendAuthRequest(
    proto,
    Buffer.concat([request, sshString(Buffer.concat([sshString(algorithms.sig), sshString(signature)]))]),
  );
}

export interface CertificateAuth {
  /** The `authHandler` for ssh2: the certificate, then the key alone. */
  readonly authHandler: AuthMethod[];
  /** Wraps the client's `authPK`: call right after `client.connect()`, which makes the protocol object. */
  attach(client: Client): void;
}

/**
 * Checks the certificate against the key and the clock before any network: a host certificate, one for
 * another key or one outside its validity window never reaches the server.
 *
 * @throws SshModelError `ssh-cert-invalid` | `ssh-cert-expired` {validity, validAfter, validBefore, window} |
 *   `ssh-cert-mismatch` | `ssh-key-invalid` when the private key cannot be read (no message repeats it)
 */
export function certificateAuth(options: {
  readonly username: string;
  readonly privateKey: string;
  readonly passphrase?: string;
  readonly certificate: string;
  /** Milliseconds; tests pin it. */
  readonly now?: number;
}): CertificateAuth {
  const cert = parseCertificate(options.certificate);
  if (cert.kind !== 'user') {
    throw new SshModelError('ssh-cert-invalid', 'This is a host certificate; signing in needs a user certificate');
  }
  const validity = certificateValidity(cert, options.now ?? Date.now());
  if (validity !== 'valid') {
    const window = formatValidity(cert);
    throw new SshModelError(
      'ssh-cert-expired',
      validity === 'expired'
        ? `The certificate has expired: it was valid ${window}`
        : `The certificate is not valid yet: it is valid ${window}`,
      { validity, validAfter: cert.validAfter, validBefore: cert.validBefore, window },
    );
  }
  const parsed = utils.parseKey(options.privateKey, options.passphrase || undefined);
  const key = Array.isArray(parsed) ? (parsed[0] as ParsedKey | undefined) : parsed;
  if (key === undefined || key instanceof Error || !key.isPrivateKey()) {
    throw new SshModelError('ssh-key-invalid', 'The private key could not be read');
  }
  if (fingerprintOf(key.getPublicSSH()) !== cert.publicKeyFingerprint) {
    throw new SshModelError('ssh-cert-mismatch', 'The certificate was issued for a different key');
  }
  // What the client hands `authPK` for the certificate attempt: ssh2 takes it for the parsed key it inherits
  // from (it checks a symbol on it), and the wrapper knows it by identity.
  const certKey = Object.create(key, {
    type: { value: cert.certType },
    getPublicSSH: { value: () => cert.blob },
  }) as ParsedKey;
  return {
    authHandler: [
      { type: 'publickey', username: options.username, key: certKey } as AuthMethod,
      { type: 'publickey', username: options.username, key } as AuthMethod,
    ],
    attach(client) {
      const proto = (client as unknown as { _protocol: AuthProtocol })._protocol;
      const original = proto.authPK.bind(proto);
      proto.authPK = (username, pubKey, keyAlgo, cbSign) => {
        if (pubKey !== certKey) return original(username, pubKey, keyAlgo, cbSign);
        // The library passes a signing callback (third or fourth argument) for the signed request.
        certAuthPK(proto, username, cert, key, typeof cbSign === 'function' || typeof keyAlgo === 'function');
      };
    },
  };
}
