import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapExtensions } from './helpers.js';

/**
 * BP 1.1 R2722: when a `soapbind:fault` carries a name attribute, its value "MUST match the value
 * of the name attribute of the parent wsdl:fault" — the two describe the same fault.
 */
export const R2722: WsiAssertion = {
  id: 'R2722',
  title: 'A soapbind:fault name matches its parent wsdl:fault',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let faults = 0;
    for (const view of soapExtensions(context)) {
      const name = view.kind === 'fault' ? optionalAttribute(view.element, 'name') : undefined;
      if (name === undefined || view.wsdlFault === undefined) {
        continue;
      }
      faults += 1;
      const parentName = optionalAttribute(view.wsdlFault, 'name');
      if (parentName !== name) {
        findings.push(
          findingAt(
            view.location,
            view.element,
            `soapbind:fault name="${name}" does not match the enclosing wsdl:fault name="${parentName ?? ''}"`,
          ),
        );
      }
    }
    return faults === 0 ? NOT_APPLICABLE : findings;
  },
};
