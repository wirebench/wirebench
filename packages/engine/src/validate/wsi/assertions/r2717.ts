import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, soapExtensions } from './helpers.js';

/**
 * BP 1.1 R2717: an rpc-literal binding "MUST have the namespace attribute specified" on every
 * contained `soapbind:body` — the operation wrapper element needs a namespace to live in.
 *
 * What that namespace may *be* is a separate requirement: {@link R2803} forbids a relative URI
 * there. This assertion only checks that the attribute is present.
 */
export const R2717: WsiAssertion = {
  id: 'R2717',
  title: 'rpc-literal soapbind:body declares a namespace attribute',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    let bodies = 0;
    for (const view of soapExtensions(context)) {
      if (view.style !== 'rpc' || view.kind !== 'body') {
        continue;
      }
      bodies += 1;
      const namespace = optionalAttribute(view.element, 'namespace');
      if (namespace === undefined) {
        findings.push(findingAt(view.location, view.element, 'rpc-literal soapbind:body has no namespace attribute'));
      }
    }
    return bodies === 0 ? NOT_APPLICABLE : findings;
  },
};
