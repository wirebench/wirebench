import { NS } from '../xml/namespaces.js';
import type { QName } from '../wsdl/qname.js';
import { qnameEquals, qnameToString } from '../wsdl/qname.js';
import type { ComplexType, ResolvedAttribute, SimpleType } from './model.js';
import type { SchemaSet } from './schema-set.js';
import type { SimpleTypeRef } from './sample-values.js';

/** The type a leaf or element resolves to, once names and built-ins are followed. */
export type ResolvedType =
  | { readonly kind: 'complex'; readonly type: ComplexType }
  | { readonly kind: 'simple'; readonly ref: SimpleTypeRef }
  | { readonly kind: 'anyType' }
  | { readonly kind: 'soapencArray' };

export function resolveType(set: SchemaSet, ref: QName | ComplexType | SimpleType | undefined): ResolvedType {
  if (ref === undefined) {
    return { kind: 'anyType' };
  }
  if ('kind' in ref) {
    return ref.kind === 'complexType' ? { kind: 'complex', type: ref } : { kind: 'simple', ref };
  }
  const builtin = set.builtin(ref);
  if (builtin !== undefined) {
    if (builtin.soapEncArray === true) {
      return { kind: 'soapencArray' };
    }
    return ref.namespaceUri === NS.XSD && (ref.localName === 'anyType' || ref.localName === 'anySimpleType')
      ? { kind: 'anyType' }
      : { kind: 'simple', ref };
  }
  const type = set.lookupType(ref);
  if (type === undefined) {
    // A dangling type reference is already reported by the schema set; fall
    // back to a bare placeholder rather than failing the whole fragment.
    return { kind: 'anyType' };
  }
  return type.kind === 'complexType' ? { kind: 'complex', type } : { kind: 'simple', ref };
}

/** True when `candidate` reaches `base` through its complexContent derivation chain. */
function derivesFrom(set: SchemaSet, candidate: ComplexType, base: QName): boolean {
  const seen = new Set<string>();
  let current: ComplexType | undefined = candidate;
  while (current !== undefined) {
    if (current.content.kind !== 'complexContent' && current.content.kind !== 'simpleContent') {
      return false;
    }
    const parent = current.content.base;
    if (qnameEquals(parent, base)) {
      return true;
    }
    const key = qnameToString(parent);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    const next = set.lookupType(parent);
    current = next !== undefined && next.kind === 'complexType' ? next : undefined;
  }
  return false;
}

/** The first concrete type derived from an abstract one, in schema declaration order. */
export function firstConcreteDerived(set: SchemaSet, abstractType: ComplexType): ComplexType | undefined {
  if (abstractType.name === undefined) {
    return undefined;
  }
  for (const type of set.types.values()) {
    if (type.kind === 'complexType' && !type.abstract && derivesFrom(set, type, abstractType.name)) {
      return type;
    }
  }
  return undefined;
}

/** The `wsdl:arrayType` recorded on a SOAP-encoded array type, e.g. `xs:string[]`. */
export function arrayTypeOf(attributes: readonly ResolvedAttribute[]): string | undefined {
  for (const attribute of attributes) {
    if (attribute.arrayType !== undefined) {
      return attribute.arrayType;
    }
  }
  return undefined;
}
