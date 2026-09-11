import { NS } from '../../../../xml/namespaces.js';
import type { WsiFinding, WsiMessageAssertion } from '../../types.js';
import { NOT_APPLICABLE } from '../../types.js';
import { attributesOf, envelopes, messageFinding, partAccessors } from './helpers.js';

/** The `xsi:nil` values that actually assert nil-ness. */
const NIL = ['1', 'true'];

/**
 * BP 1.1 R2211: an rpc-literal message carries no `xsi:nil="true"` on a part accessor. An rpc
 * part accessor is not a schema element declaration, so it has no `nillable` to make nil legal —
 * an omitted part says "absent" in a way every receiver agrees on.
 */
export const R2211: WsiMessageAssertion = {
  id: 'R2211',
  title: 'An rpc-literal part accessor carries no xsi:nil',
  level: 'REQUIRED',
  section: '4.4 rpc-literal',
  check(context) {
    if (context.binding.style !== 'rpc' || context.binding.use !== 'literal') {
      return NOT_APPLICABLE;
    }
    const findings: WsiFinding[] = [];
    let accessors = 0;
    for (const view of envelopes(context)) {
      // The body child is the operation wrapper; its children are the part accessors.
      for (const wrapper of partAccessors(view)) {
        let child = wrapper.firstChild;
        while (child !== null) {
          if (child.nodeType === 1) {
            const element = child as typeof wrapper;
            accessors += 1;
            for (const attribute of attributesOf(element)) {
              if (attribute.namespaceUri === NS.XSI && attribute.localName === 'nil' && NIL.includes(attribute.value)) {
                findings.push(
                  messageFinding(
                    view,
                    element,
                    `the rpc-literal part accessor "${element.nodeName}" carries xsi:nil="${attribute.value}"`,
                  ),
                );
              }
            }
          }
          child = child.nextSibling;
        }
      }
    }
    return accessors === 0 ? NOT_APPLICABLE : findings;
  },
};
