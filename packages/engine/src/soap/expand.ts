/**
 * Property expansion over a SOAP send input: the endpoint, the envelope, the SOAP action, the
 * headers, the attachments and the WS-Addressing fields.
 *
 * The expansion itself is `project/properties.ts`'s {@link expand}; this file knows which fields of
 * a {@link SoapSendInput} take it, as `rest/expand.ts`, `grpc/expand.ts` and `ws/expand.ts` do for
 * theirs.
 */

import { expand } from '../project/properties.js';
import type { ExpandOptions, PropertyScopes, UnresolvedRef } from '../project/properties.js';
import {
  assertNoControlCharacters,
  assertOriginIndependent,
  escapeXmlValue,
  expandWithSequenceEscaped,
} from '../project/sequence-guards.js';
import type { SoapSendInput } from './types.js';

/**
 * Expands the endpoint, envelope, soap action, and every header name/value of a
 * {@link SoapSendInput}. Header *names* are expanded too, so two headers whose names expand to
 * the same string collapse into one entry (last-write-wins, per `Object.entries` insertion
 * order — same as any other JS object key collision).
 *
 * Attachments are expanded as well, in the two places a property can reasonably appear: the
 * display/file name that ends up in `Content-Disposition`, and the path of a file-backed
 * attachment. Content-IDs are left alone — they are generated, not authored.
 */
export function expandSendInput(
  input: SoapSendInput,
  scopes: PropertyScopes,
  options?: ExpandOptions,
): { input: SoapSendInput; unresolved: UnresolvedRef[] } {
  const unresolved: UnresolvedRef[] = [];

  /** Expands `text`; `place`, when given, names a line-oriented field a Sequence value must not break. */
  function run(text: string, place?: string): string {
    const result = expand(text, scopes, { ...options, entitize: false });
    unresolved.push(...result.unresolved);
    if (place !== undefined) {
      assertNoControlCharacters(place, result, scopes);
    }
    return result.text;
  }

  // The endpoint is where the envelope, and every credential with it, goes (ADR-0015).
  assertOriginIndependent('The endpoint', (s) => expand(input.endpoint, s).text, scopes);
  const endpoint = run(input.endpoint, 'The endpoint');
  const envelopeXml = expandEnvelope(input.envelopeXml, scopes, options, input.entitize, unresolved);
  const soapAction = input.soapAction !== undefined ? run(input.soapAction, 'The SOAP action') : undefined;

  let headers: Record<string, string> | undefined;
  if (input.headers !== undefined) {
    headers = {};
    for (const [name, value] of Object.entries(input.headers)) {
      headers[run(name, 'A header name')] = run(value, `The ${name} header`);
    }
  }

  const attachments = input.attachments?.map((attachment) => ({
    ...attachment,
    name: run(attachment.name),
    source:
      attachment.source.kind === 'path'
        ? { kind: 'path' as const, path: run(attachment.source.path) }
        : attachment.source,
  }));

  // The explicit WS-Addressing fields are user-typed strings just like the endpoint or a
  // header value, and may carry the same `${#Env#…}`/`${#Global#…}` references — so they go
  // through the same scopes rather than reaching the wire verbatim.
  const wsa =
    input.wsa !== undefined
      ? {
          ...input.wsa,
          config: {
            ...input.wsa.config,
            ...(input.wsa.config.to !== undefined ? { to: run(input.wsa.config.to, 'wsa:To') } : {}),
            ...(input.wsa.config.action !== undefined ? { action: run(input.wsa.config.action, 'wsa:Action') } : {}),
            ...(input.wsa.config.replyTo !== undefined
              ? { replyTo: run(input.wsa.config.replyTo, 'wsa:ReplyTo') }
              : {}),
            ...(input.wsa.config.from !== undefined ? { from: run(input.wsa.config.from, 'wsa:From') } : {}),
            ...(input.wsa.config.faultTo !== undefined
              ? { faultTo: run(input.wsa.config.faultTo, 'wsa:FaultTo') }
              : {}),
          },
        }
      : undefined;

  return {
    input: {
      ...input,
      endpoint,
      envelopeXml,
      ...(soapAction !== undefined ? { soapAction } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(attachments !== undefined ? { attachments } : {}),
      ...(wsa !== undefined ? { wsa } : {}),
    },
    unresolved,
  };
}

/**
 * The envelope, expanded. Only the envelope is entitized: escaping a header value or an endpoint
 * would corrupt it. A Sequence value is XML-escaped here whatever the request's own setting, quotes
 * included, because it came from a response and could otherwise add elements or attributes to the
 * envelope (ADR-0015).
 */
function expandEnvelope(
  envelopeXml: string,
  scopes: PropertyScopes,
  options: ExpandOptions | undefined,
  requested: boolean | undefined,
  unresolved: UnresolvedRef[],
): string {
  const entitize = options?.entitize ?? requested ?? false;
  const result = expand(envelopeXml, scopes, { ...options, entitize });
  unresolved.push(...result.unresolved);
  return expandWithSequenceEscaped(
    (s) => expand(envelopeXml, s, { ...options, entitize }).text,
    scopes,
    escapeXmlValue,
  );
}
