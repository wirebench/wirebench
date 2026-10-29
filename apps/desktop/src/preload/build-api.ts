import type { z } from 'zod';
import type { EventPayload, IpcChannel, IpcResult } from '@wirebench/wire/ipc';
import { channels, events } from '@wirebench/wire/ipc';
import { ALL_CAPABILITIES, type Capability } from '@wirebench/wire/capabilities';

/** Injected transport for `invoke`-style channels: send `request`, get the raw reply back. */
export type Invoke = (channelName: string, request: unknown) => Promise<unknown>;

/** Injected transport for `on`-style events: subscribe, return an unsubscribe function. */
export type On = (eventName: string, listener: (payload: unknown) => void) => () => void;

/** A tree of {@link IpcChannel}s, arbitrarily nested by domain (e.g. `{ app: { version } }`). */
type ChannelTree = { readonly [key: string]: IpcChannel<z.ZodType, z.ZodType> | ChannelTree };

/** Mirrors a {@link ChannelTree} shape, replacing each channel leaf with a callable invoker. */
type ApiFromChannels<T extends ChannelTree> = {
  readonly [K in keyof T]: T[K] extends IpcChannel<infer Req, infer Res>
    ? (request: z.infer<Req>) => Promise<IpcResult<z.infer<Res>>>
    : T[K] extends ChannelTree
      ? ApiFromChannels<T[K]>
      : never;
};

/** Recursively extracts every {@link IpcEvent} leaf out of an arbitrarily nested event tree. */
type EventsOf<T> = T extends { readonly name: string; readonly payload: z.ZodType }
  ? T
  : T extends object
    ? EventsOf<T[keyof T]>
    : never;

/** Every {@link IpcEvent} leaf found in {@link events}, flattened out of its nested tree. */
type AllEvents = EventsOf<typeof events>;

/** Event name -> payload map derived from {@link events}. */
type WirebenchEventMap = { [E in AllEvents as E['name']]: EventPayload<E> };

/**
 * The API surface exposed on `window.wirebench`: one callable invoker per channel, mirroring
 * the shape of {@link channels}, plus a single generic `on` for subscribing to events.
 */
/**
 * Every channel a window calls: the registry without the local agent's own group (`agent.*`, spec §18.1),
 * which a paired agent serves to a browser tab over its own socket and no window's host serves.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to leave it out
const { agent: _agentChannels, ...windowChannels } = channels;

export type WirebenchApi = ApiFromChannels<typeof windowChannels> & {
  on<Name extends keyof WirebenchEventMap>(
    name: Name,
    listener: (payload: WirebenchEventMap[Name]) => void,
  ): () => void;
  /**
   * Environment values baked in at preload time, not IPC calls, because the renderer has no
   * `process.env` and an IPC round trip lands after the first paint.
   *
   * `e2e` mirrors main's `WIREBENCH_E2E` env var, so the renderer can tell a Playwright-driven
   * build apart from a real user's. Used to gate the `__wirebenchMonaco` handle e2e specs need
   * (see `editor/markers.ts`) — nothing beyond `import.meta.env.DEV` should ever need it.
   *
   * `osTheme` is `nativeTheme.shouldUseDarkColors` as main computed it when the window was
   * created (`main/windows.ts` passes it through `additionalArguments`). It seeds the `system`
   * theme preference before the first paint; `theme.get`/`theme.changed` keep it current
   * afterwards. The renderer never computes it itself.
   *
   * `fixedLayout` mirrors `WIREBENCH_E2E_FIXED_LAYOUT`: an e2e run whose specs were written for the
   * default window keeps that layout on a CI runner whose small screen clamps the window, instead
   * of stacking the REST editor and collapsing the console the way a small window does. It also opens
   * the console in a fresh workspace, which a user's first run keeps collapsed until the first send.
   *
   * `sendTemplatesUnasked` mirrors `WIREBENCH_E2E_SEND_TEMPLATES`: e2e specs send freshly generated
   * requests, template "?" values and all, so the question a send asks about them (#728) is skipped
   * there, except in the spec that tests it.
   *
   * `host` says which program built this API: the Electron preload, or the browser bootstrap over the
   * server's host socket (hosted edition spec §3.1). `capabilities` are what the connected host can do;
   * the desktop has every one, the browser what the socket's hello frame lists. The renderer reads them
   * through `hasCapability` only and never compares `host`.
   *
   * `signOut` is set by the browser bootstrap only: a tab's account is held by the server, which refuses
   * `account.signOut`, so the tab ends its session with the root `/sign-out` instead (hosted edition spec
   * §17.2). The preload never sets it; the renderer offers its plain *Sign out* only when it is there.
   *
   * `onOsThemeChanged` is a live OS-theme source the page itself has: the browser bootstrap sets it over
   * `prefers-color-scheme`, since the server has no OS theme of the user's. When it is there the renderer
   * follows it and not `theme.get`/`theme.changed`; the preload leaves it unset, as main's `nativeTheme`
   * is the authority on the desktop.
   */
  env: {
    readonly e2e: boolean;
    readonly osTheme: 'dark' | 'light';
    readonly host: 'electron' | 'browser';
    readonly capabilities: readonly Capability[];
    readonly fixedLayout?: boolean;
    readonly sendTemplatesUnasked?: boolean;
    readonly signOut?: () => void;
    readonly onOsThemeChanged?: (listener: (os: 'dark' | 'light') => void) => () => void;
  };
  /**
   * The path on this machine of a file dropped from the OS (`webUtils.getPathForFile`), or `''` for one
   * that has none. The Files tab copies dropped files by path.
   */
  pathForFile(file: File): string;
};

function isChannel(value: unknown): value is IpcChannel<z.ZodType, z.ZodType> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'request' in value &&
    'response' in value
  );
}

function buildChannelApi(tree: ChannelTree, invoke: Invoke): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, node] of Object.entries(tree)) {
    result[key] = isChannel(node) ? (request: unknown) => invoke(node.name, request) : buildChannelApi(node, invoke);
  }
  return result;
}

/**
 * Builds the `window.wirebench` API generically from the {@link channels} registry, given
 * the injected `invoke`/`on` transports. Kept free of any `electron` import so it can be
 * unit-tested with fake transports; `preload/index.ts` supplies the real `ipcRenderer`-backed
 * ones and never exposes `ipcRenderer` itself.
 */
export function buildApi(
  invoke: Invoke,
  on: On,
  env: WirebenchApi['env'] = { e2e: false, osTheme: 'dark', host: 'electron', capabilities: ALL_CAPABILITIES },
  pathForFile: (file: File) => string = () => '',
): WirebenchApi {
  const channelApi = buildChannelApi(windowChannels, invoke);
  return {
    ...channelApi,
    on: (name, listener) => on(name as string, listener as (payload: unknown) => void),
    env,
    pathForFile,
  } as WirebenchApi;
}
