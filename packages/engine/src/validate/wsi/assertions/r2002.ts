import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { bundledDocumentFor, findingAt, resolveAgainst, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2002: to import XML Schema definitions, a description "MUST use the XML Schema 'import'
 * statement" — i.e. an `xs:import` inside `wsdl:types`, never a `wsdl:import`. This flags each
 * `wsdl:import` that resolves to an `xs:schema` document.
 *
 * Such an import also breaches {@link R2001} ("wsdl:import imports WSDL only"); this assertion is
 * the more specific of the two, so R2001 defers the schema case to it and the construct is
 * reported once.
 */
export const R2002: WsiAssertion = {
  id: 'R2002',
  title: 'Schemas are imported with xs:import, not wsdl:import',
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
        if (target?.kind === 'xsd') {
          findings.push(
            findingAt(
              doc.location,
              importEl,
              `wsdl:import location="${location}" imports a schema; use xs:import inside wsdl:types instead`,
            ),
          );
        }
      }
    }
    return imports === 0 ? NOT_APPLICABLE : findings;
  },
};
