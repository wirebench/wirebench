/**
 * `wirebench run`'s capture source (callback-assertion spec §4): the webhook manage API of the
 * Wirebench Server at `WIREBENCH_SERVER_URL`, read with the CI token in `WIREBENCH_SERVER_TOKEN`.
 * It asks `ci/whoami` once, lazily, for the workspace, lists the hooks once, and pages captures 200 at
 * a time (`captureSourceOver`).
 *
 * The token goes into one header and nowhere else. A message names the server's origin and its
 * answer, never the request; `runCommand` also hands the token to the masker.
 */
import {
  WirebenchError,
  captureSchema,
  captureSourceOver,
  capturesResponseSchema,
  ciWhoamiResponseSchema,
  sendHttp,
  unavailableCaptureSource,
} from '@wirebench/engine';
import type { CaptureSource, HttpExchange, HttpRequest, ProxyOptions } from '@wirebench/engine';

export const CAPTURES_UNSET_MESSAGE = 'set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks';

/** Each read has its own: a hung one must not outlast a callback's `withinMs`. */
const TIMEOUT_MS = 10_000;

/**
 * A hook as a CI token sees it: the server leaves out its `url` (the catch secret), so only the
 * fields a name lookup needs are required. The engine's `catchUrlsResponseSchema` demands `url`.
 */
const hooksSchema: Parser<readonly { readonly id: string; readonly name: string }[]> = {
  safeParse(value) {
    if (!Array.isArray(value)) return { success: false };
    const hooks: { id: string; name: string }[] = [];
    for (const item of value as unknown[]) {
      const { id, name } = (item ?? {}) as { id?: unknown; name?: unknown };
      if (typeof id !== 'string' || typeof name !== 'string') return { success: false };
      hooks.push({ id, name });
    }
    return { success: true, data: hooks };
  },
};

/** What `get` needs of a zod schema, without the CLI depending on zod itself. */
interface Parser<T> {
  safeParse(value: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

export interface ServerCapturesDeps {
  /** The engine's `sendHttp` by default; a test seam. */
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  readonly proxyFor?: (url: string) => ProxyOptions | undefined;
}

function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function captureSourceFromEnv(
  env: NodeJS.ProcessEnv,
  deps: ServerCapturesDeps = {},
): { readonly source: CaptureSource; readonly token?: string } {
  const url = variable(env, 'WIREBENCH_SERVER_URL');
  const token = variable(env, 'WIREBENCH_SERVER_TOKEN');
  if (url === undefined || token === undefined) {
    return { source: unavailableCaptureSource(CAPTURES_UNSET_MESSAGE), ...(token !== undefined ? { token } : {}) };
  }
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { source: unavailableCaptureSource('WIREBENCH_SERVER_URL is not a URL'), token };
  }
  const send = deps.send ?? ((request: HttpRequest) => sendHttp(request));

  const get = async <T>(path: string, schema: Parser<T>): Promise<T> => {
    const proxy = deps.proxyFor?.(origin);
    let exchange: HttpExchange;
    try {
      exchange = await send({
        url: `${origin}${path}`,
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        timeoutMs: TIMEOUT_MS,
        followRedirects: false,
        ...(proxy !== undefined ? { proxy } : {}),
      });
    } catch {
      // Not the cause: a transport error can quote the request it failed to send.
      throw new WirebenchError('server-unreachable', `Could not reach ${origin}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(exchange.body));
    } catch {
      json = undefined;
    }
    if (exchange.status < 200 || exchange.status >= 300) {
      const problem = json as { readonly code?: unknown; readonly message?: unknown } | undefined;
      const said =
        typeof problem?.code === 'string' && typeof problem.message === 'string'
          ? ` ${problem.code}: ${problem.message}`
          : '';
      throw new WirebenchError('server-refused', `${origin} answered ${String(exchange.status)}${said}`, {
        details: { status: exchange.status },
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new WirebenchError('server-bad-response', `${origin} answered with an unexpected shape`);
    return parsed.data;
  };

  let workspace: Promise<string> | undefined;
  const workspacePath = async (): Promise<string> => {
    workspace ??= get('/api/v1/ci/whoami', ciWhoamiResponseSchema).then(
      (who) => `/api/v1/workspaces/${encodeURIComponent(who.workspaceId)}`,
    );
    try {
      return await workspace;
    } catch (error) {
      workspace = undefined;
      throw error;
    }
  };
  const hookPath = async (hookId: string): Promise<string> =>
    `${await workspacePath()}/hooks/${encodeURIComponent(hookId)}`;

  const source = captureSourceOver({
    hooks: async () => get(`${await workspacePath()}/hooks`, hooksSchema),
    captures: async (hookId, page) => {
      const query = new URLSearchParams({
        ...(page.after !== undefined ? { after: page.after } : {}),
        limit: String(page.limit),
      });
      return get(`${await hookPath(hookId)}/captures?${query.toString()}`, capturesResponseSchema);
    },
    capture: async (hookId, captureId) =>
      get(`${await hookPath(hookId)}/captures/${encodeURIComponent(captureId)}`, captureSchema),
  });
  return { source, token };
}
