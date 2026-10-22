import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { envelopes, headerBlocks, messageFinding } from './helpers.js';

/**
 * BP 1.1 R1017: every `soap:Header` block is namespace-qualified. A header block is addressed by
 * its qualified name; an unqualified one belongs to no module and cannot be targeted by a
 * `mustUnderstand` contract.
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1017: WsiMessageAssertion = {
  id: 'R1017',
  title: 'Every soap:Header block is namespace-qualified',
  level: 'REQUIRED',
  section: '3.2 SOAP Processing Model',
  unverifiedId: true,
  check(context) {
    const findings: WsiFinding[] = [];
    let blocks = 0;
    for (const view of envelopes(context)) {
      for (const block of headerBlocks(view)) {
        blocks += 1;
        if (block.namespaceURI === null || block.namespaceURI === '') {
          findings.push(
            messageFinding(view, block, `the soap:Header block "${block.nodeName}" is not namespace-qualified`),
          );
        }
      }
    }
    return blocks === 0 ? NOT_APPLICABLE : findings;
  },
};
