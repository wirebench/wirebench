/**
 * The local agent's channels (hosted edition spec §18.1, §18.4; ADR-0035): what a browser tab at a team's
 * Wirebench Server calls on its paired agent. The one working channel, `agent.send`, takes a send bundle the
 * server host built: the request item's project files, by relative path, and the names of the secrets it
 * reads. The agent writes them to a fresh directory, loads that as a project and sends the one item through
 * the engine's send path on the person's machine.
 */
import { z } from 'zod';
import { defineChannel } from './ipc-contract.js';
import { restExchangeSummarySchema } from './kinds/rest/wire.js';
import { exchangeSummarySchema } from './kinds/soap/wire.js';

/**
 * A bundle's files together, decoded: the server never sends more, and the agent refuses more. 23 MiB,
 * so a bundle sent all as base64 (a third larger, about 30.7 MiB) still fits the socket's 32 MiB frame with
 * its JSON envelope around it.
 */
export const AGENT_BUNDLE_MAX_BYTES = 23 * 1024 * 1024;
/** A bundle's files, at most. */
export const AGENT_BUNDLE_MAX_FILES = 2000;

/** The kinds the agent sends. WebSocket is a session, not a send; gRPC and MCP can follow (task 4 ruling). */
export const AGENT_SEND_KINDS = ['soap', 'rest'] as const;
export type AgentSendKind = (typeof AGENT_SEND_KINDS)[number];

/**
 * Whether `path` is a file path the agent may write under its directory: relative, `/`-separated, with no
 * empty, `.` or `..` segment, no backslash, no NUL and no drive letter. The agent still resolves each one
 * and checks it stays inside; this only refuses what can never be right.
 */
export function isBundlePath(path: string): boolean {
  if (path.length === 0 || path.length > 1024) return false;
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** One project file of a bundle: its text, or its bytes as base64. */
export const sendBundleFileSchema = z.strictObject({
  path: z.string().refine(isBundlePath, { message: 'Not a relative path inside the bundle' }),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string(),
});
export type SendBundleFile = z.infer<typeof sendBundleFileSchema>;

/** How many bytes `file` is once decoded; `undefined` for base64 that is not. */
export function bundleFileBytes(file: Pick<SendBundleFile, 'encoding' | 'content'>): number | undefined {
  // `TextEncoder`, not `Buffer`: this module reaches the renderer through `ipc.ts`.
  if (file.encoding === 'utf8') return new TextEncoder().encode(file.content).length;
  if (!BASE64.test(file.content)) return undefined;
  const padding = file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0;
  return (file.content.length / 4) * 3 - padding;
}

/**
 * A send bundle (§18.4), version 1: the project files the one request item needs (its manifest, the item,
 * its folder chain's scripts, the non-secret values, the files it reads) and the names of the secrets and
 * `${#System#…}` values it reads, never their values: those names are the only `${secret:…}` refs the send may
 * resolve, and the only system names it may read (when this machine allows them too). `itemId` is
 * the request's id in those files; `environment` the environment id it is sent under, the project's active
 * one when absent.
 */
export const sendBundleSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.enum(AGENT_SEND_KINDS),
    /**
     * The server workspace the request belongs to: with the pairing's id, it names the agent's own secret
     * namespace (`agent:<pairingId>:<workspaceId>:<name>`).
     */
    workspaceId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    itemId: z.string().min(1).max(256),
    environment: z.string().min(1).max(256).optional(),
    files: z.array(sendBundleFileSchema).max(AGENT_BUNDLE_MAX_FILES),
    secretNames: z
      .array(
        z
          .string()
          .max(256)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      )
      .max(1000),
    /**
     * The `${#System#NAME}` names the request reads. A name resolves only when it is declared here and this
     * machine's agent allows it (`allowedSystemNames`, empty by default); any other is unresolved and the send
     * is refused, as on the server host, so a paired server cannot read the agent's process environment.
     */
    systemNames: z
      .array(
        z
          .string()
          .max(256)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      )
      .max(1000),
  })
  .superRefine((bundle, context) => {
    let total = 0;
    bundle.files.forEach((file, index) => {
      const bytes = bundleFileBytes(file);
      if (bytes === undefined) {
        context.addIssue({ code: 'custom', path: ['files', index, 'content'], message: 'Not base64' });
        return;
      }
      total += bytes;
    });
    if (total > AGENT_BUNDLE_MAX_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['files'],
        message: `The files come to more than ${String(AGENT_BUNDLE_MAX_BYTES)} bytes`,
        params: { tooLarge: true },
      });
    }
  });
export type SendBundle = z.infer<typeof sendBundleSchema>;

/** A send id: also the name of the send's directory, so it is a plain name. */
const sendIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const agentSendRequestSchema = z.strictObject({ sendId: sendIdSchema, bundle: sendBundleSchema });
export type AgentSendRequest = z.infer<typeof agentSendRequestSchema>;

/** Where a result was sent from (§18.4): an agent send's result says so. */
const sentFromAgent = { sentFrom: z.literal('agent') };

/** A kind's ordinary send result, from the agent: REST's `request.sendRest` or SOAP's `request.send`. */
export const agentSendResponseSchema = z.union([
  restExchangeSummarySchema.extend(sentFromAgent),
  exchangeSummarySchema.extend(sentFromAgent),
]);
export type AgentSendResponse = z.infer<typeof agentSendResponseSchema>;

export const agentCancelRequestSchema = z.strictObject({ sendId: sendIdSchema });
export const agentCancelResponseSchema = z.object({ cancelled: z.boolean() });

/** The agent's share of the IPC registry; served by a paired agent only, never by a window's host. */
export const agentChannels = {
  agent: {
    /** Runs one send bundle on this machine; answers the kind's result with `sentFrom: 'agent'`. */
    send: defineChannel('agent.send', agentSendRequestSchema, agentSendResponseSchema),
    /** Aborts a send this tab's pairing started; `false` when none of that id is running. */
    cancel: defineChannel('agent.cancel', agentCancelRequestSchema, agentCancelResponseSchema),
    /** Empties the cookie jar the agent holds for this tab's pairing. */
    cookies: {
      clear: defineChannel('agent.cookies.clear', z.undefined(), z.undefined()),
    },
  },
} as const;
