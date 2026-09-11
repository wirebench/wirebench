import type { Element, Node } from '@xmldom/xmldom';
import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { envelopes, faultOf, messageFinding } from './helpers.js';

/** The only children SOAP 1.1 defines for `soap:Fault`. */
const FAULT_CHILDREN = ['faultcode', 'faultstring', 'faultactor', 'detail'];

/** The element children of `fault`, in document order. */
function childrenOf(fault: Element): readonly Element[] {
  const out: Element[] = [];
  let child: Node | null = fault.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      out.push(child as Element);
    }
    child = child.nextSibling;
  }
  return out;
}

/**
 * BP 1.1 R1100: a SOAP 1.1 `soap:Fault` has no element children other than `faultcode`,
 * `faultstring`, `faultactor` and `detail`. Application data belongs inside `detail`, where a
 * receiver knows to look for it.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1100: WsiMessageAssertion = {
  id: 'R1100',
  title: 'soap:Fault has only the four children SOAP 1.1 defines',
  level: 'REQUIRED',
  section: '3.5 SOAP Faults',
  unverifiedId: true,
  check(context) {
    if (context.binding.soapVersion !== '1.1') {
      return NOT_APPLICABLE;
    }
    const findings: WsiFinding[] = [];
    let faults = 0;
    for (const view of envelopes(context)) {
      const fault = faultOf(view);
      if (fault === undefined) {
        continue;
      }
      faults += 1;
      for (const child of childrenOf(fault)) {
        if (!FAULT_CHILDREN.includes(child.localName ?? child.nodeName)) {
          findings.push(messageFinding(view, child, `soap:Fault has the unexpected child "${child.nodeName}"`));
        }
      }
    }
    return faults === 0 ? NOT_APPLICABLE : findings;
  },
};
