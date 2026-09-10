/**
 * NTLM (MS-NLMP) message codec: the Type 1 (NEGOTIATE), Type 2 (CHALLENGE) and
 * Type 3 (AUTHENTICATE) messages plus the NTLMv2/LMv2 response computation, as a
 * pure byte-level module. The connection choreography lives in `ntlm-transport.ts`.
 *
 * Only NTLMv2 with extended session security is produced; no session key exchange,
 * signing or sealing, none of which HTTP needs. No MIC is emitted (it is optional
 * for a client that negotiates no key exchange).
 */

import { createHmac } from 'node:crypto';
import { md4 } from './md4.js';

const SIGNATURE = 'NTLMSSP\0';
const SIGNATURE_BYTES = new Uint8Array(Buffer.from(SIGNATURE, 'ascii'));

/** NTLM negotiate flags (MS-NLMP §2.2.2.5) this codec cares about. */
export const NTLM_FLAGS = {
  NEGOTIATE_UNICODE: 0x00000001,
  NEGOTIATE_OEM: 0x00000002,
  REQUEST_TARGET: 0x00000004,
  NEGOTIATE_NTLM: 0x00000200,
  NEGOTIATE_OEM_DOMAIN_SUPPLIED: 0x00001000,
  NEGOTIATE_OEM_WORKSTATION_SUPPLIED: 0x00002000,
  NEGOTIATE_ALWAYS_SIGN: 0x00008000,
  NEGOTIATE_EXTENDED_SESSIONSECURITY: 0x00080000,
  NEGOTIATE_TARGET_INFO: 0x00800000,
  NEGOTIATE_VERSION: 0x02000000,
  NEGOTIATE_128: 0x20000000,
  NEGOTIATE_56: 0x80000000,
} as const;

/**
 * The flag set every Wirebench Type 1/Type 3 message carries: Unicode names, NTLM with
 * extended session security (NTLMv2), target info, a version block, and 128/56-bit key
 * strengths. Deliberately *without* `NEGOTIATE_SIGN`/`SEAL`/`KEY_EXCH` — HTTP carries no
 * signed or sealed payloads, so advertising them would only invite a server to expect one.
 */
export const DEFAULT_NEGOTIATE_FLAGS =
  (NTLM_FLAGS.NEGOTIATE_UNICODE |
    NTLM_FLAGS.REQUEST_TARGET |
    NTLM_FLAGS.NEGOTIATE_NTLM |
    NTLM_FLAGS.NEGOTIATE_ALWAYS_SIGN |
    NTLM_FLAGS.NEGOTIATE_EXTENDED_SESSIONSECURITY |
    NTLM_FLAGS.NEGOTIATE_TARGET_INFO |
    NTLM_FLAGS.NEGOTIATE_VERSION |
    NTLM_FLAGS.NEGOTIATE_128 |
    NTLM_FLAGS.NEGOTIATE_56) >>>
  0;

/** AV pair identifiers (MS-NLMP §2.2.2.1). */
export const AV_IDS = {
  MsvAvEOL: 0x0000,
  MsvAvNbComputerName: 0x0001,
  MsvAvNbDomainName: 0x0002,
  MsvAvDnsComputerName: 0x0003,
  MsvAvDnsDomainName: 0x0004,
  MsvAvTimestamp: 0x0007,
  MsvAvFlags: 0x0006,
} as const;

/**
 * The `Version` block (MS-NLMP §2.2.2.10): Windows 6.1 build 7601, NTLMSSP revision 15.
 * Purely cosmetic — servers log it, none of them gate on it.
 */
const VERSION_BLOCK = new Uint8Array([0x06, 0x01, 0xb1, 0x1d, 0x00, 0x00, 0x00, 0x0f]);

/** 100-nanosecond intervals between the Windows FILETIME epoch (1601-01-01) and the Unix epoch. */
const FILETIME_EPOCH_OFFSET = 11_644_473_600_000n;

/** Converts a Unix millisecond timestamp to a Windows FILETIME (100 ns ticks since 1601). */
export function toFileTime(unixMillis: number): bigint {
  return (BigInt(Math.floor(unixMillis)) + FILETIME_EPOCH_OFFSET) * 10_000n;
}

function utf16le(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'utf16le'));
}

function oem(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'latin1'));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function hmacMd5(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('md5', key).update(data).digest());
}

/** Reads a `(Len, MaxLen, BufferOffset)` field descriptor and returns the payload slice it points at. */
function readField(bytes: Uint8Array, view: DataView, at: number): Uint8Array {
  const length = view.getUint16(at, true);
  const offset = view.getUint32(at + 4, true);
  if (length === 0 || offset + length > bytes.length) {
    return new Uint8Array(0);
  }
  return bytes.slice(offset, offset + length);
}

/** Writes a `(Len, MaxLen, BufferOffset)` field descriptor at `at`. */
function writeField(view: DataView, at: number, length: number, offset: number): void {
  view.setUint16(at, length, true);
  view.setUint16(at + 2, length, true);
  view.setUint32(at + 4, offset, true);
}

function hasSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  return SIGNATURE_BYTES.every((byte, index) => bytes[index] === byte);
}

/** Options for {@link createType1}. */
export interface Type1Options {
  /** Override the negotiate flags; defaults to {@link DEFAULT_NEGOTIATE_FLAGS}. */
  readonly flags?: number;
  /** Optional NetBIOS domain to advertise (OEM-encoded, as the Type 1 message requires). */
  readonly domain?: string;
  /** Optional NetBIOS workstation name to advertise (OEM-encoded). */
  readonly workstation?: string;
}

/**
 * Builds a Type 1 NEGOTIATE message.
 *
 * @param options negotiate flags plus the optional domain/workstation to advertise
 * @returns the raw message bytes, ready for {@link encodeNtlmAuthorization}
 */
export function createType1(options?: Type1Options): Uint8Array {
  const domain = options?.domain !== undefined && options.domain !== '' ? oem(options.domain.toUpperCase()) : undefined;
  const workstation =
    options?.workstation !== undefined && options.workstation !== ''
      ? oem(options.workstation.toUpperCase())
      : undefined;
  let flags = options?.flags ?? DEFAULT_NEGOTIATE_FLAGS;
  if (domain !== undefined) flags = (flags | NTLM_FLAGS.NEGOTIATE_OEM_DOMAIN_SUPPLIED) >>> 0;
  if (workstation !== undefined) flags = (flags | NTLM_FLAGS.NEGOTIATE_OEM_WORKSTATION_SUPPLIED) >>> 0;

  // 8 signature + 4 type + 8 domain field + 8 workstation field + 4 flags + 8 version.
  const headerLength = 40;
  const payload = concat([domain ?? new Uint8Array(0), workstation ?? new Uint8Array(0)]);
  const message = new Uint8Array(headerLength + payload.length);
  message.set(SIGNATURE_BYTES, 0);
  const view = new DataView(message.buffer);
  view.setUint32(8, 1, true);
  view.setUint32(12, flags, true);
  writeField(view, 16, domain?.length ?? 0, headerLength);
  writeField(view, 24, workstation?.length ?? 0, headerLength + (domain?.length ?? 0));
  message.set(VERSION_BLOCK, 32);
  message.set(payload, headerLength);
  return message;
}

/** A decoded Type 2 CHALLENGE message. */
export interface Type2Message {
  readonly flags: number;
  /** The 8-byte server challenge. */
  readonly serverChallenge: Uint8Array;
  /** The target name, decoded as UTF-16LE or OEM depending on the negotiated flags. */
  readonly targetName: string;
  /** The raw AV-pair block, copied verbatim into the NTLMv2 blob. */
  readonly targetInfo: Uint8Array;
  /** The 8-byte version block, when the server sent one. */
  readonly version?: Uint8Array;
}

/**
 * Parses a Type 2 CHALLENGE message.
 *
 * @param bytes the raw message (already base64-decoded)
 * @throws Error when the signature or message type is not a Type 2 message
 */
export function parseType2(bytes: Uint8Array): Type2Message {
  if (!hasSignature(bytes) || bytes.length < 32) {
    throw new Error('not an NTLM message');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== 2) {
    throw new Error('not an NTLM Type 2 message');
  }
  const flags = view.getUint32(20, true);
  const targetNameBytes = readField(bytes, view, 12);
  const targetInfo = bytes.length >= 48 ? readField(bytes, view, 40) : new Uint8Array(0);
  const version = bytes.length >= 56 ? bytes.slice(48, 56) : undefined;
  return {
    flags,
    serverChallenge: bytes.slice(24, 32),
    targetName: Buffer.from(targetNameBytes).toString(
      (flags & NTLM_FLAGS.NEGOTIATE_UNICODE) !== 0 ? 'utf16le' : 'latin1',
    ),
    targetInfo,
    ...(version !== undefined ? { version } : {}),
  };
}

/**
 * `NTOWFv2` (MS-NLMP §3.3.2): `HMAC_MD5(MD4(UTF16LE(password)), UTF16LE(UPPER(user) + domain))`.
 * The domain keeps its case; only the user name is upper-cased.
 *
 * @param username the account name
 * @param domain the domain (empty string when there is none)
 * @param password the plaintext password — never logged, never stored by this module
 */
export function ntowfv2(username: string, domain: string, password: string): Uint8Array {
  const ntHash = md4(utf16le(password));
  return hmacMd5(ntHash, utf16le(username.toUpperCase() + domain));
}

/**
 * Builds the NTLMv2 `temp` blob: version bytes, the timestamp, the client challenge and the
 * server's AV pairs. Exported so a verifier can rebuild the exact blob it received.
 */
export function ntlmv2Blob(params: {
  readonly timestamp: bigint;
  readonly clientChallenge: Uint8Array;
  readonly targetInfo: Uint8Array;
}): Uint8Array {
  const head = new Uint8Array(28);
  const view = new DataView(head.buffer);
  head[0] = 1; // Responserversion
  head[1] = 1; // HiResponserversion
  view.setBigUint64(8, params.timestamp, true);
  head.set(params.clientChallenge, 16);
  return concat([head, params.targetInfo, new Uint8Array(4)]);
}

/**
 * `NTProofStr` (MS-NLMP §3.3.2): `HMAC_MD5(NTOWFv2, serverChallenge || temp)`.
 *
 * @param responseKeyNt the `NTOWFv2` for the account
 * @param serverChallenge the 8-byte challenge from the Type 2 message
 * @param blob the `temp` blob from {@link ntlmv2Blob}
 */
export function ntProofString(responseKeyNt: Uint8Array, serverChallenge: Uint8Array, blob: Uint8Array): Uint8Array {
  return hmacMd5(responseKeyNt, concat([serverChallenge, blob]));
}

/**
 * The LMv2 response: `HMAC_MD5(NTOWFv2, serverChallenge || clientChallenge) || clientChallenge`.
 */
export function lmv2Response(
  responseKeyNt: Uint8Array,
  serverChallenge: Uint8Array,
  clientChallenge: Uint8Array,
): Uint8Array {
  return concat([hmacMd5(responseKeyNt, concat([serverChallenge, clientChallenge])), clientChallenge]);
}

/** Appends an `MsvAvFlags` AV pair to a target-info block whose `MsvAvEOL` terminator is replaced. */
function withAvPairs(targetInfo: Uint8Array, extra: readonly { readonly id: number; readonly value: Uint8Array }[]) {
  // Strip the trailing EOL pair (id 0, len 0) so the extra pairs land before it.
  let end = targetInfo.length;
  if (end >= 4 && targetInfo[end - 4] === 0 && targetInfo[end - 3] === 0) {
    end -= 4;
  }
  const parts: Uint8Array[] = [targetInfo.slice(0, end)];
  for (const pair of extra) {
    const header = new Uint8Array(4);
    const view = new DataView(header.buffer);
    view.setUint16(0, pair.id, true);
    view.setUint16(2, pair.value.length, true);
    parts.push(header, pair.value);
  }
  parts.push(new Uint8Array(4)); // MsvAvEOL
  return concat(parts);
}

/** Reads an AV-pair block into a list of `{id, value}` entries, stopping at `MsvAvEOL`. */
export function parseAvPairs(bytes: Uint8Array): readonly { readonly id: number; readonly value: Uint8Array }[] {
  const pairs: { id: number; value: Uint8Array }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const id = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    if (id === AV_IDS.MsvAvEOL) break;
    if (offset + 4 + length > bytes.length) break;
    pairs.push({ id, value: bytes.slice(offset + 4, offset + 4 + length) });
    offset += 4 + length;
  }
  return pairs;
}

/** Builds an AV-pair block from `{id, value}` entries, terminated with `MsvAvEOL`. */
export function buildAvPairs(pairs: readonly { readonly id: number; readonly value: Uint8Array }[]): Uint8Array {
  return withAvPairs(new Uint8Array(4), pairs);
}

/** Inputs for {@link createType3}. */
export interface Type3Params {
  readonly username: string;
  readonly password: string;
  readonly domain?: string;
  readonly workstation?: string;
  readonly type2: Type2Message;
  /** The 8-byte client challenge; injected in tests, random in production. */
  readonly clientChallenge: Uint8Array;
  /** The timestamp as a Windows FILETIME; injected in tests, `toFileTime(Date.now())` otherwise. */
  readonly timestamp: bigint;
}

/** The Type 3 message plus the intermediate values a test (or a verifier) wants to assert on. */
export interface Type3Result {
  readonly message: Uint8Array;
  readonly ntProofStr: Uint8Array;
  readonly ntChallengeResponse: Uint8Array;
  readonly lmChallengeResponse: Uint8Array;
  readonly responseKeyNt: Uint8Array;
}

/**
 * Builds a Type 3 AUTHENTICATE message answering `params.type2`, computing the NTLMv2 and
 * LMv2 responses. The server's target info is carried through verbatim (with an
 * `MsvAvTimestamp` added when the server sent none, and `MsvAvFlags` = 0 to state
 * explicitly that no MIC follows).
 *
 * The password is used only to derive `NTOWFv2` and never appears in the message.
 *
 * @param params the credentials, the parsed challenge and the injectable nonce/clock
 */
export function createType3(params: Type3Params): Type3Result {
  const domain = params.domain ?? '';
  const workstation = params.workstation ?? '';
  const responseKeyNt = ntowfv2(params.username, domain, params.password);

  const serverPairs = parseAvPairs(params.type2.targetInfo);
  const hasTimestamp = serverPairs.some((pair) => pair.id === AV_IDS.MsvAvTimestamp);
  const timestampBytes = new Uint8Array(8);
  new DataView(timestampBytes.buffer).setBigUint64(0, params.timestamp, true);
  const extra: { id: number; value: Uint8Array }[] = [];
  if (!hasTimestamp) extra.push({ id: AV_IDS.MsvAvTimestamp, value: timestampBytes });
  // MsvAvFlags = 0: no MIC is present. (Bit 0x02 would claim one, which we do not send.)
  extra.push({ id: AV_IDS.MsvAvFlags, value: new Uint8Array(4) });
  const targetInfo = extra.length > 0 ? withAvPairs(params.type2.targetInfo, extra) : params.type2.targetInfo;

  const blob = ntlmv2Blob({ timestamp: params.timestamp, clientChallenge: params.clientChallenge, targetInfo });
  const ntProofStr = ntProofString(responseKeyNt, params.type2.serverChallenge, blob);
  const ntChallengeResponse = concat([ntProofStr, blob]);
  const lmChallengeResponse = lmv2Response(responseKeyNt, params.type2.serverChallenge, params.clientChallenge);

  const domainBytes = utf16le(domain);
  const userBytes = utf16le(params.username);
  const workstationBytes = utf16le(workstation);
  // 8 signature + 4 type + 6 * 8 field descriptors + 4 flags + 8 version. No MIC.
  const headerLength = 72;
  const parts = [lmChallengeResponse, ntChallengeResponse, domainBytes, userBytes, workstationBytes];
  const message = new Uint8Array(headerLength + parts.reduce((sum, part) => sum + part.length, 0));
  message.set(SIGNATURE_BYTES, 0);
  const view = new DataView(message.buffer);
  view.setUint32(8, 3, true);
  let offset = headerLength;
  for (const [index, part] of parts.entries()) {
    writeField(view, 12 + index * 8, part.length, offset);
    message.set(part, offset);
    offset += part.length;
  }
  // EncryptedRandomSessionKey: empty, since no key exchange is negotiated.
  writeField(view, 52, 0, offset);
  view.setUint32(60, DEFAULT_NEGOTIATE_FLAGS, true);
  message.set(VERSION_BLOCK, 64);

  return { message, ntProofStr, ntChallengeResponse, lmChallengeResponse, responseKeyNt };
}

/** A decoded Type 3 AUTHENTICATE message, as a server verifier sees it. */
export interface Type3Message {
  readonly flags: number;
  readonly domain: string;
  readonly username: string;
  readonly workstation: string;
  readonly lmChallengeResponse: Uint8Array;
  readonly ntChallengeResponse: Uint8Array;
}

/**
 * Parses a Type 3 AUTHENTICATE message. Used by the test NTLM server to verify a client's
 * response independently of {@link createType3}.
 *
 * @param bytes the raw message (already base64-decoded)
 * @throws Error when the signature or message type is not a Type 3 message
 */
export function parseType3(bytes: Uint8Array): Type3Message {
  if (!hasSignature(bytes) || bytes.length < 64) {
    throw new Error('not an NTLM message');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== 3) {
    throw new Error('not an NTLM Type 3 message');
  }
  const flags = view.getUint32(60, true);
  const decode = (field: Uint8Array): string =>
    Buffer.from(field).toString((flags & NTLM_FLAGS.NEGOTIATE_UNICODE) !== 0 ? 'utf16le' : 'latin1');
  return {
    flags,
    lmChallengeResponse: readField(bytes, view, 12),
    ntChallengeResponse: readField(bytes, view, 20),
    domain: decode(readField(bytes, view, 28)),
    username: decode(readField(bytes, view, 36)),
    workstation: decode(readField(bytes, view, 44)),
  };
}

/**
 * Formats a message as an `Authorization`/`WWW-Authenticate` value: `NTLM <base64>`.
 * Wirebench always answers with the `NTLM` scheme, even when the server advertised
 * `Negotiate` — every server that offers raw NTLMSSP under `Negotiate` accepts it.
 */
export function encodeNtlmAuthorization(message: Uint8Array): string {
  return `NTLM ${Buffer.from(message).toString('base64')}`;
}

/**
 * Extracts an NTLMSSP message from a `WWW-Authenticate` header value. Accepts both
 * `NTLM <base64>` and `Negotiate <base64>` (only when the payload really is NTLMSSP,
 * not a Kerberos/SPNEGO token), and tolerates several challenges in one header.
 *
 * @param header the raw header value, or `undefined` when the response had none
 * @returns the decoded message bytes, or `undefined` when there is no usable NTLM challenge
 */
export function parseNtlmChallengeHeader(header: string | undefined): Uint8Array | undefined {
  if (header === undefined) return undefined;
  for (const part of header.split(',')) {
    const match = /^\s*(NTLM|Negotiate)(?:\s+([A-Za-z0-9+/=]+))?\s*$/i.exec(part);
    const token = match?.[2];
    if (token === undefined || token === '') continue;
    let decoded: Uint8Array;
    try {
      decoded = new Uint8Array(Buffer.from(token, 'base64'));
    } catch {
      continue;
    }
    if (hasSignature(decoded)) return decoded;
  }
  return undefined;
}

/**
 * True when `header` offers an NTLM (or NTLMSSP-over-Negotiate) challenge at all, including
 * the bare `WWW-Authenticate: NTLM` that starts a handshake.
 */
export function offersNtlm(header: string | undefined): boolean {
  if (header === undefined) return false;
  return header.split(',').some((part) => /^\s*(NTLM|Negotiate)(\s|$)/i.test(part));
}
