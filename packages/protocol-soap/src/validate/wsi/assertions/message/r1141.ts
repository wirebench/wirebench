import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { charsetOf, headerValue, mediaTypeOf, viewFinding } from './helpers.js';

/**
 * BP 1.1 R1141: a message states a `charset` parameter on its `Content-Type`. Without it a
 * `text/xml` entity defaults to US-ASCII under the HTTP rules while the XML declaration says
 * UTF-8, and the two readings disagree the moment a non-ASCII character appears.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1141: WsiMessageAssertion = {
  id: 'R1141',
  title: 'Content-Type states a charset parameter',
  level: 'REQUIRED',
  section: '3.4 Use of SOAP in HTTP',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let judged = 0;
    for (const view of context.messages) {
      const contentType = headerValue(view, 'content-type');
      if (contentType === undefined || mediaTypeOf(contentType).startsWith('multipart/')) {
        continue;
      }
      judged += 1;
      if (charsetOf(contentType) === undefined) {
        findings.push(
          viewFinding(view, `the ${view.direction} Content-Type "${contentType}" states no charset parameter`),
        );
      }
    }
    return judged === 0 ? NOT_APPLICABLE : findings;
  },
};
