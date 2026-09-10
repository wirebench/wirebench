import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import { lookupBuiltin } from './builtins.js';
import type {
  AttributeGroup,
  AttributeUse,
  ComplexType,
  Group,
  Particle,
  ResolvedAttribute,
  ResolvedContent,
  Sequence,
  TypeDefinition,
} from './model.js';

/** The lookups {@link resolveContent} needs; satisfied by the built `SchemaSet`. */
export interface ResolutionContext {
  lookupType(name: QName): TypeDefinition | undefined;
  lookupGroup(name: QName): Group | undefined;
  lookupAttributeGroup(name: QName): AttributeGroup | undefined;
  lookupAttribute(name: QName): import('./model.js').AttributeDecl | undefined;
}

/**
 * Replaces every `groupRef` with the referenced group's compositor, carrying the
 * ref's own occurrence constraints. `visited` breaks group-reference cycles.
 */
function expandGroups(particle: Particle, ctx: ResolutionContext, visited: ReadonlySet<string>): Particle | undefined {
  switch (particle.kind) {
    case 'groupRef': {
      const key = qnameToString(particle.ref);
      if (visited.has(key)) {
        return undefined;
      }
      const group = ctx.lookupGroup(particle.ref);
      if (group === undefined) {
        return undefined;
      }
      const inner = expandGroups(group.particle, ctx, new Set([...visited, key]));
      return inner === undefined ? undefined : { ...inner, occurs: particle.occurs };
    }
    case 'sequence':
    case 'choice':
    case 'all': {
      const particles = particle.particles
        .map((p) => expandGroups(p, ctx, visited))
        .filter((p): p is Particle => p !== undefined);
      return { ...particle, particles };
    }
    default:
      return particle;
  }
}

const ONCE = { min: 1, max: 1 } as const;

/** True when a particle can be spliced into an enclosing synthetic sequence. */
function isInlinableSequence(particle: Particle): particle is Sequence {
  return particle.kind === 'sequence' && particle.occurs.min === 1 && particle.occurs.max === 1;
}

/** Concatenates base-first particles into a single sequence, splicing plain sub-sequences. */
function mergeParticles(parts: readonly Particle[]): Particle | undefined {
  const flat: Particle[] = [];
  for (const part of parts) {
    if (isInlinableSequence(part)) {
      flat.push(...part.particles);
    } else {
      flat.push(part);
    }
  }
  if (flat.length === 0) {
    return undefined;
  }
  if (parts.length === 1 && !isInlinableSequence(parts[0] as Particle)) {
    return parts[0];
  }
  return { kind: 'sequence', particles: flat, occurs: ONCE };
}

function toResolvedAttribute(decl: import('./model.js').AttributeDecl): ResolvedAttribute {
  return {
    name: decl.name,
    ...(decl.type !== undefined ? { type: decl.type } : {}),
    ...(decl.anonymousType !== undefined ? { anonymousType: decl.anonymousType } : {}),
    use: decl.use === 'required' ? 'required' : 'optional',
    ...(decl.default !== undefined ? { default: decl.default } : {}),
    ...(decl.fixed !== undefined ? { fixed: decl.fixed } : {}),
  };
}

/** Accumulator for a derivation chain's attributes: name → attribute, plus prohibitions. */
interface AttributeAccumulator {
  readonly byName: Map<string, ResolvedAttribute>;
  readonly prohibited: Set<string>;
  anyAttribute?: { readonly namespace: string; readonly processContents: 'strict' | 'lax' | 'skip' };
}

function collectAttributes(
  uses: readonly AttributeUse[],
  ctx: ResolutionContext,
  acc: AttributeAccumulator,
  seenGroups: Set<string>,
): void {
  for (const use of uses) {
    switch (use.kind) {
      case 'attribute': {
        const key = qnameToString(use.name);
        if (use.use === 'prohibited') {
          acc.prohibited.add(key);
          acc.byName.delete(key);
        } else {
          acc.byName.set(key, toResolvedAttribute(use));
        }
        break;
      }
      case 'attributeRef': {
        const key = qnameToString(use.ref);
        if (use.use === 'prohibited') {
          acc.prohibited.add(key);
          acc.byName.delete(key);
          break;
        }
        const decl = ctx.lookupAttribute(use.ref);
        const base: ResolvedAttribute =
          decl !== undefined ? toResolvedAttribute(decl) : { name: use.ref, use: 'optional' };
        acc.byName.set(key, {
          ...base,
          use: use.use === 'required' ? 'required' : base.use,
          ...(use.default !== undefined ? { default: use.default } : {}),
          ...(use.fixed !== undefined ? { fixed: use.fixed } : {}),
        });
        break;
      }
      case 'attributeGroupRef': {
        const key = qnameToString(use.ref);
        if (seenGroups.has(key)) {
          break;
        }
        seenGroups.add(key);
        const group = ctx.lookupAttributeGroup(use.ref);
        if (group !== undefined) {
          collectAttributes(group.attributes, ctx, acc, seenGroups);
        }
        break;
      }
      case 'anyAttribute':
        acc.anyAttribute = { namespace: use.namespace, processContents: use.processContents };
        break;
    }
  }
}

/** Walks a `simpleContent` derivation chain down to its ultimate simple base. */
function ultimateSimpleBase(base: QName, ctx: ResolutionContext, visited: Set<string>): QName {
  const key = qnameToString(base);
  if (visited.has(key) || lookupBuiltin(base) !== undefined) {
    return base;
  }
  visited.add(key);
  const type = ctx.lookupType(base);
  if (type === undefined) {
    return base;
  }
  if (type.kind === 'simpleType') {
    return type.base !== undefined ? ultimateSimpleBase(type.base, ctx, visited) : base;
  }
  if (type.content.kind === 'simpleContent') {
    return ultimateSimpleBase(type.content.base, ctx, visited);
  }
  return base;
}

/**
 * Computes a complex type's effective content: extension chains flattened
 * base-first, `groupRef`s expanded in place, attribute groups and inherited
 * attributes merged (later declarations win, `prohibited` ones removed).
 *
 * Cycle-safe: a base chain that loops back on itself stops at the repeat, and
 * recursive element declarations are left as references rather than expanded.
 */
export function resolveContent(type: ComplexType, ctx: ResolutionContext): ResolvedContent {
  const particles: Particle[] = [];
  const acc: AttributeAccumulator = { byName: new Map(), prohibited: new Set() };
  const visited = new Set<string>();
  let mixed = false;
  let simpleContentBase: QName | undefined;

  // Walk the derivation chain to its root, collecting each level, then apply
  // base-first so extensions append after what they extend.
  const chain: ComplexType[] = [];
  let current: ComplexType | undefined = type;
  while (current !== undefined) {
    const key = current.name !== undefined ? qnameToString(current.name) : undefined;
    if (key !== undefined) {
      if (visited.has(key)) {
        break;
      }
      visited.add(key);
    }
    chain.unshift(current);
    const content = current.content;
    if (content.kind === 'complexContent') {
      const base = ctx.lookupType(content.base);
      current = base !== undefined && base.kind === 'complexType' ? base : undefined;
      // A `restriction` restates the whole content model, so the base's particle
      // is not inherited; only its attributes (and mixed/anyAttribute) are.
      if (content.derivation === 'restriction') {
        break;
      }
    } else if (content.kind === 'simpleContent') {
      // A simpleContent extension/restriction may still chain to a complex base
      // that itself declares simpleContent (e.g. TaxedAmount extends Amount);
      // follow it so the base's attributes are inherited. The chain ends once
      // the base is a simple type or builtin (handled by ultimateSimpleBase).
      const base = ctx.lookupType(content.base);
      current = base !== undefined && base.kind === 'complexType' ? base : undefined;
      if (content.derivation === 'restriction') {
        break;
      }
    } else {
      current = undefined;
    }
  }

  for (const level of chain) {
    mixed = mixed || level.mixed;
    const content = level.content;
    if (content.kind === 'simpleContent') {
      simpleContentBase = ultimateSimpleBase(content.base, ctx, new Set());
    } else if (content.kind === 'particle') {
      particles.push(content.particle);
    } else if (content.kind === 'complexContent' && content.particle !== undefined) {
      particles.push(content.particle);
    }
    collectAttributes(content.attributes, ctx, acc, new Set());
  }

  // Attributes (and, for complexContent, mixed/anyAttribute) of levels *above*
  // a restriction cut-off are still inherited: a restriction restates the
  // content model but not necessarily every attribute/mixed/anyAttribute.
  const restrictionRoot = chain[0];
  if (
    restrictionRoot !== undefined &&
    (restrictionRoot.content.kind === 'complexContent' || restrictionRoot.content.kind === 'simpleContent') &&
    restrictionRoot.content.derivation === 'restriction'
  ) {
    const rootContent = restrictionRoot.content;
    const inheritedType = ctx.lookupType(rootContent.base);
    if (inheritedType !== undefined && inheritedType.kind === 'complexType') {
      const inherited = resolveContent(inheritedType, ctx);
      for (const attribute of inherited.attributes) {
        const key = qnameToString(attribute.name);
        if (!acc.prohibited.has(key) && !acc.byName.has(key)) {
          acc.byName.set(key, attribute);
        }
      }
      if (rootContent.kind === 'complexContent') {
        // The derived type inherits `mixed` from the base unless it declares
        // its own (XSD 1.0: `mixed` is not required to be restated).
        if (!restrictionRoot.mixed) {
          mixed = mixed || inherited.mixed;
        }
        // A restriction may narrow or drop `anyAttribute`; only fall back to
        // the base's when the restriction itself declares none.
        if (acc.anyAttribute === undefined && inherited.anyAttribute !== undefined) {
          acc.anyAttribute = inherited.anyAttribute;
        }
      }
    }
  }

  const expanded = particles.map((p) => expandGroups(p, ctx, new Set())).filter((p): p is Particle => p !== undefined);
  const particle = mergeParticles(expanded);

  return {
    ...(particle !== undefined ? { particle } : {}),
    attributes: [...acc.byName.values()],
    mixed,
    ...(simpleContentBase !== undefined ? { simpleContentBase } : {}),
    ...(acc.anyAttribute !== undefined ? { anyAttribute: acc.anyAttribute } : {}),
  };
}
