import { NS } from '../../../xml/namespaces.js';
import { childElements, optionalAttribute } from '../../../wsdl/dom-utils.js';
import type { WsiAssertion, WsiFinding } from '../types.js';
import { NOT_APPLICABLE } from '../types.js';
import { bundledDocumentFor, findingAt, resolveAgainst, schemaElements } from './helpers.js';

/**
 * BP 1.1 R2005: the `targetNamespace` of an imported schema must be identical to the `namespace`
 * attribute of the `xs:import` that referenced it. Imports without a `schemaLocation`, and imports
 * whose target was not fetched, carry nothing to compare and are skipped.
 */
export const R2005: WsiAssertion = {
  id: 'R2005',
  title: 'An imported schema targetNamespace matches the xs:import namespace',
  level: 'REQUIRED',
  section: '4.2 Document Structure',
  check(context) {
    const findings: WsiFinding[] = [];
    let compared = 0;
    for (const view of schemaElements(context)) {
      for (const importEl of childElements(view.schema, NS.XSD, 'import')) {
        const schemaLocation = optionalAttribute(importEl, 'schemaLocation');
        if (schemaLocation === undefined) {
          continue;
        }
        const resolved = resolveAgainst(schemaLocation, view.location);
        const target = resolved === undefined ? undefined : bundledDocumentFor(context, resolved);
        const root = target?.document.documentElement ?? null;
        if (target === undefined || root === null || root.namespaceURI !== NS.XSD) {
          continue;
        }
        compared += 1;
        const declared = optionalAttribute(importEl, 'namespace') ?? '';
        const actual = optionalAttribute(root, 'targetNamespace') ?? '';
        if (declared !== actual) {
          findings.push(
            findingAt(
              view.location,
              importEl,
              `xs:import namespace="${declared}" does not match the imported schema's targetNamespace "${actual}"`,
            ),
          );
        }
      }
    }
    return compared === 0 ? NOT_APPLICABLE : findings;
  },
};
