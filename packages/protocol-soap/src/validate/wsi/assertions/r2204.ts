import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { boundMessages, findingAt } from './helpers.js';

/**
 * BP 1.1 R2204: a document-literal binding's message parts bound to `soapbind:body` "MUST use the
 * element attribute" — the part itself names the single global element the body carries.
 */
export const R2204: WsiAssertion = {
  id: 'R2204',
  title: 'document-literal parts are declared with element, not type',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let parts = 0;
    for (const view of boundMessages(context)) {
      if (view.style !== 'document') {
        continue;
      }
      for (const part of view.boundParts) {
        parts += 1;
        if (optionalAttribute(part, 'element') === undefined) {
          findings.push(
            findingAt(
              view.location,
              part,
              `wsdl:part "${optionalAttribute(part, 'name') ?? ''}" is bound to a document-literal soapbind:body but does not use the element attribute`,
            ),
          );
        }
      }
    }
    return parts === 0 ? NOT_APPLICABLE : findings;
  },
};
