import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { faultOf, viewFinding } from './helpers.js';

/** The status codes a successful SOAP/HTTP response is expected to carry. */
const SUCCESS = [200, 202];

/**
 * BP 1.1 R1124: an envelope that is not a fault is returned with the HTTP status 200 ("OK") or,
 * for a one-way message, 202 ("Accepted"). This is one of section 3.4's HTTP-status rules, which
 * the profile makes `REQUIRED`.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1124: WsiMessageAssertion = {
  id: 'R1124',
  title: 'A non-fault response carries HTTP status 200 or 202',
  level: 'REQUIRED',
  section: '3.4 Use of SOAP in HTTP',
  unverifiedId: true,
  check(context) {
    const response = context.response;
    if (response === undefined || faultOf(response) !== undefined) {
      return NOT_APPLICABLE;
    }
    const findings: WsiFinding[] = [];
    const status = response.status ?? 0;
    if (!SUCCESS.includes(status)) {
      findings.push(
        viewFinding(
          response,
          `the response carries no soap:Fault but the HTTP status is ${String(status)}, not 200 or 202`,
        ),
      );
    }
    return findings;
  },
};
