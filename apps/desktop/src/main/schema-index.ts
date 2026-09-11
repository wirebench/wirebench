/**
 * Pure projections of an imported definition's `SchemaSet` onto the wire shapes the Interface
 * editor's Schema browser and its go-to-definition need. Lives in main because the `SchemaSet`
 * does — the renderer has neither the engine's parse tree nor the document texts.
 */

import { completionContextAt, declarationOf, elementPathAt } from '@wirebench/engine';
import type { QName, SchemaSet } from '@wirebench/engine';
import type {
  DefinitionDeclarationAtResponse,
  SchemaComponentWire,
  SchemaNamespaceWire,
} from '../shared/wire-types.js';

/** Renders a QName as Clark notation (`{namespaceUri}localName`), matching every other channel. */
function toClark(name: QName): string {
  return `{${name.namespaceUri}}${name.localName}`;
}

/** Parses a Clark-notation map key back into its namespace and local name. */
function parseClark(key: string): QName {
  const match = /^\{([^}]*)\}(.*)$/.exec(key);
  if (match === null) {
    return { namespaceUri: '', localName: key };
  }
  return { namespaceUri: match[1] ?? '', localName: match[2] ?? '' };
}

function component(
  localName: string,
  source: { readonly location: string; readonly line?: number },
  typeName?: QName,
): SchemaComponentWire {
  return {
    name: localName,
    ...(typeName !== undefined ? { typeName: toClark(typeName) } : {}),
    document: source.location,
    ...(source.line !== undefined ? { line: source.line } : {}),
  };
}

function byName(a: SchemaComponentWire, b: SchemaComponentWire): number {
  return a.name.localeCompare(b.name);
}

/** One schema type that actually has a name — an anonymous (inline) type is not browsable. */
type NamedType<T> = T & { readonly name: QName };

/** Narrows away the anonymous types, so their `name` needs no cast downstream. */
function isNamedType<T extends { readonly name?: QName | undefined }>(type: T): type is NamedType<T> {
  return type.name !== undefined;
}

/** The named components of `map` whose key sits in `namespaceUri`, sorted by local name. */
function namedIn(
  map: ReadonlyMap<string, { readonly source: { readonly location: string; readonly line?: number } }>,
  namespaceUri: string,
): SchemaComponentWire[] {
  const out: SchemaComponentWire[] = [];
  for (const [key, value] of map) {
    const qname = parseClark(key);
    if (qname.namespaceUri === namespaceUri) {
      out.push(component(qname.localName, value.source));
    }
  }
  return out.sort(byName);
}

/**
 * Every namespace of `schemaSet` with its global elements, types, groups and attribute groups —
 * the left tree of the Schema tab. Namespaces are sorted by URI, components by local name, so
 * the browser is stable across imports.
 */
export function schemaIndexOf(schemaSet: SchemaSet): SchemaNamespaceWire[] {
  return [...schemaSet.namespaces]
    .sort((a, b) => a.localeCompare(b))
    .map((uri) => {
      const types = schemaSet.typesInNamespace(uri);
      const named = types.filter(isNamedType);
      return {
        uri,
        elements: schemaSet
          .elementsInNamespace(uri)
          .map((decl) => component(decl.name.localName, decl.source, decl.type))
          .sort(byName),
        complexTypes: named
          .filter((type) => type.kind === 'complexType')
          .map((type) => component(type.name.localName, type.source))
          .sort(byName),
        simpleTypes: named
          .filter((type) => type.kind === 'simpleType')
          .map((type) => component(type.name.localName, type.source))
          .sort(byName),
        groups: namedIn(schemaSet.groups, uri),
        attributeGroups: namedIn(schemaSet.attributeGroups, uri),
      };
    });
}

/** Resolves a possibly prefixed name against the `xmlns` declarations in scope. */
function resolvePrefixed(name: string, prefixes: Readonly<Record<string, string>>): QName {
  const colon = name.indexOf(':');
  if (colon === -1) {
    return { namespaceUri: prefixes[''] ?? '', localName: name };
  }
  return { namespaceUri: prefixes[name.slice(0, colon)] ?? '', localName: name.slice(colon + 1) };
}

/**
 * The element ancestor path the caret at `offset` points at. When the caret is inside an open
 * tag's name the element itself is appended (it is not yet on the ancestor stack); inside a
 * close tag, or in text content, the innermost open element is already the last segment.
 */
export function pathAtOffset(text: string, offset: number): QName[] {
  const lt = text.lastIndexOf('<', offset);
  const gtBefore = text.lastIndexOf('>', offset);
  const insideTag = lt !== -1 && lt > gtBefore;
  if (!insideTag) {
    return elementPathAt(text, offset);
  }
  const closing = text[lt + 1] === '/';
  if (closing) {
    // The element's own open tag is already on the stack at `lt`.
    return elementPathAt(text, lt);
  }
  const nameMatch = /^([^\s/>]+)/.exec(text.slice(lt + 1));
  if (nameMatch === null) {
    return elementPathAt(text, lt);
  }
  const name = nameMatch[1] as string;
  const context = completionContextAt(text, lt + 1 + name.length);
  if (context === undefined) {
    return elementPathAt(text, lt);
  }
  return [...context.path, resolvePrefixed(name, context.prefixes)];
}

/**
 * Go-to-definition for the request editor: resolves the schema declaration of the element the
 * caret sits on. The path starts inside a SOAP envelope, whose `Envelope`/`Body` wrappers are
 * not schema components here, so leading segments are dropped until a global element resolves.
 */
export function declarationAtOffset(
  schemaSet: SchemaSet,
  text: string,
  offset: number,
): DefinitionDeclarationAtResponse {
  const path = pathAtOffset(text, offset);
  for (let start = 0; start < path.length; start += 1) {
    const found = declarationOf(schemaSet, path.slice(start));
    if (found !== undefined) {
      return {
        namespace: found.element.name.namespaceUri,
        name: found.element.name.localName,
        kind: 'element',
        document: found.source.location,
        ...(found.source.line !== undefined ? { line: found.source.line } : {}),
      };
    }
  }
  return null;
}
