import type { Element } from '@xmldom/xmldom';
import { NS } from '../xml/namespaces.js';
import { childElements, firstChildElement, optionalAttribute } from '../wsdl/dom-utils.js';
import type { QName } from '../wsdl/qname.js';
import type {
  AttributeDecl,
  AttributeGroup,
  ComplexContentModel,
  ComplexType,
  Compositor,
  ElementDecl,
  Group,
  SimpleType,
} from './model.js';
import {
  addProblem,
  parseAttribute,
  firstParticleChild,
  parseAttributeUses,
  parseElementDecl,
  parseFacets,
  parseParticle,
  parseSimpleType,
  readAnnotation,
  readQName,
  sourceRef,
} from './parse-particles.js';
import type { SchemaContext } from './parse-particles.js';

/** The global components declared by one `xs:schema` element. */
export interface SchemaComponents {
  readonly elements: readonly ElementDecl[];
  readonly types: readonly (ComplexType | SimpleType)[];
  readonly groups: readonly Group[];
  readonly attributeGroups: readonly AttributeGroup[];
  readonly attributes: readonly AttributeDecl[];
}

function parseDerivedContent(
  derivationEl: Element,
  ctx: SchemaContext,
  wrapper: 'complexContent' | 'simpleContent',
  derivation: 'extension' | 'restriction',
): ComplexContentModel {
  const base = readQName(derivationEl, 'base', ctx) ?? { namespaceUri: '', localName: '' };
  const attributes = parseAttributeUses(derivationEl, ctx);
  if (wrapper === 'simpleContent') {
    const facets = derivation === 'restriction' ? parseFacets(derivationEl) : [];
    return {
      kind: 'simpleContent',
      derivation,
      base,
      attributes,
      ...(facets.length > 0 ? { facets } : {}),
    };
  }
  const particleEl = firstParticleChild(derivationEl);
  const particle = particleEl !== undefined ? parseParticle(particleEl, ctx, parseComplexType) : undefined;
  return {
    kind: 'complexContent',
    derivation,
    base,
    ...(particle !== undefined ? { particle } : {}),
    attributes,
  };
}

/** Parses an `xs:complexType` element (named when `name` is given, anonymous otherwise). */
export function parseComplexType(el: Element, ctx: SchemaContext, name?: QName): ComplexType {
  const documentation = readAnnotation(el);
  const common = {
    kind: 'complexType' as const,
    ...(name !== undefined ? { name } : {}),
    abstract: optionalAttribute(el, 'abstract') === 'true',
    mixed: optionalAttribute(el, 'mixed') === 'true',
    ...(documentation !== undefined ? { documentation } : {}),
    source: sourceRef(el, ctx),
  };

  for (const wrapper of ['complexContent', 'simpleContent'] as const) {
    const wrapperEl = firstChildElement(el, NS.XSD, wrapper);
    if (wrapperEl === undefined) {
      continue;
    }
    // `mixed` may also be declared on `xs:complexContent`.
    const mixed = common.mixed || optionalAttribute(wrapperEl, 'mixed') === 'true';
    for (const derivation of ['extension', 'restriction'] as const) {
      const derivationEl = firstChildElement(wrapperEl, NS.XSD, derivation);
      if (derivationEl !== undefined) {
        return { ...common, mixed, content: parseDerivedContent(derivationEl, ctx, wrapper, derivation) };
      }
    }
    addProblem(ctx, 'invalid-schema', `<xs:${wrapper}> without extension or restriction`, wrapperEl);
    return { ...common, mixed, content: { kind: 'empty', attributes: [] } };
  }

  const attributes = parseAttributeUses(el, ctx);
  const particleEl = firstParticleChild(el);
  const particle = particleEl !== undefined ? parseParticle(particleEl, ctx, parseComplexType) : undefined;
  if (particle === undefined) {
    return { ...common, content: { kind: 'empty', attributes } };
  }
  return { ...common, content: { kind: 'particle', particle, attributes } };
}

function parseGroup(el: Element, ctx: SchemaContext, name: QName): Group | undefined {
  const particleEl = firstParticleChild(el);
  const particle = particleEl !== undefined ? parseParticle(particleEl, ctx, parseComplexType) : undefined;
  if (particle === undefined || particle.kind === 'groupRef') {
    addProblem(ctx, 'invalid-schema', `<xs:group name="${name.localName}"> has no compositor child`, el);
    return undefined;
  }
  const documentation = readAnnotation(el);
  return {
    kind: 'group',
    name,
    particle: particle as Compositor,
    ...(documentation !== undefined ? { documentation } : {}),
    source: sourceRef(el, ctx),
  };
}

/**
 * Parses the global components of one `xs:schema` element.
 *
 * `xs:import`/`xs:include` are ignored (the bundle already resolved them);
 * `xs:redefine` records an `unsupported` problem and its content is skipped.
 */
export function parseSchemaElement(schemaEl: Element, ctx: SchemaContext): SchemaComponents {
  const elements: ElementDecl[] = [];
  const types: (ComplexType | SimpleType)[] = [];
  const groups: Group[] = [];
  const attributeGroups: AttributeGroup[] = [];
  const attributes: AttributeDecl[] = [];

  for (const child of childElements(schemaEl, NS.XSD, 'redefine')) {
    addProblem(ctx, 'unsupported', 'xs:redefine is not supported; its content is ignored', child);
  }

  let child = schemaEl.firstChild;
  while (child !== null) {
    if (child.nodeType === 1) {
      const el = child as Element;
      if (el.namespaceURI === NS.XSD) {
        const localName = optionalAttribute(el, 'name');
        const name: QName = { namespaceUri: ctx.targetNamespace, localName: localName ?? '' };
        switch (el.localName) {
          case 'element':
            elements.push(parseElementDecl(el, ctx, true, parseComplexType));
            break;
          case 'complexType':
            types.push(parseComplexType(el, ctx, name));
            break;
          case 'simpleType':
            types.push(parseSimpleType(el, ctx, name));
            break;
          case 'group': {
            const group = parseGroup(el, ctx, name);
            if (group !== undefined) {
              groups.push(group);
            }
            break;
          }
          case 'attributeGroup': {
            const documentation = readAnnotation(el);
            attributeGroups.push({
              kind: 'attributeGroup',
              name,
              attributes: parseAttributeUses(el, ctx),
              ...(documentation !== undefined ? { documentation } : {}),
              source: sourceRef(el, ctx),
            });
            break;
          }
          case 'attribute': {
            const parsed = parseAttribute(el, ctx, true);
            if (parsed.kind === 'attribute') {
              attributes.push(parsed);
            }
            break;
          }
          default:
            break;
        }
      }
    }
    child = child.nextSibling;
  }

  return { elements, types, groups, attributeGroups, attributes };
}
