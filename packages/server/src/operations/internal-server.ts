/**
 * The internal listener (hosted edition spec §20.6): a second port, on `WIREBENCH_SERVER_INSTANCE_URL`, that the
 * other instances of a `multi` server dial to reach a terminal share this one holds. It serves `/internal/v1/*` and
 * nothing else; the public listener has no `/internal/` route at all, so it answers `404` there.
 *
 * - `GET /internal/v1/shares/:shareId` (a WebSocket): a viewer whose socket landed on another instance. The holder
 *   admits it as one more viewer with the viewer's identity, so the registry's viewer limit, control and audit apply
 *   once, here.
 * - `GET /internal/v1/shares/:shareId/info`: the join dialog's answer for that viewer.
 *
 * Each request carries a relay token (`Authorization: Bearer …`, see `relay-token.ts`) made for this holder and that
 * share; any other is answered `401` before an upgrade. The tenant is the token's, turned into a scope through the
 * tenant directory, as the bus builds one (`scopeFor`); an unknown tenant is refused the same way.
 *
 * **Where it binds.** The URL names this instance's address on the private network. A literal IP address or
 * `localhost` is bound as given, so the port is reachable on that interface only; a DNS name is bound on every IPv4
 * interface (`0.0.0.0`), since the name may resolve to an address of the network in front of the process (a
 * container's service name) rather than one of its own. The docs say the port must not be reachable from outside the
 * private network; the token is the guard if it is.
 *
 * Started in `multi` only (`serve.ts`), after the public listener; closed after the app, so a share that ends at
 * shutdown still tells its relayed viewers. A `single` server has none and never dials.
 */
import { isIP } from 'node:net';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { TERMINAL_SHARE_LIMITS, type TerminalShareInfo } from '@wirebench/engine';
import type { WebSocket } from 'ws';
import type { TenantScope } from '../tenancy/scope.js';
import { signRelayToken, verifyRelayToken, type RelayClaims } from './relay-token.js';

/** What the terminal-shares module serves on the internal listener. */
export interface ShareRelayHandlers {
  /** A relayed viewer's socket, its token checked; called synchronously, as `@fastify/websocket` requires. */
  join(socket: WebSocket, claims: RelayClaims, tenant: TenantScope): void;
  info(claims: RelayClaims, tenant: TenantScope): TerminalShareInfo | undefined;
}

/** What a module sees of the relay (`ctx.relay`), in `multi` only. */
export interface InstanceRelay {
  /** A token for `claims`, good for 30 s, for the holder `claims.holder` names. */
  token(claims: Omit<RelayClaims, 'expiresAt'>): string;
  /** Registers the share routes' handlers; the terminal-shares module calls it once, at registration. */
  serveShares(handlers: ShareRelayHandlers): void;
}

export interface InternalServerDeps {
  /** `WIREBENCH_SERVER_INSTANCE_URL`: the port listened on, and the host bound (see the module comment). */
  readonly url: string;
  /** This process's holder id: only a token made for it is accepted. */
  readonly holder: string;
  /** `relayKey(WIREBENCH_SERVER_SECRETS_KEY)`. */
  readonly key: Buffer;
  /** The tenant directory's scope for a tenant id; `undefined` for an unknown one. */
  readonly scopeFor: (tenantId: string) => Promise<TenantScope | undefined>;
  readonly now?: () => number;
}

const SHARE_ID = /^[a-z2-7]{26}$/;
const BEARER = /^Bearer ([A-Za-z0-9_.-]+)$/;

/** Where to bind for `url` (see the module comment). */
export function bindHostOf(url: string): string {
  const hostname = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');
  return isIP(hostname) !== 0 || hostname === 'localhost' ? hostname : '0.0.0.0';
}

export class InternalServer implements InstanceRelay {
  private readonly now: () => number;
  private handlers: ShareRelayHandlers | undefined;
  private app: FastifyInstance | undefined;
  /** The checked token and scope of each request, from its `onRequest` hook to its handler. */
  private readonly admitted = new WeakMap<FastifyRequest, { claims: RelayClaims; tenant: TenantScope }>();

  constructor(private readonly deps: InternalServerDeps) {
    this.now = deps.now ?? Date.now;
  }

  token(claims: Omit<RelayClaims, 'expiresAt'>): string {
    return signRelayToken(this.deps.key, claims, this.now());
  }

  serveShares(handlers: ShareRelayHandlers): void {
    this.handlers = handlers;
  }

  /** Listens on the URL's port; `log` is the app's, which exists only once the modules registered. */
  async start(log: FastifyBaseLogger): Promise<void> {
    const app = Fastify({ logger: false });
    this.app = app;
    await app.register(fastifyWebsocket, {
      // A relayed viewer sends what its public socket accepted, which is capped at this size.
      options: { maxPayload: TERMINAL_SHARE_LIMITS.maxMessageBytes },
      errorHandler: (error, socket) => {
        log.warn({ err: error }, 'a relayed share socket failed');
        socket.terminate();
      },
    });
    const admit = async (request: FastifyRequest): Promise<boolean> => {
      const shareId = (request.params as { shareId: string }).shareId;
      const match = BEARER.exec(request.headers.authorization ?? '');
      if (match === null) return false;
      const claims = verifyRelayToken(this.deps.key, match[1]!, { holder: this.deps.holder, shareId }, this.now());
      if (claims === undefined) return false;
      const tenant = await this.deps.scopeFor(claims.tenantId);
      if (tenant === undefined) return false;
      this.admitted.set(request, { claims, tenant });
      return true;
    };
    const onRequest = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (this.handlers === undefined || !SHARE_ID.test((request.params as { shareId: string }).shareId)) {
        await reply.code(404).send();
        return;
      }
      if (!(await admit(request))) await reply.code(401).send();
    };
    app.get(
      '/internal/v1/shares/:shareId',
      { websocket: true, onRequest },
      (socket: WebSocket, request: FastifyRequest) => {
        const found = this.admitted.get(request);
        if (found === undefined || this.handlers === undefined) {
          socket.terminate();
          return;
        }
        socket.on('error', (error) => {
          log.warn({ err: error }, 'a relayed share socket failed');
        });
        this.handlers.join(socket, found.claims, found.tenant);
      },
    );
    app.get('/internal/v1/shares/:shareId/info', { onRequest }, async (request, reply) => {
      const found = this.admitted.get(request);
      const info = found !== undefined ? this.handlers?.info(found.claims, found.tenant) : undefined;
      if (info === undefined) return reply.code(404).send();
      return reply.code(200).send(info);
    });
    app.setNotFoundHandler((_request, reply) => reply.code(404).send());
    app.setErrorHandler((error, _request, reply) => {
      log.warn({ err: error }, 'an internal request failed');
      return reply.code(500).send();
    });
    await app.listen({ host: bindHostOf(this.deps.url), port: Number(new URL(this.deps.url).port) });
  }

  /** Stops listening and closes every relayed socket still open. Idempotent. */
  async close(): Promise<void> {
    const app = this.app;
    this.app = undefined;
    await app?.close();
  }
}
