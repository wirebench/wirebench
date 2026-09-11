import { NS } from '../../../xml/namespaces.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { descendants, findingAt, schemaElements } from './helpers.js';

/**
 * BP 1.1 R2111: a description's type declarations "MUST NOT use the wsdl:arrayType attribute" —
 * the SOAP-encoded array annotation has no place in a literal description.
 */
export const R2111: WsiAssertion = {
  id: 'R2111',
  title: 'No type declaration carries wsdl:arrayType',
  level: 'REQUIRED',
  section: '4.4 XML Schema',
  check(context) {
    const findings: WsiFinding[] = [];
    let declarations = 0;
    for (const view of schemaElements(context)) {
      for (const element of descendants(view.schema)) {
        if (element.namespaceURI !== NS.XSD) {
          continue;
        }
        declarations += 1;
        const value = element.getAttributeNS(NS.WSDL, 'arrayType');
        if (value !== null && value !== '') {
          findings.push(
            findingAt(view.location, element, `xs:${element.localName ?? ''} carries wsdl:arrayType="${value}"`),
          );
        }
      }
    }
    return declarations === 0 ? NOT_APPLICABLE : findings;
  },
};
