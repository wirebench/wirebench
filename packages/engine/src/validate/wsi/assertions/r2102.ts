import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import {
  attributeQName,
  declaredNamespaces,
  findingAt,
  messageParts,
  targetNamespaceOf,
  wsdlDocuments,
} from './helpers.js';

/**
 * BP 1.1 R2102: a QName reference to a *schema component* — the `element` or `type` of a
 * `wsdl:part` — "MUST use the namespace defined in the targetNamespace attribute on the
 * xsd:schema element", i.e. it must name a namespace the description actually defines or imports.
 *
 * The companion {@link R2101} covers references to *WSDL* components (a binding's port type, a
 * port's binding, an operation's messages); this one covers the schema side.
 */
export const R2102: WsiAssertion = {
  id: 'R2102',
  title: 'Part element/type references name only imported or locally defined namespaces',
  level: 'REQUIRED',
  section: '4.4 XML Schema',
  check(context) {
    const known = declaredNamespaces(context);
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
