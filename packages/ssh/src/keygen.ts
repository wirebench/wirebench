import ssh2 from 'ssh2';
import { SshModelError } from './errors.js';
import { fingerprintOf } from './known-hosts.js';

// ssh2 is CommonJS: its `utils` is reached through the default export, as the test fixture does.
const { utils } = ssh2;

export type SshKeyAlgorithm = 'ed25519' | 'ecdsa' | 'rsa';

/** The sizes each algorithm offers, default first; Ed25519 has one fixed size. */
export const SSH_KEY_BITS: Readonly<Record<SshKeyAlgorithm, readonly number[]>> = {
  ed25519: [],
  ecdsa: [256, 384, 521],
  rsa: [4096, 3072, 2048],
};

export interface GenerateKeyOptions {
  readonly algorithm: SshKeyAlgorithm;
  /** One of {@link SSH_KEY_BITS} for the algorithm; its first when left out. Ignored for Ed25519. */
  readonly bits?: number;
  /** Encrypts the private key (aes256-ctr, bcrypt KDF) when non-empty. */
  readonly passphrase?: string;
  readonly comment?: string;
}

/** What can be said of a key without its private half. */
export interface SshKeyInfo {
  /** The OpenSSH key type: `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`, … */
  readonly keyType: string;
  /** 'SHA256:<base64, no padding>', as `ssh-keygen -l` prints it. */
  readonly fingerprint: string;
  /** The public key as one `authorized_keys` line: type, base64 blob and the comment if there is one. */
  readonly publicKey: string;
}

export interface GeneratedKey extends SshKeyInfo {
  /** The private key in OpenSSH format (`-----BEGIN OPENSSH PRIVATE KEY-----`). */
  readonly privateKey: string;
}

/** bcrypt rounds for an encrypted key: ssh-keygen's default. */
const KDF_ROUNDS = 16;

/**
 * ssh2 drops every leading zero byte of an Ed25519 public key, so about one pair in 256 comes out with a
 * 31-byte key that neither ssh2 nor OpenSSH reads back. Such a pair is thrown away and another made.
 */
const ED25519_ATTEMPTS = 8;

/**
 * A new key pair in OpenSSH format. Asynchronous because an RSA key takes a noticeable time to make and the
 * desktop calls this from its main process.
 *
 * @throws SshModelError `ssh-key-invalid` for a size the algorithm does not offer or a multi-line comment
 */
export async function generateKey(options: GenerateKeyOptions): Promise<GeneratedKey> {
  const sizes = Object.hasOwn(SSH_KEY_BITS, options.algorithm) ? SSH_KEY_BITS[options.algorithm] : undefined;
  if (sizes === undefined) throw new SshModelError('ssh-key-invalid', 'Unknown key type');
  const bits = options.algorithm === 'ed25519' ? undefined : (options.bits ?? sizes[0]);
  if (bits !== undefined && !sizes.includes(bits)) {
    throw new SshModelError('ssh-key-invalid', `A ${options.algorithm} key is ${sizes.join(', ')} bits`, { bits });
  }
  const comment = options.comment ?? '';
  if (/[\r\n]/.test(comment)) throw new SshModelError('ssh-key-invalid', 'A key comment is one line');
  const passphrase = options.passphrase ?? '';
  const settings = {
    ...(bits === undefined ? {} : { bits }),
    ...(comment === '' ? {} : { comment }),
    ...(passphrase === '' ? {} : { passphrase, cipher: 'aes256-ctr', rounds: KDF_ROUNDS }),
  };
  for (let attempt = 1; ; attempt++) {
    const pair = await new Promise<{ private: string; public: string }>((resolve, reject) => {
      utils.generateKeyPair(options.algorithm, settings as never, (error, keys) => {
        // The library message is not forwarded: it can describe the options, passphrase included.
        if (error) reject(new SshModelError('ssh-key-invalid', 'The key could not be generated'));
        else resolve(keys);
      });
    });
    const info = describePublicKey(pair.public);
    if (options.algorithm !== 'ed25519' || isWholeEd25519(info)) return { privateKey: pair.private, ...info };
    if (attempt === ED25519_ATTEMPTS) throw new SshModelError('ssh-key-invalid', 'The key could not be generated');
  }
}

/** True when the public blob is the 4-byte-length type name followed by a 32-byte key. */
function isWholeEd25519(info: SshKeyInfo): boolean {
  const blob = Buffer.from(info.publicKey.split(' ')[1] ?? '', 'base64');
  return blob.length === 4 + 'ssh-ed25519'.length + 4 + 32 && blob.readUInt32BE(4 + 'ssh-ed25519'.length) === 32;
}

/** True when `text` looks like a private key in a format ssh2 reads (OpenSSH, PKCS#1, PKCS#8 or SEC1 PEM). */
export function looksLikePrivateKey(text: string): boolean {
  return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(text);
}

/**
 * The public half of a private key, as {@link SshKeyInfo}. The private key and passphrase stay with the
 * caller: no message here repeats either.
 *
 * @throws SshModelError `ssh-key-locked` when the key is encrypted and `passphrase` is missing or wrong |
 *   `ssh-key-invalid` when `text` is not a private key ssh2 can read
 */
export function describePrivateKey(text: string, passphrase?: string): SshKeyInfo {
  if (!looksLikePrivateKey(text)) throw new SshModelError('ssh-key-invalid', 'This secret is not a private key');
  const parsed = utils.parseKey(text, passphrase === '' ? undefined : passphrase);
  const key = Array.isArray(parsed) ? (parsed[0] as ssh2.ParsedKey | undefined) : parsed;
  if (key === undefined || key instanceof Error) {
    const message = key instanceof Error ? key.message : '';
    if (/passphrase|encrypt|decrypt/i.test(message)) {
      throw new SshModelError(
        'ssh-key-locked',
        passphrase ? 'The passphrase does not open this private key' : 'This private key needs its passphrase',
      );
    }
    throw new SshModelError('ssh-key-invalid', 'This secret is not a private key Wirebench can read');
  }
  const blob = key.getPublicSSH();
  const line = `${key.type} ${blob.toString('base64')}`;
  return {
    keyType: key.type,
    fingerprint: fingerprintOf(blob),
    publicKey: key.comment ? `${line} ${key.comment}` : line,
  };
}

/**
 * Reads one OpenSSH public key line (`type base64 [comment]`).
 *
 * @throws SshModelError `ssh-key-invalid` when the line is not a public key
 */
export function describePublicKey(line: string): SshKeyInfo {
  const match = /^([a-z0-9@.-]+) ([A-Za-z0-9+/]+={0,2})(?: ([^\r\n]*))?$/.exec(line.trim());
  if (!match) throw new SshModelError('ssh-key-invalid', 'Not an OpenSSH public key line');
  const [, type = '', base64 = '', comment] = match;
  const blob = Buffer.from(base64, 'base64');
  // The blob opens with its own type name: a mismatch is a corrupt or hand-edited line.
  const declared = blob.length >= 4 ? blob.subarray(4, 4 + blob.readUInt32BE(0)).toString('ascii') : '';
  if (declared !== type) throw new SshModelError('ssh-key-invalid', 'Not an OpenSSH public key line');
  return {
    keyType: type,
    fingerprint: fingerprintOf(blob),
    publicKey: comment ? `${type} ${base64} ${comment}` : `${type} ${base64}`,
  };
}
