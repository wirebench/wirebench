import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { viewFinding } from './helpers.js';

/** The encodings the profile allows a message to be serialized in. */
const ALLOWED = ['utf-8', 'utf-16'];

/**
 * BP 1.1 R1003: a message is serialized as UTF-8 or UTF-16. Only a message that states its
 * encoding in an XML declaration can be judged here; one that states none is, by the XML rules,
 * already UTF-8 or UTF-16 and so conforms.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1003: WsiMessageAssertion = {
  id: 'R1003',
  title: 'A message that declares an encoding declares UTF-8 or UTF-16',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let declarations = 0;
    for (const view of context.messages) {
      const declared = /^\s*<\?xml[^?]*encoding\s*=\s*["']([^"']+)["']/i.exec(view.envelopeXml ?? '')?.[1];
      if (declared === undefined) {
        continue;
      }
      declarations += 1;
      if (!ALLOWED.includes(declared.toLowerCase())) {
        findings.push(
          viewFinding(
            view,
            `the ${view.direction} declares encoding "${declared}"; the profile allows UTF-8 and UTF-16`,
          ),
        );
      }
    }
    return declarations === 0 ? NOT_APPLICABLE : findings;
  },
};
