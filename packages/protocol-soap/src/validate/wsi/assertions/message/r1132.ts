import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { viewFinding } from './helpers.js';

/**
 * BP 1.1 R1132: an HTTP request message uses the `POST` method. The envelope is the entity body,
 * and only `POST` carries one an origin server is required to read.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1132: WsiMessageAssertion = {
  id: 'R1132',
  title: 'The HTTP request uses the POST method',
  level: 'REQUIRED',
  section: '3.4 Use of SOAP in HTTP',
  unverifiedId: true,
  check(context) {
    const method = context.exchange.http.request.method.toUpperCase();
    const findings: WsiFinding[] = [];
    if (method !== 'POST') {
      findings.push(
        viewFinding(context.request, `the request was sent with HTTP ${method}; the profile requires POST`),
      );
    }
    return findings;
  },
};
