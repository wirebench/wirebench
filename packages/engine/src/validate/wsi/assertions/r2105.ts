import { NS } from '../../../xml/namespaces.js';
import { childElements, firstChildElement } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2105: every `xs:schema` contained in a `wsdl:types` element "MUST have a targetNamespace
 * attribute with a valid and non-null value". Both an absent `targetNamespace` and a present but
 * empty one (`targetNamespace=""`, the no-namespace schema) fail. Standalone schema documents are
 * governed by XML Schema itself and are not examined here.
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
        // "a valid and non-null value": an absent attribute and a present-but-empty one both
        // fail. getAttribute is used directly because optionalAttribute collapses the two.
        const declared = schema.getAttribute('targetNamespace');
        if (declared === null) {
          findings.push(findingAt(doc.location, schema, 'Inline xs:schema has no targetNamespace attribute'));
        } else if (declared === '') {
          findings.push(findingAt(doc.location, schema, 'Inline xs:schema declares an empty targetNamespace'));
        }
      }
    }
    return schemas === 0 ? NOT_APPLICABLE : findings;
  },
};
