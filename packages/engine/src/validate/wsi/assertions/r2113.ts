import { NS } from '../../../xml/namespaces.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { descendants, findingAt, schemaElements } from './helpers.js';

const ENCODING_NAMESPACES = [NS.SOAP11_ENC, NS.SOAP12_ENC] as const;

/**
 * BP 1.1 R2113: a description's type declarations "MUST NOT use the soapenc:arrayType attribute".
 * Both SOAP encoding namespaces are checked, so a SOAP 1.2 spelling is caught too.
 */
export const R2113: WsiAssertion = {
  id: 'R2113',
  title: 'No type declaration carries soapenc:arrayType',
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
        for (const ns of ENCODING_NAMESPACES) {
          const value = element.getAttributeNS(ns, 'arrayType');
          if (value !== null && value !== '') {
            findings.push(
              findingAt(view.location, element, `xs:${element.localName ?? ''} carries soapenc:arrayType="${value}"`),
            );
          }
        }
      }
    }
    return declarations === 0 ? NOT_APPLICABLE : findings;
  },
};
