/**
 * Routing a send from the browser (hosted edition spec §18.4): the channels a tab calls on the server host
 * before and after a send. `request.route` says where the send must go; `request.bundle` builds what the
 * paired agent sends; `exchanges.recordAgentSend` writes the agent's redacted exchange to History, so History
 * stays one list whichever host sent.
 */
import { z } from 'zod';
import { defineChannel } from './ipc-contract.js';
import { sendBundleSchema } from './agent.js';
import { restExchangeSummarySchema } from './kinds/rest/wire.js';
import { exchangeSummarySchema, soapResponseWireSchema } from './kinds/soap/wire.js';
import { failedExchangeWireSchema, httpExchangeWireSchema } from './wire-base.js';
import { historyEntrySchema } from './wire-types.js';

/**
 * Why a send must go through the agent. Each is something only the person's machine has: an address on
 * its network, a `${#System#…}` value, a secret source or team secret, a keystore on a path of its own,
 * its Kerberos ticket or NTLM logon, or a pin.
 */
export const SEND_NEEDS = [
  'private-target',
  'loopback-target',
  'system-values',
  'secret-source',
  'team-secret',
  'keystore',
  'kerberos',
  'ntlm-machine',
  'agent-cookies',
  'pinned',
] as const;
export const sendNeedSchema = z.enum(SEND_NEEDS);
export type SendNeed = z.infer<typeof sendNeedSchema>;

/** One saved request of one open project, under an environment (the project's active one when absent). */
export const requestRouteRequestSchema = z.object({
  projectId: z.string().min(1),
  itemId: z.string().min(1),
  environment: z.string().min(1).optional(),
});
export type RequestRouteRequest = z.infer<typeof requestRouteRequestSchema>;

/**
 * The bundle of one saved request. `confirmed` says the person was asked about the protected environment it
 * is sent under and said send: without it, a protected environment answers `needs-confirmation` (details
 * `environment`, its name), and the tab asks before calling again. The agent never asks.
 */
export const requestBundleRequestSchema = requestRouteRequestSchema.extend({ confirmed: z.boolean().optional() });
export type RequestBundleRequest = z.infer<typeof requestBundleRequestSchema>;

/**
 * What a tab shows beside the send button (§18.4): the pins on this request and its workspace, the server
 * workspace id a workspace pin is set by, and the target's host name, which the tab checks against the
 * cookie domains its agent holds (`agent-cookies`, a need only the tab can see). Absent on a host that does
 * not route.
 */
export const requestRouteInfoSchema = z.object({
  pins: z.object({ request: z.boolean(), workspace: z.boolean() }),
  workspaceId: z.string().min(1).max(256).optional(),
  targetHost: z.string().min(1).max(256).optional(),
});
export type RequestRouteInfo = z.infer<typeof requestRouteInfoSchema>;

/** Where the send goes: as today, or through the agent, with every reason it must. */
export const requestRouteResponseSchema = z.discriminatedUnion('route', [
  z.object({ route: z.literal('server'), info: requestRouteInfoSchema.optional() }),
  z.object({
    route: z.literal('agent'),
    info: requestRouteInfoSchema.optional(),
    needs: z.array(sendNeedSchema).min(1),
    /** Why: `unresolved` when the target's host did not resolve on the server (`private-target`). */
    detail: z.object({ reason: z.literal('unresolved') }).optional(),
  }),
]);
export type RequestRouteResponse = z.infer<typeof requestRouteResponseSchema>;

/** A pin to the agent, on a whole workspace (by its id) or one request; `null` takes the pin off. */
export const requestSetRoutePinRequestSchema = z.object({
  scope: z.enum(['workspace', 'request']),
  id: z.string().min(1).max(256),
  pin: z.literal('agent').nullable(),
});
export type RequestSetRoutePinRequest = z.infer<typeof requestSetRoutePinRequestSchema>;
export const requestSetRoutePinResponseSchema = z.object({ pin: z.literal('agent').nullable() });

const sentFromAgent = { sentFrom: z.literal('agent') };
const recordedItem = { projectId: z.string().min(1), itemId: z.string().min(1) };

/**
 * The most a body may hold in an agent's exchange uploaded for History. The tab trims each body as History
 * would (`history-body.ts`) before it uploads, so a trimmed one is far under this; the cap keeps the frame well
 * under the server socket's 32 MiB, which a whole large response would break.
 */
export const AGENT_RECORD_MAX_BODY_CHARS = 2 * 1024 * 1024;

const recordedBody = z.string().max(AGENT_RECORD_MAX_BODY_CHARS);
const recordedHttp = httpExchangeWireSchema.extend({
  bodyBase64: recordedBody,
  rawBodyBase64: recordedBody,
  rawRequestBase64: recordedBody,
  rawResponseBase64: recordedBody,
});
const recordedFields = {
  ...recordedItem,
  /** The response's size on the wire, before the tab trimmed it. */
  responseBytes: z.number().int().min(0).optional(),
};

/**
 * The agent's answer to one bundle send, as `agent.send` gave it (`sentFrom: 'agent'`), its bodies trimmed as
 * History trims them.
 */
export const exchangesRecordAgentSendRequestSchema = z.discriminatedUnion('kind', [
  z.object({
    ...recordedFields,
    kind: z.literal('rest'),
    result: restExchangeSummarySchema.extend({ ...sentFromAgent, text: recordedBody, http: recordedHttp }),
  }),
  z.object({
    ...recordedFields,
    kind: z.literal('soap'),
    result: exchangeSummarySchema.extend({
      ...sentFromAgent,
      http: recordedHttp,
      response: soapResponseWireSchema.extend({ envelopeXml: recordedBody }).optional(),
    }),
  }),
]);
export type ExchangesRecordAgentSendRequest = z.infer<typeof exchangesRecordAgentSendRequestSchema>;
/** The History entry written; absent when the project's History is not open or the file was busy. */
export const exchangesRecordAgentSendResponseSchema = z.object({ entry: historyEntrySchema.optional() });

/**
 * An agent send that failed: the HTTP Log's failure row the agent built for it (redacted there), carried on
 * the `agent.send` error's `details.failure`. The server host writes the same History entry and Log row a
 * failed send of its own leaves.
 */
export const exchangesRecordAgentFailureRequestSchema = z.object({
  ...recordedItem,
  kind: z.enum(['rest', 'soap']),
  failure: failedExchangeWireSchema.extend({ rawRequestBase64: recordedBody.optional() }),
});
export type ExchangesRecordAgentFailureRequest = z.infer<typeof exchangesRecordAgentFailureRequestSchema>;

/** The routing channels; spread into `request` and `exchanges` in the registry. */
export const agentRouteChannels = {
  request: {
    /** Where a send of the item must go (§18.4); a host that is not the server's answers `server`. */
    route: defineChannel('request.route', requestRouteRequestSchema, requestRouteResponseSchema),
    /** The send bundle the agent runs: the item's project files and secret names, never a secret value. */
    bundle: defineChannel('request.bundle', requestBundleRequestSchema, sendBundleSchema),
    /** Pins a workspace or a request to the agent, kept in the user's state on the server host. */
    setRoutePin: defineChannel(
      'request.setRoutePin',
      requestSetRoutePinRequestSchema,
      requestSetRoutePinResponseSchema,
    ),
  },
  exchanges: {
    /** Writes an agent send's exchange to History with `sentFrom: 'agent'`. */
    recordAgentSend: defineChannel(
      'exchanges.recordAgentSend',
      exchangesRecordAgentSendRequestSchema,
      exchangesRecordAgentSendResponseSchema,
    ),
    /** Writes a failed agent send's History entry and HTTP Log row, as a failed send on the server leaves. */
    recordAgentFailure: defineChannel(
      'exchanges.recordAgentFailure',
      exchangesRecordAgentFailureRequestSchema,
      exchangesRecordAgentSendResponseSchema,
    ),
  },
} as const;
