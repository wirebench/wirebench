/**
 * The host bundle's entry (hosted edition spec §17.3): `scripts/bundle-host.mjs` bundles this file, with
 * `@wirebench/host` and `@wirebench/wire`, into `dist/host/bundle.js`, which `src/host/host-runtime.ts`
 * imports at start-up. Only the package root is imported: `@wirebench/host/desktop`
 * is the Electron shell's (`pnpm check:host-boundary`).
 *
 * `tsconfig.json` beside this file typechecks it against the host's own types, which is what holds the
 * server's structural copies (`HostCaller`, `ServerPlatform`, ...) to the real ones.
 */
import {
  createHost,
  HOST_CLOSE,
  HOST_LIMITS,
  runHostSocket as sharedRunHostSocket,
  serveCall,
  type HostOptions,
  type HostPlatform,
} from '@wirebench/host';
import { HOST_CLOSE as SERVER_CLOSE, HOST_LIMITS as SERVER_LIMITS } from '../src/host/errors.js';
import type { CreateServerHost, RunSharedHostSocket, ServerHost } from '../src/host/host-runtime.js';
import { createServerPlatform } from '../src/host/server-platform.js';

/** How long a new tab waits for another of the user's sockets to close before it counts as a second tab. */
const RELOAD_GRACE_MS = 1500;

export const createServerHost: CreateServerHost = async (input) => {
  const platform: HostPlatform = createServerPlatform(input);
  const options: HostOptions = {
    // Sends from here go out from the server: History says so, and browser sends are routed (§18.4).
    sendOrigin: 'server',
    ...(input.server !== undefined ? { server: input.server } : {}),
    ...(input.onSecret !== undefined ? { onSecret: input.onSecret } : {}),
    ...(input.sendGate !== undefined ? { sendGate: input.sendGate } : {}),
  };
  const host = await createHost(platform, options);
  /** The sockets attached and not yet closing, and the quit paths of those that are. */
  const live = new Set<number>();
  const closing = new Set<Promise<void>>();
  const serverHost: ServerHost = {
    capabilities: [...platform.capabilities],
    osTheme: platform.app.osTheme(),
    channels: () => [...host.handlers.keys()],
    attach: (caller) => {
      live.add(caller.id);
      // A reload closes the old socket as the new one opens: its quit path saves and releases the workspace,
      // so the reopen waits for it. A second tab beside an open one starts at the picker (#879).
      host.attach(caller, {
        reopenLast: true,
        reopenWhen: async () => {
          // The old socket's close can reach the server after the new socket: give it a moment to arrive.
          const deadline = Date.now() + RELOAD_GRACE_MS;
          while (live.size > 1 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          await Promise.allSettled([...closing]);
          return live.size === 1 && live.has(caller.id);
        },
      });
    },
    serve: (caller, frame, allowed) => serveCall(host, caller, frame, allowed),
    detach: (callerId) => {
      live.delete(callerId);
      const done = host.detach(callerId);
      closing.add(done);
      void done.finally(() => closing.delete(done)).catch(() => undefined);
      return done;
    },
    dispose: () => host.shutdown(),
  };
  return serverHost;
};

/**
 * The shared socket loop, which `src/host/socket.ts` runs the server's sockets on; typechecked against
 * the server's structural copy of its shapes.
 */
export const runHostSocket: RunSharedHostSocket = sharedRunHostSocket;

/**
 * The server's mirrors of the close codes and limits (`src/host/errors.ts`) are held to the originals:
 * a code changed on one side and not the other no longer typechecks (both are `as const`).
 */
export const hostWire: { readonly close: typeof HOST_CLOSE; readonly limits: typeof HOST_LIMITS } = {
  close: SERVER_CLOSE,
  limits: SERVER_LIMITS,
};
