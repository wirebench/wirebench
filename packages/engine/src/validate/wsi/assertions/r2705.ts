import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, operationStyle, soapBindings } from './helpers.js';

/**
 * BP 1.1 R2705: a `wsdl:binding` "MUST be either rpc-literal or document-literal" — one binding
 * cannot mix the two styles across its operations.
 *
 * Only the *style* half of that requirement is checked here: whether the binding's operations agree
 * on `document` vs `rpc`. That the `use` is `literal` rather than `encoded` is checked by
 * {@link R2706}, so a binding that consistently uses one style but encodes its bodies fails there,
 * not here.
 */
export const R2705: WsiAssertion = {
  id: 'R2705',
  title: 'A binding does not mix the document and rpc styles (literal-ness is R2706)',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const findings: WsiFinding[] = [];
    const bindings = soapBindings(context);
    for (const view of bindings) {
      const operations = childElements(view.binding, NS.WSDL, 'operation');
      const styles = new Set(operations.map((operation) => operationStyle(view, operation)));
      if (styles.size > 1) {
        findings.push(
          findingAt(
            view.location,
            view.binding,
            `wsdl:binding "${optionalAttribute(view.binding, 'name') ?? ''}" mixes the document and rpc styles across its operations`,
          ),
        );
      }
    }
    return bindings.length === 0 ? NOT_APPLICABLE : findings;
  },
};
