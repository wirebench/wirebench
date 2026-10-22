import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { headerValue, mediaTypeOf, viewFinding } from './helpers.js';

/** The media type each SOAP version's HTTP binding uses. */
const MEDIA_TYPE: Readonly<Record<'1.1' | '1.2', string>> = {
  '1.1': 'text/xml',
  '1.2': 'application/soap+xml',
};

/**
 * BP 1.1 R1140: a message states the media type its SOAP version's HTTP binding defines —
 * `text/xml` for SOAP 1.1. A multipart message (MTOM or SOAP with Attachments) is not judged
 * here: its envelope's media type is the root part's, not the message's.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1140: WsiMessageAssertion = {
  id: 'R1140',
  title: 'Content-Type states the media type the SOAP version defines',
  level: 'REQUIRED',
  section: '3.4 Use of SOAP in HTTP',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    const expected = MEDIA_TYPE[context.binding.soapVersion];
    let judged = 0;
    for (const view of context.messages) {
      const contentType = headerValue(view, 'content-type');
      if (contentType === undefined) {
        continue;
      }
      const mediaType = mediaTypeOf(contentType);
      if (mediaType.startsWith('multipart/')) {
        continue;
      }
      judged += 1;
      if (mediaType !== expected) {
        findings.push(
          viewFinding(
            view,
            `the ${view.direction} Content-Type media type is "${mediaType}"; SOAP ${context.binding.soapVersion} over HTTP uses "${expected}"`,
          ),
        );
      }
    }
    return judged === 0 ? NOT_APPLICABLE : findings;
  },
};
