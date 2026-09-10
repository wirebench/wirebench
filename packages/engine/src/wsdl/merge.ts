import type { Binding, Message, PortType, Service, WsdlDefinition } from './model.js';
import { qnameEquals } from './qname.js';
import type { QName } from './qname.js';
import { parseWsdlDocument } from './parse-wsdl.js';
import type { DefinitionBundle } from './resolver.js';

/** Keeps the first occurrence of each expanded QName, dropping later duplicates. */
function dedupeByQName<T extends { readonly name: QName }>(items: readonly T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    if (!result.some((existing) => qnameEquals(existing.name, item.name))) {
      result.push(item);
    }
  }
  return result;
}

/**
 * Merges a resolved {@link DefinitionBundle} into a single {@link WsdlDefinition}.
 *
 * Every `wsdl`-kind document in the bundle is parsed with {@link parseWsdlDocument}
 * and merged: the root's `location`/`targetNamespace`/`documentation`/`imports`
 * are kept, while `messages`/`portTypes`/`bindings`/`services` are concatenated
 * (root first, then imports in discovery order) with duplicate QNames resolved
 * by keeping the first occurrence. `schemaElements` collects the root's own
 * inline schemas, plus the inline schemas of every imported `wsdl`-kind document,
 * plus the root `xs:schema` element of every `xsd`-kind document in the bundle
 * (in that order: root first, then imports in discovery order, then xsd roots).
 *
 * @param bundle the bundle produced by {@link resolveDefinition}
 */
export function parseWsdlBundle(bundle: DefinitionBundle): WsdlDefinition {
  const rootDef = parseWsdlDocument(bundle.root.document, bundle.root.location);

  const importedWsdlDefs = bundle.documents
    .filter((doc) => doc.kind === 'wsdl' && doc.location !== bundle.root.location)
    .map((doc) => parseWsdlDocument(doc.document, doc.location));

  const messages: Message[] = dedupeByQName([...rootDef.messages, ...importedWsdlDefs.flatMap((d) => d.messages)]);
  const portTypes: PortType[] = dedupeByQName([...rootDef.portTypes, ...importedWsdlDefs.flatMap((d) => d.portTypes)]);
  const bindings: Binding[] = dedupeByQName([...rootDef.bindings, ...importedWsdlDefs.flatMap((d) => d.bindings)]);
  const services: Service[] = dedupeByQName([...rootDef.services, ...importedWsdlDefs.flatMap((d) => d.services)]);

  const xsdSchemaElements = bundle.documents
    .filter((doc) => doc.kind === 'xsd')
    .map((doc) => doc.document.documentElement)
    .filter((el): el is NonNullable<typeof el> => el !== null);

  return {
    location: rootDef.location,
    targetNamespace: rootDef.targetNamespace,
    ...(rootDef.documentation !== undefined ? { documentation: rootDef.documentation } : {}),
    messages,
    portTypes,
    bindings,
    services,
    schemaElements: [
      ...rootDef.schemaElements,
      ...importedWsdlDefs.flatMap((d) => d.schemaElements),
      ...xsdSchemaElements,
    ],
    imports: rootDef.imports,
    problems: bundle.problems,
  };
}
