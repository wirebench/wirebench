import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { attributeQName, findingAt, messageParts, targetNamespaceOf, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2101: a description "MUST NOT use QName references to elements in namespaces that have
 * been neither imported, nor defined in the referring WSDL document". The namespaces considered
 * known are every schema namespace of the bundle, every `wsdl:definitions` target namespace, every
 * `wsdl:import`/`xs:import` namespace, and the XML Schema namespace itself.
 */
export const R2101: WsiAssertion = {
  id: 'R2101',
  title: 'Part references name only imported or locally defined namespaces',
  level: 'REQUIRED',
  section: '4.4 XML Schema',
  check(context) {
    const known = new Set<string>([NS.XSD, ...context.schemaSet.namespaces]);
    for (const doc of wsdlDocuments(context)) {
      known.add(targetNamespaceOf(doc.definitions));
      for (const importEl of childElements(doc.definitions, NS.WSDL, 'import')) {
        const namespace = optionalAttribute(importEl, 'namespace');
        if (namespace !== undefined) {
          known.add(namespace);
        }
      }
    }

    const findings: WsiFinding[] = [];
    let references = 0;
    for (const doc of wsdlDocuments(context)) {
      const tns = targetNamespaceOf(doc.definitions);
      for (const message of childElements(doc.definitions, NS.WSDL, 'message')) {
        for (const part of messageParts(message)) {
          for (const attribute of ['element', 'type'] as const) {
            const qname = attributeQName(part, attribute, tns);
            if (qname === undefined) {
              continue;
            }
            references += 1;
            if (!known.has(qname.namespaceUri)) {
              findings.push(
                findingAt(
                  doc.location,
                  part,
                  `wsdl:part ${attribute}="${optionalAttribute(part, attribute) ?? ''}" is in namespace "${qname.namespaceUri}", which is neither defined nor imported`,
                ),
              );
            }
          }
        }
      }
    }
    return references === 0 ? NOT_APPLICABLE : findings;
  },
};
