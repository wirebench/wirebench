import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, isAbsoluteUri, soapAddresses } from './helpers.js';

/**
 * A `wsdl:port` describes an endpoint through `soapbind:address`, whose `location` must be an
 * absolute URI — a relative reference has no base once the description is republished elsewhere.
 *
 * The requirement itself is part of BP 1.1 §4.7's SOAP binding extensions, but its requirement
 * *number* could not be confirmed against the published profile: `R2401` is the id this catalogue
 * uses, flagged `unverifiedId` so the generated document says so rather than asserting an id
 * Wirebench is not sure of. (It is definitely not `R2701`, which is the HTTP-transport
 * requirement.)
 */
export const R2401: WsiAssertion = {
  id: 'R2401',
  title: 'soapbind:address declares an absolute endpoint URI',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding Extensions',
  unverifiedId: true,
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
