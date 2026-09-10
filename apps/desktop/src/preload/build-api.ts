import type { z } from 'zod';
import type { EventPayload, IpcChannel, IpcResult } from '../shared/ipc.js';
import { channels, events } from '../shared/ipc.js';

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
export type WirebenchApi = ApiFromChannels<typeof channels> & {
  on<Name extends keyof WirebenchEventMap>(
    name: Name,
    listener: (payload: WirebenchEventMap[Name]) => void,
  ): () => void;
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
export function buildApi(invoke: Invoke, on: On): WirebenchApi {
  const channelApi = buildChannelApi(channels, invoke);
  return {
    ...channelApi,
    on: (name, listener) => on(name as string, listener as (payload: unknown) => void),
  } as WirebenchApi;
}
