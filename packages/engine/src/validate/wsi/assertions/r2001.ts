import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { bundledDocumentFor, findingAt, resolveAgainst, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2001: a description "MUST only use the WSDL 'import' statement to import another WSDL
 * description". Every `wsdl:import` is therefore checked to point at a document whose root element
 * is `wsdl:definitions`; an import whose target could not be fetched is left alone (the resolver
 * already reports that as its own problem).
 */
export const R2001: WsiAssertion = {
  id: 'R2001',
  title: 'wsdl:import only imports WSDL documents',
  level: 'REQUIRED',
  section: '4.2 Document Structure',
  check(context) {
    const findings: WsiFinding[] = [];
    let imports = 0;
    for (const doc of wsdlDocuments(context)) {
      for (const importEl of childElements(doc.definitions, NS.WSDL, 'import')) {
        const location = optionalAttribute(importEl, 'location');
        if (location === undefined) {
          continue;
        }
        imports += 1;
        const resolved = resolveAgainst(location, doc.location);
        const target = resolved === undefined ? undefined : bundledDocumentFor(context, resolved);
        if (target !== undefined && target.kind !== 'wsdl') {
          findings.push(
            findingAt(
              doc.location,
              importEl,
              `wsdl:import location="${location}" refers to a document whose root element is not wsdl:definitions`,
            ),
          );
        }
      }
    }
    return imports === 0 ? NOT_APPLICABLE : findings;
  },
};
