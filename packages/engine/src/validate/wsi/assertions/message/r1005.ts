import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { viewFinding } from './helpers.js';

/**
 * BP 1.1 R1005: a message must not contain a Document Type Declaration. A `DOCTYPE` lets a
 * message pull in external entities, which a receiver cannot be expected to resolve.
 *
 * The check works on the raw text rather than the DOM: a parser is free to drop the declaration
 * once it has applied it, so by the time there is a document the evidence may be gone.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1005: WsiMessageAssertion = {
  id: 'R1005',
  title: 'A message contains no Document Type Declaration',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let messages = 0;
    for (const view of context.messages) {
      if (view.envelopeXml === undefined) {
        continue;
      }
      messages += 1;
      // Anything before the document element is prolog; a DOCTYPE can only legally appear there.
      const rootTag = '<' + (view.document?.documentElement?.nodeName ?? '\u0000');
      const rootIndex = view.envelopeXml.indexOf(rootTag);
      const prolog = rootIndex === -1 ? view.envelopeXml : view.envelopeXml.slice(0, rootIndex);
      if (/<!DOCTYPE\b/i.test(prolog)) {
        findings.push(viewFinding(view, `the ${view.direction} carries a Document Type Declaration`));
      }
    }
    return messages === 0 ? NOT_APPLICABLE : findings;
  },
};
