/**
 * A minimal NTLM-authenticating HTTP server for tests. It issues a real Type 2 challenge and
 * verifies the client's Type 3 independently of `createType3` — it re-derives `NTOWFv2` from
 * the account it was configured with and recomputes `NTProofStr` over the blob exactly as the
 * client sent it — so a codec bug cannot cancel itself out.
 *
 * It also records, per handshake, whether the legs arrived on one socket, which is what makes
 * "NTLM authenticates the connection" testable.
 */

import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import {
  AV_IDS,
  buildAvPairs,
  DEFAULT_NEGOTIATE_FLAGS,
  encodeNtlmAuthorization,
  ntProofString,
  ntowfv2,
  parseType3,
  toFileTime,
} from '../../src/http/auth/ntlm.js';

/** One request the NTLM server saw, with the identity of the socket it arrived on. */
export interface NtlmRequestRecord {
  readonly leg: 1 | 2 | 3;
  readonly socketId: number;
  readonly contentLength: number;
  readonly authorization: string | undefined;
}

/** Handle to a running {@link startNtlmServer}. */
export interface NtlmServer {
  readonly url: string;
  /** Every request, in order, with its socket identity. */
  readonly requests: NtlmRequestRecord[];
  /** True when every leg of every handshake arrived on the same socket. */
  sameSocket(): boolean;
  close(): Promise<void>;
}

/** Configuration for {@link startNtlmServer}. */
export interface NtlmServerOptions {
  readonly username: string;
  readonly password: string;
  readonly domain?: string;
  /** Advertise the challenge as `Negotiate` rather than `NTLM`, as IIS with Windows auth does. */
  readonly advertiseNegotiate?: boolean;
  /** Answer every request 200 without ever challenging, to test the short-circuit path. */
  readonly noAuthRequired?: boolean;
  /** Delay (ms) before answering leg 2, so a test can abort mid-handshake. */
  readonly delayLeg2Ms?: number;
}

/** Builds the Type 2 CHALLENGE message a real server would send. */
export function buildChallengeMessage(params: {
  readonly serverChallenge: Uint8Array;
  readonly targetName: string;
}): Uint8Array {
  const targetName = new Uint8Array(Buffer.from(params.targetName, 'utf16le'));
  const targetInfo = buildAvPairs([
    { id: AV_IDS.MsvAvNbDomainName, value: new Uint8Array(Buffer.from(params.targetName, 'utf16le')) },
    { id: AV_IDS.MsvAvNbComputerName, value: new Uint8Array(Buffer.from('WIREBENCH', 'utf16le')) },
    { id: AV_IDS.MsvAvDnsDomainName, value: new Uint8Array(Buffer.from('test.wirebench', 'utf16le')) },
    { id: AV_IDS.MsvAvTimestamp, value: fileTimeBytes(toFileTime(Date.now())) },
  ]);
  const header = 56;
  const message = new Uint8Array(header + targetName.length + targetInfo.length);
  message.set(new Uint8Array(Buffer.from('NTLMSSP\0', 'latin1')), 0);
  const view = new DataView(message.buffer);
  view.setUint32(8, 2, true);
  view.setUint16(12, targetName.length, true);
  view.setUint16(14, targetName.length, true);
  view.setUint32(16, header, true);
  view.setUint32(20, DEFAULT_NEGOTIATE_FLAGS, true);
  message.set(params.serverChallenge, 24);
  view.setUint16(40, targetInfo.length, true);
  view.setUint16(42, targetInfo.length, true);
  view.setUint32(44, header + targetName.length, true);
  message.set(new Uint8Array([0x06, 0x01, 0xb1, 0x1d, 0x00, 0x00, 0x00, 0x0f]), 48);
  message.set(targetName, header);
  message.set(targetInfo, header + targetName.length);
  return message;
}

function fileTimeBytes(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/**
 * Verifies a Type 3 message against an account, the way a domain controller would: recompute
 * `NTOWFv2` and the `NTProofStr` over the blob as received, then compare.
 *
 * @param type3Bytes the raw Type 3 message
 * @param account the credentials the server expects
 * @param serverChallenge the challenge this connection was issued
 */
export function verifyType3(
  type3Bytes: Uint8Array,
  account: { readonly username: string; readonly password: string; readonly domain: string },
  serverChallenge: Uint8Array,
): boolean {
  let parsed;
  try {
    parsed = parseType3(type3Bytes);
  } catch {
    return false;
  }
  if (parsed.username.toUpperCase() !== account.username.toUpperCase()) return false;
  if (parsed.domain.toUpperCase() !== account.domain.toUpperCase()) return false;
  if (parsed.ntChallengeResponse.length < 24) return false;
  const proof = parsed.ntChallengeResponse.slice(0, 16);
  const blob = parsed.ntChallengeResponse.slice(16);
  // The domain in the message is what the client hashed with, so use it (not the server's spelling).
  const key = ntowfv2(parsed.username, parsed.domain, account.password);
  const expected = ntProofString(key, serverChallenge, blob);
  return Buffer.from(proof).equals(Buffer.from(expected));
}

/** The account an NTLM route authenticates against. */
export interface NtlmAccount {
  readonly username: string;
  readonly password: string;
  readonly domain: string;
}

/** Behaviour knobs shared by {@link createNtlmAuthenticator} and {@link startNtlmServer}. */
export interface NtlmAuthenticatorOptions {
  /** Advertise the challenge as `Negotiate` rather than `NTLM`, as IIS with Windows auth does. */
  readonly advertiseNegotiate?: boolean;
  /** Delay (ms) before answering the Type 1 leg, so a test can abort mid-handshake. */
  readonly delayLeg2Ms?: number;
  /** Called with the leg number each request belongs to, for recording. */
  readonly onLeg?: (leg: 1 | 2 | 3, req: IncomingMessage) => void;
}

/** What a request did to the NTLM state machine. */
export type NtlmLegOutcome = 'challenged' | 'authenticated' | 'rejected';

/**
 * The NTLM server state machine, reusable by any `http` server route. Keeps the issued
 * challenge per *connection*, which is what makes a handshake spread over several sockets
 * fail the way a real server makes it fail.
 *
 * @param account the credentials the route accepts
 * @param options challenge scheme, an artificial delay and a leg callback
 * @returns `handle(req, res)`: `'authenticated'` when the caller should send its own 200
 *          response, otherwise the 401 has already been written.
 */
export function createNtlmAuthenticator(
  account: NtlmAccount,
  options?: NtlmAuthenticatorOptions,
): { handle(req: IncomingMessage, res: ServerResponse): NtlmLegOutcome } {
  const challenges = new WeakMap<Socket, Uint8Array>();
  const scheme = options?.advertiseNegotiate === true ? 'Negotiate' : 'NTLM';

  return {
    handle(req: IncomingMessage, res: ServerResponse): NtlmLegOutcome {
      const socket = req.socket;
      const authorization = req.headers.authorization;
      const token = authorization?.replace(/^(NTLM|Negotiate)\s+/i, '');
      const message = token !== undefined && token !== authorization ? Buffer.from(token, 'base64') : undefined;
      const messageType = message !== undefined && message.length >= 12 ? message.readUInt32LE(8) : undefined;

      if (messageType === 1) {
        options?.onLeg?.(2, req);
        const serverChallenge = new Uint8Array(randomBytes(8));
        challenges.set(socket, serverChallenge);
        const challenge = buildChallengeMessage({ serverChallenge, targetName: account.domain || 'WIREBENCH' });
        const respond = (): void => {
          res.writeHead(401, {
            'content-type': 'text/plain',
            'www-authenticate': encodeNtlmAuthorization(challenge).replace(/^NTLM/, scheme),
            'content-length': '0',
          });
          res.end();
        };
        if (options?.delayLeg2Ms !== undefined) {
          setTimeout(respond, options.delayLeg2Ms).unref();
        } else {
          respond();
        }
        return 'challenged';
      }

      if (messageType === 3) {
        options?.onLeg?.(3, req);
        const serverChallenge = challenges.get(socket);
        // A Type 3 on a connection that was never challenged can never be valid: NTLM state
        // is per-connection, so this is exactly the failure a pooling bug would cause.
        const ok =
          serverChallenge !== undefined &&
          verifyType3(new Uint8Array(message ?? Buffer.alloc(0)), account, serverChallenge);
        if (!ok) {
          res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': scheme });
          res.end('Unauthorized');
          return 'rejected';
        }
        return 'authenticated';
      }

      options?.onLeg?.(1, req);
      res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': scheme, 'content-length': '0' });
      res.end();
      return 'challenged';
    },
  };
}

/**
 * Starts an HTTP server that requires NTLMv2 and echoes the request body once authenticated.
 *
 * @param options the account it accepts plus the behaviours a test wants to provoke
 */
export async function startNtlmServer(options: NtlmServerOptions): Promise<NtlmServer> {
  const account: NtlmAccount = {
    username: options.username,
    password: options.password,
    domain: options.domain ?? '',
  };
  const requests: NtlmRequestRecord[] = [];
  const socketIds = new WeakMap<Socket, number>();
  let nextSocketId = 1;

  const socketIdOf = (socket: Socket): number => {
    let id = socketIds.get(socket);
    if (id === undefined) {
      id = nextSocketId++;
      socketIds.set(socket, id);
    }
    return id;
  };

  let pendingLeg: 1 | 2 | 3 = 1;
  const authenticator = createNtlmAuthenticator(account, {
    ...(options.advertiseNegotiate !== undefined ? { advertiseNegotiate: options.advertiseNegotiate } : {}),
    ...(options.delayLeg2Ms !== undefined ? { delayLeg2Ms: options.delayLeg2Ms } : {}),
    onLeg: (leg) => {
      pendingLeg = leg;
    },
  });

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const socketId = socketIdOf(req.socket);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const record = (leg: 1 | 2 | 3): void => {
        requests.push({ leg, socketId, contentLength: body.length, authorization: req.headers.authorization });
      };

      if (options.noAuthRequired === true) {
        record(1);
        res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml', 'x-auth-scheme': 'none' });
        res.end(body);
        return;
      }

      const outcome = authenticator.handle(req, res);
      record(pendingLeg);
      if (outcome !== 'authenticated') return;
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml', 'x-auth-scheme': 'ntlm' });
      res.end(body);
    });
  };

  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    sameSocket(): boolean {
      return new Set(requests.map((entry) => entry.socketId)).size === 1;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}
