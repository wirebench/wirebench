import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, operationStyle, soapBindings } from './helpers.js';

/**
 * BP 1.1 R2705: a `wsdl:binding` "MUST be either rpc-literal or document-literal" — one binding
 * cannot mix the two styles across its operations.
 */
export const R2705: WsiAssertion = {
  id: 'R2705',
  title: 'A binding is entirely rpc-literal or entirely document-literal',
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
