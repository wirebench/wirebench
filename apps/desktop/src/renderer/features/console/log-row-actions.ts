/**
 * What one HTTP Log row can do, and why an action is off. A pure table: the row menu renders it,
 * `runRowAction` (log-row-menu.tsx) carries it out.
 */
import { decodeBase64Text } from '../../lib/format-size.js';
import type { LogEntry } from '../../state/exchanges.js';
import { useProjectStore } from '../../state/project.js';
import { protocolOf, stageOf, type LogProtocol } from './log-filter.js';

export type RowActionId =
  | 'curl-posix'
  | 'curl-powershell'
  | 'copy-url'
  | 'copy-request-headers'
  | 'copy-response-headers'
  | 'copy-response-body'
  | 'resend'
  | 'open-request';

export interface RowAction {
  readonly id: RowActionId;
  readonly label: string;
  readonly enabled: boolean;
  /** Why the action is off; shown as its tooltip. */
  readonly reason?: string;
  /** What an enabled action does, when its label alone does not say. */
  readonly hint?: string;
}

/** Whether the saved request behind a row still exists, and whether a gRPC one is unary. */
export interface RequestLookup {
  has(protocol: LogProtocol, requestId: string): boolean;
  unaryGrpc(requestId: string): boolean;
}

const RESEND_HINT = 'Sends the saved request as it is now';

/** The saved request a row came from; absent for an ad-hoc send. */
export function requestIdOf(entry: LogEntry): string | undefined {
  return entry.kind === 'exchange' ? entry.requestId : entry.failure.requestId;
}

/** The request headers the row shows. */
export function requestHeadersOf(entry: LogEntry): Readonly<Record<string, string>> {
  return entry.kind === 'exchange' ? entry.exchange.http.request.headers : entry.failure.request.headers;
}

/** One `Name: value` line per header. */
export function headersText(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n');
}

/** The response body as text; undefined for a failure, which has none. */
export function responseBodyText(entry: LogEntry): string | undefined {
  return entry.kind === 'exchange' ? decodeBase64Text(entry.exchange.http.bodyBase64) : undefined;
}

function on(id: RowActionId, label: string, hint?: string): RowAction {
  return { id, label, enabled: true, ...(hint !== undefined ? { hint } : {}) };
}

function off(id: RowActionId, label: string, reason: string): RowAction {
  return { id, label, enabled: false, reason };
}

export function rowActions(entry: LogEntry, lookup: RequestLookup): RowAction[] {
  const protocol = protocolOf(entry);
  const requestId = requestIdOf(entry);
  const exists = requestId !== undefined && lookup.has(protocol, requestId);
  const failed = entry.kind === 'failure';

  const missingReason = requestId === undefined ? 'Not from a saved request' : 'The request no longer exists';
  let resend: RowAction;
  if (!exists) {
    resend = off('resend', 'Resend', missingReason);
  } else if (stageOf(entry) === 'prepare') {
    resend = off('resend', 'Resend', 'Never sent');
  } else if (protocol === 'grpc' && !lookup.unaryGrpc(requestId)) {
    resend = off('resend', 'Resend', 'Streaming calls resend from the editor');
  } else {
    resend = on('resend', 'Resend', RESEND_HINT);
  }

  return [
    on('curl-posix', 'Copy as cURL (POSIX)'),
    on('curl-powershell', 'Copy as cURL (PowerShell)'),
    on('copy-url', 'Copy URL'),
    Object.keys(requestHeadersOf(entry)).length > 0
      ? on('copy-request-headers', 'Copy request headers')
      : off('copy-request-headers', 'Copy request headers', 'No request headers'),
    failed
      ? off('copy-response-headers', 'Copy response headers', 'No response')
      : on('copy-response-headers', 'Copy response headers'),
    failed
      ? off('copy-response-body', 'Copy response body', 'No response')
      : on('copy-response-body', 'Copy response body'),
    resend,
    exists ? on('open-request', 'Open request') : off('open-request', 'Open request', missingReason),
  ];
}

/** A {@link RequestLookup} over the open projects. */
export function projectLookup(): RequestLookup {
  return {
    has: (protocol, requestId) => {
      const state = useProjectStore.getState();
      const records =
        protocol === 'soap' ? state.requests : protocol === 'rest' ? state.restRequests : state.grpcRequests;
      return records[requestId] !== undefined;
    },
    unaryGrpc: (requestId) => useProjectStore.getState().grpcRequests[requestId]?.methodKind === 'unary',
  };
}
