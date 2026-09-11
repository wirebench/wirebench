import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, isAbsoluteUri, soapAddresses } from './helpers.js';

/**
 * BP 1.1 R2401: a `wsdl:port` describes an endpoint through `soapbind:address`, whose location
 * must be an absolute URI — a relative reference has no base once the description is republished
 * elsewhere.
 */
export const R2401: WsiAssertion = {
  id: 'R2401',
  title: 'soapbind:address declares an absolute endpoint URI',
  level: 'REQUIRED',
  section: '4.8 Use of XML in SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    const addresses = soapAddresses(context);
    for (const view of addresses) {
      const location = optionalAttribute(view.address, 'location');
      if (location === undefined || !isAbsoluteUri(location)) {
        findings.push(
          findingAt(
            view.location,
            view.address,
            `soapbind:address location="${location ?? ''}" is not an absolute URI`,
          ),
        );
      }
    }
    return addresses.length === 0 ? NOT_APPLICABLE : findings;
  },
};
