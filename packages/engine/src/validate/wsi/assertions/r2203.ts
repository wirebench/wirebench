import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { boundMessages, findingAt } from './helpers.js';

/**
 * BP 1.1 R2203: an rpc-literal binding's message parts bound to `soapbind:body` "MUST use the type
 * attribute" — the operation wrapper supplies the element name, so the part contributes only a
 * type.
 */
export const R2203: WsiAssertion = {
  id: 'R2203',
  title: 'rpc-literal parts are declared with type, not element',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let parts = 0;
    for (const view of boundMessages(context)) {
      if (view.style !== 'rpc') {
        continue;
      }
      for (const part of view.boundParts) {
        parts += 1;
        if (optionalAttribute(part, 'type') === undefined) {
          findings.push(
            findingAt(
              view.location,
              part,
              `wsdl:part "${optionalAttribute(part, 'name') ?? ''}" is bound to an rpc-literal soapbind:body but does not use the type attribute`,
            ),
          );
        }
      }
    }
    return parts === 0 ? NOT_APPLICABLE : findings;
  },
};
