import { createECDH, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { asCborMap, cborBytes, cborNumber, decodeCbor, encodeCbor } from '../../src/fido/cbor.js';
import type { CborMap, CborValue } from '../../src/fido/cbor.js';
import {
  BROADCAST_CID,
  CAPABILITY_CBOR,
  CMD_CBOR,
  CMD_INIT,
  CMD_KEEPALIVE,
  framesOf,
  REPORT_SIZE,
  STATUS_UPNEEDED,
} from '../../src/fido/ctaphid.js';
import type { HidDevice } from '../../src/fido/ctaphid.js';
import {
  CMD_CLIENT_PIN,
  CMD_GET_ASSERTION,
  CMD_GET_INFO,
  CMD_MAKE_CREDENTIAL,
  COSE_EDDSA,
  COSE_ES256,
  CTAP2_ERR,
  PIN_GET_KEY_AGREEMENT,
  PIN_GET_RETRIES,
  PIN_GET_TOKEN,
  pinProtocolOf,
  sha256,
} from '../../src/fido/ctap2.js';
import type { FidoDeviceInfo, FidoTransport } from '../../src/fido/authenticator.js';

/**
 * A software FIDO2 authenticator behind the CTAPHID framing, for tests: it makes non-resident credentials,
 * signs assertions with them and runs PIN protocols 1 and 2, as a hardware key does over USB. Nothing here
 * is secure; credentials live in memory.
 */
export interface SoftAuthenticatorOptions {
  /** A PIN set on the authenticator; none when absent. */
  readonly pin?: string;
  readonly pinProtocols?: readonly number[];
  readonly algorithms?: readonly number[];
  /** `touch`: answers after a keep-alive (default); `never`: the person never touches it. */
  readonly touch?: 'touch' | 'never';
  /** Speaks only U2F (no CBOR capability). */
  readonly u2fOnly?: boolean;
  readonly product?: string;
}

interface Credential {
  readonly rpId: string;
  readonly algorithm: number;
  readonly key: KeyObject;
}

interface Reply {
  readonly status: number;
  readonly body?: Buffer;
  /** It waited for a touch first: a keep-alive goes out before the reply. */
  readonly touched?: boolean;
}

const CID = 0x0a0b0c0d;

export class SoftAuthenticator {
  readonly credentials = new Map<string, Credential>();
  /** The touches it waited for, and the CTAP2 commands it answered. */
  touches = 0;
  readonly commands: number[] = [];
  pinRetries = 8;
  private counter = 0;
  private readonly agreement = createECDH('prime256v1');
  private token: Buffer | undefined;

  constructor(readonly options: SoftAuthenticatorOptions = {}) {
    this.agreement.generateKeys();
  }

  get product(): string {
    return this.options.product ?? 'Soft FIDO2 key';
  }

  /** A HID device on this authenticator (each open is a fresh connection). */
  device(): HidDevice {
    let pending: { cid: number; cmd: number; length: number; parts: Buffer[]; received: number } | undefined;
    const outgoing: Buffer[] = [];
    let waiter: (() => void) | undefined;
    const send = (cid: number, cmd: number, payload: Buffer): void => {
      outgoing.push(...framesOf(cid, cmd, payload));
      waiter?.();
    };
    const complete = (cid: number, cmd: number, payload: Buffer): void => {
      if (cmd === CMD_INIT && cid === BROADCAST_CID) {
        const reply = Buffer.alloc(17);
        payload.copy(reply, 0, 0, 8);
        reply.writeUInt32BE(CID, 8);
        reply[12] = 2;
        reply[16] = this.options.u2fOnly ? 0 : CAPABILITY_CBOR | 0x08;
        send(BROADCAST_CID, CMD_INIT, reply);
      } else if (cmd === CMD_CBOR && cid === CID) {
        const { status, body, touched } = this.handle(payload);
        if (touched) send(CID, CMD_KEEPALIVE, Buffer.from([STATUS_UPNEEDED]));
        send(CID, CMD_CBOR, Buffer.concat([Buffer.from([status]), body ?? Buffer.alloc(0)]));
      }
    };
    const write = (report: Buffer): void => {
      if (report.length !== REPORT_SIZE) throw new Error('A report is 64 bytes');
      const cid = report.readUInt32BE(0);
      const command = report[4] ?? 0;
      if ((command & 0x80) !== 0) {
        const length = report.readUInt16BE(5);
        const first = report.subarray(7, 7 + Math.min(length, REPORT_SIZE - 7));
        pending = { cid, cmd: command & 0x7f, length, parts: [first], received: first.length };
      } else if (pending) {
        const more = report.subarray(5, 5 + Math.min(pending.length - pending.received, REPORT_SIZE - 5));
        pending.parts.push(more);
        pending.received += more.length;
      }
      if (pending && pending.received >= pending.length) {
        const { cid: from, cmd, parts } = pending;
        pending = undefined;
        complete(from, cmd, Buffer.concat(parts));
      }
    };
    return {
      // A throw inside the executor rejects the promise.
      write: (report) =>
        new Promise<void>((resolve) => {
          write(report);
          resolve();
        }),
      read: async (timeoutMs) => {
        if (outgoing.length === 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.min(timeoutMs, 50));
            waiter = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          waiter = undefined;
        }
        return outgoing.shift();
      },
      close: () => Promise.resolve(),
    };
  }

  /** The public key of a credential, as Node holds it (to check signatures in tests). */
  publicKeyOf(credentialId: Buffer): KeyObject | undefined {
    const credential = this.credentials.get(credentialId.toString('hex'));
    return credential && createPublicKey(credential.key);
  }

  private handle(payload: Buffer): Reply {
    const command = payload[0] ?? 0;
    this.commands.push(command);
    let request: CborMap | undefined;
    try {
      request = payload.length > 1 ? asCborMap(decodeCbor(payload.subarray(1))) : new Map();
    } catch {
      request = undefined;
    }
    if (request === undefined) return { status: CTAP2_ERR.INVALID_CBOR };
    switch (command) {
      case CMD_GET_INFO:
        return { status: 0, body: encodeCbor(this.info()) };
      case CMD_CLIENT_PIN:
        return this.clientPin(request);
      case CMD_MAKE_CREDENTIAL:
        return this.makeCredential(request);
      case CMD_GET_ASSERTION:
        return this.getAssertion(request);
      default:
        return { status: 0x01 };
    }
  }

  private algorithms(): readonly number[] {
    return this.options.algorithms ?? [COSE_EDDSA, COSE_ES256];
  }

  private info(): CborMap {
    return new Map<number, CborValue>([
      [1, ['FIDO_2_0', 'FIDO_2_1']],
      [3, Buffer.alloc(16, 7)],
      [4, new Map([['clientPin', this.options.pin !== undefined]])],
      [6, [...(this.options.pinProtocols ?? [2, 1])]],
      [
        10,
        this.algorithms().map(
          (alg) =>
            new Map<string, CborValue>([
              ['alg', alg],
              ['type', 'public-key'],
            ]),
        ),
      ],
    ]);
  }

  private clientPin(request: CborMap): Reply {
    const protocol = pinProtocolOf(cborNumber(request, 1) ?? 1);
    switch (cborNumber(request, 2)) {
      case PIN_GET_RETRIES:
        return { status: 0, body: encodeCbor(new Map([[3, this.pinRetries]])) };
      case PIN_GET_KEY_AGREEMENT: {
        const point = this.agreement.getPublicKey();
        const key = new Map<number, CborValue>([
          [1, 2],
          [3, -25],
          [-1, 1],
          [-2, point.subarray(1, 33)],
          [-3, point.subarray(33, 65)],
        ]);
        return { status: 0, body: encodeCbor(new Map([[1, key]])) };
      }
      case PIN_GET_TOKEN: {
        if (this.options.pin === undefined) return { status: CTAP2_ERR.PIN_NOT_SET };
        if (this.pinRetries === 0) return { status: CTAP2_ERR.PIN_BLOCKED };
        const platform = asCborMap(request.get(3));
        const x = platform && cborBytes(platform, -2);
        const y = platform && cborBytes(platform, -3);
        const sealed = cborBytes(request, 6);
        if (!x || !y || !sealed) return { status: CTAP2_ERR.INVALID_CBOR };
        const shared = protocol.shared(this.agreement.computeSecret(Buffer.concat([Buffer.from([4]), x, y])));
        if (!protocol.decrypt(shared, sealed).equals(sha256(this.options.pin).subarray(0, 16))) {
          this.pinRetries -= 1;
          return { status: this.pinRetries === 0 ? CTAP2_ERR.PIN_BLOCKED : CTAP2_ERR.PIN_INVALID };
        }
        this.pinRetries = 8;
        this.token = randomBytes(32);
        return { status: 0, body: encodeCbor(new Map([[2, protocol.encrypt(shared, this.token)]])) };
      }
      default:
        return { status: 0x01 };
    }
  }

  /** True for a valid pinUvAuthParam at `key`, false for none, a CTAP2 status for a bad one. */
  private verified(request: CborMap, clientDataHash: Buffer, key: number): boolean | number {
    const auth = cborBytes(request, key);
    if (auth === undefined) return false;
    if (this.token === undefined) return CTAP2_ERR.PIN_AUTH_INVALID;
    const protocol = pinProtocolOf(cborNumber(request, key + 1) ?? 1);
    return protocol.authenticate(this.token, clientDataHash).equals(auth) ? true : CTAP2_ERR.PIN_AUTH_INVALID;
  }

  private makeCredential(request: CborMap): Reply {
    const clientDataHash = cborBytes(request, 1);
    const rpId = asCborMap(request.get(2))?.get('id');
    const params = request.get(4);
    if (!clientDataHash || typeof rpId !== 'string' || !Array.isArray(params)) {
      return { status: CTAP2_ERR.INVALID_CBOR };
    }
    const verified = this.verified(request, clientDataHash, 8);
    if (typeof verified === 'number') return { status: verified };
    if (this.options.pin !== undefined && !verified) return { status: CTAP2_ERR.PIN_REQUIRED };
    const algorithm = params
      .map((p) => (p instanceof Map ? p.get('alg') : undefined))
      .find((alg): alg is number => typeof alg === 'number' && this.algorithms().includes(alg));
    if (algorithm === undefined) return { status: CTAP2_ERR.UNSUPPORTED_ALGORITHM };
    if (!this.touch()) return { status: CTAP2_ERR.USER_ACTION_TIMEOUT, touched: true };
    const { privateKey, publicKey } =
      algorithm === COSE_EDDSA ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const id = randomBytes(48);
    this.credentials.set(id.toString('hex'), { rpId, algorithm, key: privateKey });
    const jwk = publicKey.export({ format: 'jwk' });
    const x = Buffer.from(jwk.x ?? '', 'base64url');
    const cose = new Map<number, CborValue>(
      algorithm === COSE_EDDSA
        ? [
            [1, 1],
            [3, COSE_EDDSA],
            [-1, 6],
            [-2, x],
          ]
        : [
            [1, 2],
            [3, COSE_ES256],
            [-1, 1],
            [-2, x],
            [-3, Buffer.from(jwk.y ?? '', 'base64url')],
          ],
    );
    const length = Buffer.alloc(2);
    length.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([0x41 | (verified ? 0x04 : 0)]),
      this.nextCounter(),
      Buffer.alloc(16, 7),
      length,
      id,
      encodeCbor(cose),
    ]);
    const reply = new Map<number, CborValue>([
      [1, 'none'],
      [2, authData],
      [3, new Map()],
    ]);
    return { status: 0, body: encodeCbor(reply), touched: true };
  }

  private getAssertion(request: CborMap): Reply {
    const rpId = request.get(1);
    const clientDataHash = cborBytes(request, 2);
    const allow = request.get(3);
    if (typeof rpId !== 'string' || !clientDataHash || !Array.isArray(allow)) {
      return { status: CTAP2_ERR.INVALID_CBOR };
    }
    const found = allow
      .map((d) => (d instanceof Map ? d.get('id') : undefined))
      .filter((id): id is Buffer => Buffer.isBuffer(id))
      .map((id) => ({ id, credential: this.credentials.get(id.toString('hex')) }))
      .find((c) => c.credential?.rpId === rpId);
    if (!found?.credential) return { status: CTAP2_ERR.NO_CREDENTIALS };
    const verified = this.verified(request, clientDataHash, 6);
    if (typeof verified === 'number') return { status: verified };
    const up = asCborMap(request.get(5))?.get('up') !== false;
    if (up && !this.touch()) return { status: CTAP2_ERR.USER_ACTION_TIMEOUT, touched: true };
    const authData = Buffer.concat([
      sha256(rpId),
      Buffer.from([(up ? 0x01 : 0) | (verified ? 0x04 : 0)]),
      this.nextCounter(),
    ]);
    const message = Buffer.concat([authData, clientDataHash]);
    const signature =
      found.credential.algorithm === COSE_EDDSA
        ? sign(null, message, found.credential.key)
        : sign('sha256', message, found.credential.key);
    const descriptor = new Map<string, CborValue>([
      ['id', found.id],
      ['type', 'public-key'],
    ]);
    const reply = new Map<number, CborValue>([
      [1, descriptor],
      [2, authData],
      [3, signature],
    ]);
    return { status: 0, body: encodeCbor(reply), touched: up };
  }

  private touch(): boolean {
    this.touches += 1;
    return this.options.touch !== 'never';
  }

  private nextCounter(): Buffer {
    this.counter += 1;
    const out = Buffer.alloc(4);
    out.writeUInt32BE(this.counter);
    return out;
  }
}

/** A {@link FidoTransport} with these authenticators plugged in. */
export function softTransport(...authenticators: SoftAuthenticator[]): FidoTransport {
  return {
    list: (): Promise<FidoDeviceInfo[]> =>
      Promise.resolve(authenticators.map((a, index) => ({ path: `soft-${String(index)}`, product: a.product }))),
    open: (path) => {
      const authenticator = authenticators[Number(path.slice('soft-'.length))];
      return authenticator ? Promise.resolve(authenticator.device()) : Promise.reject(new Error(`No device ${path}`));
    },
  };
}
