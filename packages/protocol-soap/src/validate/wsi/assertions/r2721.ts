import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapExtensions } from './helpers.js';

/**
 * BP 1.1 R2721: a `wsdl:binding` "MUST have the name attribute specified on all contained
 * soapbind:fault elements" — without it the fault cannot be tied to the abstract `wsdl:fault`.
 */
export const R2721: WsiAssertion = {
  id: 'R2721',
  title: 'Every soapbind:fault carries a name attribute',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let faults = 0;
    for (const view of soapExtensions(context)) {
      if (view.kind !== 'fault') {
        continue;
      }
      faults += 1;
      if (optionalAttribute(view.element, 'name') === undefined) {
        findings.push(findingAt(view.location, view.element, 'soapbind:fault has no name attribute'));
      }
    }
    return faults === 0 ? NOT_APPLICABLE : findings;
  },
};
