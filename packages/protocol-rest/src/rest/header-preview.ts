/**
 * What a REST send would put on the wire, header by header, without sending it: the rows
 * `sendRest` builds its headers from (`request-headers.ts`), plus what the transport and a
 * credential's handshake add (spec `2026-10-11-generated-headers-preview-design.md`).
 */

import { applyAuth } from '#core/http/auth/apply-auth';
import { basicAuthorization } from '#core/http/auth/basic';
import { signSigV4 } from '#core/http/auth/sigv4';
import { encodeRestBody } from './body.js';
import type { EncodedBody } from './body.js';
import { cookieHeader } from './cookies.js';
import { isOmitted, restHeaderRows } from './request-headers.js';
import type { RestHeaderRow, RestHeaderState } from './request-headers.js';
import type { RestSendInput } from './send.js';
import { composeUrl } from './url.js';

/** The scheme an `Authorization` only a challenge round trip sends would carry. */
const HANDSHAKE_SCHEME = { basic: 'Basic', ntlm: 'NTLM', kerberos: 'Negotiate', digest: 'Digest' } as const;

/**
 * The body as the send encodes it. A file part that cannot be read leaves the length unknown and
 * keeps the type the body's kind implies, rather than failing a preview the user is reading.
 */
async function encodedFor(input: RestSendInput): Promise<EncodedBody> {
  const { body } = input.request;
  try {
    return await encodeRestBody(body, {
      ...(input.resolveFile !== undefined ? { resolveFile: input.resolveFile } : {}),
      ...(input.settings.charset !== undefined ? { charset: input.settings.charset } : {}),
      ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
    });
  } catch {
    return body.kind === 'binary'
      ? { contentType: body.contentType }
      : body.kind === 'multipart'
        ? { contentType: 'multipart/form-data' }
        : {};
  }
}

/** The host a composed URL names, or undefined while it is not a complete address. */
function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).host;
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

/**
 * Every header a send of `input` would carry, each with its source and whether it goes out, in the
 * order: generated layers, the typed table, then the transport's `Host` and `Content-Length`.
 *
 * Credentials go on as the send applies them: a preemptive Basic `Authorization` is a row of its own,
 * and one that only a challenge round trip sends (NTLM, Kerberos, a non-preemptive Basic) is a
 * `handshake` row whose value is its scheme (NTLM, Kerberos, Digest, a non-preemptive Basic). An AWS
 * Signature v4 header signature is computed for real at `options.now`, over the headers and body the
 * send would sign, and each header it adds is a row. The cookie jar is read for the composed URL when
 * the send would read it. Nothing is sent and the jar is not written.
 */
export async function previewRestHeaders(
  input: RestSendInput,
  options: { readonly now?: number } = {},
): Promise<RestHeaderRow[]> {
  const { request, settings } = input;
  const omit = settings.omitHeaders;
  const applied = applyAuth(input.auth);
  const url = composeUrl(input.baseUrl, request.url, request.pathParams, [...request.query, ...applied.query], {
    encode: settings.encodeUrl ?? true,
  }).url;
  const encoded = await encodedFor(input);

  const rows = restHeaderRows({
    defaults: input.defaultHeaders ?? {},
    auth: applied.headers,
    contentType: encoded.contentType,
    cookie: input.jar === undefined ? cookieHeader(input.cookies ?? []) : undefined,
    typed: request.headers,
    omit,
  });
  const typed = (name: string): boolean =>
    rows.some((row) => row.source === 'typed' && row.name.toLowerCase() === name.toLowerCase());
  const generated = rows.filter((row) => row.source !== 'typed');
  const typedRows = rows.filter((row) => row.source === 'typed');

  const transport = applied.transportAuth;
  if (transport?.type === 'basic' && transport.preemptive) {
    const state: RestHeaderState = typed('Authorization')
      ? 'overridden'
      : isOmitted(omit, 'Authorization')
        ? 'omitted'
        : 'sent';
    generated.push({
      name: 'Authorization',
      value: basicAuthorization(transport.username, transport.password),
      source: 'auth',
      state,
    });
  } else if (transport?.type === 'aws-sigv4' && transport.placement === 'header' && hostOf(url) !== undefined) {
    const sent: Record<string, string> = {};
    for (const row of rows) if (row.state === 'sent' || row.state === 'merged') sent[row.name] = row.value;
    const signed = signSigV4(
      {
        method: request.method.toUpperCase(),
        url: new URL(url).href,
        headers: sent,
        ...(encoded.bytes !== undefined ? { body: encoded.bytes } : {}),
      },
      transport,
      { now: options.now ?? Date.now() },
    );
    const state: RestHeaderState = typed('Authorization') ? 'overridden' : 'sent';
    for (const [name, value] of Object.entries(signed.headers)) {
      generated.push({ name, value, source: 'auth', state });
    }
  } else if (
    transport?.type === 'basic' ||
    transport?.type === 'ntlm' ||
    transport?.type === 'kerberos' ||
    transport?.type === 'digest'
  ) {
    generated.push({
      name: 'Authorization',
      value: HANDSHAKE_SCHEME[transport.type],
      source: 'handshake',
      state: typed('Authorization') ? 'overridden' : 'sent',
    });
  }

  const jarCookies = input.jar?.send === true ? input.jar.host.cookiesFor(url) : [];
  if (jarCookies.length > 0) {
    generated.push({
      name: 'Cookie',
      value: jarCookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
      source: 'cookie',
      state: isOmitted(omit, 'Cookie') ? 'omitted' : typed('Cookie') ? 'merged' : 'sent',
    });
  }

  const host = hostOf(url);
  return [
    ...generated,
    ...typedRows,
    ...(host !== undefined
      ? [{ name: 'Host', value: host, source: 'transport' as const, state: 'sent' as const }]
      : []),
    ...(encoded.bytes !== undefined
      ? [
          {
            name: 'Content-Length',
            value: String(encoded.bytes.byteLength),
            source: 'transport' as const,
            state: 'sent' as const,
          },
        ]
      : []),
  ];
}
