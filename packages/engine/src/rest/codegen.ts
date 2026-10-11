/**
 * A resolved REST send as a {@link CodeRequest}: the same input `sendRest` and `restToCurl` take, so
 * every language describes what the send would put on the wire. Credentials go on as the send applies
 * them (`applyAuth`), the URL is composed as the send composes it, and the body's `Content-Type` is
 * the one the send would declare unless a typed header says otherwise.
 */

import { applyAuth } from '../http/auth/apply-auth.js';
import type { CodeHeader, CodeRequest } from '../http/codegen/model.js';
import { rawContentType } from './body.js';
import { curlBody } from './curl.js';
import { isOmitted, omittedBasic } from './request-headers.js';
import type { RestSendInput } from './send.js';
import { composeUrl } from './url.js';

/** The `Content-Type` the body implies, as `encodeRestBody` would declare it. Multipart has a boundary of the library's own. */
function impliedContentType(input: RestSendInput): string | undefined {
  const { body } = input.request;
  switch (body.kind) {
    case 'raw':
      return rawContentType(body.language, body.contentType, input.settings.charset);
    case 'form':
      return 'application/x-www-form-urlencoded';
    case 'binary':
      return body.contentType;
    default:
      return undefined;
  }
}

/** One REST send as code. NTLM and Kerberos are not carried: the caller notes them. */
export function restCodeRequest(input: RestSendInput): CodeRequest {
  const applied = applyAuth(input.auth);
  const { request, settings } = input;
  const url = composeUrl(input.baseUrl, request.url, request.pathParams, [...request.query, ...applied.query], {
    encode: settings.encodeUrl ?? true,
  }).url;

  const headers: CodeHeader[] = request.headers
    .filter((row) => row.enabled)
    .map((row) => ({ name: row.name, value: row.value }));
  const typed = (name: string): boolean => headers.some((row) => row.name.toLowerCase() === name.toLowerCase());
  // A header the request set itself wins over a computed one, as `mergeRequestHeaders` has it.
  const computed: CodeHeader[] = Object.entries(applied.headers).map(([name, value]) => ({ name, value }));
  const contentType = impliedContentType(input);
  if (contentType !== undefined) computed.push({ name: 'Content-Type', value: contentType });
  // ... and a header the request switched off (`omitHeaders`) is left out, as the send leaves it out.
  const omit = settings.omitHeaders;
  for (const row of computed) {
    if (!typed(row.name) && !isOmitted(omit, row.name)) headers.push(row);
  }

  const transport = omittedBasic(applied.transportAuth, omit) ? undefined : applied.transportAuth;
  return {
    method: request.method,
    url,
    headers,
    body: curlBody(request.body),
    ...(transport?.type === 'basic' ? { basic: { username: transport.username, password: transport.password } } : {}),
    ...(input.tls?.rejectUnauthorized === false ? { insecure: true } : {}),
    followRedirects: settings.followRedirects,
    ...(settings.maxRedirects !== undefined ? { maxRedirects: settings.maxRedirects } : {}),
    ...(settings.timeoutMs > 0 ? { timeoutMs: settings.timeoutMs } : {}),
  };
}
