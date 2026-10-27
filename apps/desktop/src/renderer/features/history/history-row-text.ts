/** The words a History row, its tab and its footer are made of. */
import { formatClockTime } from '../../lib/format-size.js';
import type { HistoryEntryWire } from '@shared/wire-types.js';

/** The host part of a URL, or the raw string when it doesn't parse (a `${...}` placeholder, say). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * A URL split for a History row's first line (G04): the path and query, which tell sends to one host
 * apart, and the host, shown faint beside it. A URL that doesn't parse (a `${...}` placeholder, say)
 * is all path and no host, so the row still shows what was sent.
 */
export function endpointParts(url: string): { readonly path: string; readonly host: string } {
  try {
    const parsed = new URL(url);
    return { path: `${parsed.pathname}${parsed.search}`, host: parsed.host };
  } catch {
    return { path: url, host: '' };
  }
}

/**
 * An entry tab's title: the request's name and the time it was sent, so the tab never reads as the
 * request's own editor tab and two entries of one request tell apart.
 */
export function historyTabTitle(entry: Pick<HistoryEntryWire, 'requestName' | 'at'>): string {
  return `${entry.requestName} · ${formatClockTime(entry.at)}`;
}

/** A failed send's chip names what went wrong, short enough for the row (#732 X12). */
const ERROR_CHIP: Readonly<Record<string, string>> = {
  'connection-refused': 'refused',
  dns: 'DNS',
  timeout: 'timeout',
  tls: 'TLS',
  'tls-untrusted': 'TLS',
  aborted: 'cancelled',
  proxy: 'proxy',
  'too-many-redirects': 'redirects',
  'missing-endpoint': 'no URL',
};

/** What a row's status chip says: the status, or for a send that got none, the kind of failure. */
export function historyStatusChip(entry: Pick<HistoryEntryWire, 'status' | 'error'>): string {
  if (entry.status !== undefined) return String(entry.status);
  const code = entry.error?.code;
  return code === undefined ? 'err' : (ERROR_CHIP[code] ?? 'err');
}

/** The footer's count: "1 entry", "2 entries". */
export function historyCountLabel(total: number): string {
  return total === 1 ? '1 entry' : `${String(total)} entries`;
}
