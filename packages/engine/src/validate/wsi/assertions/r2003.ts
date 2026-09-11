import type { Element } from '@xmldom/xmldom';
import { NS } from '../../../xml/namespaces.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { descendants, findingAt, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2003: a description "MUST use the XML Schema 'import' statement only within the
 * xsd:schema element of the types section". An `xs:import` placed directly under `wsdl:types` (or
 * anywhere else in the document) is flagged.
 */
export const R2003: WsiAssertion = {
  id: 'R2003',
  title: 'xs:import appears only inside an xs:schema of wsdl:types',
  level: 'REQUIRED',
  section: '4.2 Document Structure',
  check(context) {
    const findings: WsiFinding[] = [];
    let imports = 0;
    for (const doc of wsdlDocuments(context)) {
      for (const element of descendants(doc.definitions)) {
        if (element.namespaceURI !== NS.XSD || element.localName !== 'import') {
          continue;
        }
        imports += 1;
        const parent = element.parentNode;
        const parentEl = parent !== null && parent.nodeType === 1 ? (parent as Element) : undefined;
        if (parentEl?.namespaceURI !== NS.XSD || parentEl.localName !== 'schema') {
          findings.push(
            findingAt(doc.location, element, 'xs:import must be a child of an xs:schema inside wsdl:types'),
          );
        }
      }
    }
    return imports === 0 ? NOT_APPLICABLE : findings;
  },
};
