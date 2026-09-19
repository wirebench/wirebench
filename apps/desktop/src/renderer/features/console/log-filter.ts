/**
 * The pure half of the HTTP Log's filter bar: how a `LogEntry` of either kind reads (protocol,
 * method, URL, status class) and whether it passes a `LogFilter`. No React, no store — the table
 * and the bar both call this, and the tests need nothing rendered.
 */

import type { LogEntry, LogFilter, StatusClass } from '../../state/exchanges.js';
import { compileMatcher, matchesText, type TextMatcher } from './log-search.js';

export type { StatusClass } from '../../state/exchanges.js';

export type LogProtocol = 'soap' | 'rest' | 'grpc' | 'websocket';

/**
 * A gRPC summary is the one that reports `statusName`, a REST summary the one that reports
 * `methodChanged`; a SOAP summary reports neither.
 */
export function protocolOf(entry: LogEntry): LogProtocol {
  if (entry.kind === 'failure') {
    return entry.failure.protocol;
  }
  if ('statusName' in entry.exchange) {
    return 'grpc';
  }
  return 'methodChanged' in entry.exchange ? 'rest' : 'soap';
}

export function methodOf(entry: LogEntry): string {
  return entry.kind === 'failure' ? entry.failure.request.method : entry.exchange.http.request.method;
}

export function urlOf(entry: LogEntry): string {
  return entry.kind === 'failure' ? entry.failure.request.url : entry.exchange.http.request.url;
}

/** Wall-clock start, ISO 8601. */
export function startedAtOf(entry: LogEntry): string {
  return entry.kind === 'failure' ? entry.failure.startedAt : entry.exchange.http.timings.startedAt;
}

/** Start to response, or start to failure, in milliseconds. */
export function durationOf(entry: LogEntry): number {
  return entry.kind === 'failure' ? entry.failure.durationMs : entry.exchange.durationMs;
}

/** Where a failure happened (`send` when the row predates the field); undefined for an exchange. */
export function stageOf(entry: LogEntry): 'prepare' | 'send' | undefined {
  return entry.kind === 'failure' ? (entry.failure.stage ?? 'send') : undefined;
}

/** The status cell text: HTTP status, the error code, or `Failed · before send`. */
export function statusLabelOf(entry: LogEntry): string {
  if (entry.kind === 'exchange') {
    return String(entry.exchange.http.status);
  }
  return entry.failure.stage === 'prepare' ? 'Failed · before send' : entry.failure.error.code;
}

/**
 * The class is the HTTP status, nothing else: a SOAP fault carried on a 200 is `2xx` (the row's
 * danger tone still shows the fault). A failure produced no status and matches `failed` only.
 * Anything below 300 (including the 1xx nobody should see here) reads as `2xx`.
 */
export function statusClassOf(entry: LogEntry): StatusClass {
  if (entry.kind === 'failure') {
    return 'failed';
  }
  const status = entry.exchange.http.status;
  if (status >= 500) {
    return '5xx';
  }
  if (status >= 400) {
    return '4xx';
  }
  if (status >= 300) {
    return '3xx';
  }
  return '2xx';
}

/** Every group must pass (AND); within a group, any selected value passes (OR); an empty group passes all. */
export function matchesFilter(
  entry: LogEntry,
  filter: LogFilter,
  nameOf?: (entry: LogEntry) => string | undefined,
): boolean {
  return matchesFilterWith(entry, filter, compileMatcher(filter), nameOf);
}

/**
 * {@link matchesFilter} with the text matcher compiled once by the caller — the table compiles it
 * per render, not per row. An invalid regex skips the text test, so every row stays visible.
 */
export function matchesFilterWith(
  entry: LogEntry,
  filter: LogFilter,
  matcher: TextMatcher,
  nameOf?: (entry: LogEntry) => string | undefined,
): boolean {
  if (filter.text !== '' && matcher.invalid !== true && !matchesText(entry, matcher, nameOf?.(entry))) {
    return false;
  }
  if (filter.methods.length > 0 && !filter.methods.includes(methodOf(entry).toUpperCase())) {
    return false;
  }
  if (filter.statuses.length > 0 && !filter.statuses.includes(statusClassOf(entry))) {
    return false;
  }
  if (filter.protocols.length > 0 && !filter.protocols.includes(protocolOf(entry))) {
    return false;
  }
  return true;
}

/** The methods present in the log — what the bar offers as chips — unique, upper-case, sorted. */
export function methodsIn(log: readonly LogEntry[]): string[] {
  return [...new Set(log.map((entry) => methodOf(entry).toUpperCase()))].sort();
}
