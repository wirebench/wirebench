/**
 * `wirebench mcp --http <port>` (spec §4.1): Streamable HTTP on 127.0.0.1 only. Every request needs
 * the bearer token; a browser page on another origin is refused before the token is even looked at
 * (DNS rebinding). One transport and one `McpServer` per session, all with the same gates.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export const TOKEN_VARIABLE = 'WIREBENCH_MCP_TOKEN';
/** The only address served. There is deliberately no option to change it. */
const HOST = '127.0.0.1';
const PATH = '/mcp';
/** The largest request body a client may send; the SDK answers 413 beyond it. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** A chosen token shorter than this is too easy to guess. */
const MIN_TOKEN_LENGTH = 16;
const MAX_SESSIONS = 64;
const MAX_CONNECTIONS = 128;

/** The chosen token is unusable; the message is what the user is told. */
export class InvalidTokenError extends Error {
  constructor() {
    super(`${TOKEN_VARIABLE} must be at least ${String(MIN_TOKEN_LENGTH)} characters with no spaces`);
    this.name = 'InvalidTokenError';
  }
}

/**
 * The variable, trimmed; unset or blank means a fresh random token.
 * @throws InvalidTokenError when a set token is short or has whitespace inside.
 */
export function resolveToken(env: NodeJS.ProcessEnv): { readonly token: string; readonly generated: boolean } {
  const set = env[TOKEN_VARIABLE]?.trim();
  if (set === undefined || set.length === 0) {
    return { token: randomBytes(32).toString('base64url'), generated: true };
  }
  if (set.length < MIN_TOKEN_LENGTH || /\s/.test(set)) {
    throw new InvalidTokenError();
  }
  return { token: set, generated: false };
}

export interface HttpServerOptions {
  /** `0` picks a free port (tests). */
  readonly port: number;
  readonly token: string;
  /** A fresh server for each session. */
  readonly createServer: () => McpServer;
  readonly log: (line: string) => void;
  /** Live sessions allowed at once; past it the least recently active one is closed. Default 64. */
  readonly maxSessions?: number;
}

export interface RunningHttpServer {
  /** `http://127.0.0.1:<port>/mcp`. */
  readonly url: string;
  /** The address the socket is bound to. */
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
  /** A counter reading, not a clock: the higher, the more recently a request reached the session. */
  lastActive: number;
}

/** The body says only what was wrong with the request, never what the request said. */
function refuse(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
}

/**
 * Both sides are hashed first, so the comparison is over equal-length digests and neither the
 * token's nor the guess's length changes how long it takes.
 */
function tokenMatches(header: string | undefined, token: string): boolean {
  const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header);
  const given = createHash('sha256')
    .update(match?.[1] ?? '')
    .digest();
  const expected = createHash('sha256').update(token).digest();
  return timingSafeEqual(given, expected) && match !== null;
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const sessions = new Map<string, Session>();
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  // Sessions being opened right now, so a burst of initializes cannot overshoot the cap.
  let opening = 0;
  let activity = 0;
  let origins: ReadonlySet<string> = new Set();
  let hosts: ReadonlySet<string> = new Set();

  /** The live session that went longest without a request. */
  const leastRecentlyActive = (): [string, Session] | undefined => {
    let oldest: [string, Session] | undefined;
    for (const entry of sessions) {
      if (oldest === undefined || entry[1].lastActive < oldest[1].lastActive) {
        oldest = entry;
      }
    }
    return oldest;
  };

  const openSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // The SDK client's `close()` never sends DELETE, so a closed agent leaves its session behind.
    // At the cap the session idle longest makes room; only slots all still initializing refuse.
    while (sessions.size + opening >= maxSessions) {
      const victim = leastRecentlyActive();
      if (victim === undefined) {
        refuse(res, 503, 'Too many sessions; try again shortly');
        return;
      }
      // Out of the map first, so a concurrent initialize picks the next one, not this one again.
      sessions.delete(victim[0]);
      await victim[1].server.close();
    }
    opening += 1;
    let counted = true;
    const settled = (): void => {
      if (counted) {
        counted = false;
        opening -= 1;
      }
    };
    let server: McpServer | undefined;
    try {
      server = options.createServer();
      const opened = server;
      // The SDK's 400 for a bad `mcp-protocol-version` reflects that header back to the authenticated
      // caller only, which is fine. Log the error message alone: never `extra.requestInfo` in a message
      // handler, because it carries the request's `authorization` header.
      opened.server.onerror = (error) => {
        options.log(`wirebench mcp: ${error.message}`);
      };
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        maxRequestBodySize: MAX_BODY_BYTES,
        onsessioninitialized: (id) => {
          activity += 1;
          sessions.set(id, { transport, server: opened, lastActive: activity });
          settled();
        },
      });
      // Set before `connect`, which chains onto it: a session ends however its transport closes
      // (the client's DELETE, or this server closing it), so the map cannot outgrow the live sessions.
      transport.onclose = () => {
        if (transport.sessionId !== undefined) {
          sessions.delete(transport.sessionId);
        }
      };
      // The SDK's class declares optional members its `Transport` interface requires, which
      // `exactOptionalPropertyTypes` rejects; it is the SDK's documented pairing.
      await opened.connect(transport as Transport);
      await transport.handleRequest(req, res);
      if (transport.sessionId === undefined) {
        // Not a valid initialize: the transport has answered, and there is no session to keep.
        await opened.close();
      }
    } catch (error) {
      await server?.close().catch(() => undefined);
      throw error;
    } finally {
      settled();
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      refuse(res, 403, 'Origin not allowed');
      return;
    }
    if (req.headers.host === undefined || !hosts.has(req.headers.host.toLowerCase())) {
      refuse(res, 403, 'Host not allowed');
      return;
    }
    if (!tokenMatches(req.headers.authorization, options.token)) {
      refuse(res, 401, `Missing or wrong bearer token (${TOKEN_VARIABLE})`, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    if (new URL(req.url ?? '/', `http://${HOST}`).pathname !== PATH) {
      refuse(res, 404, `Not found; the MCP endpoint is ${PATH}`);
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        refuse(res, 404, 'Unknown session; initialize a new one');
        return;
      }
      activity += 1;
      session.lastActive = activity;
      await session.transport.handleRequest(req, res);
      return;
    }
    await openSession(req, res);
  };

  // `requireHostHeader: false` lets a request with no Host reach the check above, which refuses it.
  const http = createServer({ requireHostHeader: false }, (req, res) => {
    handle(req, res).catch((error: unknown) => {
      options.log(`wirebench mcp: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        refuse(res, 500, 'Internal error');
      } else {
        res.end();
      }
    });
  });
  // A local process can still hold sockets open, and these two bounds keep that to a nuisance: at
  // most 128 connections, and a connection that never finishes its headers is dropped after 10 s.
  http.maxConnections = MAX_CONNECTIONS;
  http.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, HOST, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const bound = http.address() as AddressInfo;
  origins = new Set([`http://localhost:${String(bound.port)}`, `http://${HOST}:${String(bound.port)}`]);
  hosts = new Set([`localhost:${String(bound.port)}`, `${HOST}:${String(bound.port)}`]);

  return {
    url: `http://${HOST}:${String(bound.port)}${PATH}`,
    host: bound.address,
    port: bound.port,
    close: async () => {
      await Promise.all([...sessions.values()].map((session) => session.server.close()));
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        http.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
