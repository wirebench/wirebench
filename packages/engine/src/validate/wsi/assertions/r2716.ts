import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapExtensions } from './helpers.js';

/**
 * BP 1.1 R2716: a document-literal binding "MUST NOT have the namespace attribute specified on
 * contained soapbind:body, soapbind:header, soapbind:headerfault and soapbind:fault elements" —
 * the namespace comes from the global element declaration the part names.
 */
export const R2716: WsiAssertion = {
  id: 'R2716',
  title: 'document-literal soapbind elements declare no namespace attribute',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let elements = 0;
    for (const view of soapExtensions(context)) {
      if (view.style !== 'document') {
        continue;
      }
      elements += 1;
      const namespace = optionalAttribute(view.element, 'namespace');
      if (namespace !== undefined) {
        findings.push(
          findingAt(
            view.location,
            view.element,
            `document-literal soapbind:${view.kind} declares namespace="${namespace}"`,
          ),
        );
      }
    }
    return elements === 0 ? NOT_APPLICABLE : findings;
  },
};
