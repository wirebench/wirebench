import type { Node } from '@xmldom/xmldom';
import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { viewFinding } from './helpers.js';

/** Counts the processing instructions anywhere in a parsed document. */
function processingInstructions(root: Node): readonly string[] {
  const found: string[] = [];
  const visit = (node: Node): void => {
    let child: Node | null = node.firstChild;
    while (child !== null) {
      // xmldom exposes the XML declaration as a processing instruction named `xml`; it is a
      // declaration, not an instruction, and the profile does not forbid it.
      if (child.nodeType === 7 && child.nodeName !== 'xml') {
        found.push(child.nodeName);
      }
      visit(child);
      child = child.nextSibling;
    }
  };
  visit(root);
  return found;
}

/**
 * BP 1.1 R1006: a message must not contain processing instructions. Their meaning is defined by
 * the application, not the profile, so a receiver has no interoperable way to act on one. The XML
 * declaration is not a processing instruction and is not reported.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1006: WsiMessageAssertion = {
  id: 'R1006',
  title: 'A message contains no processing instructions',
  level: 'REQUIRED',
  section: '3.1 XML Representation of SOAP Messages',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let documents = 0;
    for (const view of context.messages) {
      if (view.document === undefined) {
        continue;
      }
      documents += 1;
      for (const name of processingInstructions(view.document)) {
        findings.push(viewFinding(view, `the ${view.direction} carries the processing instruction "<?${name} ... ?>"`));
      }
    }
    return documents === 0 ? NOT_APPLICABLE : findings;
  },
};
