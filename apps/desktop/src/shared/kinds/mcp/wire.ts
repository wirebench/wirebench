/**
 * The wire shapes only MCP uses (kind modules spec §4.2; #79): servers, requests, the catalogue, a
 * session's exchange and its live messages, and the stdio approval round trip. Imports
 * `wire-base.ts` and never another kind's file.
 */

import { z } from 'zod';
import {
  authConfigWireSchema,
  keyValueWireSchema,
  requestAssertionResultWireSchema,
  requestAssertionWireSchema,
  requestScriptsWireSchema,
  restFolderWireSchema,
  scriptResultWireSchema,
  timingsWireSchema,
} from '../../wire-base.js';

/** An MCP folder, sharing the project's `folders` list with REST, gRPC and WebSocket. */
export const mcpFolderWireSchema = restFolderWireSchema;
export type McpFolderWire = z.infer<typeof mcpFolderWireSchema>;

// ——— Servers ————————————————————————————————————————————————————————————————————————————————

/**
 * A local server, spawned with no shell as `command` with `args`. `cwd` is relative to the project
 * folder; absent, the server runs in the project folder.
 */
export const mcpStdioTransportWireSchema = z.object({
  type: z.literal('stdio'),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string().optional(),
  env: z.array(keyValueWireSchema),
});

const httpTransportFields = {
  url: z.string(),
  headers: z.array(keyValueWireSchema),
  auth: authConfigWireSchema.optional(),
};

/** How a session reaches its server: stdio, Streamable HTTP, or the legacy HTTP+SSE transport. */
export const mcpTransportWireSchema = z.discriminatedUnion('type', [
  mcpStdioTransportWireSchema,
  z.object({ type: z.literal('http'), ...httpTransportFields }),
  /** `url` is the event-stream endpoint. */
  z.object({ type: z.literal('sse'), ...httpTransportFields }),
]);
export type McpTransportWire = z.infer<typeof mcpTransportWireSchema>;

/** A server's own settings; an absent field means the default. */
export const mcpServerSettingsWireSchema = z.object({
  timeoutMs: z.number().int().positive().optional(),
  protocolVersion: z.string().optional(),
});
export type McpServerSettingsWire = z.infer<typeof mcpServerSettingsWireSchema>;

/** Where the catalogue came from, as a refresh wrote it. */
export const mcpCatalogueInfoWireSchema = z.object({
  fetchedAt: z.string(),
  serverInfo: z.object({ name: z.string(), version: z.string() }),
  protocolVersion: z.string(),
});
export type McpCatalogueInfoWire = z.infer<typeof mcpCatalogueInfoWireSchema>;

/**
 * The server's lists as `catalogue.json` keeps them. Each entry is kept as the server listed it,
 * fields the protocol adds later included, so these check only what the editor reads.
 */
export const mcpCatalogueWireSchema = z.object({
  tools: z
    .array(
      z.looseObject({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
  resources: z
    .array(
      z.looseObject({
        uri: z.string(),
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    )
    .optional(),
  resourceTemplates: z
    .array(
      z.looseObject({
        uriTemplate: z.string(),
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        mimeType: z.string().optional(),
      }),
    )
    .optional(),
  prompts: z
    .array(
      z.looseObject({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        arguments: z
          .array(
            z.looseObject({
              name: z.string(),
              description: z.string().optional(),
              required: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});
export type McpCatalogueWire = z.infer<typeof mcpCatalogueWireSchema>;

/** One MCP server as the renderer sees it. Its folders share the project's `folders` list. */
export const mcpServerWireSchema = z.object({
  kind: z.literal('mcp'),
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  transport: mcpTransportWireSchema,
  settings: mcpServerSettingsWireSchema,
  catalogueInfo: mcpCatalogueInfoWireSchema.optional(),
  /** The lists of the last refresh; absent until the first. */
  catalogue: mcpCatalogueWireSchema.optional(),
});
export type McpServerWire = z.infer<typeof mcpServerWireSchema>;

/**
 * The fields of an MCP server the renderer may patch; `null` clears an optional one. `transport`
 * and `settings` are replaced whole. The catalogue is written by a refresh only.
 */
export const mcpServerPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  transport: mcpTransportWireSchema.optional(),
  settings: mcpServerSettingsWireSchema.optional(),
});
export type McpServerPatchWire = z.infer<typeof mcpServerPatchSchema>;

// ——— Requests ———————————————————————————————————————————————————————————————————————————————

/** The four operations that list what the server has. */
export const mcpListMethodWireSchema = z.enum([
  'tools/list',
  'resources/list',
  'resources/templates/list',
  'prompts/list',
]);

/** Every operation a request can be: one method, no free-form JSON-RPC. */
export const mcpMethodWireSchema = z.enum([
  ...mcpListMethodWireSchema.options,
  'tools/call',
  'resources/read',
  'prompts/get',
]);
export type McpMethodWire = z.infer<typeof mcpMethodWireSchema>;

/**
 * The one operation a request runs. A `tools/call`'s `arguments` is the JSON text as edited (blank
 * sends `{}`); a prompt's arguments are strings, so they are a table.
 */
export const mcpOperationWireSchema = z.discriminatedUnion('method', [
  z.object({ method: mcpListMethodWireSchema }),
  z.object({ method: z.literal('tools/call'), tool: z.string(), arguments: z.string() }),
  z.object({ method: z.literal('resources/read'), uri: z.string() }),
  z.object({ method: z.literal('prompts/get'), prompt: z.string(), arguments: z.array(keyValueWireSchema) }),
]);
export type McpOperationWire = z.infer<typeof mcpOperationWireSchema>;

/** A request's own settings; absent means the server's. */
export const mcpRequestSettingsWireSchema = z.object({ timeoutMs: z.number().int().positive().optional() });
export type McpRequestSettingsWire = z.infer<typeof mcpRequestSettingsWireSchema>;

/** One MCP request as the renderer sees it. */
export const mcpRequestWireSchema = z.object({
  kind: z.literal('mcp'),
  id: z.string(),
  /** The server it belongs to, named as every other kind names its container. */
  apiId: z.string(),
  /** Id of the folder it sits in, absent at the server's root. */
  folderId: z.string().optional(),
  name: z.string(),
  slug: z.string(),
  order: z.number(),
  description: z.string().optional(),
  operation: mcpOperationWireSchema,
  settings: mcpRequestSettingsWireSchema,
  scripts: requestScriptsWireSchema.optional(),
  /** The request's own assertions (request-assertions spec §5.1); a stub may omit them, so they default. */
  assertions: z.array(requestAssertionWireSchema).default([]),
});
export type McpRequestWire = z.infer<typeof mcpRequestWireSchema>;

/**
 * The fields of an MCP request the renderer may patch. `operation` and `settings` are replaced
 * whole: changing the method is a new operation.
 */
export const mcpRequestPatchSchema = z.object({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  operation: mcpOperationWireSchema.optional(),
  settings: mcpRequestSettingsWireSchema.optional(),
});
export type McpRequestPatchWire = z.infer<typeof mcpRequestPatchSchema>;

// ——— A session's exchange ———————————————————————————————————————————————————————————————————

/** One JSON-RPC message of a session, either way, as the engine's `McpMessage` keeps it. */
export const mcpMessageWireSchema = z.object({
  direction: z.enum(['sent', 'received']),
  at: z.string(),
  /** UTF-8 bytes on the wire. */
  size: z.number(),
  kind: z.enum(['request', 'notification', 'result', 'error', 'invalid']),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  /** Empty for a received message over the size cap, or one whose text History's cap left out. */
  text: z.string(),
  warnings: z.array(z.string()),
  payloadTruncated: z.literal(true).optional(),
});
export type McpMessageWire = z.infer<typeof mcpMessageWireSchema>;

/** One HTTP call of a session over Streamable HTTP or SSE, as the engine's `McpHttpCall`. */
export const mcpHttpCallWireSchema = z.object({
  method: z.string(),
  url: z.string(),
  startedAt: z.string(),
  /** `0` when no response came. */
  status: z.number(),
  requestHeaders: z.record(z.string(), z.string()),
  responseHeaders: z.record(z.string(), z.string()),
  timings: timingsWireSchema.optional(),
  message: z.object({ id: z.union([z.string(), z.number()]).optional(), method: z.string().optional() }).optional(),
  error: z.string().optional(),
});
export type McpHttpCallWire = z.infer<typeof mcpHttpCallWireSchema>;

/** The transport an exchange went over, as it was expanded for the send (`McpExchangeTransport`). */
export const mcpExchangeTransportWireSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()),
    /** Absolute. */
    cwd: z.string(),
    /** The transport's own variables, values masked unless the session shows secrets. */
    env: z.record(z.string(), z.string()),
  }),
  z.object({ type: z.literal('http'), url: z.string() }),
  z.object({ type: z.literal('sse'), url: z.string() }),
]);
export type McpExchangeTransportWire = z.infer<typeof mcpExchangeTransportWireSchema>;

/** A JSON-RPC error object, as the server answered it. */
export const mcpErrorObjectWireSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});

/**
 * What one MCP send produced: the engine's `McpExchange` as the renderer is handed it, redacted
 * unless the session shows secrets, with the send's id, its assertions and its scripts beside it.
 */
export const mcpExchangeSummarySchema = z.object({
  /** The request's own assertions as an editor Send checked them; absent when it has none or nothing checked them. */
  assertions: z.array(requestAssertionResultWireSchema).optional(),
  sendId: z.string(),
  transport: mcpExchangeTransportWireSchema,
  method: mcpMethodWireSchema,
  startedAt: z.string(),
  durationMs: z.number(),
  /** The server's `initialize` result, as it came. */
  initialize: z.record(z.string(), z.unknown()).optional(),
  protocolVersion: z.string().optional(),
  messages: z.array(mcpMessageWireSchema),
  /** Messages past the session's own cap, not kept. */
  droppedMessages: z.number(),
  httpCalls: z.array(mcpHttpCallWireSchema).optional(),
  stderr: z.string().optional(),
  stderrTruncated: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
  exitSignal: z.string().nullable().optional(),
  /** The operation's result; absent when the server answered with an error, or did not answer. */
  result: z.unknown().optional(),
  error: mcpErrorObjectWireSchema.optional(),
  /** Why the session could not finish (`mcp-server-exited`, a deadline, …); absent when it did. */
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  /** What the checks against the catalogue found: the arguments, the structured content. */
  warnings: z.array(z.string()),
  /** What the request's scripts did; absent when it has none, or they are switched off. */
  script: scriptResultWireSchema.optional(),
  /** Set when the request has scripts and they are switched off, so none ran. */
  scriptsOff: z.boolean().optional(),
});
export type McpExchangeSummary = z.infer<typeof mcpExchangeSummarySchema>;

/**
 * One message of an MCP session still in flight, correlated to its invoke by `sendId`: what
 * `request.sendMcp` (or a catalogue refresh given a `sendId`) has sent or received so far.
 */
export const mcpLiveEventSchema = z.object({
  kind: z.literal('message'),
  sendId: z.string(),
  message: mcpMessageWireSchema,
});
export type McpLiveEvent = z.infer<typeof mcpLiveEventSchema>;

/** Request payload for `request.sendMcp`: the saved request and the editor's unsaved edits, never a command line. */
export const requestSendMcpRequestSchema = z.object({
  sendId: z.string(),
  requestId: z.string(),
  draft: mcpRequestPatchSchema.optional(),
});
export type RequestSendMcpRequest = z.infer<typeof requestSendMcpRequestSchema>;

/** Request/response for `request.cancelMcp`: ends the session in flight under `sendId`. */
export const requestCancelMcpRequestSchema = z.object({ sendId: z.string() });
export type RequestCancelMcpRequest = z.infer<typeof requestCancelMcpRequestSchema>;
export const requestCancelMcpResponseSchema = z.object({ cancelled: z.boolean() });

/**
 * The session record of an MCP History entry: the engine's `HistoryMcp`, its messages capped at
 * both ends as a WebSocket session's frames are. Stored redacted.
 */
export const historyMcpWireSchema = z.object({
  transport: mcpExchangeTransportWireSchema,
  /** The operation's JSON-RPC method. */
  method: z.string(),
  startedAt: z.string(),
  protocolVersion: z.string().optional(),
  serverInfo: z.object({ name: z.string(), version: z.string() }).optional(),
  messages: z.array(mcpMessageWireSchema),
  droppedMessages: z.number(),
  /** Set only when History's cap trimmed something (messages, or just a message's text). */
  truncated: z.boolean().optional(),
  omittedMessages: z.number().optional(),
  httpCalls: z.array(mcpHttpCallWireSchema).optional(),
  stderr: z.string().optional(),
  stderrTruncated: z.boolean().optional(),
  exitCode: z.number().nullable().optional(),
  exitSignal: z.string().nullable().optional(),
  result: z.unknown().optional(),
  /** A result came but was too large to keep here; its message may still hold it. */
  resultOmitted: z.literal(true).optional(),
  error: mcpErrorObjectWireSchema.optional(),
  failure: z.object({ code: z.string(), message: z.string() }).optional(),
  warnings: z.array(z.string()),
});
export type HistoryMcpWire = z.infer<typeof historyMcpWireSchema>;

// ——— The catalogue refresh——————————————————————————————————————————————————————————————————

/** Request payload for `api.refreshMcpCatalogue`. `sendId` streams the session's messages on `mcp.live`. */
export const apiRefreshMcpCatalogueRequestSchema = z.object({ apiId: z.string(), sendId: z.string().optional() });
export type ApiRefreshMcpCatalogueRequest = z.infer<typeof apiRefreshMcpCatalogueRequestSchema>;

/** What a refresh wrote: the fresh project, where the catalogue came from, and how much it holds. */
export const apiRefreshMcpCatalogueResponseSchema = z.object({
  projectId: z.string(),
  info: mcpCatalogueInfoWireSchema,
  counts: z.object({
    tools: z.number(),
    resources: z.number(),
    resourceTemplates: z.number(),
    prompts: z.number(),
  }),
  /** One line per list cut off at the page cap. */
  warnings: z.array(z.string()),
});
export type ApiRefreshMcpCatalogueResponse = z.infer<typeof apiRefreshMcpCatalogueResponseSchema>;

// ——— The stdio approval ——————————————————————————————————————————————————————————————————————

/** One command line this machine has approved (*Always allow*), as `mcp-approvals.json` keeps it. */
export const mcpApprovalWireSchema = z.object({
  /** The SHA-256 of the expanded command, arguments and folder, and the variables' names. */
  fingerprint: z.string(),
  /** The command line as it ran, secrets masked. */
  display: z.string(),
  approvedAt: z.string(),
});
export type McpApprovalWire = z.infer<typeof mcpApprovalWireSchema>;

/** Response for `app.mcpApprovals` and `app.mcpRevokeApproval`: every approval, newest first. */
export const appMcpApprovalsResponseSchema = z.object({ approvals: z.array(mcpApprovalWireSchema) });
export type AppMcpApprovalsResponse = z.infer<typeof appMcpApprovalsResponseSchema>;

/** Request payload for `app.mcpRevokeApproval`: a revoked command line asks again on its next send. */
export const appMcpRevokeApprovalRequestSchema = z.object({ fingerprint: z.string() });
export type AppMcpRevokeApprovalRequest = z.infer<typeof appMcpRevokeApprovalRequestSchema>;

/**
 * Payload for the `mcp.approval` event: a stdio send (or refresh) waits on a command line this
 * machine has not approved. The window that started it shows the dialog and answers with
 * `app.mcpApprove`, naming `promptId`.
 */
export const mcpApprovalPromptEventSchema = z.object({
  promptId: z.string(),
  serverName: z.string(),
  fingerprint: z.string(),
  /** The command line exactly as it will run, secrets masked. */
  display: z.string(),
  /** The absolute folder it runs in. */
  cwd: z.string(),
  /** The names of the variables it is given; their values are never shown. */
  envNames: z.array(z.string()),
});
export type McpApprovalPromptEvent = z.infer<typeof mcpApprovalPromptEventSchema>;

/** The dialog's three buttons: *Run once*, *Always allow* and *Cancel*. */
export const mcpApprovalAnswerWireSchema = z.enum(['once', 'always', 'cancel']);
export type McpApprovalAnswerWire = z.infer<typeof mcpApprovalAnswerWireSchema>;

/** Request payload for `app.mcpApprove`. An unknown or already answered `promptId` is ignored. */
export const appMcpApproveRequestSchema = z.object({ promptId: z.string(), answer: mcpApprovalAnswerWireSchema });
export type AppMcpApproveRequest = z.infer<typeof appMcpApproveRequestSchema>;
