import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { attributeQName, findingAt, messageParts, targetNamespaceOf, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2206: a `wsdl:part` that uses the element attribute "MUST refer to a global element
 * declaration" — the schema set must actually declare it. Parts naming a namespace the schema set
 * knows nothing about are reported by R2101 instead.
 */
export const R2206: WsiAssertion = {
  id: 'R2206',
  title: 'An element-declared part refers to a global element declaration',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let parts = 0;
    for (const doc of wsdlDocuments(context)) {
      const tns = targetNamespaceOf(doc.definitions);
      for (const message of childElements(doc.definitions, NS.WSDL, 'message')) {
        for (const part of messageParts(message)) {
          const raw = optionalAttribute(part, 'element');
          const qname = attributeQName(part, 'element', tns);
          if (raw === undefined || qname === undefined || !context.schemaSet.namespaces.includes(qname.namespaceUri)) {
            continue;
          }
          parts += 1;
          if (context.schemaSet.lookupElement(qname) === undefined) {
            findings.push(
              findingAt(
                doc.location,
                part,
                `wsdl:part element="${raw}" does not resolve to a global element declaration`,
              ),
            );
          }
        }
      }
    }
    return parts === 0 ? NOT_APPLICABLE : findings;
  },
};
