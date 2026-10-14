/**
 * MCP's share of the IPC registry (kind modules spec §4.3; #79): its send, the catalogue refresh, the
 * machine's stdio approvals and the approval prompt's answer, and its events. `ipc.ts` composes them
 * with core's.
 */
import { z } from 'zod';
import { defineChannel, defineEvent } from '../../ipc-contract.js';
import {
  apiRefreshMcpCatalogueRequestSchema,
  apiRefreshMcpCatalogueResponseSchema,
  appMcpApprovalsResponseSchema,
  appMcpApproveRequestSchema,
  appMcpRevokeApprovalRequestSchema,
  mcpApprovalPromptEventSchema,
  mcpExchangeSummarySchema,
  mcpLiveEventSchema,
  requestCancelMcpRequestSchema,
  requestCancelMcpResponseSchema,
  requestSendMcpRequestSchema,
} from './wire.js';

/** MCP's IPC channels, by the group each sits in; `ipc.ts` spreads them into `channels`. */
export const mcpChannels = {
  request: {
    /**
     * One MCP send: connect, initialize, the request's one operation, close. Resolves with the whole
     * exchange; `events.mcp.live` reports each message as it goes. A stdio command line this machine
     * has not approved first asks, through `events.mcp.approval`.
     */
    sendMcp: defineChannel('request.sendMcp', requestSendMcpRequestSchema, mcpExchangeSummarySchema),
    /** Ends the session in flight under `sendId`. `{ cancelled: false }` when there is none. */
    cancelMcp: defineChannel('request.cancelMcp', requestCancelMcpRequestSchema, requestCancelMcpResponseSchema),
  },
  api: {
    /**
     * Fetches the server's tools, resources, templates and prompts into `catalogue.json` and its
     * metadata into `api.yaml`, through the same approval gate a send goes through.
     */
    refreshMcpCatalogue: defineChannel(
      'api.refreshMcpCatalogue',
      apiRefreshMcpCatalogueRequestSchema,
      apiRefreshMcpCatalogueResponseSchema,
    ),
  },
  app: {
    /** The stdio command lines this machine always allows. Kept per machine, never in a project. */
    mcpApprovals: defineChannel('app.mcpApprovals', z.undefined(), appMcpApprovalsResponseSchema),
    /** Forgets one approval; that command line asks again on its next send. Answers with the rest. */
    mcpRevokeApproval: defineChannel(
      'app.mcpRevokeApproval',
      appMcpRevokeApprovalRequestSchema,
      appMcpApprovalsResponseSchema,
    ),
    /** Answers an `mcp.approval` prompt: *Run once*, *Always allow* or *Cancel*. */
    mcpApprove: defineChannel('app.mcpApprove', appMcpApproveRequestSchema, z.object({})),
  },
} as const;

/** MCP's main-to-renderer events; `ipc.ts` spreads them into `events`. */
export const mcpEvents = {
  mcp: {
    /** One message of a session in flight, keyed by the send's id. */
    live: defineEvent('mcp.live', mcpLiveEventSchema),
    /** A stdio send waits on a command line this machine has not approved: `app.mcpApprove` answers. */
    approval: defineEvent('mcp.approval', mcpApprovalPromptEventSchema),
  },
} as const;
