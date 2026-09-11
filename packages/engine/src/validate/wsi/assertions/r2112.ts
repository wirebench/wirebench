import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, schemaElements } from './helpers.js';

const ARRAY_OF = /^ArrayOf.+/;

/**
 * BP 1.1 R2112: in a description, "elements SHOULD NOT be named using the convention ArrayOfXXX" —
 * the naming survives from SOAP encoding and misleads consumers of a literal description. This is
 * a `SHOULD`, so a hit is reported as a warning rather than a failure.
 */
export const R2112: WsiAssertion = {
  id: 'R2112',
  title: 'Global declarations avoid the ArrayOfXXX naming convention',
  level: 'RECOMMENDED',
  section: '4.4 XML Schema',
  check(context) {
    const findings: WsiFinding[] = [];
    let declarations = 0;
    for (const view of schemaElements(context)) {
      for (const kind of ['element', 'complexType', 'simpleType'] as const) {
        for (const declaration of childElements(view.schema, NS.XSD, kind)) {
          const name = optionalAttribute(declaration, 'name');
          if (name === undefined) {
            continue;
          }
          declarations += 1;
          if (ARRAY_OF.test(name)) {
            findings.push(
              findingAt(view.location, declaration, `xs:${kind} "${name}" uses the ArrayOfXXX naming convention`),
            );
          }
        }
      }
    }
    return declarations === 0 ? NOT_APPLICABLE : findings;
  },
};
