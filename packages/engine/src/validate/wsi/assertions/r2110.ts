import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { attributeQName, descendants, findingAt, schemaElements } from './helpers.js';

const ENCODING_NAMESPACES = new Set<string>([NS.SOAP11_ENC, NS.SOAP12_ENC]);

/**
 * BP 1.1 R2110: in a description, "declarations MUST NOT extend or restrict the soapenc:Array
 * type" — the SOAP 1.1 section 5 array shape is outside the profile. Every
 * `xs:extension`/`xs:restriction` inside an `xs:complexContent` is checked against the SOAP
 * encoding namespaces.
 */
export const R2110: WsiAssertion = {
  id: 'R2110',
  title: 'No type extends or restricts soapenc:Array',
  level: 'REQUIRED',
  section: '4.4 XML Schema',
  check(context) {
    const findings: WsiFinding[] = [];
    let derivations = 0;
    for (const view of schemaElements(context)) {
      for (const complexContent of descendants(view.schema)) {
        if (complexContent.namespaceURI !== NS.XSD || complexContent.localName !== 'complexContent') {
          continue;
        }
        for (const kind of ['extension', 'restriction'] as const) {
          for (const derivation of childElements(complexContent, NS.XSD, kind)) {
            derivations += 1;
            const base = attributeQName(derivation, 'base', '');
            if (base !== undefined && ENCODING_NAMESPACES.has(base.namespaceUri) && base.localName === 'Array') {
              findings.push(
                findingAt(
                  view.location,
                  derivation,
                  `xs:${kind} base="${optionalAttribute(derivation, 'base') ?? ''}" derives from soapenc:Array`,
                ),
              );
            }
          }
        }
      }
    }
    return derivations === 0 ? NOT_APPLICABLE : findings;
  },
};
