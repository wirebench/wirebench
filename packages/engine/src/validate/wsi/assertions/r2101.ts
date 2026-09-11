import type { Element } from '@xmldom/xmldom';
import { NS } from '../../../xml/namespaces.js';
import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import {
  SOAP_BINDING_NAMESPACES,
  attributeQName,
  declaredNamespaces,
  descendants,
  findingAt,
  targetNamespaceOf,
  wsdlDocuments,
} from './helpers.js';

/** One QName-valued attribute that refers to a WSDL component, and the element carrying it. */
interface ComponentReference {
  readonly element: Element;
  readonly attribute: string;
}

/** Every attribute of `definitions` that is a QName reference to a WSDL component. */
function componentReferences(definitions: Element): readonly ComponentReference[] {
  const references: ComponentReference[] = [];
  for (const element of descendants(definitions)) {
    if (element.namespaceURI === NS.WSDL) {
      if (element.localName === 'binding' && element.parentNode === definitions) {
        references.push({ element, attribute: 'type' });
      } else if (element.localName === 'port') {
        references.push({ element, attribute: 'binding' });
      } else if (element.localName === 'input' || element.localName === 'output' || element.localName === 'fault') {
        // Only the abstract sides carry @message; the binding sides do not.
        references.push({ element, attribute: 'message' });
      }
    } else if (
      SOAP_BINDING_NAMESPACES.includes(element.namespaceURI as (typeof SOAP_BINDING_NAMESPACES)[number]) &&
      (element.localName === 'header' || element.localName === 'headerfault')
    ) {
      references.push({ element, attribute: 'message' });
    }
  }
  return references;
}

/**
 * BP 1.1 R2101: a description "MUST NOT use QName references to WSDL components in namespaces
 * that have been neither imported, nor defined in the referring WSDL document". Checked here are
 * the references to *WSDL* components: `wsdl:binding/@type`, `wsdl:port/@binding`, the
 * `@message` of an abstract `wsdl:input`/`output`/`fault` and of a `soapbind:header`/
 * `headerfault`. A `wsdl:import` *declares* a namespace rather than referring to one, so it is not
 * itself a reference to check.
 *
 * The parallel requirement for *schema* components (`wsdl:part/@element|@type`) is {@link R2102}.
 * A namespace counts as known when it is a `wsdl:definitions/@targetNamespace` or an
 * `xs:schema/@targetNamespace` of the bundle, or the `namespace` of a `wsdl:import`/`xs:import`.
 */
export const R2101: WsiAssertion = {
  id: 'R2101',
  title: 'WSDL component references name only imported or locally defined namespaces',
  level: 'REQUIRED',
  section: '4.4 XML Schema',
  check(context) {
    const known = declaredNamespaces(context);
    const findings: WsiFinding[] = [];
    let references = 0;
    for (const doc of wsdlDocuments(context)) {
      const tns = targetNamespaceOf(doc.definitions);
      for (const { element, attribute } of componentReferences(doc.definitions)) {
        const raw = optionalAttribute(element, attribute);
        if (raw === undefined) {
          continue;
        }
        const qname = attributeQName(element, attribute, tns);
        references += 1;
        if (qname === undefined || !known.has(qname.namespaceUri)) {
          findings.push(
            findingAt(
              doc.location,
              element,
              `${element.localName ?? ''} ${attribute}="${raw}" refers to a namespace that is neither defined nor imported`,
            ),
          );
        }
      }
    }
    return references === 0 ? NOT_APPLICABLE : findings;
  },
};
