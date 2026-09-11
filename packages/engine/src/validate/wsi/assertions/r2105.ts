import { NS } from '../../../xml/namespaces.js';
import { childElements, firstChildElement, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2105: every `xs:schema` contained in a `wsdl:types` element "MUST have a targetNamespace
 * attribute with a valid and non-null value". Standalone schema documents are governed by XML
 * Schema itself and are not examined here.
 */
export const R2105: WsiAssertion = {
  id: 'R2105',
  title: 'Every inline xs:schema declares a non-empty targetNamespace',
  level: 'REQUIRED',
  section: '4.4 XML Schema',
  check(context) {
    const findings: WsiFinding[] = [];
    let schemas = 0;
    for (const doc of wsdlDocuments(context)) {
      const typesEl = firstChildElement(doc.definitions, NS.WSDL, 'types');
      if (typesEl === undefined) {
        continue;
      }
      for (const schema of childElements(typesEl, NS.XSD, 'schema')) {
        schemas += 1;
        if (optionalAttribute(schema, 'targetNamespace') === undefined) {
          findings.push(findingAt(doc.location, schema, 'Inline xs:schema has no targetNamespace attribute'));
        }
      }
    }
    return schemas === 0 ? NOT_APPLICABLE : findings;
  },
};
