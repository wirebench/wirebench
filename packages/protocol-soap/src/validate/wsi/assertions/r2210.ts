import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { boundMessages, findingAt } from './helpers.js';

/**
 * BP 1.1 R2210: if a document-literal binding does not specify the parts attribute on
 * `soapbind:body`, "the corresponding abstract wsdl:message MUST define zero or one wsdl:parts" —
 * otherwise the body would carry more than one child element.
 */
export const R2210: WsiAssertion = {
  id: 'R2210',
  title: 'A document-literal body without a parts attribute binds a message of at most one part',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let bodies = 0;
    for (const view of boundMessages(context)) {
      if (
        view.style !== 'document' ||
        view.soapBody === undefined ||
        view.declaredParts !== undefined ||
        view.abstractMessage === undefined
      ) {
        continue;
      }
      bodies += 1;
      if (view.parts.length > 1) {
        findings.push(
          findingAt(
            view.location,
            view.soapBody,
            `soapbind:body has no parts attribute and its message defines ${view.parts.length} parts`,
          ),
        );
      }
    }
    return bodies === 0 ? NOT_APPLICABLE : findings;
  },
};
