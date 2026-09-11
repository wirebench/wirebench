import type { Element, Node } from '@xmldom/xmldom';
import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, wsdlDocuments } from './helpers.js';

/** The first `wsdl:input`/`wsdl:output` child of a port-type operation, in document order. */
function firstMessageKind(operation: Element): 'input' | 'output' | undefined {
  let child: Node | null = operation.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      const element = child as Element;
      if (element.namespaceURI === NS.WSDL && (element.localName === 'input' || element.localName === 'output')) {
        return element.localName;
      }
    }
    child = child.nextSibling;
  }
  return undefined;
}

/**
 * BP 1.1 R2303: a description "MUST NOT use Solicit-Response and Notification type operations" —
 * the profile covers only the two client-initiated message exchange patterns, so a port-type
 * operation whose first message is an output is out of profile.
 */
export const R2303: WsiAssertion = {
  id: 'R2303',
  title: 'No Solicit-Response or Notification operations',
  level: 'REQUIRED',
  section: '4.6 Operations',
  check(context) {
    const findings: WsiFinding[] = [];
    let operations = 0;
    for (const doc of wsdlDocuments(context)) {
      for (const portType of childElements(doc.definitions, NS.WSDL, 'portType')) {
        for (const operation of childElements(portType, NS.WSDL, 'operation')) {
          operations += 1;
          if (firstMessageKind(operation) === 'output') {
            findings.push(
              findingAt(
                doc.location,
                operation,
                `Operation "${optionalAttribute(operation, 'name') ?? ''}" starts with wsdl:output, which is a Solicit-Response or Notification operation`,
              ),
            );
          }
        }
      }
    }
    return operations === 0 ? NOT_APPLICABLE : findings;
  },
};
