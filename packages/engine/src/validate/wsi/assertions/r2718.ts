import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { findingAt, portTypeOf, soapBindings, wsdlDocuments } from './helpers.js';

/**
 * BP 1.1 R2718: a `wsdl:binding` "MUST have the same set of wsdl:operations as the wsdl:portType
 * to which it refers" — a binding may neither bind an operation the interface does not declare nor
 * leave one of its operations unbound.
 */
export const R2718: WsiAssertion = {
  id: 'R2718',
  title: 'A binding binds exactly the operations of its portType',
  level: 'REQUIRED',
  section: '4.7 SOAP Binding',
  check(context) {
    const definitionsByLocation = new Map(
      wsdlDocuments(context).map((doc) => [doc.location, doc.definitions] as const),
    );
    const findings: WsiFinding[] = [];
    let compared = 0;
    for (const view of soapBindings(context)) {
      const definitions = definitionsByLocation.get(view.location);
      const portType = definitions === undefined ? undefined : portTypeOf(context, view, definitions);
      if (portType === undefined) {
        continue;
      }
      compared += 1;
      const bound = new Set(
        childElements(view.binding, NS.WSDL, 'operation').map(
          (operation) => optionalAttribute(operation, 'name') ?? '',
        ),
      );
      const declared = new Set(
        childElements(portType.element, NS.WSDL, 'operation').map(
          (operation) => optionalAttribute(operation, 'name') ?? '',
        ),
      );
      for (const name of bound) {
        if (!declared.has(name)) {
          findings.push(
            findingAt(view.location, view.binding, `Binding operation "${name}" is not declared by the portType`),
          );
        }
      }
      for (const name of declared) {
        if (!bound.has(name)) {
          findings.push(findingAt(view.location, view.binding, `portType operation "${name}" is not bound`));
        }
      }
    }
    return compared === 0 ? NOT_APPLICABLE : findings;
  },
};
