/**
 * Builds the in-memory libxml2 file set one bundle's schema documents compile into: every XSD
 * (and every WSDL-embedded `<types>` schema) as its own synthetic file, one glue file per target
 * namespace (so a namespace split across several documents can still be `xs:import`ed with a
 * single reference), and the wrapper schema helpers that pull every namespace into one document
 * a Body child can be validated against.
 *
 * Split out of `schema-validator.ts` (Task 42 fix round 1, minor 9): that module now only
 * orchestrates validating a fragment against the set this one builds.
 */

import type { Element, Node } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import { serializeXml } from '../xml/serialize.js';
import { childElements, firstChildElement } from '../wsdl/dom-utils.js';
import type { BundledDocument, DefinitionBundle } from '../wsdl/resolver.js';
import { escapeAttribute } from '../xsd/xml-writer.js';
import type { ValidationBinding } from './types.js';

/** One in-memory file handed to libxml2. */
export interface SchemaFile {
  readonly fileName: string;
  readonly contents: string;
}

/** The libxml2-ready form of one bundle: every schema as a file, plus one glue file per namespace. */
export interface SchemaFileSet {
  /** Every synthetic schema document, plus the per-namespace glue files. */
  readonly files: readonly SchemaFile[];
  /** Target namespace -> the glue file that pulls in every document contributing to it. */
  readonly glue: ReadonlyMap<string, string>;
  /** Synthetic files with no target namespace of their own (and not a chameleon include). */
  readonly noNamespace: readonly string[];
  /**
   * Synthetic file name -> a human-readable label for where it came from: the original
   * document's location for a `doc-N.xsd`/`embedded-N.xsd`, or `undefined` for a file this
   * module invented itself (a glue file or a wrapper), which {@link fileSetLabels} reports as
   * "the schema set".
   */
  readonly documentOf: ReadonlyMap<string, string>;
}

/**
 * Per-bundle cache of the built file set. Keyed by bundle identity, so a
 * re-import (a new bundle object) rebuilds and the old entry is collected.
 */
const fileSetCache = new WeakMap<DefinitionBundle, SchemaFileSet>();

/** The `xmlns`/`xmlns:*` declarations in scope at `element` from its ancestors, nearest first. */
function inheritedNamespaceDeclarations(element: Element): Map<string, string> {
  const declarations = new Map<string, string>();
  let current: Node | null = element.parentNode;
  while (current !== null) {
    if (current.nodeType === 1) {
      const ancestor = current as Element;
      for (let index = 0; index < ancestor.attributes.length; index += 1) {
        const attribute = ancestor.attributes.item(index);
        if (attribute === null) {
          continue;
        }
        if ((attribute.name === 'xmlns' || attribute.name.startsWith('xmlns:')) && !declarations.has(attribute.name)) {
          declarations.set(attribute.name, attribute.value);
        }
      }
    }
    current = current.parentNode;
  }
  return declarations;
}

/** The `xs:import`/`xs:include`/`xs:redefine` elements of a schema, at any depth (they are top-level in practice). */
function referenceElements(schema: Element): Element[] {
  return ['import', 'include', 'redefine'].flatMap((name) => childElements(schema, NS.XSD, name));
}

/** The index of the `>` that closes the (opening) tag starting at `text[0]`, skipping any `>`
 * that appears inside a quoted attribute value (a raw `>` needs no escaping there, so it is
 * legal — `indexOf('>')` would stop at the first one and truncate the tag). Returns `-1` when
 * the tag never closes (should not happen for a serializer's own output). */
function endOfStartTag(text: string): number {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '>') {
      return index;
    }
  }
  return -1;
}

/**
 * Clones `schema`, hoists the namespace declarations it inherited from its
 * WSDL ancestors (prefixes used in `type="s:int"` attribute values would
 * otherwise dangle), and rewrites every `schemaLocation` to the synthetic
 * file name the referenced document was given.
 */
function synthesizeSchema(schema: Element, base: string, fileNameFor: ReadonlyMap<string, string>): string {
  const clone = schema.cloneNode(true) as Element;
  for (const reference of referenceElements(clone)) {
    const location = reference.getAttribute('schemaLocation');
    if (location === null || location === '') {
      continue;
    }
    let resolved: string;
    try {
      resolved = new URL(location, base).toString();
    } catch {
      resolved = location;
    }
    const fileName = fileNameFor.get(resolved);
    if (fileName === undefined) {
      // The bundle never resolved this reference; dropping the location leaves
      // a namespace-only import, which libxml2 treats as "assume it is declared
      // elsewhere" instead of failing to compile the whole set.
      reference.removeAttribute('schemaLocation');
      continue;
    }
    reference.setAttribute('schemaLocation', fileName);
  }

  // The namespace declarations are injected into the serialized text rather than
  // set as attributes: xmldom's serializer emits a declaration for the element's
  // own prefix by itself, and setting the same one as an attribute would produce
  // a duplicate (which libxml2 rejects as not well formed).
  const text = serializeXml(clone);
  const insertAt = text.search(/[\s/>]/);
  const tagEnd = endOfStartTag(text);
  const head = text.slice(0, tagEnd === -1 ? text.length : tagEnd);
  const extra = [...inheritedNamespaceDeclarations(schema)]
    .filter(([name]) => !new RegExp(`[\\s<]${name.replace(':', '\\:')}\\s*=`).test(head))
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
  return `${text.slice(0, insertAt)}${extra}${text.slice(insertAt)}`;
}

/** Every `xs:schema` a bundled document contributes, with the document it came from. */
function schemaElementsOf(document: BundledDocument): Element[] {
  const root = document.document.documentElement;
  if (root === null) {
    return [];
  }
  if (document.kind === 'xsd') {
    return root.namespaceURI === NS.XSD && root.localName === 'schema' ? [root] : [];
  }
  const types = firstChildElement(root, NS.WSDL, 'types');
  return types === undefined ? [] : childElements(types, NS.XSD, 'schema');
}

/** Builds (or returns the cached) libxml2 file set for `bundle`. */
export function buildSchemaFileSet(bundle: DefinitionBundle): SchemaFileSet {
  const cached = fileSetCache.get(bundle);
  if (cached !== undefined) {
    return cached;
  }

  // Pass 1: name every document, so pass 2 can rewrite references to those names.
  const fileNameFor = new Map<string, string>();
  const sources: { schema: Element; base: string; fileName: string; chameleon: boolean }[] = [];
  let index = 0;
  for (const document of bundle.documents) {
    const schemas = schemaElementsOf(document);
    schemas.forEach((schema, ordinal) => {
      index += 1;
      const fileName = document.kind === 'wsdl' ? `embedded-${String(index)}.xsd` : `doc-${String(index)}.xsd`;
      if (ordinal === 0) {
        fileNameFor.set(document.location, fileName);
        fileNameFor.set(document.requestedLocation, fileName);
      }
      sources.push({
        schema,
        base: document.location,
        fileName,
        chameleon: document.chameleonFor !== undefined,
      });
    });
  }

  // Pass 2: synthesize each schema, and group them by their own target namespace.
  const files: SchemaFile[] = [];
  const byNamespace = new Map<string, string[]>();
  const noNamespace: string[] = [];
  const documentOf = new Map<string, string>();
  for (const source of sources) {
    files.push({ fileName: source.fileName, contents: synthesizeSchema(source.schema, source.base, fileNameFor) });
    documentOf.set(source.fileName, source.base);
    const targetNamespace = source.schema.getAttribute('targetNamespace');
    if (targetNamespace === null || targetNamespace === '') {
      // A chameleon include has no namespace of its own and is already pulled in
      // by the schema that includes it; adding it again at the top level would
      // redeclare its components.
      if (!source.chameleon) {
        noNamespace.push(source.fileName);
      }
      continue;
    }
    const bucket = byNamespace.get(targetNamespace);
    if (bucket === undefined) {
      byNamespace.set(targetNamespace, [source.fileName]);
    } else {
      bucket.push(source.fileName);
    }
  }

  // Pass 3: one glue schema per namespace, so a namespace split across several
  // documents can still be imported by a wrapper with a single `xs:import`.
  const glue = new Map<string, string>();
  let glueIndex = 0;
  for (const [namespace, members] of byNamespace) {
    glueIndex += 1;
    const fileName = `ns-${String(glueIndex)}.xsd`;
    const includes = members.map((member) => `  <xs:include schemaLocation="${escapeAttribute(member)}"/>`).join('\n');
    files.push({
      fileName,
      contents: `<xs:schema xmlns:xs="${NS.XSD}" targetNamespace="${escapeAttribute(namespace)}">\n${includes}\n</xs:schema>`,
    });
    glue.set(namespace, fileName);
  }

  const fileSet: SchemaFileSet = { files, glue, noNamespace, documentOf };
  fileSetCache.set(bundle, fileSet);
  return fileSet;
}

/** The `xs:import`/`xs:include` lines a wrapper needs to see every namespace but `own`. */
function wrapperReferences(fileSet: SchemaFileSet, own: string | undefined): string {
  const lines: string[] = [];
  for (const [namespace, fileName] of fileSet.glue) {
    lines.push(
      namespace === own
        ? `  <xs:include schemaLocation="${escapeAttribute(fileName)}"/>`
        : `  <xs:import namespace="${escapeAttribute(namespace)}" schemaLocation="${escapeAttribute(fileName)}"/>`,
    );
  }
  for (const fileName of fileSet.noNamespace) {
    lines.push(`  <xs:include schemaLocation="${escapeAttribute(fileName)}"/>`);
  }
  return lines.join('\n');
}

/** The wrapper schema for `document` style: no declarations of its own, just every namespace. */
export function documentWrapper(fileSet: SchemaFileSet): string {
  return `<xs:schema xmlns:xs="${NS.XSD}">\n${wrapperReferences(fileSet, undefined)}\n</xs:schema>`;
}

/**
 * The wrapper schema for `rpc` style: the body child is the operation wrapper
 * element, which no schema declares, so one is synthesized here with a child
 * per `wsdl:part`. `xs:all` rather than `xs:sequence`, because `parameterOrder`
 * (and sample generation) may order the parts differently from the
 * `wsdl:message`, and part order is not something this validator should police.
 */
export function rpcWrapper(
  fileSet: SchemaFileSet,
  namespace: string,
  elementName: string,
  binding: ValidationBinding,
): string {
  const prefixes = new Map<string, string>([[NS.XSD, 'xs']]);
  const prefixFor = (uri: string): string | undefined => {
    const existing = prefixes.get(uri);
    if (existing !== undefined) {
      return existing;
    }
    if (!fileSet.glue.has(uri)) {
      return undefined;
    }
    const prefix = `p${String(prefixes.size)}`;
    prefixes.set(uri, prefix);
    return prefix;
  };

  const particles = binding.parts.map((part) => {
    const name = escapeAttribute(part.name);
    if (part.element !== undefined) {
      const prefix = prefixFor(part.element.namespaceUri);
      if (prefix !== undefined) {
        return `    <xs:element ref="${prefix}:${escapeAttribute(part.element.localName)}"/>`;
      }
      return `    <xs:element name="${name}"/>`;
    }
    if (part.type !== undefined) {
      const prefix = prefixFor(part.type.namespaceUri);
      if (prefix !== undefined) {
        return `    <xs:element name="${name}" type="${prefix}:${escapeAttribute(part.type.localName)}"/>`;
      }
    }
    // An unknown part type must not fail the whole compile: accept anything.
    return `    <xs:element name="${name}"/>`;
  });

  const declarations = [...prefixes].map(([uri, prefix]) => `xmlns:${prefix}="${escapeAttribute(uri)}"`).join(' ');
  const content =
    particles.length === 0
      ? '  <xs:complexType/>'
      : `  <xs:complexType>\n   <xs:all>\n${particles.join('\n')}\n   </xs:all>\n  </xs:complexType>`;

  return [
    `<xs:schema ${declarations} targetNamespace="${escapeAttribute(namespace)}" elementFormDefault="unqualified">`,
    wrapperReferences(fileSet, namespace),
    ` <xs:element name="${escapeAttribute(elementName)}">`,
    content,
    ' </xs:element>',
    '</xs:schema>',
  ].join('\n');
}

/**
 * Human-readable label for every synthetic file name a diagnostic might mention: the original
 * document's location for a document file, or "the schema set" for anything this module
 * invented (a glue file, or the caller's own wrapper/body files).
 */
export function fileSetLabels(fileSet: SchemaFileSet): ReadonlyMap<string, string> {
  const labels = new Map<string, string>();
  for (const [fileName, location] of fileSet.documentOf) {
    labels.set(fileName, location);
  }
  for (const fileName of fileSet.glue.values()) {
    if (!labels.has(fileName)) {
      labels.set(fileName, 'the schema set');
    }
  }
  for (const fileName of fileSet.noNamespace) {
    if (!labels.has(fileName)) {
      labels.set(fileName, 'the schema set');
    }
  }
  labels.set('wrapper.xsd', 'the schema set');
  labels.set('body.xml', 'the message');
  return labels;
}
