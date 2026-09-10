import type { HttpRequest } from './types.js';

const CRLF = '\r\n';

/**
 * Reconstructs the request as bytes approximating what was put on the wire:
 * `METHOD path HTTP/1.1\r\nHeader: value\r\n...\r\n\r\n<body>`.
 *
 * This is a reconstruction, not a wire capture: undici does not expose the
 * literal bytes it sends. `finalHeaders` should include any headers undici
 * adds itself (e.g. `content-length`, `host`) so the reconstruction is as
 * faithful as practical.
 */
export function buildRawRequest(
  req: HttpRequest,
  finalHeaders: Readonly<Record<string, string>>,
  body?: Uint8Array,
): Uint8Array {
  let path: string;
  try {
    const parsed = new URL(req.url);
    path = `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    path = req.url;
  }

  const lines = [`${req.method} ${path} HTTP/1.1`];
  for (const [name, value] of Object.entries(finalHeaders)) {
    lines.push(`${name}: ${value}`);
  }
  const head = `${lines.join(CRLF)}${CRLF}${CRLF}`;
  const headBytes = new TextEncoder().encode(head);

  if (body === undefined || body.length === 0) return headBytes;
  const out = new Uint8Array(headBytes.length + body.length);
  out.set(headBytes, 0);
  out.set(body, headBytes.length);
  return out;
}

/**
 * Reconstructs the response as bytes approximating what was received on the
 * wire: `HTTP/1.1 <status> <text>\r\nHeader: value\r\n...\r\n\r\n<body>`.
 *
 * This is a reconstruction, not a wire capture: undici does not expose the
 * literal bytes it received.
 */
export function buildRawResponse(
  status: number,
  statusText: string,
  rawHeaders: readonly (readonly [string, string])[],
  rawBody: Uint8Array,
): Uint8Array {
  const lines = [`HTTP/1.1 ${status} ${statusText}`];
  for (const [name, value] of rawHeaders) {
    lines.push(`${name}: ${value}`);
  }
  const head = `${lines.join(CRLF)}${CRLF}${CRLF}`;
  const headBytes = new TextEncoder().encode(head);

  if (rawBody.length === 0) return headBytes;
  const out = new Uint8Array(headBytes.length + rawBody.length);
  out.set(headBytes, 0);
  out.set(rawBody, headBytes.length);
  return out;
}
