/**
 * A passkey in software, for the server's passkey tests (two-step sign-in plan Task 7): one P-256 key from
 * `node:crypto`, `none` attestations and ES256 assertions, encoded as a browser hands them over. Enough of CBOR for
 * the attestation object and the COSE key.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

type Cbor = number | string | Buffer | Map<number | string, Cbor>;

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  const out = Buffer.alloc(3);
  out[0] = (major << 5) | 25;
  out.writeUInt16BE(length, 1);
  return out;
}

function cbor(value: Cbor): Buffer {
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const parts = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

const b64url = (bytes: Buffer): string => bytes.toString('base64url');
const sha256 = (bytes: Buffer | string): Buffer => createHash('sha256').update(bytes).digest();

const UP = 0x01;
const UV = 0x04;
const AT = 0x40;

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly cose: Buffer;
  /** The signature counter the next assertion carries, less one; a test sets it back to make one go backwards. */
  counter = 0;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    const jwk = pair.publicKey.export({ format: 'jwk' });
    this.cose = cbor(
      new Map<number, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  /** The COSE public key, as the server stores it: for a test that writes the passkey row itself. */
  get publicKey(): Buffer {
    return this.cose;
  }

  private authData(flags: number, attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const parts = [sha256(this.rpId), Buffer.from([flags]), counter];
    if (attested) {
      const length = Buffer.alloc(2);
      length.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), length, this.credentialId, this.cose);
    }
    return Buffer.concat(parts);
  }

  private clientData(type: string, challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  /** The answer to registration options: a `none` attestation of this key. */
  create(options: { readonly challenge: string }, origin = this.origin): Record<string, unknown> {
    const clientDataJSON = this.clientData('webauthn.create', options.challenge, origin);
    const attestationObject = cbor(
      new Map<string, Cbor>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', this.authData(UP | UV | AT, true)],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** The answer to request options: an assertion signed with this key, its counter one higher than the last. */
  get(options: { readonly challenge: string }, origin = this.origin): Record<string, unknown> {
    this.counter += 1;
    const clientDataJSON = this.clientData('webauthn.get', options.challenge, origin);
    const authenticatorData = this.authData(UP | UV, false);
    const signature = sign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}
