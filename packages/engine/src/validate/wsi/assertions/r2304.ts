import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2304: a description "MUST have operations with distinct values for their name attributes
 * within the same wsdl:portType" — WSDL 1.1 operation overloading is outside the profile.
 */
export const R2304: WsiAssertion = {
  id: 'R2304',
  title: 'Operation names are distinct within a portType',
  level: 'REQUIRED',
  section: '4.6 Operations',
  check(context) {
    const findings: WsiFinding[] = [];
    let operations = 0;
    for (const doc of wsdlDocuments(context)) {
      for (const portType of childElements(doc.definitions, NS.WSDL, 'portType')) {
        const seen = new Set<string>();
        for (const operation of childElements(portType, NS.WSDL, 'operation')) {
          operations += 1;
          const name = optionalAttribute(operation, 'name') ?? '';
          if (seen.has(name)) {
            findings.push(
              findingAt(
                doc.location,
                operation,
                `wsdl:portType "${optionalAttribute(portType, 'name') ?? ''}" declares more than one operation named "${name}"`,
              ),
            );
          }
          seen.add(name);
        }
      }
    }
    return operations === 0 ? NOT_APPLICABLE : findings;
  },
};
