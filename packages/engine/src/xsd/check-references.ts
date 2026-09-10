import { NS } from '../xml/namespaces.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import type {
  AttributeDecl,
  AttributeGroup,
  AttributeUse,
  ComplexType,
  ElementDecl,
  Group,
  Particle,
  SchemaProblem,
  SimpleType,
  SourceRef,
  TypeDefinition,
} from './model.js';

/** The parts of a built `SchemaSet` the reference check reads. */
export interface ReferenceCheckTarget {
  readonly elements: ReadonlyMap<string, ElementDecl>;
  readonly types: ReadonlyMap<string, TypeDefinition>;
  readonly groups: ReadonlyMap<string, Group>;
  readonly attributeGroups: ReadonlyMap<string, AttributeGroup>;
  readonly attributes: ReadonlyMap<string, AttributeDecl>;
  lookupElement(name: QName): ElementDecl | undefined;
  lookupType(name: QName): TypeDefinition | undefined;
  lookupGroup(name: QName): Group | undefined;
  lookupAttributeGroup(name: QName): AttributeGroup | undefined;
  lookupAttribute(name: QName): AttributeDecl | undefined;
}

/** Namespaces whose references are satisfied by the built-in table rather than a schema. */
function isExternallyKnown(name: QName): boolean {
  return name.namespaceUri === NS.XSD || name.namespaceUri === NS.SOAP11_ENC;
}

/**
 * Records an `unresolved-ref` problem for every dangling reference in `set`:
 * type, element, group, attribute, attribute-group and substitution-group
 * heads. References into the XSD and SOAP-encoding namespaces are satisfied by
 * the built-in table, so they are never reported.
 *
 * Unresolved references are never fatal: the corresponding lookup simply
 * returns `undefined`, and consumers decide how to degrade.
 */
export function checkReferences(set: ReferenceCheckTarget, problems: SchemaProblem[]): void {
  const report = (what: string, name: QName, source: SourceRef): void => {
    problems.push({
      code: 'unresolved-ref',
      message: `Unresolved ${what} reference ${qnameToString(name)}`,
      location: source.location,
      ...(source.line !== undefined ? { line: source.line, column: source.column ?? 1 } : {}),
    });
  };
  const checkType = (name: QName | undefined, source: SourceRef): void => {
    if (name !== undefined && !isExternallyKnown(name) && set.lookupType(name) === undefined) {
      report('type', name, source);
    }
  };
  const checkSimple = (type: SimpleType, source: SourceRef): void => {
    checkType(type.base, source);
    if (type.baseType !== undefined) {
      checkSimple(type.baseType, source);
    }
    if (type.itemType !== undefined) {
      if ('kind' in type.itemType) {
        checkSimple(type.itemType, source);
      } else {
        checkType(type.itemType, source);
      }
    }
    for (const member of type.memberTypes ?? []) {
      if ('kind' in member) {
        checkSimple(member, source);
      } else {
        checkType(member, source);
      }
    }
  };
  const checkAttributes = (uses: readonly AttributeUse[], source: SourceRef): void => {
    for (const use of uses) {
      if (use.kind === 'attribute') {
        checkType(use.type, source);
        if (use.anonymousType !== undefined) {
          checkSimple(use.anonymousType, source);
        }
      } else if (use.kind === 'attributeRef') {
        if (!isExternallyKnown(use.ref) && set.lookupAttribute(use.ref) === undefined) {
          report('attribute', use.ref, source);
        }
      } else if (use.kind === 'attributeGroupRef') {
        if (!isExternallyKnown(use.ref) && set.lookupAttributeGroup(use.ref) === undefined) {
          report('attribute group', use.ref, source);
        }
      }
    }
  };
  const checkParticle = (particle: Particle, source: SourceRef): void => {
    switch (particle.kind) {
      case 'localElement':
        checkElement(particle.decl);
        break;
      case 'elementRef':
        if (!isExternallyKnown(particle.ref) && set.lookupElement(particle.ref) === undefined) {
          report('element', particle.ref, source);
        }
        break;
      case 'groupRef':
        if (!isExternallyKnown(particle.ref) && set.lookupGroup(particle.ref) === undefined) {
          report('group', particle.ref, source);
        }
        break;
      case 'sequence':
      case 'choice':
      case 'all':
        for (const child of particle.particles) {
          checkParticle(child, source);
        }
        break;
      default:
        break;
    }
  };
  const checkComplex = (type: ComplexType): void => {
    const content = type.content;
    if (content.kind === 'complexContent' || content.kind === 'simpleContent') {
      checkType(content.base, type.source);
    }
    if (content.kind === 'particle') {
      checkParticle(content.particle, type.source);
    } else if (content.kind === 'complexContent' && content.particle !== undefined) {
      checkParticle(content.particle, type.source);
    }
    checkAttributes(content.attributes, type.source);
  };
  const checkElement = (decl: ElementDecl): void => {
    checkType(decl.type, decl.source);
    if (decl.substitutionGroup !== undefined && set.lookupElement(decl.substitutionGroup) === undefined) {
      report('substitution group head', decl.substitutionGroup, decl.source);
    }
    if (decl.anonymousType !== undefined) {
      if (decl.anonymousType.kind === 'complexType') {
        checkComplex(decl.anonymousType);
      } else {
        checkSimple(decl.anonymousType, decl.source);
      }
    }
  };

  for (const decl of set.elements.values()) {
    checkElement(decl);
  }
  for (const type of set.types.values()) {
    if (type.kind === 'complexType') {
      checkComplex(type);
    } else {
      checkSimple(type, type.source);
    }
  }
  for (const group of set.groups.values()) {
    checkParticle(group.particle, group.source);
  }
  for (const group of set.attributeGroups.values()) {
    checkAttributes(group.attributes, group.source);
  }
  for (const attribute of set.attributes.values()) {
    checkAttributes([attribute], attribute.source);
  }
}
