import { WsError } from '../errors.js';
import type { KeyValueEntry } from '../rest/model.js';

const SCHEME: Readonly<Record<string, string>> = { 'ws:': 'ws:', 'wss:': 'wss:', 'http:': 'ws:', 'https:': 'wss:' };

/** The URL a session dials: the request's own when absolute, else its path under the server URL. */
export function resolveWsUrl(serverUrl: string, requestUrl: string, query: readonly KeyValueEntry[]): string {
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(requestUrl);
  const joined = absolute
    ? requestUrl
    : requestUrl === ''
      ? serverUrl
      : `${serverUrl.replace(/\/+$/, '')}/${requestUrl.replace(/^\/+/, '')}`;
  let url: URL;
  try {
    url = new URL(joined);
  } catch {
    throw new WsError('ws-bad-url', `"${joined}" is not a URL`, { details: { url: joined } });
  }
  const scheme = SCHEME[url.protocol];
  if (scheme === undefined) {
    throw new WsError('ws-bad-url', `A WebSocket URL starts with ws:// or wss://, not ${url.protocol}//`, {
      details: { url: joined },
    });
  }
  url.protocol = scheme;
  for (const row of query) {
    if (row.enabled && row.name !== '') url.searchParams.append(row.name, row.value);
  }
  return url.toString();
}
