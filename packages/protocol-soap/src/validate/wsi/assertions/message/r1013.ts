import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { attributesOf, envelopeElements, envelopes, messageFinding } from './helpers.js';

/** The `soap:mustUnderstand` values each SOAP version admits. */
const ALLOWED: Readonly<Record<'1.1' | '1.2', readonly string[]>> = {
  // SOAP 1.1 types the attribute as xsd:boolean restricted to the two digits.
  '1.1': ['0', '1'],
  // SOAP 1.2 types it as a plain xsd:boolean, so the lexical forms of true/false are all legal.
  '1.2': ['0', '1', 'true', 'false'],
};

/**
 * BP 1.1 R1013: `soap:mustUnderstand` carries a value the SOAP version admits. A receiver that
 * cannot parse the flag cannot tell a header block it may ignore from one it must reject.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1013: WsiMessageAssertion = {
  id: 'R1013',
  title: 'soap:mustUnderstand carries a value the SOAP version admits',
  level: 'REQUIRED',
  section: '3.2 SOAP Processing Model',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let attributes = 0;
    const allowed = ALLOWED[context.binding.soapVersion];
    for (const view of envelopes(context)) {
      for (const element of envelopeElements(view)) {
        for (const attribute of attributesOf(element)) {
          if (attribute.namespaceUri !== view.soapNs || attribute.localName !== 'mustUnderstand') {
            continue;
          }
          attributes += 1;
          if (!allowed.includes(attribute.value)) {
            findings.push(
              messageFinding(
                view,
                element,
                `soap:mustUnderstand="${attribute.value}" on "${element.nodeName}"; SOAP ${context.binding.soapVersion} allows ${allowed.join(', ')}`,
              ),
            );
          }
        }
      }
    }
    return attributes === 0 ? NOT_APPLICABLE : findings;
  },
};
