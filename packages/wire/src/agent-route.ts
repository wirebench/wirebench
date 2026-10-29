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
import { exchangeSummarySchema } from './kinds/soap/wire.js';
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

/** Where the send goes: as today, or through the agent, with every reason it must. */
export const requestRouteResponseSchema = z.discriminatedUnion('route', [
  z.object({ route: z.literal('server') }),
  z.object({
    route: z.literal('agent'),
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

/** The agent's answer to one bundle send, as `agent.send` gave it: the kind's result, `sentFrom: 'agent'`. */
export const exchangesRecordAgentSendRequestSchema = z.discriminatedUnion('kind', [
  z.object({ ...recordedItem, kind: z.literal('rest'), result: restExchangeSummarySchema.extend(sentFromAgent) }),
  z.object({ ...recordedItem, kind: z.literal('soap'), result: exchangeSummarySchema.extend(sentFromAgent) }),
]);
export type ExchangesRecordAgentSendRequest = z.infer<typeof exchangesRecordAgentSendRequestSchema>;
/** The History entry written; absent when the project's History is not open or the file was busy. */
export const exchangesRecordAgentSendResponseSchema = z.object({ entry: historyEntrySchema.optional() });

/** The routing channels; spread into `request` and `exchanges` in the registry. */
export const agentRouteChannels = {
  request: {
    /** Where a send of the item must go (§18.4); a host that is not the server's answers `server`. */
    route: defineChannel('request.route', requestRouteRequestSchema, requestRouteResponseSchema),
    /** The send bundle the agent runs: the item's project files and secret names, never a secret value. */
    bundle: defineChannel('request.bundle', requestRouteRequestSchema, sendBundleSchema),
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
  },
} as const;
