import { createPublicKey } from 'node:crypto';
import { SshModelError } from './errors.js';
import { SshReader, sshString } from './sk-key.js';

/**
 * Device keys (#428): SSH keys made and kept by this machine's secure hardware, the Secure Enclave on macOS or
 * Windows Hello. The secret a host's `auth.key` names holds a block with the public key and a handle that only
 * that hardware can sign with; nothing here ever holds a private key. Reaching the hardware is the desktop's
 * job, through a {@link DeviceKeySigner} it hands to dial.
 */

export type DevicePlatform = 'macos-secure-enclave' | 'windows-hello';
export const DEVICE_PLATFORMS: readonly DevicePlatform[] = ['macos-secure-enclave', 'windows-hello'];

export const ECDSA_P256 = 'ecdsa-sha2-nistp256';
export const SSH_RSA = 'ssh-rsa';
/** The RSA signature algorithm a Windows Hello key signs with: PKCS#1 v1.5 over SHA-256. */
export const RSA_SHA2_256 = 'rsa-sha2-256';

/** The one key type each platform makes. */
export const DEVICE_KEY_TYPE: Readonly<Record<DevicePlatform, string>> = {
  'macos-secure-enclave': ECDSA_P256,
  'windows-hello': SSH_RSA,
};

export interface DeviceKey {
  readonly platform: DevicePlatform;
  /** The host name it was made on; for messages only. */
  readonly device: string;
  /** Its `authorized_keys` line: type, base64 blob and the comment if there is one. */
  readonly publicKey: string;
  /** What the hardware signs with: a wrapped key (macOS) or a credential name (Windows). */
  readonly handle: string;
}

export interface ParsedDeviceKey extends DeviceKey {
  readonly keyType: string;
  readonly publicBlob: Buffer;
}

/**
 * Signs with a device key. The answer is the raw signature: P-256 r‖s (64 bytes), or an RSA PKCS#1 v1.5
 * SHA-256 signature. `reason` is what the OS prompt says.
 *
 * @throws SshModelError `ssh-device-key-missing` (this hardware cannot open the handle) |
 *   `ssh-device-key-cancelled` (the person dismissed the prompt) | `ssh-device-key-unavailable`
 */
export interface DeviceKeySigner {
  sign(key: ParsedDeviceKey, data: Buffer, reason: string): Promise<Buffer>;
}

let processSigner: DeviceKeySigner | undefined;

/**
 * Sets the signer every dial in this process uses when its options name none: the desktop sets it once at
 * start-up, so every connect (terminal, files, forwards, key install) reaches the hardware the same way. The
 * CLI never does, so a device key there is `ssh-device-key-unavailable`.
 */
export function setDeviceKeySigner(signer: DeviceKeySigner | undefined): void {
  processSigner = signer;
}

/** The signer {@link setDeviceKeySigner} set, if any. */
export const defaultDeviceKeySigner = (): DeviceKeySigner | undefined => processSigner;

const BEGIN = '-----BEGIN WIREBENCH DEVICE KEY-----';
const END = '-----END WIREBENCH DEVICE KEY-----';
const BLOCK = /^-----BEGIN WIREBENCH DEVICE KEY-----\r?\n([\s\S]+?)\r?\n-----END WIREBENCH DEVICE KEY-----$/;

const invalid = (message = 'This is not a device key Wirebench can read'): SshModelError =>
  new SshModelError('ssh-key-invalid', message);

/** True when `text` is a device key block (read without checking its contents). */
export function isDeviceKeySecret(text: string): boolean {
  return BLOCK.test(text.trim());
}

/** The block a device key is stored as. */
export function encodeDeviceKey(key: DeviceKey): string {
  const json = JSON.stringify({
    v: 1,
    platform: key.platform,
    device: key.device,
    publicKey: key.publicKey,
    handle: key.handle,
  });
  const body = Buffer.from(json, 'utf8').toString('base64');
  return [BEGIN, ...(body.match(/.{1,64}/g) ?? []), END].join('\n');
}

/**
 * Reads a device key block; undefined when `text` is not one.
 *
 * @throws SshModelError `ssh-key-invalid` for a block that is malformed, of a later version or of an unknown
 *   platform, or whose public key is not the type its platform makes
 */
export function parseDeviceKey(text: string): ParsedDeviceKey | undefined {
  const match = BLOCK.exec(text.trim());
  if (!match) return undefined;
  let fields: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(Buffer.from((match[1] ?? '').replace(/\s+/g, ''), 'base64').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw invalid();
    fields = parsed as Record<string, unknown>;
  } catch {
    throw invalid();
  }
  if (fields['v'] !== 1) throw invalid('This device key was made by a later Wirebench');
  const { platform, device, publicKey, handle } = fields;
  if (typeof platform !== 'string' || !(DEVICE_PLATFORMS as readonly string[]).includes(platform)) {
    throw invalid('This device key is for a kind of device Wirebench does not know');
  }
  if (typeof device !== 'string' || typeof publicKey !== 'string' || typeof handle !== 'string' || handle === '') {
    throw invalid();
  }
  const line = /^([a-z0-9@.-]+) ([A-Za-z0-9+/]+={0,2})(?: ([^\r\n]*))?$/.exec(publicKey.trim());
  if (!line) throw invalid();
  const keyType = line[1] ?? '';
  const publicBlob = Buffer.from(line[2] ?? '', 'base64');
  let declared: string;
  try {
    declared = new SshReader(publicBlob).text();
  } catch {
    throw invalid();
  }
  if (keyType !== DEVICE_KEY_TYPE[platform as DevicePlatform] || declared !== keyType) throw invalid();
  return { platform: platform as DevicePlatform, device, publicKey: publicKey.trim(), handle, keyType, publicBlob };
}

/** An SSH mpint: big-endian, no leading zero bytes, and one zero byte first when the top bit is set. */
function mpint(bytes: Buffer): Buffer {
  let start = 0;
  while (start < bytes.length && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  const signed = trimmed.length > 0 && ((trimmed[0] as number) & 0x80) !== 0;
  return sshString(signed ? Buffer.concat([Buffer.of(0), trimmed]) : trimmed);
}

const unreadablePublicKey = (): SshModelError => invalid('The device answered a public key Wirebench cannot read');

/** The `ecdsa-sha2-nistp256` public blob of an uncompressed P-256 point (X9.63, 65 bytes). */
export function ecdsaP256Blob(point: Buffer): Buffer {
  if (point.length !== 65 || point[0] !== 4) throw unreadablePublicKey();
  return Buffer.concat([sshString(ECDSA_P256), sshString('nistp256'), sshString(point)]);
}

/** The `ssh-rsa` public blob of an RSA X.509 SubjectPublicKeyInfo (DER). */
export function sshRsaBlobFromSpki(der: Buffer): Buffer {
  let jwk: { kty?: string; n?: string; e?: string };
  try {
    jwk = createPublicKey({ key: der, format: 'der', type: 'spki' }).export({ format: 'jwk' });
  } catch {
    throw unreadablePublicKey();
  }
  if (jwk.kty !== 'RSA' || jwk.n === undefined || jwk.e === undefined) throw unreadablePublicKey();
  return Buffer.concat([
    sshString(SSH_RSA),
    mpint(Buffer.from(jwk.e, 'base64url')),
    mpint(Buffer.from(jwk.n, 'base64url')),
  ]);
}

/** One `authorized_keys` line for a public blob. */
export function publicKeyLine(blob: Buffer, comment: string): string {
  const line = `${new SshReader(blob).text()} ${blob.toString('base64')}`;
  return comment === '' ? line : `${line} ${comment}`;
}

/** The signature algorithm a device key signs in with. */
export const deviceSignatureAlgorithm = (key: ParsedDeviceKey): string =>
  key.keyType === SSH_RSA ? RSA_SHA2_256 : key.keyType;

/**
 * The SSH signature blob for a raw device signature: `ecdsa-sha2-nistp256` with r and s as mpints, or
 * `rsa-sha2-256` with the PKCS#1 signature as it is.
 *
 * @throws SshModelError `ssh-key-invalid` for a P-256 signature that is not 64 bytes
 */
export function deviceSignatureBlob(key: ParsedDeviceKey, raw: Buffer): Buffer {
  if (key.keyType === SSH_RSA) return Buffer.concat([sshString(RSA_SHA2_256), sshString(raw)]);
  if (raw.length !== 64) throw invalid('The device answered a signature Wirebench cannot read');
  return Buffer.concat([
    sshString(ECDSA_P256),
    sshString(Buffer.concat([mpint(raw.subarray(0, 32)), mpint(raw.subarray(32))])),
  ]);
}
