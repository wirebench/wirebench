import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { envelopes, faultOf, inScopePrefixes, messageFinding, unqualifiedChild } from './helpers.js';

/**
 * BP 1.1 R1102: a `faultcode` carries a QName whose prefix is declared in scope. An undeclared
 * prefix makes the code unresolvable, and a receiver cannot tell a `Client` fault (do not retry)
 * from a `Server` one (retry may help).
 *
 * The id is a paraphrase of the requirement Wirebench implements; it could not be confirmed
 * against the published profile, so the catalogue marks it unverified.
 */
export const R1102: WsiMessageAssertion = {
  id: 'R1102',
  title: 'A faultcode is a QName whose prefix is declared in scope',
  level: 'REQUIRED',
  section: '3.5 SOAP Faults',
  unverifiedId: true,
  check(context) {
    if (context.binding.soapVersion !== '1.1') {
      return NOT_APPLICABLE;
    }
    const findings: WsiFinding[] = [];
    let codes = 0;
    for (const view of envelopes(context)) {
      const fault = faultOf(view);
      const code = fault === undefined ? undefined : unqualifiedChild(fault, 'faultcode');
      if (code === undefined) {
        continue;
      }
      codes += 1;
      const value = (code.textContent ?? '').trim();
      const colon = value.indexOf(':');
      if (value.length === 0) {
        findings.push(messageFinding(view, code, 'faultcode is empty'));
      } else if (colon > -1 && !inScopePrefixes(code).has(value.slice(0, colon))) {
        findings.push(
          messageFinding(
            view,
            code,
            `faultcode "${value}" uses the prefix "${value.slice(0, colon)}", which is not declared in scope`,
          ),
        );
      }
    }
    return codes === 0 ? NOT_APPLICABLE : findings;
  },
};
