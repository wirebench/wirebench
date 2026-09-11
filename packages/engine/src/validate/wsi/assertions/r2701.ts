import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapNamespaceOf, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2701: the `wsdl:binding` element of a description "MUST be a WSDL SOAP binding" as
 * defined by WSDL 1.1 section 3 — a binding carrying, for instance, an HTTP GET/POST extension
 * instead of `soapbind:binding` is outside the profile.
 */
export const R2701: WsiAssertion = {
  id: 'R2701',
  title: 'Every wsdl:binding is a SOAP binding',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let bindings = 0;
    for (const doc of wsdlDocuments(context)) {
      for (const binding of childElements(doc.definitions, NS.WSDL, 'binding')) {
        bindings += 1;
        if (soapNamespaceOf(binding) === undefined) {
          findings.push(
            findingAt(
              doc.location,
              binding,
              `wsdl:binding "${optionalAttribute(binding, 'name') ?? ''}" has no soapbind:binding element`,
            ),
          );
        }
      }
    }
    return bindings === 0 ? NOT_APPLICABLE : findings;
  },
};
