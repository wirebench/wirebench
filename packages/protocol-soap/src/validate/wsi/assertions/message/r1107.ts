import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { attributesOf, envelopes, faultOf, messageFinding, unqualifiedChild } from './helpers.js';
import { descendants } from '../helpers.js';

/**
 * BP 1.1 R1107: a fault's `detail` element carries no `soap:encodingStyle`. The detail of a
 * literal fault is an instance of the schema the description declares, so naming an encoding for
 * it would change how a receiver reads it.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1107: WsiMessageAssertion = {
  id: 'R1107',
  title: 'A fault detail carries no soap:encodingStyle',
  level: 'REQUIRED',
  section: '3.5 SOAP Faults',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let details = 0;
    for (const view of envelopes(context)) {
      const fault = faultOf(view);
      const detail = fault === undefined ? undefined : unqualifiedChild(fault, 'detail');
      if (detail === undefined) {
        continue;
      }
      details += 1;
      for (const element of [detail, ...descendants(detail)]) {
        for (const attribute of attributesOf(element)) {
          if (attribute.namespaceUri === view.soapNs && attribute.localName === 'encodingStyle') {
            findings.push(
              messageFinding(
                view,
                element,
                `"${element.nodeName}" inside soap:Fault/detail carries soap:encodingStyle="${attribute.value}"`,
              ),
            );
          }
        }
      }
    }
    return details === 0 ? NOT_APPLICABLE : findings;
  },
};
