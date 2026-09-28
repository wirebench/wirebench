/**
 * The pure pieces of the public route (webhook-capture spec §3.2, §3.3): how an inbound request
 * becomes a capture row. Nothing here reads the database or the clock.
 */

/** Node's `rawHeaders` (`[name, value, name, value, …]`) as pairs: arrival order, repeats and spelling kept. */
export function headerPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([raw[index]!, raw[index + 1]!]);
  return pairs;
}

/** The request target split at its first `?`; both halves stay percent-encoded as they arrived. */
export function splitTarget(url: string): { readonly path: string; readonly query: string } {
  const at = url.indexOf('?');
  return at === -1 ? { path: url, query: '' } : { path: url.slice(0, at), query: url.slice(at + 1) };
}

const PREFIX = '/hooks/';

/** What followed `/hooks/<secret>`: `''`, or `/` and whatever came after it. */
export function subpathOf(path: string): string {
  const rest = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path;
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : rest.slice(slash);
}

/**
 * §3.3 step 1: the first `limit` bytes are stored. A longer body is cut to `limit`, with `truncated`
 * and its full size recorded; the sender still gets the configured response.
 */
export function truncateBody(
  body: Buffer,
  limit: number,
): { readonly body: Buffer; readonly bodySize: number; readonly truncated: boolean } {
  return body.length > limit
    ? { body: body.subarray(0, limit), bodySize: body.length, truncated: true }
    : { body, bodySize: body.length, truncated: false };
}
