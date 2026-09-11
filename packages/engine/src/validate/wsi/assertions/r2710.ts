import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapBindings } from './helpers.js';

/**
 * BP 1.1 R2710: the operations of a `wsdl:binding` "MUST result in wire signatures that are
 * different from one another".
 *
 * This is an **approximation**: the profile's subject is the *wire signature* (for document-literal,
 * the qualified name of the body's first child; for rpc-literal, the wrapper element), which two
 * differently-named operations can still share. What is checked here is the much cheaper and
 * strictly narrower condition that no two operations of one binding share a `name` — the case
 * that is both unambiguous and by far the most common. Operations whose names differ but whose
 * wire signatures collide are not reported.
 */
export const R2710: WsiAssertion = {
  id: 'R2710',
  title: 'Operation names are distinct within a binding (approximates wire-signature distinctness)',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let operations = 0;
    for (const view of soapBindings(context)) {
      const seen = new Set<string>();
      for (const operation of childElements(view.binding, NS.WSDL, 'operation')) {
        operations += 1;
        const name = optionalAttribute(operation, 'name') ?? '';
        if (seen.has(name)) {
          findings.push(
            findingAt(
              view.location,
              operation,
              `wsdl:binding "${optionalAttribute(view.binding, 'name') ?? ''}" declares more than one operation named "${name}"`,
            ),
          );
        }
        seen.add(name);
      }
    }
    return operations === 0 ? NOT_APPLICABLE : findings;
  },
};
