import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { SOAP_ENCODING_NS, attributesOf, envelopeElements, envelopes, messageFinding } from './helpers.js';

/** Both SOAP encoding namespaces; an `arrayType` in either one is out of profile. */
const ENCODING_NAMESPACES = [SOAP_ENCODING_NS['1.1'], SOAP_ENCODING_NS['1.2']];

/**
 * BP 1.1 R2113: an envelope carries no `soapenc:arrayType` attribute on any of its elements.
 * The profile rules out SOAP encoding, and `arrayType` is the attribute that carries an encoded
 * array's item type and dimensions — so its presence means the message is not the literal
 * instance the description promised.
 *
 * The description-level counterparts (a `wsdl:arrayType` attribute, a type derived from
 * `soapenc:Array`) stay in the WSDL catalogue as R2110/R2111.
 */
export const R2113: WsiMessageAssertion = {
  id: 'R2113',
  title: 'An envelope carries no soapenc:arrayType attribute',
  level: 'REQUIRED',
  section: '4.3 Use of SOAP Encoding',
  check(context) {
    const findings: WsiFinding[] = [];
    const views = envelopes(context);
    for (const view of views) {
      for (const element of envelopeElements(view)) {
        for (const attribute of attributesOf(element)) {
          if (attribute.localName === 'arrayType' && ENCODING_NAMESPACES.includes(attribute.namespaceUri ?? '')) {
            findings.push(
              messageFinding(view, element, `"${element.nodeName}" carries soapenc:arrayType="${attribute.value}"`),
            );
          }
        }
      }
    }
    return views.length === 0 ? NOT_APPLICABLE : findings;
  },
};
