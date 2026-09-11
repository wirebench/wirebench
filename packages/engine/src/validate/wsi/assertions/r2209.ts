import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { boundMessages, findingAt } from './helpers.js';

/**
 * BP 1.1 R2209: a `wsdl:binding` "SHOULD bind every wsdl:part of a wsdl:message in the
 * wsdl:portType to which it refers to one of soapbind:body, soapbind:header, soapbind:fault or
 * soapbind:headerfault". An unbound part never reaches the wire, so it is reported as a warning.
 *
 * All four constructs count: a part left out of `soapbind:body/@parts` is still bound when a
 * `soapbind:header` or `soapbind:headerfault` of the same binding operation names it on this very
 * message (see `soapBoundParts`).
 */
export const R2209: WsiAssertion = {
  id: 'R2209',
  title: 'Every part of a bound message is bound to a SOAP construct',
  level: 'RECOMMENDED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let messages = 0;
    for (const view of boundMessages(context)) {
      if (view.abstractMessage === undefined || view.parts.length === 0) {
        continue;
      }
      messages += 1;
      const boundNames = new Set(view.soapBoundParts.map((part) => optionalAttribute(part, 'name')));
      for (const part of view.parts) {
        const name = optionalAttribute(part, 'name');
        if (!boundNames.has(name)) {
          findings.push(
            findingAt(
              view.location,
              view.messageElement,
              `wsdl:part "${name ?? ''}" of the bound message is not bound to any SOAP construct`,
            ),
          );
        }
      }
    }
    return messages === 0 ? NOT_APPLICABLE : findings;
  },
};
