/**
 * A resolved SOAP send as a {@link CodeRequest}: a POST of the envelope with the headers `soapToCurl`
 * writes, so every language sends what the `curl` export and the send itself would.
 */

import type { CodeRequest } from '#core/http/codegen/model';
import { soapWireHeaders } from './curl.js';
import type { SoapSendInput } from './types.js';

/**
 * One SOAP send as code. `basic` is passed apart from the headers, rather than baked into an
 * `Authorization` value, so a password read from the environment stays a read in every language.
 */
export function soapCodeRequest(
  input: SoapSendInput & { readonly contentType?: string },
  basic?: { readonly username: string; readonly password: string },
): CodeRequest {
  return {
    method: 'POST',
    url: input.endpoint,
    headers: soapWireHeaders(input),
    body: { kind: 'raw', text: input.envelopeXml },
    ...(basic !== undefined ? { basic } : {}),
    ...(input.tls?.rejectUnauthorized === false ? { insecure: true } : {}),
    followRedirects: input.followRedirects ?? false,
    ...(input.timeoutMs !== undefined && input.timeoutMs > 0 ? { timeoutMs: input.timeoutMs } : {}),
  };
}
