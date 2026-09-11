import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { envelopeChildren, envelopes, messageFinding } from './helpers.js';

/**
 * BP 1.1 R1007: `soap:Envelope` has no element children other than `soap:Header` and
 * `soap:Body`. A trailing signature or a stray application element there is invisible to a
 * conforming receiver, which only ever looks in the two.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1007: WsiMessageAssertion = {
  id: 'R1007',
  title: 'soap:Envelope has no element children other than soap:Header and soap:Body',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    const views = envelopes(context);
    for (const view of views) {
      for (const child of envelopeChildren(view)) {
        const known =
          child.namespaceURI === view.soapNs && (child.localName === 'Header' || child.localName === 'Body');
        if (!known) {
          findings.push(
            messageFinding(view, child, `soap:Envelope has the unexpected element child "${child.nodeName}"`),
          );
        }
      }
    }
    return views.length === 0 ? NOT_APPLICABLE : findings;
  },
};
