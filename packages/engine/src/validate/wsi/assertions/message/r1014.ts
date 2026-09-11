import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { bodyChildren, envelopes, messageFinding } from './helpers.js';

/**
 * BP 1.1 R1014: the children of `soap:Body` are namespace-qualified. The body child is what a
 * receiver dispatches on, and an unqualified name cannot be matched against a global element
 * declaration or an rpc operation wrapper.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1014: WsiMessageAssertion = {
  id: 'R1014',
  title: 'The children of soap:Body are namespace-qualified',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let children = 0;
    for (const view of envelopes(context)) {
      for (const child of bodyChildren(view)) {
        children += 1;
        if (child.namespaceURI === null || child.namespaceURI === '') {
          findings.push(
            messageFinding(view, child, `the soap:Body child "${child.nodeName}" is not namespace-qualified`),
          );
        }
      }
    }
    return children === 0 ? NOT_APPLICABLE : findings;
  },
};
