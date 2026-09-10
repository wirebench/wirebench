import type { QName } from '../wsdl/qname.js';
import { qnameEquals } from '../wsdl/qname.js';
import type { ComplexType, ElementDecl, Particle, ResolvedAttribute, SourceRef } from './model.js';
import type { SchemaSet } from './schema-set.js';

/** A half-open character range in a text document. */
export interface TextRange {
  readonly start: number;
  readonly end: number;
}

/** What the completion provider needs to offer children of the element the cursor is in. */
export interface CompletionContext {
  /** Ancestor chain of the element that would contain the completed child, outermost first. */
  readonly path: readonly QName[];
  /** The (possibly empty) element name typed so far after `<`, including any prefix. */
  readonly partial: string;
  /** Namespace prefixes in scope at the cursor. */
  readonly prefixes: Readonly<Record<string, string>>;
  /** The range of `partial` in the document, to replace with the accepted completion. */
  readonly replaceRange: TextRange;
}

const OPEN_TAG_RE = /<([^\s/!?>][^\s/>]*)((?:\s+[^<>]*)?)\s*(\/?)>/g;
const ATTR_RE = /([:\w.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XML_PREFIX = 'xml';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

interface Scope {
  readonly qname: QName;
  readonly prefixes: Readonly<Record<string, string>>;
}

/** Extracts `xmlns`/`xmlns:prefix` declarations from a tag's raw attribute text. */
function xmlnsDeclarations(rawAttrs: string): Record<string, string> {
  const decls: Record<string, string> = {};
  const re = new RegExp(ATTR_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(rawAttrs)) !== null) {
    const attrName = m[1] as string;
    const value = m[2] ?? m[3] ?? '';
    if (attrName === 'xmlns') {
      decls[''] = value;
    } else if (attrName.startsWith('xmlns:')) {
      decls[attrName.slice('xmlns:'.length)] = value;
    }
  }
  return decls;
}

function resolvePrefixed(name: string, prefixes: Readonly<Record<string, string>>): QName {
  const colon = name.indexOf(':');
  if (colon === -1) {
    return { namespaceUri: prefixes[''] ?? '', localName: name };
  }
  const prefix = name.slice(0, colon);
  const localName = name.slice(colon + 1);
  if (prefix === XML_PREFIX) {
    return { namespaceUri: XML_NS, localName };
  }
  return { namespaceUri: prefixes[prefix] ?? '', localName };
}

/**
 * Walks open/close tags textually (never a DOM parse) to find the in-scope
 * ancestor stack ending just before `offset`. Tolerant of an unfinished tag
 * at the cursor: a `<…` with no closing `>` yet in the text simply does not
 * match and is ignored.
 */
function scopeStackAt(text: string, offset: number): Scope[] {
  const stack: Scope[] = [];
  const re = new RegExp(OPEN_TAG_RE);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const matchEnd = m.index + m[0].length;
    if (matchEnd > offset) {
      break;
    }
    const raw = m[0];
    if (raw.startsWith('</')) {
      // Tolerant of stray/mismatched close tags: just pop, since the source text
      // up to the cursor is assumed well-formed for the purpose of this walk.
      if (stack.length > 0) {
        stack.pop();
      }
      continue;
    }
    const name = (m[1] as string).replace(/^\//, '');
    const rawAttrs = m[2] ?? '';
    const selfClosing = m[3] === '/';
    const parentPrefixes = stack.length > 0 ? (stack[stack.length - 1] as Scope).prefixes : {};
    const ownDecls = xmlnsDeclarations(rawAttrs);
    const prefixes = Object.keys(ownDecls).length > 0 ? { ...parentPrefixes, ...ownDecls } : parentPrefixes;
    const qname = resolvePrefixed(name, prefixes);
    if (!selfClosing) {
      stack.push({ qname, prefixes });
    }
  }
  return stack;
}

/**
 * Ancestor chain (outermost first) of the element containing `offset`,
 * resolved to expanded QNames via the `xmlns` declarations in scope at that
 * point in the text.
 */
export function elementPathAt(text: string, offset: number): QName[] {
  return scopeStackAt(text, offset).map((s) => s.qname);
}

/**
 * Pure text analysis for the completion provider: detects an in-progress
 * `<partial` element-name token ending at `offset` and reports the ancestor
 * path, in-scope prefixes and the range to replace with the accepted item.
 * Returns `undefined` when the cursor is not positioned right after an open
 * `<` (e.g. mid-attribute, or not inside a tag at all).
 */
export function completionContextAt(text: string, offset: number): CompletionContext | undefined {
  const before = text.slice(0, offset);
  const ltIndex = before.lastIndexOf('<');
  if (ltIndex === -1) {
    return undefined;
  }
  const between = text.slice(ltIndex + 1, offset);
  if (/[\s>/]/.test(between) || between.startsWith('/')) {
    return undefined;
  }
  let end = offset;
  while (end < text.length && /[\w:.-]/.test(text[end] as string)) {
    end += 1;
  }
  const path = elementPathAt(text, ltIndex);
  const scope = scopeStackAt(text, ltIndex);
  const prefixes = scope.length > 0 ? (scope[scope.length - 1] as Scope).prefixes : {};
  return {
    path,
    partial: between,
    prefixes,
    replaceRange: { start: ltIndex + 1, end },
  };
}

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
