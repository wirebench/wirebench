import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { elementChildren, envelopes, faultOf, messageFinding } from './helpers.js';

/**
 * BP 1.1 R1101: the children of a SOAP 1.1 `soap:Fault` are unqualified. SOAP 1.1 declares
 * `faultcode`, `faultstring`, `faultactor` and `detail` with no target namespace, so putting them
 * in the envelope namespace (a common mistake) produces names a receiver does not recognise.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1101: WsiMessageAssertion = {
  id: 'R1101',
  title: 'The children of a SOAP 1.1 soap:Fault are unqualified',
  level: 'REQUIRED',
  section: '3.5 SOAP Faults',
  unverifiedId: true,
  check(context) {
    if (context.binding.soapVersion !== '1.1') {
      return NOT_APPLICABLE;
    }
    const findings: WsiFinding[] = [];
    let children = 0;
    for (const view of envelopes(context)) {
      const fault = faultOf(view);
      if (fault === undefined) {
        continue;
      }
      for (const child of elementChildren(fault)) {
        children += 1;
        if (child.namespaceURI !== null && child.namespaceURI !== '') {
          findings.push(
            messageFinding(
              view,
              child,
              `the soap:Fault child "${child.nodeName}" is qualified ("${child.namespaceURI}"); it must be unqualified`,
            ),
          );
        }
      }
    }
    return children === 0 ? NOT_APPLICABLE : findings;
  },
};
