import type { QName } from '../wsdl/qname.js';
import { qnameEquals } from '../wsdl/qname.js';
import type { ComplexType, ElementDecl, Particle, ResolvedAttribute, SourceRef } from './model.js';
import type { SchemaSet } from './schema-set.js';

export { completionContextAt, elementPathAt } from '../xml/locate.js';
export type { CompletionContext, TextRange } from '../xml/locate.js';

function resolveDeclType(schemaSet: SchemaSet, decl: ElementDecl): ComplexType | undefined {
  if (decl.type !== undefined) {
    const type = schemaSet.lookupType(decl.type);
    return type?.kind === 'complexType' ? type : undefined;
  }
  return decl.anonymousType?.kind === 'complexType' ? decl.anonymousType : undefined;
}

function findChildDecl(particle: Particle, schemaSet: SchemaSet, name: QName): ElementDecl | undefined {
  switch (particle.kind) {
    case 'localElement':
      return qnameEquals(particle.decl.name, name) ? particle.decl : undefined;
    case 'elementRef': {
      const head = schemaSet.lookupElement(particle.ref);
      if (head !== undefined && qnameEquals(head.name, name)) {
        return head;
      }
      for (const sub of schemaSet.substitutionsFor(particle.ref)) {
        if (qnameEquals(sub.name, name)) {
          return sub;
        }
      }
      return undefined;
    }
    case 'sequence':
    case 'choice':
    case 'all':
      for (const p of particle.particles) {
        const found = findChildDecl(p, schemaSet, name);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    case 'groupRef': {
      const group = schemaSet.lookupGroup(particle.ref);
      return group !== undefined ? findChildDecl(group.particle, schemaSet, name) : undefined;
    }
    case 'any':
      return undefined;
    default:
      return undefined;
  }
}

function collectChildElements(particle: Particle, schemaSet: SchemaSet, out: ElementDecl[]): void {
  switch (particle.kind) {
    case 'localElement':
      out.push(particle.decl);
      return;
    case 'elementRef': {
      const head = schemaSet.lookupElement(particle.ref);
      if (head !== undefined) {
        out.push(head);
      }
      for (const sub of schemaSet.substitutionsFor(particle.ref)) {
        out.push(sub);
      }
      return;
    }
    case 'sequence':
    case 'choice':
    case 'all':
      for (const p of particle.particles) {
        collectChildElements(p, schemaSet, out);
      }
      return;
    case 'groupRef': {
      const group = schemaSet.lookupGroup(particle.ref);
      if (group !== undefined) {
        collectChildElements(group.particle, schemaSet, out);
      }
      return;
    }
    case 'any':
      return;
    default:
      return;
  }
}

/** Resolves the element declaration at the end of `path` by walking global elements through their content models. */
function resolveElementAt(schemaSet: SchemaSet, path: readonly QName[]): ElementDecl | undefined {
  if (path.length === 0) {
    return undefined;
  }
  let decl = schemaSet.lookupElement(path[0] as QName);
  if (decl === undefined) {
    return undefined;
  }
  for (let i = 1; i < path.length; i += 1) {
    const type = resolveDeclType(schemaSet, decl);
    if (type === undefined) {
      return undefined;
    }
    const content = schemaSet.resolveContent(type);
    if (content.particle === undefined) {
      return undefined;
    }
    const child = findChildDecl(content.particle, schemaSet, path[i] as QName);
    if (child === undefined) {
      return undefined;
    }
    decl = child;
  }
  return decl;
}

/** Element declarations legal as children of the element at `path`, in schema order (substitution members included). */
export function childrenAllowedAt(schemaSet: SchemaSet, path: readonly QName[]): ElementDecl[] {
  const decl = resolveElementAt(schemaSet, path);
  if (decl === undefined) {
    return [];
  }
  const type = resolveDeclType(schemaSet, decl);
  if (type === undefined) {
    return [];
  }
  const content = schemaSet.resolveContent(type);
  if (content.particle === undefined) {
    return [];
  }
  const out: ElementDecl[] = [];
  collectChildElements(content.particle, schemaSet, out);
  return out;
}

/** Attributes legal on the element at `path`. */
export function attributesAllowedAt(schemaSet: SchemaSet, path: readonly QName[]): readonly ResolvedAttribute[] {
  const decl = resolveElementAt(schemaSet, path);
  if (decl === undefined) {
    return [];
  }
  const type = resolveDeclType(schemaSet, decl);
  if (type === undefined) {
    return [];
  }
  return schemaSet.resolveContent(type).attributes;
}

/** The declaration and source location of the element at `path`, or `undefined` when unresolvable. */
export function declarationOf(
  schemaSet: SchemaSet,
  path: readonly QName[],
): { readonly element: ElementDecl; readonly source: SourceRef } | undefined {
  const decl = resolveElementAt(schemaSet, path);
  return decl === undefined ? undefined : { element: decl, source: decl.source };
}
