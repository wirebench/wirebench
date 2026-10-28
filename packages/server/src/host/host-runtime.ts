/**
 * The typed boundary between the server and the host bundle (hosted edition spec §17.3). `@wirebench/host`
 * is source-only (ADR-0033), so the build bundles it with esbuild into `dist/host/bundle.js` and the
 * server reaches it only through this file: the shapes below, which `host-bundle/entry.ts` is typechecked
 * against, and {@link loadHostRuntime}, which imports the bundle only when the browser client is on.
 *
 * Nothing here imports the host: the server's `tsc -b` would refuse its sources (TS6059).
 */
import type { ConnectedWebSocket, HttpExchange, HttpRequest } from '@wirebench/engine';
import type { ServerPlatformInput } from './server-platform.js';

/** Whoever a host call comes from: one browser socket. The host's `Caller`, structurally. */
export interface HostCaller {
  readonly id: number;
  /** Pushes `payload` on `channel`; a no-op once the caller is closed. */
  send(channel: string, payload: unknown): void;
  isClosed(): boolean;
  /** A socket never starts over (a drop is a close), so its implementation never calls `listener`. */
  onReset(listener: () => void, options?: { readonly on?: 'start' | 'commit' }): () => void;
  /** Runs `listener` once when the caller closes; returns a function that unsubscribes. */
  onClosed(listener: () => void): () => void;
}

/** One call off a socket: the client's id for the reply, the channel and its raw request. */
export interface HostCallFrame {
  readonly id: number;
  readonly channel: string;
  readonly request: unknown;
}

/** The answer to one {@link HostCallFrame}: its id and the handler's envelope. */
export type HostReplyFrame = { readonly id: number } & (
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string; readonly details?: unknown };
    }
);

/** What the host tells the embedder about a secret: its name, never its value (spec §17.4). */
export interface HostSecretEvent {
  readonly kind: 'written' | 'resolved';
  readonly name: string;
  readonly target?: string;
}

/** Everything one user's host is built from. */
export interface ServerHostInput extends ServerPlatformInput {
  /** The in-process transport to this server's own routes (`HostOptions.server`). */
  readonly server?: {
    readonly url: string;
    readonly send: (request: HttpRequest) => Promise<HttpExchange>;
    readonly connectLive: (wsUrl: string) => ConnectedWebSocket;
  };
  /** Told of every secret written or resolved, by name (`HostOptions.onSecret`). */
  readonly onSecret?: (event: HostSecretEvent) => void;
}

/** One user's host, as the server sees it. */
export interface ServerHost {
  /** The platform's capabilities, for the socket's hello frame. */
  readonly capabilities: readonly string[];
  /** The platform's theme, for the socket's hello frame. */
  readonly osTheme: 'dark' | 'light';
  /** Every channel this host registered (an allowlist decides which of them a socket may call). */
  channels(): readonly string[];
  /** A socket opened: gives it its own scope (workspace, cookie jar, current values). */
  attach(caller: HostCaller): void;
  /**
   * Serves one frame as `caller`. A channel the host lacks, or one `allowed` refuses, answers
   * `host-capability-missing`; never rejects.
   */
  serve(caller: HostCaller, frame: HostCallFrame, allowed?: (channel: string) => boolean): Promise<HostReplyFrame>;
  /** A socket closed: runs its scope's quit path; resolves once it is done. */
  detach(callerId: number): Promise<void>;
  /** Eviction: runs every remaining scope's quit path, as the desktop's quit does. */
  dispose(): Promise<void>;
}

/** What the bundle exports. */
export type CreateServerHost = (input: ServerHostInput) => Promise<ServerHost>;

/** The built bundle, beside this file's own compiled output; the same path from `src/host/` under a test. */
export const HOST_BUNDLE_URL = new URL('../../dist/host/bundle.js', import.meta.url);

const loaded = new Map<string, Promise<CreateServerHost>>();

/**
 * The bundle's `createServerHost`, or `undefined` when the browser client is off, in which case the
 * bundle is never imported, so a server without it neither pays for it nor needs it built.
 *
 * @throws Error when the switch is on and the bundle is missing or is not one this server built.
 */
export async function loadHostRuntime(options: {
  readonly browserClient: boolean;
  readonly bundle?: URL;
}): Promise<CreateServerHost | undefined> {
  if (!options.browserClient) return undefined;
  const url = (options.bundle ?? HOST_BUNDLE_URL).href;
  let loading = loaded.get(url);
  if (loading === undefined) {
    loading = importBundle(url);
    loaded.set(url, loading);
    // A failed import is not cached, so a later build can still be picked up.
    loading.catch(() => loaded.delete(url));
  }
  return await loading;
}

async function importBundle(url: string): Promise<CreateServerHost> {
  let module: { readonly createServerHost?: unknown };
  try {
    module = (await import(url)) as { readonly createServerHost?: unknown };
  } catch (error) {
    throw new Error('The host bundle could not be loaded; build the server (`pnpm build`) first', { cause: error });
  }
  if (typeof module.createServerHost !== 'function') {
    throw new Error('The host bundle does not export createServerHost');
  }
  return module.createServerHost as CreateServerHost;
}
