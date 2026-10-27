/**
 * WebSocket's share of the IPC registry (kind modules spec §4.3): its channels and events, with
 * the names, groups and payloads they always had. `ipc.ts` composes them with core's.
 */
import { defineChannel, defineEvent } from '../../ipc-contract.js';
import { apiIdRequestSchema } from '../../wire-base.js';
import {
  apiAsyncApiApplyUpdateResponseSchema,
  apiImportAsyncApiResponseSchema,
  requestPreflightResponseSchema,
} from '../../wire-types.js';
import {
  apiAsyncApiApplyUpdateRequestSchema,
  apiAsyncApiPlanUpdateResponseSchema,
  apiAsyncApiServersRequestSchema,
  apiAsyncApiServersResponseSchema,
  apiImportAsyncApiRequestSchema,
  requestOpenWsRequestSchema,
  requestPreflightWsRequestSchema,
  requestWsCloseRequestSchema,
  requestWsCloseResponseSchema,
  requestWsSendRequestSchema,
  requestWsSendResponseSchema,
  wsExchangeSummarySchema,
  wsLiveEventSchema,
} from './wire.js';

/** WebSocket's IPC channels, by the group each sits in; `ipc.ts` spreads them into `channels`. */
export const wsChannels = {
  request: {
    /**
     * Opens a WebSocket session from a saved request and drives it by `sendId`: this invoke stays
     * pending for the life of the session and resolves with the whole exchange once it closes,
     * while `events.ws.live` reports the handshake and each frame as they happen.
     */
    openWs: defineChannel('request.openWs', requestOpenWsRequestSchema, wsExchangeSummarySchema),
    /** One message on an open WebSocket session, named by the same `sendId` the open used. */
    wsSend: defineChannel('request.wsSend', requestWsSendRequestSchema, requestWsSendResponseSchema),
    /** Closes an open WebSocket session. `{ closed: false }` when no such session is open. */
    wsClose: defineChannel('request.wsClose', requestWsCloseRequestSchema, requestWsCloseResponseSchema),
    preflightWs: defineChannel('request.preflightWs', requestPreflightWsRequestSchema, requestPreflightResponseSchema),
  },
  api: {
    importAsyncApi: defineChannel(
      'api.importAsyncApi',
      apiImportAsyncApiRequestSchema,
      apiImportAsyncApiResponseSchema,
    ),
    /** Reads an AsyncAPI document's WebSocket servers, for the Import dialog's server picker. */
    asyncApiServers: defineChannel(
      'api.asyncApiServers',
      apiAsyncApiServersRequestSchema,
      apiAsyncApiServersResponseSchema,
    ),
    /** Re-reads an AsyncAPI-imported API's source and reports what updating to it would change. */
    asyncApiPlanUpdate: defineChannel(
      'api.asyncApiPlanUpdate',
      apiIdRequestSchema,
      apiAsyncApiPlanUpdateResponseSchema,
    ),
    /** Applies that update: orphans, adds and rewrites requests, rewrites the cache, and saves. */
    asyncApiApplyUpdate: defineChannel(
      'api.asyncApiApplyUpdate',
      apiAsyncApiApplyUpdateRequestSchema,
      apiAsyncApiApplyUpdateResponseSchema,
    ),
  },
} as const;

/** WebSocket's main-to-renderer events; `ipc.ts` spreads them into `events`. */
export const wsEvents = {
  ws: {
    /** A WebSocket session in flight reporting what has arrived so far, keyed by the send's id. */
    live: defineEvent('ws.live', wsLiveEventSchema),
  },
} as const;
