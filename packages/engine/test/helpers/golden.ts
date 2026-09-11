import type { WsdlDefinition } from '../../src/wsdl/model.js';

/**
 * Converts a {@link WsdlDefinition} into a plain, JSON-serialisable object
 * suitable for golden-file comparison. DOM nodes in `schemaElements` are
 * summarised (they are not part of this task's contract, only collected for
 * Task 7) rather than serialised directly, and the `sourceElement` back-references the
 * parser keeps for WS-Addressing extension lookups are dropped entirely.
 */
function withoutSourceElements<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, entry: unknown) => (key === 'sourceElement' ? undefined : entry))) as T;
}

/** @see withoutSourceElements */
export function toGoldenJson(def: WsdlDefinition): unknown {
  return {
    location: def.location,
    targetNamespace: def.targetNamespace,
    documentation: def.documentation ?? null,
    messages: def.messages,
    portTypes: withoutSourceElements(def.portTypes),
    bindings: withoutSourceElements(def.bindings),
    services: withoutSourceElements(def.services),
    schemaElements: def.schemaElements.map((el) => ({
      targetNamespace: el.getAttribute('targetNamespace') ?? '',
      elementCount: el.getElementsByTagName('*').length,
    })),
    imports: def.imports,
  };
}
