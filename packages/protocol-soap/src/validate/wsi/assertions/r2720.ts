import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapExtensions } from './helpers.js';

/**
 * BP 1.1 R2720: a `wsdl:binding` "MUST use the part attribute with a schema type of 'NMTOKEN' on
 * all contained soapbind:header and soapbind:headerfault elements" — one header binds exactly one
 * part, so a whitespace-separated list is out of profile.
 */
export const R2720: WsiAssertion = {
  id: 'R2720',
  title: 'soapbind:header and headerfault name exactly one part',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let headers = 0;
    for (const view of soapExtensions(context)) {
      if (view.kind !== 'header' && view.kind !== 'headerfault') {
        continue;
      }
      headers += 1;
      const part = optionalAttribute(view.element, 'part');
      if (part === undefined || /\s/.test(part.trim())) {
        findings.push(
          findingAt(
            view.location,
            view.element,
            `soapbind:${view.kind} part="${part ?? ''}" must name exactly one wsdl:part`,
          ),
        );
      }
    }
    return headers === 0 ? NOT_APPLICABLE : findings;
  },
};
