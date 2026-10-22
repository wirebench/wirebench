/**
 * Reading JSON-RPC 2.0 messages off the wire for an MCP session (#79), without trusting them.
 *
 * A test tool has to show what the server really sent, so a message that does not match the
 * protocol is still kept: it is classified by its shape alone (a `method` and an `id` make a
 * request, and so on), and what the SDK's `JSONRPCMessageSchema` says about it becomes warnings.
 * Nothing here throws on server input.
 */
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

/** A JSON-RPC id: the protocol allows a string or a number. */
export type JsonRpcId = string | number;

/** What a message is, read from its shape. `invalid` is anything that is none of the other four. */
export type JsonRpcMessageKind = 'request' | 'notification' | 'result' | 'error' | 'invalid';

/** A JSON-RPC error object, as a server answers one. */
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** One message read from the wire. */
export interface InspectedMessage {
  readonly kind: JsonRpcMessageKind;
  /** The message's own text: the line or event as it came, or one member of a batch re-encoded. */
  readonly text: string;
  /** The parsed value; absent when the text is not JSON. */
  readonly value?: unknown;
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly warnings: readonly string[];
}

/** JSON-RPC's own "method not found", the answer to every request a server sends (decision 9). */
export const JSONRPC_METHOD_NOT_FOUND = -32601;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isId = (value: unknown): value is JsonRpcId => typeof value === 'string' || typeof value === 'number';

/**
 * The messages in one piece of text from the transport. A JSON array is a batch (allowed by the
 * 2025-03-26 protocol) and gives one message per member; text that is not JSON gives one `invalid`
 * message that says so.
 */
export function readMessages(text: string): InspectedMessage[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return [{ kind: 'invalid', text, warnings: [`The message is not JSON: ${reason}`] }];
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [{ kind: 'invalid', text, value, warnings: ['The message is an empty batch'] }];
    return value.map((member) => inspectMessage(member, JSON.stringify(member)));
  }
  return [inspectMessage(value, text)];
}

/** Classify one parsed message by its shape, and validate it against the SDK's schema. */
export function inspectMessage(value: unknown, text: string = JSON.stringify(value)): InspectedMessage {
  const warnings = schemaWarnings(value);
  if (!isRecord(value)) {
    return { kind: 'invalid', text, value, warnings };
  }
  const id = isId(value['id']) ? value['id'] : undefined;
  const method = typeof value['method'] === 'string' ? value['method'] : undefined;
  const base = {
    text,
    value,
    warnings,
    ...(id !== undefined ? { id } : {}),
    ...(method !== undefined ? { method } : {}),
  };
  if (method !== undefined) return { ...base, kind: id !== undefined ? 'request' : 'notification' };
  if (id !== undefined && 'error' in value) return { ...base, kind: 'error' };
  if (id !== undefined && 'result' in value) return { ...base, kind: 'result' };
  return { ...base, kind: 'invalid' };
}

/** What the SDK's message schema finds wrong with `value`, one line per issue; none when it matches. */
export function schemaWarnings(value: unknown): string[] {
  const parsed = JSONRPCMessageSchema.safeParse(value);
  if (parsed.success) return [];
  return formatIssues('The message is not a valid JSON-RPC message', parsed.error.issues);
}

/**
 * Zod issues as warning lines, each prefixed with `lead` and the path it is at. Exported for the
 * session, which checks the `initialize` result against its own schema the same way.
 */
export function formatIssues(
  lead: string,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): string[] {
  if (issues.length === 0) return [lead];
  return issues.map((issue) => {
    const path = issue.path.map((part) => String(part)).join('.');
    return `${lead}${path !== '' ? ` at ${path}` : ''}: ${issue.message}`;
  });
}

/** The error object of an `error` message, made safe to read: a malformed one is described, not thrown. */
export function errorObjectOf(value: unknown): JsonRpcErrorObject {
  const error = isRecord(value) ? value['error'] : undefined;
  if (!isRecord(error)) return { code: 0, message: 'The server answered with an error that is not an object' };
  return {
    code: typeof error['code'] === 'number' ? error['code'] : 0,
    message: typeof error['message'] === 'string' ? error['message'] : '',
    ...('data' in error ? { data: error['data'] } : {}),
  };
}

/** The `result` of a `result` message. */
export function resultOf(value: unknown): unknown {
  return isRecord(value) ? value['result'] : undefined;
}

/** A request, encoded for the wire. */
export function encodeRequest(id: JsonRpcId, method: string, params?: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
}

/** A notification, encoded for the wire. */
export function encodeNotification(method: string, params?: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
}

/** An error response, encoded for the wire. */
export function encodeError(id: JsonRpcId, error: JsonRpcErrorObject): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error });
}
