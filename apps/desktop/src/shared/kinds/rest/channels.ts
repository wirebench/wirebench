/**
 * REST's share of the IPC registry (kind modules spec §4.3): its channels and events, with
 * the names, groups and payloads they always had. `ipc.ts` composes them with core's.
 */
import { defineChannel, defineEvent } from '../../ipc-contract.js';
import {
  apiImportHarResponseSchema,
  apiImportHttpFileResponseSchema,
  apiImportOpenApiResponseSchema,
  apiImportPostmanResponseSchema,
  apiRestApplyUpdateResponseSchema,
  requestPreflightResponseSchema,
  requestSendToEnvironmentsResponseSchema,
} from '../../wire-types.js';
import {
  apiImportHarRequestSchema,
  apiImportHttpEnvRequestSchema,
  apiImportHttpFileRequestSchema,
  apiImportOpenApiRequestSchema,
  apiImportPostmanRequestSchema,
  apiImportPostmanVariablesRequestSchema,
  apiImportPostmanVariablesResponseSchema,
  apiImportWebhooksRequestSchema,
  apiImportWebhooksResponseSchema,
  apiInspectHttpFileRequestSchema,
  apiInspectHttpFileResponseSchema,
  apiRestApplyUpdateRequestSchema,
  apiRestPlanUpdateRequestSchema,
  apiRestPlanUpdateResponseSchema,
  apiWebhookItemsRequestSchema,
  apiWebhookItemsResponseSchema,
  exchangesSaveRestBodyRequestSchema,
  exchangesSaveRestBodyResponseSchema,
  historyResendRestRequestSchema,
  requestImportCurlRequestSchema,
  requestImportCurlResponseSchema,
  requestPreflightRestRequestSchema,
  requestRestBodySchemaRequestSchema,
  requestRestHeadersRequestSchema,
  requestRestHeadersResponseSchema,
  requestRestBodySchemaResponseSchema,
  requestSendRestRequestSchema,
  requestSendToEnvironmentsRequestSchema,
  restExchangeSummarySchema,
  restLiveEventSchema,
} from './wire.js';

/** REST's IPC channels, by the group each sits in; `ipc.ts` spreads them into `channels`. */
export const restChannels = {
  request: {
    /**
     * A REST send. Separate from `request.send` rather than a discriminated union of it: the two
     * payloads share no fields — one carries an envelope the user typed, the other a request id and
     * the editor's draft — and one channel for both would give every SOAP call a kind tag it never
     * reads.
     */
    sendRest: defineChannel('request.sendRest', requestSendRestRequestSchema, restExchangeSummarySchema),
    /**
     * One saved request sent under several environments in parallel, each resolved in main as if
     * it were active. `request.cancel` with the `batchId` stops every send still running.
     */
    sendToEnvironments: defineChannel(
      'request.sendToEnvironments',
      requestSendToEnvironmentsRequestSchema,
      requestSendToEnvironmentsResponseSchema,
    ),
    preflightRest: defineChannel(
      'request.preflightRest',
      requestPreflightRestRequestSchema,
      requestPreflightResponseSchema,
    ),
    /**
     * The headers a send of the REST request would put on the wire, each with its source, resolved
     * as the send resolves it with nothing sent; secrets masked unless the session shows them.
     */
    restHeaders: defineChannel(
      'request.restHeaders',
      requestRestHeadersRequestSchema,
      requestRestHeadersResponseSchema,
    ),
    importCurl: defineChannel('request.importCurl', requestImportCurlRequestSchema, requestImportCurlResponseSchema),
    /** The JSON schema of the body a REST request's operation declares, or `null`; feeds the body form. */
    restBodySchema: defineChannel(
      'request.restBodySchema',
      requestRestBodySchemaRequestSchema,
      requestRestBodySchemaResponseSchema,
    ),
  },
  api: {
    importOpenApi: defineChannel('api.importOpenApi', apiImportOpenApiRequestSchema, apiImportOpenApiResponseSchema),
    importPostman: defineChannel('api.importPostman', apiImportPostmanRequestSchema, apiImportPostmanResponseSchema),
    importHar: defineChannel('api.importHar', apiImportHarRequestSchema, apiImportHarResponseSchema),
    inspectHttpFile: defineChannel(
      'api.inspectHttpFile',
      apiInspectHttpFileRequestSchema,
      apiInspectHttpFileResponseSchema,
    ),
    importHttpFile: defineChannel(
      'api.importHttpFile',
      apiImportHttpFileRequestSchema,
      apiImportHttpFileResponseSchema,
    ),
    importHttpEnv: defineChannel(
      'api.importHttpEnv',
      apiImportHttpEnvRequestSchema,
      apiImportPostmanVariablesResponseSchema,
    ),
    importPostmanEnvironment: defineChannel(
      'api.importPostmanEnvironment',
      apiImportPostmanVariablesRequestSchema,
      apiImportPostmanVariablesResponseSchema,
    ),
    importPostmanGlobals: defineChannel(
      'api.importPostmanGlobals',
      apiImportPostmanVariablesRequestSchema,
      apiImportPostmanVariablesResponseSchema,
    ),
    /** Reads a REST API's source (or a chosen one) and reports what updating to it would change. */
    restPlanUpdate: defineChannel(
      'api.restPlanUpdate',
      apiRestPlanUpdateRequestSchema,
      apiRestPlanUpdateResponseSchema,
    ),
    /** Applies that update: orphans, adds and rewrites requests, rewrites the cache, and saves. */
    restApplyUpdate: defineChannel(
      'api.restApplyUpdate',
      apiRestApplyUpdateRequestSchema,
      apiRestApplyUpdateResponseSchema,
    ),
    /** An API's webhooks and callbacks, for the *Import webhooks…* picker. */
    webhookItems: defineChannel('api.webhookItems', apiWebhookItemsRequestSchema, apiWebhookItemsResponseSchema),
    /** Places the chosen webhooks/callbacks into the API's linked webhook group, creating it if needed. */
    importWebhooks: defineChannel(
      'api.importWebhooks',
      apiImportWebhooksRequestSchema,
      apiImportWebhooksResponseSchema,
    ),
  },
  exchanges: {
    // The REST response body, written to a file the *user* picks. The bytes never cross the bridge:
    // main holds them in the exchange cache and writes them itself.
    saveRestBody: defineChannel(
      'exchanges.saveRestBody',
      exchangesSaveRestBodyRequestSchema,
      exchangesSaveRestBodyResponseSchema,
    ),
  },
  history: {
    resendRest: defineChannel('history.resendRest', historyResendRestRequestSchema, restExchangeSummarySchema),
  },
} as const;

/** REST's main-to-renderer events; `ipc.ts` spreads them into `events`. */
export const restEvents = {
  rest: {
    /** A REST send whose response is an event stream, reporting rows as they arrive, keyed by `sendId`. */
    live: defineEvent('rest.live', restLiveEventSchema),
  },
} as const;
