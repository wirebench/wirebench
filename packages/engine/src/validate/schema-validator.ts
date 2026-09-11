/**
 * XSD validation of a SOAP message body against the interface's schema set,
 * using libxml2 compiled to WebAssembly (`xmllint-wasm`).
 *
 * The envelope itself is never validated against the XSD — no schema in a
 * WSDL describes `soapenv:Envelope` — so this module extracts each child of
 * `Body` as its own little document and validates that. The extraction keeps
 * the original source offsets: the fragment is padded with as many blank
 * lines as precede it in the envelope, so every line number libxml2 reports
 * is already a line number in the envelope the user is editing.
 *
 * `xmllint-wasm` runs libxml2 inside its own Node worker thread, so a
 * validation never blocks the caller's event loop (measured: a 500 KB body
 * validates in ~50 ms with a worst-case event-loop gap of ~6 ms). No extra
 * worker of our own is needed; a wall-clock timeout guards against a
 * pathological schema instead.
 */

import { validateXML } from 'xmllint-wasm';
import type { Element, Node } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import { serializeXml } from '../xml/serialize.js';
import { buildRangeTree, localNameOf, tokenizeXml } from '../xml/tolerant-tree.js';
import type { XmlRangeNode } from '../xml/tolerant-tree.js';
import { childElements, firstChildElement } from '../wsdl/dom-utils.js';
import type { BundledDocument, DefinitionBundle } from '../wsdl/resolver.js';
import type { SchemaSet } from '../xsd/schema-set.js';
import { escapeAttribute } from '../xsd/xml-writer.js';
import type { ValidationBinding, ValidationProblem } from './types.js';

/** Default wall-clock budget for one validation, in milliseconds. */
export const DEFAULT_VALIDATION_TIMEOUT_MS = 10_000;

/** What the schema validator validates against: the compiled set plus the raw documents behind it. */
export interface SchemaValidationTarget {
  readonly schemaSet: SchemaSet;
  readonly bundle: DefinitionBundle;
}

/** Options for {@link validateAgainstSchemaSet}. */
export interface SchemaValidationOptions {
  /** The operation being validated; required for `rpc` style, where no global element declares the body. */
  readonly binding?: ValidationBinding;
  /** Wall-clock budget for the whole validation; defaults to {@link DEFAULT_VALIDATION_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** One in-memory file handed to libxml2. */
interface SchemaFile {
  readonly fileName: string;
  readonly contents: string;
}

/** The libxml2-ready form of one bundle: every schema as a file, plus one glue file per namespace. */
interface SchemaFileSet {
  /** Every synthetic schema document, plus the per-namespace glue files. */
  readonly files: readonly SchemaFile[];
  /** Target namespace -> the glue file that pulls in every document contributing to it. */
  readonly glue: ReadonlyMap<string, string>;
  /** Synthetic files with no target namespace of their own (and not a chameleon include). */
  readonly noNamespace: readonly string[];
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
  const head = text.slice(0, text.indexOf('>'));
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
function buildSchemaFileSet(bundle: DefinitionBundle): SchemaFileSet {
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
  for (const source of sources) {
    files.push({ fileName: source.fileName, contents: synthesizeSchema(source.schema, source.base, fileNameFor) });
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

  const fileSet: SchemaFileSet = { files, glue, noNamespace };
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
function documentWrapper(fileSet: SchemaFileSet): string {
  return `<xs:schema xmlns:xs="${NS.XSD}">\n${wrapperReferences(fileSet, undefined)}\n</xs:schema>`;
}

/**
 * The wrapper schema for `rpc` style: the body child is the operation wrapper
 * element, which no schema declares, so one is synthesized here with a child
 * per `wsdl:part`. `xs:all` rather than `xs:sequence`, because `parameterOrder`
 * (and SoapUI-style generation) may order the parts differently from the
 * `wsdl:message`, and part order is not something this validator should police.
 */
function rpcWrapper(
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

/** The `xmlns`/`xmlns:*` declarations a range node carries, parsed out of its raw attribute text. */
function declarationsOf(node: XmlRangeNode): Map<string, string> {
  const declarations = new Map<string, string>();
  const pattern = /(xmlns(?::[\w.-]+)?)\s*=\s*"([^"]*)"|(xmlns(?::[\w.-]+)?)\s*=\s*'([^']*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(node.rawAttrs)) !== null) {
    const name = match[1] ?? match[3];
    const value = match[2] ?? match[4];
    if (name !== undefined && value !== undefined) {
      declarations.set(name, value);
    }
  }
  return declarations;
}

/** One body child, extracted as a standalone document that keeps the envelope's line numbers. */
interface BodyFragment {
  readonly name: string;
  readonly namespaceUri: string;
  readonly contents: string;
  readonly line: number;
}

/**
 * Extracts every child element of `Body` as its own document. Returns an empty
 * list when the envelope cannot be tokenized (a half-typed document): the
 * structure checks already report that, and guessing here would only produce
 * bogus markers.
 */
function bodyFragments(xml: string): BodyFragment[] {
  const tokens = tokenizeXml(xml);
  const roots = tokens === undefined ? undefined : buildRangeTree(tokens);
  const envelope = roots?.find((node) => localNameOf(node.name) === 'Envelope');
  const body = envelope?.children.find((node) => localNameOf(node.name) === 'Body');
  if (envelope === undefined || body === undefined) {
    return [];
  }

  // Namespace declarations the fragment inherits: envelope first, then Body,
  // so a redeclaration on the inner element wins.
  const inherited = new Map<string, string>([...declarationsOf(envelope), ...declarationsOf(body)]);

  return body.children.map((child) => {
    const own = declarationsOf(child);
    const extra = [...inherited]
      .filter(([name]) => !own.has(name))
      .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
      .join('');
    const raw = xml.slice(child.start, child.end);
    const insertAt = 1 + child.name.length;
    const fragment = `${raw.slice(0, insertAt)}${extra}${raw.slice(insertAt)}`;
    const line = xml.slice(0, child.start).split('\n').length;
    const prefix = child.name.includes(':') ? child.name.slice(0, child.name.indexOf(':')) : '';
    const namespaceUri =
      (prefix === '' ? inherited.get('xmlns') : inherited.get(`xmlns:${prefix}`)) ??
      own.get(prefix === '' ? 'xmlns' : `xmlns:${prefix}`) ??
      '';
    const declared = own.get(prefix === '' ? 'xmlns' : `xmlns:${prefix}`);
    return {
      name: child.name,
      namespaceUri: declared ?? namespaceUri,
      // Blank-line padding keeps libxml2's line numbers aligned with the envelope.
      contents: `${'\n'.repeat(line - 1)}${fragment}`,
      line,
    };
  });
}

/** Strips libxml2's "Schemas validity error : " prefix from a message. */
function cleanMessage(message: string): string {
  return message.replace(/^Schemas\s+\w+\s+(?:error|warning)\s*:\s*/i, '').trim();
}

/** Runs `promise`, resolving to `fallback` when it takes longer than `ms`. */
async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          resolve(fallback);
        }, ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Validates one body fragment against `wrapper`, mapping libxml2's output to problems. */
async function validateFragment(
  fragment: BodyFragment,
  wrapper: string,
  fileSet: SchemaFileSet,
  timeoutMs: number,
): Promise<ValidationProblem[]> {
  const path = `/Envelope/Body/${fragment.name}`;
  const timedOut: ValidationProblem[] = [
    {
      severity: 'warning',
      code: 'schema-timeout',
      message: `Schema validation of <${fragment.name}> timed out after ${String(timeoutMs)} ms`,
      source: 'schema',
      line: fragment.line,
      path,
    },
  ];

  let result;
  try {
    result = await withTimeout(
      validateXML({
        xml: [{ fileName: 'body.xml', contents: fragment.contents }],
        schema: [{ fileName: 'wrapper.xsd', contents: wrapper }],
        preload: fileSet.files.map((file) => ({ fileName: file.fileName, contents: file.contents })),
      }),
      timeoutMs,
      undefined,
    );
  } catch (cause) {
    // A schema set that does not compile is a problem with the definition, not
    // with the message: report it once, as a warning, with no position.
    return [
      {
        severity: 'warning',
        code: 'schema-unavailable',
        message: `The interface's schemas could not be compiled: ${cause instanceof Error ? cleanMessage(cause.message) : String(cause)}`,
        source: 'schema',
      },
    ];
  }

  if (result === undefined) {
    return timedOut;
  }
  if (result.valid) {
    return [];
  }

  return result.errors.flatMap((error) => {
    const message = cleanMessage(error.message);
    const isBody = error.loc?.fileName === 'body.xml';
    if (!isBody) {
      // libxml2 warns when a namespace reachable through two files is imported
      // twice — an artefact of the glue schemas, not a finding about the message.
      if (/Schemas\s+\w+\s+warning\s*:/i.test(error.rawMessage)) {
        return [];
      }
      return {
        severity: 'warning' as const,
        code: 'schema-unavailable',
        message,
        source: 'schema' as const,
      };
    }
    return {
      severity: 'error' as const,
      code: message.includes('No matching global declaration') ? 'schema-unknown-element' : 'schema-invalid',
      message,
      source: 'schema' as const,
      line: error.loc?.lineNumber ?? fragment.line,
      path,
    };
  });
}

/**
 * Validates the `Body` children of a SOAP envelope against an interface's
 * schema set with libxml2.
 *
 * Never throws: a message that cannot be tokenized, an empty body, or a schema
 * set with no components all yield an empty list (the structure checks own
 * those reports). Positions in the returned problems are lines in `xml`.
 *
 * @param xml the whole envelope text
 * @param target the compiled schema set plus the bundle the raw schema documents come from
 * @param options the binding context (required for `rpc` style) and the timeout
 * @returns every schema finding, in body order
 */
export async function validateAgainstSchemaSet(
  xml: string,
  target: SchemaValidationTarget,
  options?: SchemaValidationOptions,
): Promise<readonly ValidationProblem[]> {
  if (target.schemaSet.elements.size === 0 && target.schemaSet.types.size === 0) {
    return [];
  }
  const fragments = bodyFragments(xml);
  if (fragments.length === 0) {
    return [];
  }

  const fileSet = buildSchemaFileSet(target.bundle);
  const timeoutMs = options?.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS;
  const binding = options?.binding;
  const problems: ValidationProblem[] = [];

  for (const fragment of fragments) {
    const wrapper =
      binding?.style === 'rpc'
        ? rpcWrapper(fileSet, fragment.namespaceUri, localNameOf(fragment.name), binding)
        : documentWrapper(fileSet);
    problems.push(...(await validateFragment(fragment, wrapper, fileSet, timeoutMs)));
  }
  return problems;
}
