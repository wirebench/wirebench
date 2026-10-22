import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { attributesOf, envelopeElements, envelopes, messageFinding } from './helpers.js';

/**
 * BP 1.1 R1015: a message bound with `use="literal"` carries no `soap:encodingStyle` attribute.
 * A literal body is an instance of a schema, not a graph serialization, so naming an encoding for
 * it is meaningless — and a receiver that honoured it would read the body differently.
 *
 * Not applicable to an `encoded` binding, where naming the encoding is exactly the point.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1015: WsiMessageAssertion = {
  id: 'R1015',
  title: 'A literal message carries no soap:encodingStyle attribute',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    if (context.binding.use !== 'literal') {
      return NOT_APPLICABLE;
    }
    const findings: WsiFinding[] = [];
    const views = envelopes(context);
    for (const view of views) {
      for (const element of envelopeElements(view)) {
        for (const attribute of attributesOf(element)) {
          if (attribute.namespaceUri === view.soapNs && attribute.localName === 'encodingStyle') {
            findings.push(
              messageFinding(
                view,
                element,
                `"${element.nodeName}" carries soap:encodingStyle="${attribute.value}" in a ${context.binding.style}/literal message`,
              ),
            );
          }
        }
      }
    }
    return views.length === 0 ? NOT_APPLICABLE : findings;
  },
};
