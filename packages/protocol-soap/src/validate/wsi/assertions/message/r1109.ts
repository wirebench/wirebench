import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { headerValue, viewFinding } from './helpers.js';

/**
 * BP 1.1 R1109: the value of the `SOAPAction` HTTP header field is a quoted string. An empty
 * action is the two characters `""`, not an empty header value — an unquoted action is a
 * different string to a receiver that unquotes before comparing.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1109: WsiMessageAssertion = {
  id: 'R1109',
  title: 'The SOAPAction request header is a quoted string',
  level: 'REQUIRED',
  section: '3.4 Use of SOAP in HTTP',
  unverifiedId: true,
  check(context) {
    // SOAP 1.2 carries the action as a Content-Type parameter, not a header field.
    if (context.binding.soapVersion !== '1.1') {
      return NOT_APPLICABLE;
    }
    const value = headerValue(context.request, 'soapaction');
    if (value === undefined) {
      return NOT_APPLICABLE;
    }
    const findings: WsiFinding[] = [];
    if (!/^".*"$/s.test(value)) {
      findings.push(
        viewFinding(
          context.request,
          `SOAPAction: ${value} is not a quoted string (an empty action is the two characters "")`,
        ),
      );
    }
    return findings;
  },
};
