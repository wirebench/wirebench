import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import {
  bindingMessages,
  findPart,
  findingAt,
  referencedMessage,
  soapBindings,
  targetNamespaceOf,
  wsdlDocuments,
} from './helpers.js';

/**
 * BP 1.1 R2205: a description "MUST refer, in each of its soapbind:header and
 * soapbind:headerfault elements, only to wsdl:part element(s) that have been defined using the
 * element attribute" — a header is always a single global element. A reference that does not
 * resolve to a part at all is left to R2720/the WSDL parser.
 */
export const R2205: WsiAssertion = {
  id: 'R2205',
  title: 'soapbind:header and headerfault refer to element-declared parts',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const tnsByLocation = new Map(
      wsdlDocuments(context).map((doc) => [doc.location, targetNamespaceOf(doc.definitions)] as const),
    );
    const findings: WsiFinding[] = [];
    let references = 0;
    for (const view of soapBindings(context)) {
      const tns = tnsByLocation.get(view.location) ?? '';
      for (const operation of childElements(view.binding, NS.WSDL, 'operation')) {
        for (const message of bindingMessages(operation)) {
          for (const header of childElements(message, view.soapNs, 'header')) {
            for (const element of [header, ...childElements(header, view.soapNs, 'headerfault')]) {
              const partName = optionalAttribute(element, 'part');
              const target = referencedMessage(context, element, 'message', tns);
              if (partName === undefined || target === undefined) {
                continue;
              }
              const part = findPart(target.element, partName);
              if (part === undefined) {
                continue;
              }
              references += 1;
              if (optionalAttribute(part, 'element') === undefined) {
                findings.push(
                  findingAt(
                    view.location,
                    element,
                    `soapbind:${element.localName ?? 'header'} refers to wsdl:part "${partName}", which is not declared with the element attribute`,
                  ),
                );
              }
            }
          }
        }
      }
    }
    return references === 0 ? NOT_APPLICABLE : findings;
  },
};
