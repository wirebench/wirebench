import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { asCborMap, cborBytes, cborNumber, decodeCbor, decodeCborPrefix, encodeCbor } from './cbor.js';
import type { CborMap, CborValue } from './cbor.js';
import type { CborCallOptions, CtapHid } from './ctaphid.js';

/**
 * The CTAP2 commands an SSH security key needs (CTAP 2.1 §6): getInfo, makeCredential, getAssertion and
 * the clientPIN subcommands that turn a PIN into a token, with PIN/UV auth protocols 1 and 2.
 */

export const CMD_MAKE_CREDENTIAL = 0x01;
export const CMD_GET_ASSERTION = 0x02;
export const CMD_GET_INFO = 0x04;
export const CMD_CLIENT_PIN = 0x06;

export const PIN_GET_RETRIES = 0x01;
export const PIN_GET_KEY_AGREEMENT = 0x02;
export const PIN_GET_TOKEN = 0x05;

/** COSE algorithm ids. */
export const COSE_EDDSA = -8;
export const COSE_ES256 = -7;
const COSE_ECDH_ES_HKDF_256 = -25;

/** CTAP2 status codes the callers tell apart. */
export const CTAP2_ERR = {
  INVALID_CBOR: 0x12,
  INVALID_CREDENTIAL: 0x22,
  UNSUPPORTED_ALGORITHM: 0x26,
  OPERATION_DENIED: 0x27,
  KEEPALIVE_CANCEL: 0x2d,
  NO_CREDENTIALS: 0x2e,
  USER_ACTION_TIMEOUT: 0x2f,
  PIN_INVALID: 0x31,
  PIN_BLOCKED: 0x32,
  PIN_AUTH_INVALID: 0x33,
  PIN_AUTH_BLOCKED: 0x34,
  PIN_NOT_SET: 0x35,
  PIN_REQUIRED: 0x36,
  PIN_POLICY_VIOLATION: 0x37,
  ACTION_TIMEOUT: 0x3a,
} as const;

export class CtapError extends Error {
  constructor(readonly status: number) {
    super(`The security key answered CTAP2 error 0x${status.toString(16).padStart(2, '0')}`);
    this.name = 'CtapError';
  }
}

/** A reply that does not have the shape CTAP2 gives it. */
const malformed = (): CtapError => new CtapError(CTAP2_ERR.INVALID_CBOR);

export interface AuthenticatorInfo {
  readonly versions: readonly string[];
  /** The COSE algorithms it creates credentials for; undefined when it does not say (CTAP 2.0). */
  readonly algorithms: readonly number[] | undefined;
  readonly pinProtocols: readonly number[];
  /** `clientPin`: true when a PIN is set, false when one can be, undefined when it has no PIN. */
  readonly clientPin: boolean | undefined;
}

/** A PIN token and the protocol it belongs to. */
export interface PinToken {
  readonly protocol: number;
  readonly token: Buffer;
}

export interface MadeCredential {
  readonly credentialId: Buffer;
  readonly algorithm: number;
  /** Ed25519: the 32-byte key; ES256: the uncompressed P-256 point. */
  readonly publicKey: Buffer;
  readonly flags: number;
}

export interface Assertion {
  readonly flags: number;
  readonly counter: number;
  /** Ed25519: raw 64 bytes; ES256: DER. */
  readonly signature: Buffer;
}

export const sha256 = (data: Buffer | string): Buffer => createHash('sha256').update(data).digest();

/** PIN/UV auth protocol (CTAP 2.1 §6.5.6, §6.5.7). */
export interface PinProtocol {
  readonly version: number;
  /** The shared secret from the platform's and the authenticator's ECDH key agreement (its x coordinate). */
  shared(z: Buffer): Buffer;
  encrypt(shared: Buffer, data: Buffer): Buffer;
  decrypt(shared: Buffer, data: Buffer): Buffer;
  /** The pinUvAuthParam for `message` under a PIN token. */
  authenticate(token: Buffer, message: Buffer): Buffer;
}

const aes = (key: Buffer, iv: Buffer, data: Buffer, decrypt: boolean): Buffer => {
  const cipher = decrypt ? createDecipheriv('aes-256-cbc', key, iv) : createCipheriv('aes-256-cbc', key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
};

const PROTOCOL_ONE: PinProtocol = {
  version: 1,
  shared: (z) => sha256(z),
  encrypt: (shared, data) => aes(shared, Buffer.alloc(16), data, false),
  decrypt: (shared, data) => aes(shared, Buffer.alloc(16), data, true),
  authenticate: (token, message) => createHmac('sha256', token).update(message).digest().subarray(0, 16),
};

const hkdf = (z: Buffer, info: string): Buffer => Buffer.from(hkdfSync('sha256', z, Buffer.alloc(32), info, 32));

const PROTOCOL_TWO: PinProtocol = {
  version: 2,
  shared: (z) => Buffer.concat([hkdf(z, 'CTAP2 HMAC key'), hkdf(z, 'CTAP2 AES key')]),
  encrypt: (shared, data) => {
    const iv = randomBytes(16);
    return Buffer.concat([iv, aes(shared.subarray(32), iv, data, false)]);
  },
  decrypt: (shared, data) => aes(shared.subarray(32), data.subarray(0, 16), data.subarray(16), true),
  authenticate: (token, message) => createHmac('sha256', token).update(message).digest(),
};

export const pinProtocolOf = (version: number): PinProtocol => (version === 2 ? PROTOCOL_TWO : PROTOCOL_ONE);

/** The authenticator data's fixed part (rpIdHash, flags, counter) and, when present, the credential. */
export function parseAuthData(authData: Buffer): {
  flags: number;
  counter: number;
  credential?: { id: Buffer; key: CborMap };
} {
  if (authData.length < 37) throw malformed();
  const flags = authData[32] ?? 0;
  const counter = authData.readUInt32BE(33);
  if ((flags & 0x40) === 0) return { flags, counter };
  if (authData.length < 55) throw malformed();
  const idLength = authData.readUInt16BE(53);
  const id = Buffer.from(authData.subarray(55, 55 + idLength));
  if (id.length !== idLength) throw malformed();
  const key = asCborMap(decodeCborPrefix(authData.subarray(55 + idLength)).value);
  if (key === undefined) throw malformed();
  return { flags, counter, credential: { id, key } };
}

/** The raw public key from a COSE key: Ed25519's 32 bytes or P-256's uncompressed point. */
function rawPublicKey(key: CborMap): { algorithm: number; publicKey: Buffer } {
  const algorithm = cborNumber(key, 3);
  const x = cborBytes(key, -2);
  if (algorithm === COSE_EDDSA && x?.length === 32) return { algorithm, publicKey: x };
  const y = cborBytes(key, -3);
  if (algorithm === COSE_ES256 && x?.length === 32 && y?.length === 32) {
    return { algorithm, publicKey: Buffer.concat([Buffer.from([4]), x, y]) };
  }
  throw new CtapError(CTAP2_ERR.UNSUPPORTED_ALGORITHM);
}

/** A CBOR map of the entries that are set, in the order given (callers write CTAP2's canonical order). */
const map = (entries: [number | string, CborValue | undefined][]): CborMap =>
  new Map(entries.filter((entry): entry is [number | string, CborValue] => entry[1] !== undefined));

const credentialDescriptor = (id: Buffer): CborMap =>
  map([
    ['id', id],
    ['type', 'public-key'],
  ]);

export class Ctap2 {
  constructor(private readonly hid: Pick<CtapHid, 'cbor'>) {}

  /** @throws CtapError for a non-zero status or a reply that is not a CBOR map */
  private async call(command: number, request: CborMap | undefined, options?: CborCallOptions): Promise<CborMap> {
    const body = request === undefined ? Buffer.alloc(0) : encodeCbor(request);
    const reply = await this.hid.cbor(Buffer.concat([Buffer.from([command]), body]), options);
    const status = reply[0];
    if (status === undefined) throw malformed();
    if (status !== 0) throw new CtapError(status);
    if (reply.length === 1) return new Map();
    let value: CborMap | undefined;
    try {
      value = asCborMap(decodeCbor(reply.subarray(1)));
    } catch {
      value = undefined;
    }
    if (value === undefined) throw malformed();
    return value;
  }

  async info(): Promise<AuthenticatorInfo> {
    const reply = await this.call(CMD_GET_INFO, undefined);
    const strings = (value: CborValue | undefined): string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    const numbers = (value: CborValue | undefined): number[] =>
      Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
    const clientPin = asCborMap(reply.get(4))?.get('clientPin');
    const algorithms = reply.get(10);
    return {
      versions: strings(reply.get(1)),
      algorithms: Array.isArray(algorithms)
        ? algorithms.flatMap((entry) => {
            const alg = entry instanceof Map ? entry.get('alg') : undefined;
            return typeof alg === 'number' ? [alg] : [];
          })
        : undefined,
      pinProtocols: numbers(reply.get(6)),
      clientPin: typeof clientPin === 'boolean' ? clientPin : undefined,
    };
  }

  /**
   * A PIN token for `pin` (clientPIN getPinToken, which CTAP 2.1 keeps for makeCredential and getAssertion).
   * Protocol 2 when the authenticator offers it.
   *
   * @throws CtapError PIN_INVALID | PIN_BLOCKED | PIN_AUTH_BLOCKED | PIN_NOT_SET
   */
  async pinToken(pin: string, protocols: readonly number[]): Promise<PinToken> {
    const protocol = pinProtocolOf(protocols.includes(2) ? 2 : 1);
    const agreement = await this.call(
      CMD_CLIENT_PIN,
      map([
        [1, protocol.version],
        [2, PIN_GET_KEY_AGREEMENT],
      ]),
    );
    const peer = asCborMap(agreement.get(1));
    const x = peer && cborBytes(peer, -2);
    const y = peer && cborBytes(peer, -3);
    if (!x || !y) throw malformed();
    const ecdh = createECDH('prime256v1');
    const ours = ecdh.generateKeys();
    const shared = protocol.shared(ecdh.computeSecret(Buffer.concat([Buffer.from([4]), x, y])));
    const pinHash = sha256(Buffer.from(pin.normalize('NFC'), 'utf8')).subarray(0, 16);
    const reply = await this.call(
      CMD_CLIENT_PIN,
      map([
        [1, protocol.version],
        [2, PIN_GET_TOKEN],
        [
          3,
          map([
            [1, 2],
            [3, COSE_ECDH_ES_HKDF_256],
            [-1, 1],
            [-2, ours.subarray(1, 33)],
            [-3, ours.subarray(33, 65)],
          ]),
        ],
        [6, protocol.encrypt(shared, pinHash)],
      ]),
    );
    const sealed = cborBytes(reply, 2);
    if (!sealed) throw malformed();
    return { protocol: protocol.version, token: protocol.decrypt(shared, sealed) };
  }

  /** How many PIN attempts are left before the authenticator locks. */
  async pinRetries(protocols: readonly number[]): Promise<number | undefined> {
    const reply = await this.call(
      CMD_CLIENT_PIN,
      map([
        [1, protocols.includes(2) ? 2 : 1],
        [2, PIN_GET_RETRIES],
      ]),
    );
    return cborNumber(reply, 3);
  }

  /** A non-resident credential for `rpId`. */
  async makeCredential(
    request: {
      readonly rpId: string;
      readonly clientDataHash: Buffer;
      readonly algorithm: number;
      readonly userId: Buffer;
      readonly userName: string;
      readonly pin?: PinToken;
    },
    options?: CborCallOptions,
  ): Promise<MadeCredential> {
    const { pin } = request;
    const reply = await this.call(
      CMD_MAKE_CREDENTIAL,
      map([
        [1, request.clientDataHash],
        [
          2,
          map([
            ['id', request.rpId],
            ['name', request.rpId],
          ]),
        ],
        [
          3,
          map([
            ['id', request.userId],
            ['name', request.userName],
            ['displayName', request.userName],
          ]),
        ],
        [
          4,
          [
            map([
              ['alg', request.algorithm],
              ['type', 'public-key'],
            ]),
          ],
        ],
        [7, map([['rk', false]])],
        [8, pin && pinProtocolOf(pin.protocol).authenticate(pin.token, request.clientDataHash)],
        [9, pin?.protocol],
      ]),
      options,
    );
    const authData = cborBytes(reply, 2);
    if (!authData) throw malformed();
    const { flags, credential } = parseAuthData(authData);
    if (!credential) throw malformed();
    const { algorithm, publicKey } = rawPublicKey(credential.key);
    if (algorithm !== request.algorithm) throw new CtapError(CTAP2_ERR.UNSUPPORTED_ALGORITHM);
    return { credentialId: credential.id, algorithm, publicKey, flags };
  }

  /** An assertion over `clientDataHash` with the one credential `credentialId`. */
  async getAssertion(
    request: {
      readonly rpId: string;
      readonly clientDataHash: Buffer;
      readonly credentialId: Buffer;
      /** False only to probe which authenticator holds the credential, without a touch. */
      readonly userPresence: boolean;
      readonly pin?: PinToken;
    },
    options?: CborCallOptions,
  ): Promise<Assertion> {
    const { pin } = request;
    const reply = await this.call(
      CMD_GET_ASSERTION,
      map([
        [1, request.rpId],
        [2, request.clientDataHash],
        [3, [credentialDescriptor(request.credentialId)]],
        [5, map([['up', request.userPresence]])],
        [6, pin && pinProtocolOf(pin.protocol).authenticate(pin.token, request.clientDataHash)],
        [7, pin?.protocol],
      ]),
      options,
    );
    const authData = cborBytes(reply, 2);
    const signature = cborBytes(reply, 3);
    if (!authData || !signature) throw malformed();
    const { flags, counter } = parseAuthData(authData);
    return { flags, counter, signature };
  }
}
