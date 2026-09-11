import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { SOAP_ENVELOPE_NS, viewFinding } from './helpers.js';

/**
 * BP 1.1 R1001: a message must be a SOAP envelope — well-formed XML whose document element is
 * `soap:Envelope` in the envelope namespace of the version the binding declares. An HTML error
 * page, a bare body, or a SOAP 1.2 envelope answering a SOAP 1.1 binding all breach it.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1001: WsiMessageAssertion = {
  id: 'R1001',
  title: 'Each message is a soap:Envelope of the SOAP version the binding declares',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let envelopes = 0;
    const expected = SOAP_ENVELOPE_NS[context.binding.soapVersion];
    for (const view of context.messages) {
      if (view.envelopeXml === undefined) {
        continue;
      }
      envelopes += 1;
      if (view.document === undefined) {
        findings.push(viewFinding(view, `the ${view.direction} is not well-formed XML, so it is not a SOAP envelope`));
      } else if (view.envelope === undefined) {
        findings.push(
          viewFinding(
            view,
            `the ${view.direction} document element is "${view.document.documentElement?.nodeName ?? '(none)'}", not soap:Envelope`,
          ),
        );
      } else if (view.soapNs !== expected) {
        findings.push(
          viewFinding(
            view,
            `the ${view.direction} envelope is in "${view.soapNs ?? ''}"; the binding declares SOAP ${context.binding.soapVersion} ("${expected}")`,
          ),
        );
      }
    }
    return envelopes === 0 ? NOT_APPLICABLE : findings;
  },
};
