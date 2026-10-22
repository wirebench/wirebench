import { optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, isAbsoluteUri, soapExtensions } from './helpers.js';

/**
 * BP 1.1 R2803: in a description, "the namespace attribute on the soapbind:body, soapbind:header,
 * soapbind:headerfault and soapbind:fault elements MUST NOT be a relative URI" — a relative value
 * has no stable base once the description moves.
 */
export const R2803: WsiAssertion = {
  id: 'R2803',
  title: 'soapbind namespace attributes are absolute URIs',
  level: 'REQUIRED',
  section: '4.9 Namespaces',
  check(context) {
    const findings: WsiFinding[] = [];
    let namespaces = 0;
    for (const view of soapExtensions(context)) {
      const namespace = optionalAttribute(view.element, 'namespace');
      if (namespace === undefined) {
        continue;
      }
      namespaces += 1;
      if (!isAbsoluteUri(namespace)) {
        findings.push(
          findingAt(view.location, view.element, `soapbind:${view.kind} namespace="${namespace}" is a relative URI`),
        );
      }
    }
    return namespaces === 0 ? NOT_APPLICABLE : findings;
  },
};
