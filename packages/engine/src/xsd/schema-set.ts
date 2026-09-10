import type { Document, Element } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import { childElements, firstChildElement, optionalAttribute } from '../wsdl/dom-utils.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import type { DefinitionBundle } from '../wsdl/resolver.js';
import type { BuiltinType } from './builtins.js';
import { isBuiltinType, lookupBuiltin } from './builtins.js';
import type {
  AttributeDecl,
  AttributeGroup,
  ComplexType,
  ElementDecl,
  Group,
  ResolvedContent,
  SchemaProblem,
  SourceRef,
  TypeDefinition,
} from './model.js';
import { parseSchemaElement } from './parse-schema.js';
import type { SchemaContext } from './parse-particles.js';
import { resolveContent } from './resolve-content.js';
import { checkReferences } from './check-references.js';

/** A WSDL definition (or anything else) that exposes the inline `xs:schema` elements to index. */
export interface SchemaElementsInput {
  readonly schemaElements: readonly Element[];
}

/** Everything {@link buildSchemaSet} accepts. */
export type SchemaSetInput = DefinitionBundle | SchemaElementsInput;

/** The queryable, resolved set of schema components collected from a WSDL/XSD bundle. */
export interface SchemaSet {
  /** Every distinct `targetNamespace` contributing components, in first-seen order. */
  readonly namespaces: readonly string[];
  /** Global element declarations, keyed by Clark notation. */
  readonly elements: ReadonlyMap<string, ElementDecl>;
  /** Global type definitions (complex and simple), keyed by Clark notation. */
  readonly types: ReadonlyMap<string, TypeDefinition>;
  readonly groups: ReadonlyMap<string, Group>;
  readonly attributeGroups: ReadonlyMap<string, AttributeGroup>;
  /** Global attribute declarations, keyed by Clark notation. */
  readonly attributes: ReadonlyMap<string, AttributeDecl>;
  readonly problems: readonly SchemaProblem[];
  lookupElement(name: QName): ElementDecl | undefined;
  lookupType(name: QName): TypeDefinition | undefined;
  lookupGroup(name: QName): Group | undefined;
  lookupAttributeGroup(name: QName): AttributeGroup | undefined;
  lookupAttribute(name: QName): AttributeDecl | undefined;
  /** Transitive substitution-group members of `head`, excluding the head, including abstract members. */
  substitutionsFor(head: QName): readonly ElementDecl[];
  /** Flattens a complex type's derivation chain, group refs and attribute groups. */
  resolveContent(type: ComplexType): ResolvedContent;
  isBuiltin(name: QName): boolean;
  builtin(name: QName): BuiltinType | undefined;
  elementsInNamespace(namespaceUri: string): readonly ElementDecl[];
  typesInNamespace(namespaceUri: string): readonly TypeDefinition[];
}

/** One `xs:schema` element plus the document context it was found in. */
interface SchemaSource {
  readonly element: Element;
  readonly location: string;
  /** Namespace adopted from an including schema, for chameleon includes. */
  readonly namespaceOverride?: string;
}

function isDefinitionBundle(input: SchemaSetInput): input is DefinitionBundle {
  return 'documents' in input && 'root' in input;
}

function schemaElementsOfWsdl(document: Document): Element[] {
  const root = document.documentElement;
  if (root === null) {
    return [];
  }
  const types = firstChildElement(root, NS.WSDL, 'types');
  return types === undefined ? [] : childElements(types, NS.XSD, 'schema');
}

function collectSources(input: SchemaSetInput): SchemaSource[] {
  if (!isDefinitionBundle(input)) {
    return input.schemaElements.map((element) => ({ element, location: '<inline>' }));
  }
  const sources: SchemaSource[] = [];
  for (const doc of input.documents) {
    if (doc.kind === 'wsdl') {
      for (const element of schemaElementsOfWsdl(doc.document)) {
        sources.push({ element, location: doc.location });
      }
      continue;
    }
    const root = doc.document.documentElement;
    if (root === null || root.namespaceURI !== NS.XSD || root.localName !== 'schema') {
      continue;
    }
    // A chameleon include has no `targetNamespace` of its own: the bundle records
    // the namespace it adopted from the including schema.
    sources.push({
      element: root,
      location: doc.location,
      ...(doc.chameleonFor !== undefined && doc.namespace !== undefined ? { namespaceOverride: doc.namespace } : {}),
    });
  }
  return sources;
}

class SchemaSetImpl implements SchemaSet {
  readonly namespaces: readonly string[];
  readonly elements: ReadonlyMap<string, ElementDecl>;
  readonly types: ReadonlyMap<string, TypeDefinition>;
  readonly groups: ReadonlyMap<string, Group>;
  readonly attributeGroups: ReadonlyMap<string, AttributeGroup>;
  readonly attributes: ReadonlyMap<string, AttributeDecl>;
  readonly problems: readonly SchemaProblem[];
  private readonly substitutionIndex = new Map<string, ElementDecl[]>();

  constructor(
    namespaces: readonly string[],
    elements: Map<string, ElementDecl>,
    types: Map<string, TypeDefinition>,
    groups: Map<string, Group>,
    attributeGroups: Map<string, AttributeGroup>,
    attributes: Map<string, AttributeDecl>,
    problems: SchemaProblem[],
  ) {
    this.namespaces = namespaces;
    this.elements = elements;
    this.types = types;
    this.groups = groups;
    this.attributeGroups = attributeGroups;
    this.attributes = attributes;
    for (const decl of elements.values()) {
      if (decl.substitutionGroup !== undefined) {
        const key = qnameToString(decl.substitutionGroup);
        const bucket = this.substitutionIndex.get(key);
        if (bucket === undefined) {
          this.substitutionIndex.set(key, [decl]);
        } else {
          bucket.push(decl);
        }
      }
    }
    checkReferences(this, problems);
    this.problems = problems;
  }

  lookupElement(name: QName): ElementDecl | undefined {
    return this.elements.get(qnameToString(name));
  }

  lookupType(name: QName): TypeDefinition | undefined {
    return this.types.get(qnameToString(name));
  }

  lookupGroup(name: QName): Group | undefined {
    return this.groups.get(qnameToString(name));
  }

  lookupAttributeGroup(name: QName): AttributeGroup | undefined {
    return this.attributeGroups.get(qnameToString(name));
  }

  lookupAttribute(name: QName): AttributeDecl | undefined {
    return this.attributes.get(qnameToString(name));
  }

  substitutionsFor(head: QName): readonly ElementDecl[] {
    const result: ElementDecl[] = [];
    const seen = new Set<string>([qnameToString(head)]);
    const queue = [qnameToString(head)];
    while (queue.length > 0) {
      const key = queue.shift() as string;
      for (const member of this.substitutionIndex.get(key) ?? []) {
        const memberKey = qnameToString(member.name);
        if (seen.has(memberKey)) {
          continue;
        }
        seen.add(memberKey);
        result.push(member);
        queue.push(memberKey);
      }
    }
    return result;
  }

  resolveContent(type: ComplexType): ResolvedContent {
    return resolveContent(type, this);
  }

  isBuiltin(name: QName): boolean {
    return isBuiltinType(name);
  }

  builtin(name: QName): BuiltinType | undefined {
    return lookupBuiltin(name);
  }

  elementsInNamespace(namespaceUri: string): readonly ElementDecl[] {
    return [...this.elements.values()].filter((e) => e.name.namespaceUri === namespaceUri);
  }

  typesInNamespace(namespaceUri: string): readonly TypeDefinition[] {
    return [...this.types.values()].filter((t) => t.name?.namespaceUri === namespaceUri);
  }
}

/** Indexes a component, keeping the first occurrence and reporting real duplicates. */
function addComponent<T extends { readonly source: SourceRef }>(
  map: Map<string, T>,
  key: string,
  component: T,
  what: string,
  problems: SchemaProblem[],
): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, component);
    return;
  }
  // The same schema reached twice (e.g. included from two places) is not a
  // conflict: identical location *and* line means it is literally the same
  // declaration, so it is skipped silently.
  if (existing.source.location === component.source.location && existing.source.line === component.source.line) {
    return;
  }
  problems.push({
    code: 'duplicate-component',
    message: `Duplicate ${what} ${key}; keeping the declaration from ${existing.source.location}`,
    location: component.source.location,
    ...(component.source.line !== undefined
      ? { line: component.source.line, column: component.source.column ?? 1 }
      : {}),
  });
}

/**
 * Builds a queryable {@link SchemaSet} from every `xs:schema` in a resolved
 * bundle (or from a bare list of `xs:schema` elements, e.g. a merged
 * `WsdlDefinition.schemaElements`).
 *
 * Pure and synchronous: nothing is fetched. `xs:import`/`xs:include` are
 * ignored because the bundle already resolved them; `xs:redefine` is reported
 * as `unsupported`. Dangling references never throw — they are recorded in
 * {@link SchemaSet.problems} and the corresponding lookup returns `undefined`.
 *
 * @param input a {@link DefinitionBundle}, or any object exposing `schemaElements`
 */
export function buildSchemaSet(input: SchemaSetInput): SchemaSet {
  const problems: SchemaProblem[] = [];
  const elements = new Map<string, ElementDecl>();
  const types = new Map<string, TypeDefinition>();
  const groups = new Map<string, Group>();
  const attributeGroups = new Map<string, AttributeGroup>();
  const attributes = new Map<string, AttributeDecl>();
  const namespaces: string[] = [];

  for (const source of collectSources(input)) {
    const schemaEl = source.element;
    if (schemaEl.namespaceURI !== NS.XSD || schemaEl.localName !== 'schema') {
      continue;
    }
    const targetNamespace = source.namespaceOverride ?? optionalAttribute(schemaEl, 'targetNamespace') ?? '';
    const ctx: SchemaContext = {
      location: source.location,
      targetNamespace,
      elementFormDefault:
        optionalAttribute(schemaEl, 'elementFormDefault') === 'qualified' ? 'qualified' : 'unqualified',
      attributeFormDefault:
        optionalAttribute(schemaEl, 'attributeFormDefault') === 'qualified' ? 'qualified' : 'unqualified',
      problems,
    };
    if (!namespaces.includes(targetNamespace)) {
      namespaces.push(targetNamespace);
    }
    const components = parseSchemaElement(schemaEl, ctx);
    for (const decl of components.elements) {
      addComponent(elements, qnameToString(decl.name), decl, 'element', problems);
    }
    for (const type of components.types) {
      if (type.name !== undefined) {
        addComponent(types, qnameToString(type.name), type, 'type', problems);
      }
    }
    for (const group of components.groups) {
      addComponent(groups, qnameToString(group.name), group, 'group', problems);
    }
    for (const group of components.attributeGroups) {
      addComponent(attributeGroups, qnameToString(group.name), group, 'attribute group', problems);
    }
    for (const attribute of components.attributes) {
      addComponent(attributes, qnameToString(attribute.name), attribute, 'attribute', problems);
    }
  }

  return new SchemaSetImpl(namespaces, elements, types, groups, attributeGroups, attributes, problems);
}
