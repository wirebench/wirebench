/**
 * Two tenants on one hosted server (tenancy Task 18, hosted edition spec §19.13): acme (A) and beta (B), created
 * through `TenantAdmin` before the server is built, each reached by its own `Host`. Every query runs as the app role
 * under the forced policy of `0021`, so a case here proves the policy and the module's scoping together, not a filter
 * a repository never had.
 *
 * `inject` sends a request on the tenant's host; `user` writes a user into the tenant's own rows; `socketScope` is the
 * `/api/v1` scope a WebSocket upgrade can be injected into with a `Host` header (Node's WebSocket client cannot set
 * one).
 */
import type { FastifyInstance, InjectOptions, LightMyRequestResponse, RouteOptions } from 'fastify';
import type { ServerConfig } from '../../../../src/config.js';
import type { ServerModule } from '../../../../src/context.js';
import type { OidcProvider } from '../../../../src/identity/oidc.js';
import { TenantAdmin } from '../../../../src/tenancy/directory.js';
import type { TenantScope } from '../../../../src/tenancy/scope.js';
import type { TenantDb } from '../../../../src/tenancy/tenant-db.js';
import { directoryOf } from '../../../../src/tenancy/tenancy.js';
import {
  identityHarness,
  signedInUser,
  type IdentityHarness,
  type SignedInUser,
  type TestClock,
} from '../../../helpers/identity.js';

export const APP_DOMAIN = 'example.test';

export const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: APP_DOMAIN });

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface Tenant {
  readonly slug: 'acme' | 'beta';
  readonly scope: TenantScope;
  /** The tenant's own database: fixtures are written and read back through it. */
  readonly tdb: TenantDb;
  /** `<slug>.example.test`, the `Host` the resolver serves this tenant on. */
  readonly host: string;
  /** `https://<slug>.example.test`, the tenant's origin for a cookie-authenticated write. */
  readonly origin: string;
  /** A user in this tenant's rows, with one device token. */
  user(input: Omit<Parameters<typeof signedInUser>[1], 'tdb'>): Promise<SignedInUser>;
  /** A request on this tenant's host. */
  inject(options: InjectOptions): Promise<LightMyRequestResponse>;
  /** One request under `/api/v1` as `user` (anonymous when `undefined`) on this tenant's host. */
  call<T = unknown>(
    user: SignedInUser | undefined,
    method: Method,
    path: string,
    payload?: object,
  ): Promise<{ readonly status: number; readonly body: T }>;
}

export interface TwoTenants {
  readonly h: IdentityHarness;
  readonly a: Tenant;
  readonly b: Tenant;
  /** The `/api/v1` scope, captured after every module registered: `injectWS` is decorated on it when one module brought `@fastify/websocket`. */
  readonly api: FastifyInstance;
  close(): Promise<void>;
}

/** Captures the `/api/v1` scope; registered after every module. Its name only satisfies the type: it adds no route. */
function scopeProbe(onScope: (app: FastifyInstance) => void): ServerModule {
  return {
    name: 'agent',
    // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
    register: async (app) => {
      onScope(app);
    },
  };
}

/**
 * A hosted server with `modules` after identity, and tenants acme and beta. `env` and `provider` as for
 * {@link identityHarness}.
 */
export async function twoTenants(
  options: {
    readonly env?: Record<string, string>;
    readonly provider?: OidcProvider;
    readonly modules?: (clock: TestClock) => readonly ServerModule[];
    readonly logStream?: NodeJS.WritableStream;
    /** Every route the server registers. */
    readonly onRoute?: (route: RouteOptions) => void;
    /** A database an earlier call made: the throwaway schema of the isolation suite's negative run. */
    readonly db?: IdentityHarness['db'];
  } = {},
): Promise<TwoTenants> {
  const scopes: Partial<Record<'acme' | 'beta', TenantScope>> = {};
  let api: FastifyInstance | undefined;
  const h = await identityHarness({
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.logStream !== undefined ? { logStream: options.logStream } : {}),
    ...(options.onRoute !== undefined ? { onRoute: options.onRoute } : {}),
    ...(options.db !== undefined ? { db: options.db } : {}),
    configure: hosted,
    modules: (clock) => [
      ...(options.modules?.(clock) ?? []),
      scopeProbe((app) => {
        api = app;
      }),
    ],
    beforeBuild: async (db, ctx) => {
      const admin = new TenantAdmin(db, directoryOf(ctx.tenancy));
      for (const slug of ['acme', 'beta'] as const) scopes[slug] = (await admin.create({ slug, name: slug })).scope;
    },
  });
  const tenant = (slug: 'acme' | 'beta'): Tenant => {
    const scope = scopes[slug]!;
    const tdb = h.ctx.tenancy.db(scope);
    const host = `${slug}.${APP_DOMAIN}`;
    const inject = (request: InjectOptions) =>
      h.app.inject({ ...request, headers: { ...(request.headers ?? {}), host } });
    return {
      slug,
      scope,
      tdb,
      host,
      origin: `https://${host}`,
      user: (input) => signedInUser(h, { ...input, tdb }),
      inject,
      call: async <T>(user: SignedInUser | undefined, method: Method, path: string, payload?: object) => {
        const res = await inject({
          method,
          url: `/api/v1${path}`,
          ...(user !== undefined ? { headers: user.headers } : {}),
          ...(payload !== undefined ? { payload } : {}),
        });
        return { status: res.statusCode, body: (res.body.length > 0 ? res.json() : undefined) as T };
      },
    };
  };
  return { h, a: tenant('acme'), b: tenant('beta'), api: api!, close: () => h.close() };
}

/** Rows a tenant sees in `table`: the forced policy shows a unit its own only. */
export async function countIn(tenant: Tenant, table: string, where = 'true', params: unknown[] = []): Promise<number> {
  const result = await tenant.tdb.query<{ n: string }>(
    `select count(*)::text as n from ${table} where ${where}`,
    params,
  );
  return Number(result.rows[0]!.n);
}

const SOCKET_WAIT_MS = 20_000;

type Frame = { readonly type?: string; readonly id?: number; readonly [key: string]: unknown };

/** A WebSocket opened through `injectWS` on a tenant's host; JSON frames are parsed, binary ones dropped. */
export interface TestSocket {
  /** Every JSON frame so far, in arrival order. */
  readonly messages: Frame[];
  /** The first frame `match` accepts that no earlier wait returned; rejects on close or after the wait. */
  waitFor(match: (frame: Frame) => boolean, what?: string): Promise<Frame>;
  /** The first frame of `type` no earlier wait returned. */
  next(type: string): Promise<Frame>;
  send(message: unknown): void;
  close(): void;
  /** The close code. */
  readonly closed: Promise<number>;
}

/**
 * Opens `path` (the full path, `/api/v1/...`) on `tenant`'s host, with `headers` beside the `Host`; the listeners
 * are on before the socket opens.
 */
export async function openSocket(
  t: TwoTenants,
  tenant: Tenant,
  path: string,
  headers: Record<string, string> = {},
): Promise<TestSocket> {
  const messages: Frame[] = [];
  const taken = new Set<object>();
  const listeners: (() => void)[] = [];
  const changed = (): void => {
    for (const listener of listeners.splice(0)) listener();
  };
  let closedCode: number | undefined;
  let resolveClosed!: (code: number) => void;
  const closed = new Promise<number>((resolve) => (resolveClosed = resolve));
  const socket = await t.api.injectWS(
    path,
    { headers: { ...headers, host: tenant.host } },
    {
      onInit: (ws) => {
        ws.on('message', (data: Buffer, binary: boolean) => {
          if (!binary) messages.push(JSON.parse(data.toString('utf8')) as Frame);
          changed();
        });
        ws.on('close', (code: number) => {
          closedCode = code;
          resolveClosed(code);
          changed();
        });
      },
    },
  );
  const waitFor = (match: (frame: Frame) => boolean, what = 'matching'): Promise<Frame> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ${what} frame; saw ${JSON.stringify(messages).slice(0, 2000)}`)),
        SOCKET_WAIT_MS,
      );
      const check = (): void => {
        const found = messages.find((message) => match(message) && !taken.has(message));
        if (found !== undefined) {
          clearTimeout(timer);
          taken.add(found);
          resolve(found);
        } else if (closedCode !== undefined) {
          clearTimeout(timer);
          reject(new Error(`no ${what} frame: the socket closed ${String(closedCode)}`));
        } else listeners.push(check);
      };
      check();
    });
  return {
    messages,
    waitFor,
    next: (type) => waitFor((message) => message.type === type, type),
    send: (message) => {
      socket.send(JSON.stringify(message));
    },
    close: () => {
      socket.close(1000);
    },
    closed,
  };
}
