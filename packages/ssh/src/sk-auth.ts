import net from 'node:net';
import ssh2 from 'ssh2';
import type { AuthMethod, AuthenticationType, Client, ParsedKey } from 'ssh2';
import { sendAuthRequest } from './cert-auth.js';
import type { AuthProtocol } from './cert-auth.js';
import { SshModelError } from './errors.js';
import { skSign } from './fido/authenticator.js';
import type { SkPrompts } from './fido/authenticator.js';
import { SshReader, isSkKeyType, skPublicBlob, sshString, uint32 } from './sk-key.js';
import type { SkKey, SkKeyType } from './sk-key.js';

const { utils } = ssh2;

/**
 * Signing in with a FIDO2 security key (#420). ssh2 1.17 knows neither sk key type: it cannot read a stored
 * one, it drops one an agent lists, and its signature encoding has no room for the flags and counter an sk
 * signature ends with. So, as for certificates (`cert-auth.ts`), each sk attempt is a publickey method whose
 * key ssh2 carries without reading, and that client's `authPK` is wrapped to write the request itself: the
 * sk key as the public key blob, then the signature blob the signer returns, verbatim. Signing is
 * asynchronous (it waits for a touch); the packet goes out when it is done.
 */

export interface SkSigner {
  readonly keyType: SkKeyType;
  readonly publicBlob: Buffer;
  /** How the progress log names it. */
  readonly label: string;
  /** Where it signs: the security key itself, or the agent that holds it. */
  readonly via: 'key' | 'agent';
  /** The SSH signature blob over `data` (algorithm, signature, flags, counter). */
  sign(data: Buffer): Promise<Buffer>;
}

/** A stored sk key, signing through the authenticator. */
export function storedSkSigner(key: SkKey, label: string, prompts: SkPrompts): SkSigner {
  return {
    keyType: key.keyType,
    publicBlob: skPublicBlob(key),
    label,
    via: 'key',
    sign: (data) => skSign(key, data, prompts),
  };
}

const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;

/** How long the agent may take to list its keys; signing waits for a touch and has no limit here. */
const AGENT_LIST_TIMEOUT_MS = 5000;

/** One request to the agent at `socket` (draft-miller-ssh-agent), answered by one message. */
function agentRequest(socket: string, payload: Buffer, timeoutMs?: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket);
    let received = Buffer.alloc(0);
    let settled = false;
    const done = (error?: Error, reply?: Buffer): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      conn.destroy();
      if (error) reject(error);
      else resolve(reply as Buffer);
    };
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(() => done(new Error('The agent did not answer')), timeoutMs);
    conn.on('error', (error) => done(error));
    conn.on('connect', () => conn.write(Buffer.concat([uint32(payload.length), payload])));
    conn.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length < 4) return;
      const length = received.readUInt32BE(0);
      if (received.length >= 4 + length) done(undefined, received.subarray(4, 4 + length));
    });
    conn.on('end', () => done(new Error('The agent closed the connection')));
  });
}

/**
 * The sk keys the agent at `socket` holds, as signers: none when it holds none, cannot be reached or is
 * Pageant (which has no security key support). The agent asks for the touch and PIN itself.
 */
export async function agentSkSigners(socket: string): Promise<SkSigner[]> {
  if (socket === 'pageant') return [];
  let reply: Buffer;
  try {
    reply = await agentRequest(socket, Buffer.from([SSH_AGENTC_REQUEST_IDENTITIES]), AGENT_LIST_TIMEOUT_MS);
  } catch {
    return [];
  }
  const reader = new SshReader(reply);
  const signers: SkSigner[] = [];
  try {
    if (reader.byte() !== SSH_AGENT_IDENTITIES_ANSWER) return [];
    const count = reader.uint32();
    for (let i = 0; i < count; i++) {
      const blob = Buffer.from(reader.string());
      const comment = reader.text();
      const type = new SshReader(blob).text();
      if (!isSkKeyType(type)) continue;
      signers.push({
        keyType: type,
        publicBlob: blob,
        label: comment === '' ? 'the agent’s security key' : `the agent’s security key ${comment}`,
        via: 'agent',
        sign: async (data) => {
          const answer = await agentRequest(
            socket,
            Buffer.concat([Buffer.from([SSH_AGENTC_SIGN_REQUEST]), sshString(blob), sshString(data), uint32(0)]),
          );
          const parsed = new SshReader(answer);
          if (parsed.byte() !== SSH_AGENT_SIGN_RESPONSE) {
            throw new SshModelError('ssh-sk-not-touched', 'The agent did not sign with the security key');
          }
          // The agent's signature is already the whole sk blob, flags and counter included.
          return Buffer.from(parsed.string());
        },
      });
    }
  } catch {
    // A malformed listing: the keys read before it still count.
  }
  return signers;
}

let placeholderBase: ParsedKey | undefined;

/**
 * What ssh2 is handed for an sk attempt. It checks only that the key is a parsed private key (a symbol
 * parsed keys carry) and reads its type; the wrapper knows it by identity and does the rest. A throwaway
 * Ed25519 key, made once, gives it that shape; it never signs anything.
 */
function placeholderFor(signer: SkSigner): ParsedKey {
  if (placeholderBase === undefined) {
    const parsed = utils.parseKey(utils.generateKeyPairSync('ed25519').private);
    placeholderBase = (Array.isArray(parsed) ? parsed[0] : parsed) as ParsedKey;
  }
  return Object.create(placeholderBase, {
    type: { value: signer.keyType },
    getPublicSSH: { value: () => signer.publicBlob },
    isPrivateKey: { value: () => true },
  }) as ParsedKey;
}

export interface SkAuth {
  /** One publickey attempt per signer, in order. */
  readonly methods: AuthMethod[];
  /** ssh2's `authHandler`: the `first` methods by name, then the sk attempts. */
  handler(first: readonly AuthenticationType[]): AuthMethod[];
  /** Wraps the client's `authPK`: call right after `client.connect()`, which makes the protocol object. */
  attach(client: Client): void;
  /** The error that stopped a signature, once one has; the connect then fails with it. */
  readonly failure: unknown;
}

/** @param onSign told when a signer starts signing: the moment to ask for a touch */
export function skAuth(username: string, signers: readonly SkSigner[], onSign?: (signer: SkSigner) => void): SkAuth {
  const byKey = new Map(signers.map((signer) => [placeholderFor(signer), signer] as const));
  let failure: unknown;
  const methods = [...byKey.keys()].map((key) => ({ type: 'publickey', username, key }) as AuthMethod);
  return {
    methods,
    // ssh2 takes names and method objects in one list; its types keep them apart.
    handler: (first) => [...first, ...methods] as unknown as AuthMethod[],
    get failure() {
      return failure;
    },
    attach(client) {
      const proto = (client as unknown as { _protocol: AuthProtocol })._protocol;
      const original = proto.authPK.bind(proto);
      proto.authPK = (user, pubKey, keyAlgo, cbSign) => {
        const signer = byKey.get(pubKey as ParsedKey);
        if (signer === undefined) return original(user, pubKey, keyAlgo, cbSign);
        const request = (signed: boolean): Buffer =>
          Buffer.concat([
            Buffer.from([50]), // SSH_MSG_USERAUTH_REQUEST
            sshString(user),
            sshString('ssh-connection'),
            sshString('publickey'),
            Buffer.from([signed ? 1 : 0]),
            sshString(signer.keyType),
            sshString(signer.publicBlob),
          ]);
        // ssh2 passes a signing callback (third or fourth argument) for the signed request.
        if (typeof cbSign !== 'function' && typeof keyAlgo !== 'function') {
          sendAuthRequest(proto, request(false));
          return;
        }
        const body = request(true);
        onSign?.(signer);
        signer.sign(Buffer.concat([sshString(proto._kex.sessionID), body])).then(
          (signature) => sendAuthRequest(proto, Buffer.concat([body, sshString(signature)])),
          (error: unknown) => {
            failure = error;
            const message = error instanceof Error ? error.message : 'The security key did not sign';
            client.emit('error', Object.assign(new Error(message), { level: 'security-key' }));
            client.end();
          },
        );
      };
    },
  };
}
