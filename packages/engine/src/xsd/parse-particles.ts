import type { Element } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import { getPosition } from '../xml/parse.js';
import { childElements, firstChildElement, optionalAttribute } from '../wsdl/dom-utils.js';
import type { QName } from '../wsdl/qname.js';
import { parseQName } from '../wsdl/qname.js';
import type {
  AnyAttribute,
  AttributeDecl,
  AttributeUse,
  AttributeUseKind,
  ElementDecl,
  Facet,
  Occurs,
  Particle,
  ProcessContents,
  ComplexType,
  SchemaProblem,
  SimpleType,
  SourceRef,
} from './model.js';

/** Parses an `xs:complexType` element; injected to break the particle/type parsing cycle. */
export type ParseComplexType = (element: Element, ctx: SchemaContext, name?: QName) => ComplexType;

/** Per-schema state threaded through parsing: where we are and how names qualify. */
export interface SchemaContext {
  /** The document location the schema element came from, or `'<inline>'`. */
  readonly location: string;
  readonly targetNamespace: string;
  readonly elementFormDefault: 'qualified' | 'unqualified';
  readonly attributeFormDefault: 'qualified' | 'unqualified';
  /** Sink for non-fatal problems; mutated during the build. */
  readonly problems: SchemaProblem[];
}

/** Builds a {@link SourceRef} for `el` within `ctx`'s document. */
export function sourceRef(el: Element, ctx: SchemaContext): SourceRef {
  const pos = getPosition(el);
  return { location: ctx.location, ...(pos !== undefined ? pos : {}) };
}

/** Records a non-fatal problem positioned at `el`. */
export function addProblem(ctx: SchemaContext, code: SchemaProblem['code'], message: string, el: Element): void {
  const pos = getPosition(el);
  ctx.problems.push({ code, message, location: ctx.location, ...(pos !== undefined ? pos : {}) });
}

/**
 * Reads a QName-valued attribute.
 *
 * Unprefixed values resolve to the in-scope XML default namespace (`xmlns="…"`)
 * and, when none is declared, to no namespace — never to the schema's
 * `targetNamespace`. That is the XSD rule, and differs from the lenient WSDL
 * fallback, so `''` is passed as {@link parseQName}'s `defaultNamespace`.
 */
export function readQName(el: Element, attribute: string, ctx: SchemaContext): QName | undefined {
  const raw = optionalAttribute(el, attribute);
  if (raw === undefined) {
    return undefined;
  }
  try {
    return parseQName(raw, el, '');
  } catch (error) {
    addProblem(ctx, 'invalid-schema', `Cannot resolve QName "${raw}": ${String(error)}`, el);
    return undefined;
  }
}

/** Reads `minOccurs`/`maxOccurs`, defaulting both to 1. */
export function readOccurs(el: Element): Occurs {
  const minRaw = optionalAttribute(el, 'minOccurs');
  const maxRaw = optionalAttribute(el, 'maxOccurs');
  const min = minRaw === undefined ? 1 : Number.parseInt(minRaw, 10);
  const max = maxRaw === undefined ? 1 : maxRaw === 'unbounded' ? 'unbounded' : Number.parseInt(maxRaw, 10);
  return {
    min: Number.isFinite(min) ? min : 1,
    max: max === 'unbounded' || Number.isFinite(max) ? max : 1,
  };
}

/** Reads the trimmed text of an `xs:annotation/xs:documentation` child, if present. */
export function readAnnotation(el: Element): string | undefined {
  const annotation = firstChildElement(el, NS.XSD, 'annotation');
  if (annotation === undefined) {
    return undefined;
  }
  const doc = firstChildElement(annotation, NS.XSD, 'documentation');
  const text = (doc?.textContent ?? '').trim();
  return text.length > 0 ? text : undefined;
}

const NUMERIC_FACETS = new Set(['length', 'minLength', 'maxLength', 'totalDigits', 'fractionDigits']);
const LEXICAL_FACETS = new Set(['minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive']);
const WHITESPACE_VALUES = new Set(['preserve', 'replace', 'collapse']);

/** Collects the facet children of an `xs:restriction`, merging repeated enumerations. */
export function parseFacets(restriction: Element): Facet[] {
  const facets: Facet[] = [];
  const enumeration: string[] = [];
  let child = restriction.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.namespaceURI === NS.XSD) {
        const value = optionalAttribute(el, 'value') ?? '';
        const localName = el.localName ?? '';
        if (localName === 'enumeration') {
          enumeration.push(value);
        } else if (NUMERIC_FACETS.has(localName)) {
          facets.push({ kind: localName as 'length', value: Number.parseInt(value, 10) });
        } else if (LEXICAL_FACETS.has(localName)) {
          facets.push({ kind: localName as 'minInclusive', value });
        } else if (el.localName === 'pattern') {
          facets.push({ kind: 'pattern', value });
        } else if (el.localName === 'whiteSpace' && WHITESPACE_VALUES.has(value)) {
          facets.push({ kind: 'whiteSpace', value: value as 'collapse' });
        }
      }
    }
    child = child.nextSibling;
  }
  if (enumeration.length > 0) {
    facets.unshift({ kind: 'enumeration', values: enumeration });
  }
  return facets;
}

/** Parses an `xs:simpleType` element (named or anonymous). */
export function parseSimpleType(el: Element, ctx: SchemaContext, name?: QName): SimpleType {
  const documentation = readAnnotation(el);
  const common = {
    kind: 'simpleType' as const,
    ...(name !== undefined ? { name } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
    source: sourceRef(el, ctx),
  };
  const list = firstChildElement(el, NS.XSD, 'list');
  if (list !== undefined) {
    const itemTypeRef = readQName(list, 'itemType', ctx);
    const inline = firstChildElement(list, NS.XSD, 'simpleType');
    const itemType = itemTypeRef ?? (inline !== undefined ? parseSimpleType(inline, ctx) : undefined);
    return { ...common, variety: 'list', ...(itemType !== undefined ? { itemType } : {}), facets: [] };
  }
  const union = firstChildElement(el, NS.XSD, 'union');
  if (union !== undefined) {
    const raw = optionalAttribute(union, 'memberTypes') ?? '';
    const members: (QName | SimpleType)[] = [];
    for (const token of raw.split(/\s+/).filter((t) => t.length > 0)) {
      try {
        members.push(parseQName(token, union, ''));
      } catch (error) {
        addProblem(ctx, 'invalid-schema', `Cannot resolve union member "${token}": ${String(error)}`, union);
      }
    }
    for (const inline of childElements(union, NS.XSD, 'simpleType')) {
      members.push(parseSimpleType(inline, ctx));
    }
    return { ...common, variety: 'union', memberTypes: members, facets: [] };
  }
  const restriction = firstChildElement(el, NS.XSD, 'restriction');
  if (restriction === undefined) {
    return { ...common, variety: 'atomic', facets: [] };
  }
  const base = readQName(restriction, 'base', ctx);
  const inlineBase = firstChildElement(restriction, NS.XSD, 'simpleType');
  return {
    ...common,
    variety: 'atomic',
    ...(base !== undefined ? { base } : {}),
    ...(base === undefined && inlineBase !== undefined ? { baseType: parseSimpleType(inlineBase, ctx) } : {}),
    facets: parseFacets(restriction),
  };
}

function readUse(el: Element): AttributeUseKind {
  const raw = optionalAttribute(el, 'use');
  return raw === 'required' || raw === 'prohibited' ? raw : 'optional';
}

/** Parses a single `xs:attribute` element into a declaration or a ref. */
export function parseAttribute(el: Element, ctx: SchemaContext, global: boolean): AttributeUse {
  const use = readUse(el);
  const defaultValue = optionalAttribute(el, 'default');
  const fixedValue = optionalAttribute(el, 'fixed');
  const ref = global ? undefined : readQName(el, 'ref', ctx);
  if (ref !== undefined) {
    // `wsdl:arrayType` on a `soapenc:arrayType` ref is the only record of an
    // encoded array's item type, so it is preserved verbatim.
    const arrayType = el.getAttributeNS(NS.WSDL, 'arrayType') ?? undefined;
    return {
      kind: 'attributeRef',
      ref,
      use,
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(fixedValue !== undefined ? { fixed: fixedValue } : {}),
      ...(arrayType !== undefined && arrayType !== '' ? { arrayType } : {}),
    };
  }
  const localName = optionalAttribute(el, 'name') ?? '';
  const form = optionalAttribute(el, 'form');
  const qualified = global || form === 'qualified' || (form === undefined && ctx.attributeFormDefault === 'qualified');
  const type = readQName(el, 'type', ctx);
  const inline = firstChildElement(el, NS.XSD, 'simpleType');
  const documentation = readAnnotation(el);
  const decl: AttributeDecl = {
    kind: 'attribute',
    name: { namespaceUri: qualified ? ctx.targetNamespace : '', localName },
    ...(type !== undefined ? { type } : {}),
    ...(type === undefined && inline !== undefined ? { anonymousType: parseSimpleType(inline, ctx) } : {}),
    use,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(fixedValue !== undefined ? { fixed: fixedValue } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
    source: sourceRef(el, ctx),
  };
  return decl;
}

function readProcessContents(el: Element): ProcessContents {
  const raw = optionalAttribute(el, 'processContents');
  return raw === 'lax' || raw === 'skip' ? raw : 'strict';
}

function parseAnyAttribute(el: Element): AnyAttribute {
  return {
    kind: 'anyAttribute',
    namespace: optionalAttribute(el, 'namespace') ?? '##any',
    processContents: readProcessContents(el),
  };
}

/** Collects every `attribute`/`attributeGroup ref`/`anyAttribute` child of `parent`, in order. */
export function parseAttributeUses(parent: Element, ctx: SchemaContext): AttributeUse[] {
  const uses: AttributeUse[] = [];
  let child = parent.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.namespaceURI === NS.XSD) {
        if (el.localName === 'attribute') {
          uses.push(parseAttribute(el, ctx, false));
        } else if (el.localName === 'attributeGroup') {
          const ref = readQName(el, 'ref', ctx);
          if (ref !== undefined) {
            uses.push({ kind: 'attributeGroupRef', ref });
          }
        } else if (el.localName === 'anyAttribute') {
          uses.push(parseAnyAttribute(el));
        }
      }
    }
    child = child.nextSibling;
  }
  return uses;
}

/** Parses an `xs:element` declaration; `global` elements always take the target namespace. */
export function parseElementDecl(
  el: Element,
  ctx: SchemaContext,
  global: boolean,
  parseComplexType: ParseComplexType,
): ElementDecl {
  const localName = optionalAttribute(el, 'name') ?? '';
  const form = optionalAttribute(el, 'form');
  const qualified = global || form === 'qualified' || (form === undefined && ctx.elementFormDefault === 'qualified');
  const type = readQName(el, 'type', ctx);
  const inlineComplex = firstChildElement(el, NS.XSD, 'complexType');
  const inlineSimple = firstChildElement(el, NS.XSD, 'simpleType');
  const substitutionGroup = readQName(el, 'substitutionGroup', ctx);
  const defaultValue = optionalAttribute(el, 'default');
  const fixedValue = optionalAttribute(el, 'fixed');
  const documentation = readAnnotation(el);
  const anonymousType =
    type !== undefined
      ? undefined
      : inlineComplex !== undefined
        ? parseComplexType(inlineComplex, ctx)
        : inlineSimple !== undefined
          ? parseSimpleType(inlineSimple, ctx)
          : undefined;
  return {
    kind: 'element',
    name: { namespaceUri: qualified ? ctx.targetNamespace : '', localName },
    ...(type !== undefined ? { type } : {}),
    ...(anonymousType !== undefined ? { anonymousType } : {}),
    nillable: optionalAttribute(el, 'nillable') === 'true',
    abstract: optionalAttribute(el, 'abstract') === 'true',
    ...(substitutionGroup !== undefined ? { substitutionGroup } : {}),
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(fixedValue !== undefined ? { fixed: fixedValue } : {}),
    ...(documentation !== undefined ? { documentation } : {}),
    source: sourceRef(el, ctx),
  };
}

/** Parses a compositor (`sequence`/`choice`/`all`) or any other particle element. */
export function parseParticle(
  el: Element,
  ctx: SchemaContext,
  parseComplexType: ParseComplexType,
): Particle | undefined {
  const occurs = readOccurs(el);
  switch (el.localName) {
    case 'sequence':
    case 'choice':
    case 'all':
      return {
        kind: el.localName,
        particles: parseParticleChildren(el, ctx, parseComplexType),
        occurs,
      };
    case 'group': {
      const ref = readQName(el, 'ref', ctx);
      return ref !== undefined ? { kind: 'groupRef', ref, occurs } : undefined;
    }
    case 'any':
      return {
        kind: 'any',
        namespace: optionalAttribute(el, 'namespace') ?? '##any',
        processContents: readProcessContents(el),
        occurs,
      };
    case 'element': {
      const ref = readQName(el, 'ref', ctx);
      if (ref !== undefined) {
        return { kind: 'elementRef', ref, occurs };
      }
      return { kind: 'localElement', decl: parseElementDecl(el, ctx, false, parseComplexType), occurs };
    }
    default:
      return undefined;
  }
}

/** Parses every particle child of `parent`, skipping annotations and unknown elements. */
export function parseParticleChildren(
  parent: Element,
  ctx: SchemaContext,
  parseComplexType: ParseComplexType,
): Particle[] {
  const particles: Particle[] = [];
  let child = parent.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.namespaceURI === NS.XSD) {
        const particle = parseParticle(el, ctx, parseComplexType);
        if (particle !== undefined) {
          particles.push(particle);
        }
      }
    }
    child = child.nextSibling;
  }
  return particles;
}

/** Finds the first compositor child (`sequence`/`choice`/`all`/`group ref`) of `parent`. */
export function firstParticleChild(parent: Element): Element | undefined {
  let child = parent.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      const el = child as Element;
      if (
        el.namespaceURI === NS.XSD &&
        (el.localName === 'sequence' || el.localName === 'choice' || el.localName === 'all' || el.localName === 'group')
      ) {
        return el;
      }
    }
    child = child.nextSibling;
  }
  return undefined;
}
