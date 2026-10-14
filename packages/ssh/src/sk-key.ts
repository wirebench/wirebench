import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import bcrypt from 'bcrypt-pbkdf';
import { SshModelError } from './errors.js';

/**
 * FIDO2 security keys in OpenSSH's format (#420): `sk-ssh-ed25519@openssh.com` and
 * `sk-ecdsa-sha2-nistp256@openssh.com`. ssh2 reads neither, so their private key files, public blobs and
 * signatures are read and written here (OpenSSH's PROTOCOL.u2f). The "private" half holds no private key:
 * it is the authenticator's key handle, which only that authenticator can sign with.
 */

export const SK_ED25519 = 'sk-ssh-ed25519@openssh.com';
export const SK_ECDSA = 'sk-ecdsa-sha2-nistp256@openssh.com';
export type SkKeyType = typeof SK_ED25519 | typeof SK_ECDSA;

/** Key flags (PROTOCOL.u2f): touch is required unless 0x01 is clear; 0x04 asks for the PIN as well. */
export const SK_USER_PRESENCE = 0x01;
export const SK_USER_VERIFICATION = 0x04;
export const SK_RESIDENT = 0x20;

/** The FIDO application (relying party id) OpenSSH uses unless told otherwise. */
export const SK_DEFAULT_APPLICATION = 'ssh:';

export const isSkKeyType = (type: string): type is SkKeyType => type === SK_ED25519 || type === SK_ECDSA;

export interface SkPublicKey {
  readonly keyType: SkKeyType;
  /** Ed25519: the 32-byte key; ECDSA: the uncompressed P-256 point (65 bytes). */
  readonly publicKey: Buffer;
  readonly application: string;
}

export interface SkKey extends SkPublicKey {
  readonly flags: number;
  /** The authenticator's credential id. */
  readonly keyHandle: Buffer;
  readonly comment: string;
}

const MAGIC = 'openssh-key-v1\0';
const CIPHER = 'aes256-ctr';
const KDF_ROUNDS = 16;

export const sshString = (value: Buffer | string): Buffer => {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
};

export const uint32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
};

const invalid = (): SshModelError =>
  new SshModelError('ssh-key-invalid', 'This is not a security key Wirebench can read');

/** Reads SSH wire types; any read past the end is `ssh-key-invalid`. */
export class SshReader {
  private pos = 0;
  constructor(private readonly data: Buffer) {}

  get done(): boolean {
    return this.pos >= this.data.length;
  }

  byte(): number {
    if (this.pos + 1 > this.data.length) throw invalid();
    return this.data[this.pos++] as number;
  }

  uint32(): number {
    if (this.pos + 4 > this.data.length) throw invalid();
    const value = this.data.readUInt32BE(this.pos);
    this.pos += 4;
    return value;
  }

  bytes(length: number): Buffer {
    if (this.pos + length > this.data.length) throw invalid();
    const out = this.data.subarray(this.pos, this.pos + length);
    this.pos += length;
    return out;
  }

  string(): Buffer {
    return this.bytes(this.uint32());
  }

  text(): string {
    return this.string().toString('utf8');
  }
}

/** The public key blob (`authorized_keys` base64): type, key, application. */
export function skPublicBlob(key: SkPublicKey): Buffer {
  return Buffer.concat([
    sshString(key.keyType),
    ...(key.keyType === SK_ECDSA ? [sshString('nistp256')] : []),
    sshString(key.publicKey),
    sshString(key.application),
  ]);
}

/** Reads the fields after the type name, from a public blob or a private key record. */
function readSkPublic(reader: SshReader, keyType: SkKeyType): SkPublicKey {
  if (keyType === SK_ECDSA && reader.text() !== 'nistp256') throw invalid();
  const publicKey = Buffer.from(reader.string());
  const wrongSize = keyType === SK_ED25519 ? publicKey.length !== 32 : publicKey.length !== 65 || publicKey[0] !== 4;
  if (wrongSize) throw invalid();
  return { keyType, publicKey, application: reader.text() };
}

/**
 * The public half of an sk public key blob; undefined when the blob is another key type.
 *
 * @throws SshModelError `ssh-key-invalid` for an sk blob that is malformed
 */
export function parseSkPublicBlob(blob: Buffer): SkPublicKey | undefined {
  const reader = new SshReader(blob);
  let type: string;
  try {
    type = reader.text();
  } catch {
    return undefined;
  }
  if (!isSkKeyType(type)) return undefined;
  const key = readSkPublic(reader, type);
  if (!reader.done) throw invalid();
  return key;
}

const ARMOUR = /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n([\s\S]+?)\r?\n-----END OPENSSH PRIVATE KEY-----$/;

/** bcrypt-pbkdf, as ssh-keygen derives an aes256-ctr key and IV from the passphrase. */
function deriveKey(passphrase: string, salt: Buffer, rounds: number): { key: Buffer; iv: Buffer } {
  const pass = Buffer.from(passphrase, 'utf8');
  const out = Buffer.alloc(48);
  if (bcrypt.pbkdf(pass, pass.length, salt, salt.length, out, out.length, rounds) !== 0) throw invalid();
  return { key: out.subarray(0, 32), iv: out.subarray(32) };
}

interface Container {
  readonly cipher: string;
  readonly kdf: string;
  readonly kdfOptions: Buffer;
  readonly publicBlob: Buffer;
  readonly sealed: Buffer;
}

/** The openssh-key-v1 container of a one-key file; undefined for anything else. */
function readContainer(text: string): Container | undefined {
  const match = ARMOUR.exec(text.trim());
  if (!match) return undefined;
  const data = Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'base64');
  if (data.subarray(0, MAGIC.length).toString('latin1') !== MAGIC) return undefined;
  const reader = new SshReader(data.subarray(MAGIC.length));
  try {
    const cipher = reader.text();
    const kdf = reader.text();
    const kdfOptions = reader.string();
    if (reader.uint32() !== 1) return undefined; // several keys: not a file ssh-keygen writes
    return { cipher, kdf, kdfOptions, publicBlob: reader.string(), sealed: reader.string() };
  } catch {
    return undefined;
  }
}

/** True when `text` is an OpenSSH private key file holding an sk key (read without its passphrase). */
export function isSkPrivateKey(text: string): boolean {
  const container = readContainer(text);
  if (container === undefined) return false;
  try {
    return isSkKeyType(new SshReader(container.publicBlob).text());
  } catch {
    return false;
  }
}

/**
 * The sk key in an OpenSSH private key file; undefined when the file holds another kind of key (ssh2 reads
 * those). Nothing thrown repeats the file or the passphrase.
 *
 * @throws SshModelError `ssh-key-locked` when it is encrypted and `passphrase` is missing or wrong |
 *   `ssh-key-invalid` when it is malformed
 */
export function parseSkPrivateKey(text: string, passphrase?: string): SkKey | undefined {
  const container = readContainer(text);
  if (container === undefined || !isSkPrivateKey(text)) return undefined;
  const { cipher, kdf, kdfOptions, publicBlob, sealed } = container;
  let plain: Buffer;
  if (cipher === 'none') {
    plain = sealed;
  } else {
    if (cipher !== CIPHER || kdf !== 'bcrypt') {
      throw new SshModelError(
        'ssh-key-invalid',
        `This security key file is encrypted with ${cipher}, which Wirebench does not read`,
      );
    }
    if (!passphrase) throw new SshModelError('ssh-key-locked', 'This private key needs its passphrase');
    const options = new SshReader(kdfOptions);
    const salt = options.string();
    const { key, iv } = deriveKey(passphrase, salt, options.uint32());
    const decipher = createDecipheriv('aes-256-ctr', key, iv);
    plain = Buffer.concat([decipher.update(sealed), decipher.final()]);
  }
  const record = new SshReader(plain);
  // Two equal check words: a wrong passphrase decrypts them to different values.
  if (record.uint32() !== record.uint32()) {
    throw new SshModelError('ssh-key-locked', 'The passphrase does not open this private key');
  }
  const keyType = record.text();
  if (!isSkKeyType(keyType)) throw invalid();
  const pub = readSkPublic(record, keyType);
  const flags = record.byte();
  const keyHandle = Buffer.from(record.string());
  record.string(); // reserved
  const comment = record.text();
  if (!skPublicBlob(pub).equals(publicBlob)) throw invalid();
  return { ...pub, flags, keyHandle, comment };
}

/** The key as an OpenSSH private key file, encrypted (aes256-ctr, bcrypt, 16 rounds) when `passphrase` is non-empty. */
export function encodeSkPrivateKey(key: SkKey, passphrase?: string): string {
  const encrypted = passphrase !== undefined && passphrase !== '';
  const check = randomBytes(4);
  let record = Buffer.concat([
    check,
    check,
    sshString(key.keyType),
    ...(key.keyType === SK_ECDSA ? [sshString('nistp256')] : []),
    sshString(key.publicKey),
    sshString(key.application),
    Buffer.from([key.flags]),
    sshString(key.keyHandle),
    sshString(''),
    sshString(key.comment),
  ]);
  const block = encrypted ? 16 : 8;
  const padding = Buffer.from(Array.from({ length: (block - (record.length % block)) % block }, (_, i) => i + 1));
  record = Buffer.concat([record, padding]);
  let kdfOptions = Buffer.alloc(0);
  if (encrypted) {
    const salt = randomBytes(16);
    kdfOptions = Buffer.concat([sshString(salt), uint32(KDF_ROUNDS)]);
    const { key: aes, iv } = deriveKey(passphrase, salt, KDF_ROUNDS);
    const encipher = createCipheriv('aes-256-ctr', aes, iv);
    record = Buffer.concat([encipher.update(record), encipher.final()]);
  }
  const data = Buffer.concat([
    Buffer.from(MAGIC, 'latin1'),
    sshString(encrypted ? CIPHER : 'none'),
    sshString(encrypted ? 'bcrypt' : 'none'),
    sshString(kdfOptions),
    uint32(1),
    sshString(skPublicBlob(key)),
    sshString(record),
  ]);
  const lines = data.toString('base64').match(/.{1,70}/g) ?? [];
  return ['-----BEGIN OPENSSH PRIVATE KEY-----', ...lines, '-----END OPENSSH PRIVATE KEY-----', ''].join('\n');
}

/** An SSH mpint of the unsigned big-endian `bytes`. */
export const mpint = (bytes: Buffer): Buffer => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return sshString(((trimmed[0] ?? 0) & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed);
};

/** The r and s of a DER ECDSA signature (a SEQUENCE of two INTEGERs). */
export function derToRs(der: Buffer): { r: Buffer; s: Buffer } {
  const fail = (): SshModelError =>
    new SshModelError('ssh-key-invalid', 'The security key returned a malformed signature');
  let pos = 0;
  const length = (): number => {
    const first = der[pos++];
    if (first === undefined) throw fail();
    if (first < 0x80) return first;
    let value = 0;
    for (let i = 0; i < (first & 0x7f); i++) value = (value << 8) | (der[pos++] ?? 0);
    return value;
  };
  const integer = (): Buffer => {
    if (der[pos++] !== 0x02) throw fail();
    const size = length();
    const value = der.subarray(pos, pos + size);
    if (value.length !== size) throw fail();
    pos += size;
    return value;
  };
  if (der[pos++] !== 0x30) throw fail();
  length();
  return { r: integer(), s: integer() };
}

/**
 * The signature blob a server checks for an sk key (PROTOCOL.u2f): the algorithm, the authenticator's
 * signature in SSH form, then the flags and counter from its authenticator data.
 *
 * @param signature Ed25519: the raw 64 bytes; ECDSA: the DER encoding an authenticator returns
 */
export function skSignatureBlob(keyType: SkKeyType, signature: Buffer, flags: number, counter: number): Buffer {
  let inner: Buffer;
  if (keyType === SK_ED25519) {
    inner = signature;
  } else {
    const { r, s } = derToRs(signature);
    inner = Buffer.concat([mpint(r), mpint(s)]);
  }
  return Buffer.concat([sshString(keyType), sshString(inner), Buffer.from([flags]), uint32(counter)]);
}
