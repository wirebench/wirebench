import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapExtensions } from './helpers.js';

/**
 * BP 1.1 R2706: a `wsdl:binding` "MUST use the value of 'literal' for the use attribute in all
 * soapbind:body, soapbind:fault, soapbind:header and soapbind:headerfault elements" — SOAP
 * encoding is out of profile. An absent `use` is left to the description's own default.
 */
export const R2706: WsiAssertion = {
  id: 'R2706',
  title: 'Every soapbind element that declares use declares "literal"',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let declarations = 0;
    for (const view of soapExtensions(context)) {
      const use = optionalAttribute(view.element, 'use');
      if (use === undefined) {
        continue;
      }
      declarations += 1;
      if (use !== 'literal') {
        findings.push(findingAt(view.location, view.element, `soapbind:${view.kind} declares use="${use}"`));
      }
    }
    return declarations === 0 ? NOT_APPLICABLE : findings;
  },
};
