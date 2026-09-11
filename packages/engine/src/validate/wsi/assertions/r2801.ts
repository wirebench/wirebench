import type { Element } from '@xmldom/xmldom';
import { NS } from '../../../xml/namespaces.js';
import { firstChildElement } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2801: a description "MUST use XML Schema 1.0 Recommendation as the basis of user defined
 * datatypes and structures" — a `wsdl:types` section holding a schema in one of the superseded
 * XML Schema draft namespaces is out of profile.
 */
export const R2801: WsiAssertion = {
  id: 'R2801',
  title: 'Type definitions use the XML Schema 1.0 namespace',
  level: 'REQUIRED',
  section: '4.9 Namespaces',
  check(context) {
    const findings: WsiFinding[] = [];
    let children = 0;
    for (const doc of wsdlDocuments(context)) {
      const typesEl = firstChildElement(doc.definitions, NS.WSDL, 'types');
      if (typesEl === undefined) {
        continue;
      }
      for (let child = typesEl.firstChild; child !== null; child = child.nextSibling) {
        if (child.nodeType !== 1) {
          continue;
        }
        const element = child as Element;
        if (element.localName !== 'schema') {
          continue;
        }
        children += 1;
        if (element.namespaceURI !== NS.XSD) {
          findings.push(
            findingAt(
              doc.location,
              element,
              `wsdl:types holds a schema in namespace "${element.namespaceURI ?? ''}" rather than XML Schema 1.0`,
            ),
          );
        }
      }
    }
    return children === 0 ? NOT_APPLICABLE : findings;
  },
};
