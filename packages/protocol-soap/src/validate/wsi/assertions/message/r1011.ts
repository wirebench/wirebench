import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { envelopeChildren, envelopes, messageFinding } from './helpers.js';

/**
 * BP 1.1 R1011: nothing follows `soap:Body`. A receiver may stop reading once the body has been
 * dispatched, so an element after it is not reliably seen. R1007 constrains *what* may appear as
 * an envelope child; this one constrains *where*.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1011: WsiMessageAssertion = {
  id: 'R1011',
  title: 'No element child of soap:Envelope follows soap:Body',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let bodies = 0;
    for (const view of envelopes(context)) {
      const children = envelopeChildren(view);
      const bodyIndex = children.findIndex((child) => child.namespaceURI === view.soapNs && child.localName === 'Body');
      if (bodyIndex === -1) {
        continue;
      }
      bodies += 1;
      for (const trailing of children.slice(bodyIndex + 1)) {
        findings.push(messageFinding(view, trailing, `"${trailing.nodeName}" follows soap:Body inside soap:Envelope`));
      }
    }
    return bodies === 0 ? NOT_APPLICABLE : findings;
  },
};
