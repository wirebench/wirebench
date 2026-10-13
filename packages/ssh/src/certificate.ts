import { SshModelError } from './errors.js';
import { fingerprintOf } from './known-hosts.js';
import type { SshKeyInfo } from './keygen.js';

/**
 * OpenSSH certificates (`PROTOCOL.certkeys`): a public key, signed by a CA, with the names it may sign in as
 * and a validity window. Only read here, never checked against the CA: the server does that.
 */
export interface SshCertificate {
  /** `ssh-ed25519-cert-v01@openssh.com`, … */
  readonly certType: string;
  /** The certified key's own type: `ssh-ed25519`, `ecdsa-sha2-nistp256`, `ssh-rsa`. */
  readonly keyType: string;
  readonly kind: 'user' | 'host';
  readonly keyId: string;
  /** A uint64, in decimal. */
  readonly serial: string;
  /** Empty: valid for any principal. */
  readonly principals: readonly string[];
  /** Milliseconds since the epoch; null for no bound ("always" / "forever"). */
  readonly validAfter: number | null;
  readonly validBefore: number | null;
  readonly criticalOptions: readonly string[];
  readonly extensions: readonly string[];
  readonly caKeyType: string;
  readonly caFingerprint: string;
  /** The certified key's fingerprint, as `ssh-keygen -l` prints it for the plain key. */
  readonly publicKeyFingerprint: string;
  /** The whole certificate, as sent to the server. */
  readonly blob: Buffer;
  /** The certificate as one line: type, base64 blob and the comment if there is one. */
  readonly line: string;
}

export type CertificateValidity = 'valid' | 'not-yet-valid' | 'expired';

const CERT_SUFFIX = '-cert-v01@openssh.com';

/** How many fields after the nonce make up each base type's public key, in the order of its plain blob. */
const KEY_FIELDS: Readonly<Record<string, number>> = {
  'ssh-ed25519': 1,
  'ssh-rsa': 2,
  'ecdsa-sha2-nistp256': 2,
  'ecdsa-sha2-nistp384': 2,
  'ecdsa-sha2-nistp521': 2,
};

const LINE = /^([a-z0-9@.-]+) ([A-Za-z0-9+/]+={0,2})(?: ([^\r\n]*))?$/;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

const invalid = (): SshModelError => new SshModelError('ssh-cert-invalid', 'This is not an OpenSSH certificate');

/** Reads SSH wire fields; every read past the end is the `ssh-cert-invalid` refusal. */
class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) throw invalid();
  }
  uint32(): number {
    this.need(4);
    const value = this.buf.readUInt32BE(this.pos);
    this.pos += 4;
    return value;
  }
  uint64(): bigint {
    this.need(8);
    const value = this.buf.readBigUInt64BE(this.pos);
    this.pos += 8;
    return value;
  }
  bytes(): Buffer {
    const length = this.uint32();
    this.need(length);
    const value = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  }
  /** What was read from `start` on, length prefixes included. */
  since(start: number): Buffer {
    return this.buf.subarray(start, this.pos);
  }
  get offset(): number {
    return this.pos;
  }
  get done(): boolean {
    return this.pos === this.buf.length;
  }
}

/** The names in a packed list of strings (principals) or of name/data pairs (options, extensions). */
function names(packed: Buffer, pairs: boolean): string[] {
  const reader = new Reader(packed);
  const out: string[] = [];
  while (!reader.done) {
    out.push(reader.bytes().toString('utf8'));
    if (pairs) reader.bytes();
  }
  return out;
}

const sshString = (value: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(value.length);
  return Buffer.concat([length, value]);
};

const timeOf = (seconds: bigint, open: bigint): number | null => (seconds === open ? null : Number(seconds) * 1000);

/** True when `text` reads as one OpenSSH certificate line (the blob is not checked). */
export function looksLikeCertificate(text: string): boolean {
  return LINE.exec(text.trim())?.[1]?.endsWith(CERT_SUFFIX) === true;
}

/**
 * Reads one certificate line, as `ssh-keygen -s` writes it to `<key>-cert.pub`. No message repeats the input.
 *
 * @throws SshModelError `ssh-cert-invalid` when `text` is not a certificate of a key type Wirebench signs with
 */
export function parseCertificate(text: string): SshCertificate {
  const line = text.trim();
  const match = LINE.exec(line);
  const certType = match?.[1] ?? '';
  if (!match || !certType.endsWith(CERT_SUFFIX)) throw invalid();
  const keyType = certType.slice(0, -CERT_SUFFIX.length);
  const fields = KEY_FIELDS[keyType];
  if (fields === undefined) throw invalid();
  const blob = Buffer.from(match[2] ?? '', 'base64');
  const reader = new Reader(blob);
  if (reader.bytes().toString('ascii') !== certType) throw invalid();
  reader.bytes(); // nonce
  const keyStart = reader.offset;
  for (let i = 0; i < fields; i++) reader.bytes();
  const publicKey = Buffer.concat([sshString(Buffer.from(keyType, 'ascii')), reader.since(keyStart)]);
  const serial = reader.uint64();
  const type = reader.uint32();
  if (type !== 1 && type !== 2) throw invalid();
  const keyId = reader.bytes().toString('utf8');
  const principals = names(reader.bytes(), false);
  const validAfter = reader.uint64();
  const validBefore = reader.uint64();
  const criticalOptions = names(reader.bytes(), true);
  const extensions = names(reader.bytes(), true);
  reader.bytes(); // reserved
  const caKey = reader.bytes();
  reader.bytes(); // the CA's signature
  if (!reader.done) throw invalid();
  return {
    certType,
    keyType,
    kind: type === 1 ? 'user' : 'host',
    keyId,
    serial: serial.toString(),
    principals,
    validAfter: timeOf(validAfter, 0n),
    validBefore: timeOf(validBefore, UINT64_MAX),
    criticalOptions,
    extensions,
    caKeyType: new Reader(caKey).bytes().toString('ascii'),
    caFingerprint: fingerprintOf(caKey),
    publicKeyFingerprint: fingerprintOf(publicKey),
    blob,
    line,
  };
}

/** Where `now` (milliseconds) falls: both bounds are inclusive, as OpenSSH checks them. */
export function certificateValidity(
  cert: Pick<SshCertificate, 'validAfter' | 'validBefore'>,
  now: number,
): CertificateValidity {
  if (cert.validAfter !== null && now < cert.validAfter) return 'not-yet-valid';
  if (cert.validBefore !== null && now > cert.validBefore) return 'expired';
  return 'valid';
}

const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

/** The validity window in words: `from … UTC to … UTC`, `always valid`, … */
export function formatValidity(cert: Pick<SshCertificate, 'validAfter' | 'validBefore'>): string {
  const { validAfter, validBefore } = cert;
  if (validAfter === null && validBefore === null) return 'always valid';
  if (validAfter === null) return `until ${utc(validBefore as number)}`;
  if (validBefore === null) return `from ${utc(validAfter)}, no expiry`;
  return `from ${utc(validAfter)} to ${utc(validBefore)}`;
}

/** True when `cert` certifies the key `key` describes. */
export function certificateMatchesKey(cert: Pick<SshCertificate, 'publicKeyFingerprint'>, key: SshKeyInfo): boolean {
  return cert.publicKeyFingerprint === key.fingerprint;
}
