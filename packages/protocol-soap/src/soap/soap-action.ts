/**
 * The transport-level naming of a SOAP operation: SOAP 1.1's `SOAPAction`
 * header versus SOAP 1.2's `action` media-type parameter.
 */

import type { SoapEnvelopeVersion } from './envelope.js';

/** Knobs for {@link soapActionHeaders}. */
export interface SoapActionOptions {
  /** Suppress the action entirely (some servers reject an unexpected `SOAPAction`). */
  readonly skipSoapAction?: boolean;
  /** Charset for the `Content-Type`; `UTF-8` by default, and used verbatim. */
  readonly charset?: string;
}

/** The `Content-Type` and any extra request headers naming the operation. */
export interface SoapActionHeaders {
  readonly contentType: string;
  /** Additional headers to send; the `Content-Type` is *not* repeated here. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Computes the `Content-Type` and action-carrying headers for a request.
 *
 * SOAP 1.1 carries the action in a mandatory, always double-quoted `SOAPAction`
 * header (an absent action is the empty quoted string `""`, per WSDL 1.1
 * §3.5). SOAP 1.2 folds it into the `application/soap+xml` media type as an
 * `action` parameter and defines no `SOAPAction` header at all.
 *
 * @param version the SOAP version of the envelope being sent
 * @param soapAction the binding's `soapAction`, if any
 * @param opts `skipSoapAction` omits the action in either version
 */
export function soapActionHeaders(
  version: SoapEnvelopeVersion,
  soapAction: string | undefined,
  opts: SoapActionOptions = {},
): SoapActionHeaders {
  const charset = opts.charset ?? 'UTF-8';
  const skip = opts.skipSoapAction === true;
  if (version === '1.1') {
    return {
      contentType: `text/xml;charset=${charset}`,
      headers: skip ? {} : { SOAPAction: `"${soapAction ?? ''}"` },
    };
  }
  const action = !skip && soapAction !== undefined && soapAction.length > 0 ? `;action="${soapAction}"` : '';
  return { contentType: `application/soap+xml;charset=${charset}${action}`, headers: {} };
}
