/**
 * The host bundle's entry (hosted edition spec §17.3): `scripts/bundle-host.mjs` bundles this file, with
 * `@wirebench/host` and `@wirebench/wire`, into `dist/host/bundle.js`, which `src/host/host-runtime.ts`
 * imports when the browser client is on. Only the package root is imported: `@wirebench/host/desktop`
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

export const createServerHost: CreateServerHost = async (input) => {
  const platform: HostPlatform = createServerPlatform(input);
  const options: HostOptions = {
    ...(input.server !== undefined ? { server: input.server } : {}),
    ...(input.onSecret !== undefined ? { onSecret: input.onSecret } : {}),
  };
  const host = await createHost(platform, options);
  const serverHost: ServerHost = {
    capabilities: [...platform.capabilities],
    osTheme: platform.app.osTheme(),
    channels: () => [...host.handlers.keys()],
    attach: (caller) => host.attach(caller),
    serve: (caller, frame, allowed) => serveCall(host, caller, frame, allowed),
    detach: (callerId) => host.detach(callerId),
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
