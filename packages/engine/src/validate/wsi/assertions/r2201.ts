import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { boundMessages, findingAt } from './helpers.js';

/**
 * BP 1.1 R2201: a document-literal binding "MUST, in each of its soapbind:body element(s), have at
 * most one part listed in the parts attribute, if the parts attribute is specified" — a literal
 * body carries exactly one child element.
 */
export const R2201: WsiAssertion = {
  id: 'R2201',
  title: 'A document-literal soapbind:body lists at most one part',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let bodies = 0;
    for (const view of boundMessages(context)) {
      if (view.style !== 'document' || view.soapBody === undefined || view.declaredParts === undefined) {
        continue;
      }
      bodies += 1;
      if (view.declaredParts.length > 1) {
        findings.push(
          findingAt(
            view.location,
            view.soapBody,
            `soapbind:body parts="${optionalAttribute(view.soapBody, 'parts') ?? ''}" lists ${view.declaredParts.length} parts; a document-literal body may list at most one`,
          ),
        );
      }
    }
    return bodies === 0 ? NOT_APPLICABLE : findings;
  },
};
