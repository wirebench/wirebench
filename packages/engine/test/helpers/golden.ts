import type { WsdlDefinition } from '../../src/wsdl/model.js';

/**
 * Converts a {@link WsdlDefinition} into a plain, JSON-serialisable object
 * suitable for golden-file comparison. DOM nodes in `schemaElements` are
 * summarised (they are not part of this task's contract, only collected for
 * Task 7) rather than serialised directly.
 */
export function toGoldenJson(def: WsdlDefinition): unknown {
  return {
    location: def.location,
    targetNamespace: def.targetNamespace,
    documentation: def.documentation ?? null,
    messages: def.messages,
    portTypes: def.portTypes,
    bindings: def.bindings,
    services: def.services,
    schemaElements: def.schemaElements.map((el) => ({
      targetNamespace: el.getAttribute('targetNamespace') ?? '',
      elementCount: el.getElementsByTagName('*').length,
    })),
    imports: def.imports,
  };
}
