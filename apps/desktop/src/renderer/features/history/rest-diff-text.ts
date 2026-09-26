/**
 * The texts a Compare tab diffs when both sides are REST, one per tab of the diff.
 *
 * Each text is a head, a blank line and the body. The head is a status line or a request line and
 * then the headers, one `name: value` per line, sorted by name without regard to case, so two sends
 * that list the same headers in another order diff as the same. The body is pretty-printed for the
 * same reason. Redacted values are shown as they were recorded: nothing is filled or hidden.
 */
import type { HistoryEntryWire, RestExchangeSummary } from '../../../shared/wire-types.js';
import { decodeBase64Text } from '../../lib/format-size.js';
import { prettyPrintBody } from './history-format.js';

/** One side's text for each tab of a REST diff. */
export interface RestDiffTexts {
  readonly response: string;
  readonly request: string;
}

/**
 * `name: value` lines sorted by name without regard to case. Headers with the same name keep their
 * recorded order, and each name keeps its recorded spelling.
 */
export function headerLines(headers: readonly (readonly [string, string])[]): string[] {
  return headers
    .map(([name, value], index) => ({ name, value, key: name.toLowerCase(), index }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map(({ name, value }) => `${name}: ${value}`);
}

/** A head of lines, a blank line, and the body pretty-printed. */
function diffText(head: readonly string[], body: string): string {
  return `${head.join('\n')}\n\n${prettyPrintBody(body)}`;
}

/** `200 OK`, or the bare status when the server sent no reason phrase. */
function statusLine(status: number, statusText: string): string {
  return statusText === '' ? String(status) : `${String(status)} ${statusText}`;
}

/** The body after the head of a raw HTTP request, or `''` when there is none. */
function rawRequestBody(base64: string): string {
  const raw = decodeBase64Text(base64) ?? '';
  const crlf = raw.indexOf('\r\n\r\n');
  if (crlf !== -1) {
    return raw.slice(crlf + 4);
  }
  const lf = raw.indexOf('\n\n');
  return lf === -1 ? '' : raw.slice(lf + 2);
}

/** A REST History entry's texts: what it recorded, as it recorded it. */
export function restEntryTexts(entry: HistoryEntryWire): RestDiffTexts {
  const { response } = entry;
  return {
    response:
      response === undefined
        ? diffText([`No response (${entry.error?.code ?? 'error'})`], '')
        : diffText(
            [statusLine(response.status, response.statusText), ...headerLines(response.rawHeaders)],
            response.envelopeXml ?? '',
          ),
    request: diffText(
      [
        `${entry.method ?? ''} ${entry.endpoint}`.trim(),
        ...headerLines(entry.request.headers.map((header) => [header.name, header.value] as const)),
      ],
      entry.request.envelopeXml,
    ),
  };
}

/**
 * A REST request's latest exchange as texts. Its request headers are the ones sent, so auth, computed
 * and default headers show here although a History entry never records them.
 */
export function restExchangeTexts(exchange: RestExchangeSummary): RestDiffTexts {
  const { http } = exchange;
  return {
    response: diffText([statusLine(http.status, http.statusText), ...headerLines(http.rawHeaders)], exchange.text),
    request: diffText(
      [`${exchange.method} ${exchange.url}`, ...headerLines(Object.entries(http.request.headers))],
      rawRequestBody(http.rawRequestBase64),
    ),
  };
}
