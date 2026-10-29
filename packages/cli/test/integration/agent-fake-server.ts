/**
 * A fake Wirebench Server for `wirebench agent`'s tests: the pairing routes of spec §18.2 on loopback, each
 * signed route checked over the engine's message builders, plus `GET /test/nonce?pairing=<id>`, which hands
 * out the single-use nonce a tab of that pairing would give its agent.
 */
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AGENT_HEADERS, agentRedeemMessage, agentRequestMessage } from '@wirebench/engine';

export interface FakePairingServer {
  readonly url: string;
  readonly code: string;
  readonly email: string;
  /** The pairings it holds, by id: the agent's public key and the port it was last told. */
  readonly pairings: Map<string, { readonly publicKey: string; port: number }>;
  /** Every signed request, and whether its signature held. */
  readonly signed: { readonly method: string; readonly path: string; readonly ok: boolean }[];
  close(): Promise<void>;
}

function ulidLike(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return Array.from(randomBytes(26), (byte) => alphabet[byte % 32]).join('');
}

function bodyOf(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function holds(publicKey: string, message: string, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

export async function startFakePairingServer(): Promise<FakePairingServer> {
  const pairings = new Map<string, { readonly publicKey: string; port: number }>();
  const nonces = new Map<string, string>();
  const signed: { method: string; path: string; ok: boolean }[] = [];
  const code = 'ABC234';
  const email = 'ada@example.test';
  let origin = '';
  const server = createServer((request, response) => {
    void (async () => {
      const body = await bodyOf(request);
      const url = new URL(request.url ?? '/', 'http://x');
      const method = request.method ?? 'GET';
      const header = (name: string): string => {
        const value = request.headers[name];
        return typeof value === 'string' ? value : '';
      };
      const reply = (status: number, value?: unknown): void => {
        response.writeHead(status, { 'content-type': value === undefined ? 'text/plain' : 'application/json' });
        response.end(value === undefined ? undefined : JSON.stringify(value));
      };
      const pairingId = header(AGENT_HEADERS.pairing);
      const timestamp = header(AGENT_HEADERS.timestamp);
      const signature = header(AGENT_HEADERS.signature);

      if (method === 'GET' && url.pathname === '/test/nonce') {
        const nonce = randomUUID();
        nonces.set(nonce, url.searchParams.get('pairing') ?? '');
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end(nonce);
        return;
      }
      if (method === 'POST' && url.pathname === '/api/v1/agent/pairings') {
        const sent = JSON.parse(body) as { code: string; publicKey: string; port: number };
        if (sent.code !== code) {
          reply(401, { error: { code: 'agent-pairing-code-invalid', message: 'The code is not valid' } });
          return;
        }
        const id = ulidLike();
        pairings.set(id, { publicKey: sent.publicKey, port: sent.port });
        reply(201, { pairingId: id, origin, email });
        return;
      }
      if (method === 'POST' && url.pathname === '/api/v1/agent/nonces/redeem') {
        const { nonce } = JSON.parse(body) as { nonce: string };
        const pairing = pairings.get(pairingId);
        const ok =
          pairing !== undefined && holds(pairing.publicKey, agentRedeemMessage(nonce, pairingId, timestamp), signature);
        signed.push({ method, path: url.pathname, ok });
        if (!ok || nonces.get(nonce) !== pairingId) {
          reply(401, { error: { code: 'agent-nonce-invalid' } });
          return;
        }
        nonces.delete(nonce);
        reply(200, { userId: ulidLike(), email, displayName: 'Ada' });
        return;
      }
      const match = /^\/api\/v1\/agent\/pairings\/([^/]+)$/.exec(url.pathname);
      if (match !== null && (method === 'DELETE' || method === 'PATCH')) {
        const id = decodeURIComponent(match[1] ?? '');
        const pairing = pairings.get(id);
        const hash = createHash('sha256').update(body).digest('hex');
        const ok =
          pairing !== undefined &&
          pairingId === id &&
          holds(pairing.publicKey, agentRequestMessage(method, url.pathname, id, timestamp, hash), signature);
        signed.push({ method, path: url.pathname, ok });
        if (pairing === undefined) {
          reply(404, { error: { code: 'not-found' } });
          return;
        }
        if (!ok) {
          reply(401, { error: { code: 'agent-signature-invalid' } });
          return;
        }
        if (method === 'DELETE') pairings.delete(id);
        else pairing.port = (JSON.parse(body) as { port: number }).port;
        reply(204);
        return;
      }
      reply(404);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${String(port)}`;
  return {
    url: origin,
    code,
    email,
    pairings,
    signed,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}
