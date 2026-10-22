import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapBindings } from './helpers.js';

/** The only transport the profile allows a SOAP binding to declare. */
const HTTP_TRANSPORT = 'http://schemas.xmlsoap.org/soap/http';

/**
 * BP 1.1 R2702: a `wsdl:binding` "MUST specify the transport attribute with the value
 * http://schemas.xmlsoap.org/soap/http" — the profile binds SOAP to HTTP only.
 */
export const R2702: WsiAssertion = {
  id: 'R2702',
  title: 'soapbind:binding declares the HTTP transport',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    const bindings = soapBindings(context);
    for (const view of bindings) {
      const transport = optionalAttribute(view.soapBinding, 'transport');
      if (transport !== HTTP_TRANSPORT) {
        findings.push(
          findingAt(
            view.location,
            view.soapBinding,
            `soapbind:binding transport="${transport ?? ''}" is not "${HTTP_TRANSPORT}"`,
          ),
        );
      }
    }
    return bindings.length === 0 ? NOT_APPLICABLE : findings;
  },
};
