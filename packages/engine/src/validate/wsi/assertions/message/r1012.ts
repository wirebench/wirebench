import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { bodyCount, envelopeChildren, envelopes, headerCount, messageFinding, viewFinding } from './helpers.js';

/**
 * BP 1.1 R1012: an envelope carries exactly one `soap:Body`, at most one `soap:Header`, and the
 * header — when there is one — comes first. Anything else is not the structure SOAP 1.1 section 4
 * defines, so a receiver's dispatch is undefined.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1012: WsiMessageAssertion = {
  id: 'R1012',
  title: 'An envelope carries one soap:Body, at most one soap:Header, header first',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    const views = envelopes(context);
    for (const view of views) {
      const bodies = bodyCount(view);
      const headers = headerCount(view);
      if (bodies !== 1) {
        findings.push(
          viewFinding(
            view,
            `the ${view.direction} envelope carries ${bodies} soap:Body elements; exactly one is required`,
          ),
        );
      }
      if (headers > 1) {
        findings.push(
          viewFinding(
            view,
            `the ${view.direction} envelope carries ${headers} soap:Header elements; at most one is allowed`,
          ),
        );
      }
      const children = envelopeChildren(view);
      const bodyIndex = children.findIndex((child) => child.namespaceURI === view.soapNs && child.localName === 'Body');
      const headerIndex = children.findIndex(
        (child) => child.namespaceURI === view.soapNs && child.localName === 'Header',
      );
      if (headerIndex > -1 && bodyIndex > -1 && headerIndex > bodyIndex) {
        const header = children[headerIndex];
        if (header !== undefined) {
          findings.push(messageFinding(view, header, 'soap:Header follows soap:Body; it must precede it'));
        }
      }
    }
    return views.length === 0 ? NOT_APPLICABLE : findings;
  },
};
