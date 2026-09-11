import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { faultOf, viewFinding } from './helpers.js';

/**
 * BP 1.1 R1103: a response carrying a `soap:Fault` uses the HTTP status `500 Internal Server
 * Error`. A fault returned with `200 OK` is indistinguishable from a successful response to any
 * intermediary that reads only the status line.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1103: WsiMessageAssertion = {
  id: 'R1103',
  title: 'A response carrying a soap:Fault uses HTTP status 500',
  level: 'REQUIRED',
  section: '3.5 SOAP Faults',
  unverifiedId: true,
  check(context) {
    const response = context.response;
    if (response === undefined || faultOf(response) === undefined) {
      return NOT_APPLICABLE;
    }
    const findings: WsiFinding[] = [];
    if (response.status !== 500) {
      findings.push(
        viewFinding(
          response,
          `the response carries a soap:Fault but the HTTP status is ${String(response.status ?? 0)}, not 500`,
        ),
      );
    }
    return findings;
  },
};
