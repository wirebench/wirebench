/**
 * The schema-driven form model behind the request editor's Form view.
 *
 * {@link buildForm} projects one element declaration — optionally overlaid with
 * the XML that currently stands for it — onto a tree of {@link FormNode}s the
 * renderer can lay out as labelled fields, repeat groups and choice branches.
 * {@link applyForm} serialises such a tree back to an XML fragment, so a
 * structural change (add a repetition, select a choice branch, materialise an
 * omitted optional element) is "rebuild the tree, mutate it, re-render it".
 *
 * Two invariants make that safe to run against a user's hand-edited envelope:
 *
 * 1. **Nothing in the source is dropped.** Source children a particle never
 *    claims become `any` nodes carrying the verbatim text; source attributes
 *    with no schema counterpart (including `xmlns:*` and `xsi:type`) are kept
 *    as `extraAttributes` and re-emitted first.
 * 2. **Recursion is only cut where the source is silent.** A recursive type is
 *    expanded past `maxDepth` whenever the XML actually goes that deep.
 *
 * Everything here is pure, synchronous and JSON-serialisable: the tree crosses
 * the IPC boundary to the renderer as-is.
 */

import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';
import { NS } from '../xml/namespaces.js';
import type { ComplexType, ElementDecl, Occurs, Particle, ResolvedAttribute, SimpleType } from './model.js';
import type { SchemaSet } from './schema-set.js';
import { firstConcreteDerived, resolveType } from './sample-types.js';
import type { SimpleTypeRef } from './sample-values.js';
import { builtinBaseOf, facetsOf, sampleValueFor } from './sample-values.js';
import type { ScannedAttribute, ScannedElement, TextRange } from './xml-scan.js';
import { scanXml } from './xml-scan.js';
import type { XmlNode } from './xml-writer.js';
import { PrefixTable, comment, element as xmlElement, escapeAttribute, escapeText } from './xml-writer.js';

export type { TextRange } from './xml-scan.js';

/** How a leaf's value should be edited. `other` means "no useful editor; plain text". */
export type FormValueBase =
  'string' | 'number' | 'integer' | 'boolean' | 'date' | 'time' | 'dateTime' | 'binary' | 'other';

/** What the renderer needs to choose an editor and show validation hints for a leaf. */
export interface FormType {
  /** Clark notation for a named type, `xs:int` for a built-in, `''` for an anonymous one. */
  readonly name: string;
  readonly base: FormValueBase;
  readonly enum?: readonly string[];
  readonly pattern?: string;
  /** Lexical bound from the type's facets, shown as a hint — never enforced here (Task 42 validates). */
  readonly min?: string;
  readonly max?: string;
}

/** A literal attribute kept verbatim from the source because no schema attribute claims it. */
export interface FormExtraAttribute {
  readonly name: string;
  readonly value: string;
}

/** The repeat bookkeeping on a `repeat` node. */
export interface FormRepeat {
  /** One node per occurrence present in (or generated for) the document, in order. */
  readonly instances: readonly FormNode[];
  /** A not-present node used as the shape of the next occurrence "+ Add" creates. */
  readonly template: FormNode;
  readonly canAdd: boolean;
  readonly canRemove: boolean;
}

/**
 * One node of the form tree.
 *
 * `kind` decides which fields matter:
 * - `field` — an editable leaf (`type`, `value`, `valueRange`); its `children` are its attributes.
 * - `group` — a complex element; `children` are attributes then child particles.
 * - `choice` — `children` are the alternatives; `choice.selected` names the live one.
 * - `repeat` — occurrences live in `repeat.instances`, **not** in `children` (always empty).
 * - `attribute` — an attribute of the enclosing element.
 * - `any` — a wildcard, or source content the schema does not describe; `raw` holds it verbatim.
 */
export interface FormNode {
  /** Stable path id, e.g. `r/2#1/0`. Survives a rebuild of the same document. */
  readonly id: string;
  readonly kind: 'field' | 'group' | 'choice' | 'repeat' | 'attribute' | 'any';
  readonly name: QName;
  /** The lexical name to write: taken from the source when it exists, else prefixed from scope. */
  readonly label: string;
  readonly required: boolean;
  readonly occurs: Occurs;
  readonly type?: FormType;
  /** Current text for a `field`/`attribute`. The `?` placeholder counts as empty to the UI. */
  readonly value?: string;
  /** Range of `value` in the source document; absent when the node is not present as editable text. */
  readonly valueRange?: TextRange;
  /** Whether this node exists in the document right now. */
  readonly present: boolean;
  readonly nillable?: boolean;
  readonly documentation?: string;
  /** A schema-fixed value: the field is not editable. */
  readonly fixed?: string;
  /** The `xsi:type` standing on this element, shown as a read-only badge. */
  readonly xsiType?: string;
  /** Prefix → URI to declare on this element. Set on the root, and on nodes that need a new prefix. */
  readonly namespaces?: Readonly<Record<string, string>>;
  /** Source attributes no schema attribute claimed (`xmlns:*`, `xsi:type`, wildcards). */
  readonly extraAttributes?: readonly FormExtraAttribute[];
  /** Comments standing immediately before this node in the source. */
  readonly comments?: readonly string[];
  /** Comments standing after this node's last child in the source. */
  readonly trailingComments?: readonly string[];
  /** Set when the schema recursed past `maxDepth` and expansion stopped; edit such content in XML. */
  readonly truncated?: boolean;
  /** Verbatim source text for an `any` node, re-emitted unchanged. */
  readonly raw?: string;
  readonly children: readonly FormNode[];
  readonly choice?: { readonly selected?: number };
  readonly repeat?: FormRepeat;
}

/** Knobs {@link buildForm} accepts. */
export interface BuildFormOptions {
  /** Nesting depth after which a *not-present* complex element stops expanding. Default 5. */
  readonly maxDepth?: number;
  /** Fill new leaves with type-appropriate examples instead of `?`. Default false. */
  readonly sampleValues?: boolean;
  /** Prefix already in scope per namespace URI, e.g. from the enclosing envelope. */
  readonly prefixes?: Readonly<Record<string, string>>;
  /**
   * Added to every reported `valueRange`, so a fragment sliced out of a larger
   * document still reports ranges in that document's coordinates.
   */
  readonly offset?: number;
  /**
   * Namespace URI per prefix inherited from an enclosing document. A body
   * fragment sliced out of an envelope declares none of its own, so without
   * this its elements would all resolve into the empty namespace.
   */
  readonly inScope?: Readonly<Record<string, string>>;
}

const ONCE: Occurs = { min: 1, max: 1 };

const INTEGER_LOCALS = new Set([
  'integer',
  'nonPositiveInteger',
  'negativeInteger',
  'long',
  'int',
  'short',
  'byte',
  'nonNegativeInteger',
  'unsignedLong',
  'unsignedInt',
  'unsignedShort',
  'unsignedByte',
  'positiveInteger',
]);
const NUMBER_LOCALS = new Set(['decimal', 'float', 'double']);
const BINARY_LOCALS = new Set(['base64Binary', 'hexBinary']);

function baseFor(set: SchemaSet, ref: SimpleTypeRef): FormValueBase {
  const builtin = builtinBaseOf(set, ref);
  if (builtin === undefined || builtin.name.namespaceUri !== NS.XSD) {
    return 'other';
  }
  const local = builtin.name.localName;
  if (INTEGER_LOCALS.has(local)) return 'integer';
  if (NUMBER_LOCALS.has(local)) return 'number';
  if (BINARY_LOCALS.has(local)) return 'binary';
  if (local === 'boolean') return 'boolean';
  if (local === 'date' || local === 'time' || local === 'dateTime') return local;
  return 'string';
}

/** Renders a type reference the way the Outline's Type column does: Clark, or `xs:int` for built-ins. */
function typeNameOf(set: SchemaSet, ref: QName | SimpleType | ComplexType | undefined): string {
  if (ref === undefined) {
    return '';
  }
  if ('kind' in ref) {
    return ref.name !== undefined ? qnameToString(ref.name) : '';
  }
  return set.builtin(ref) !== undefined ? `xs:${ref.localName}` : qnameToString(ref);
}

function formTypeOf(set: SchemaSet, ref: SimpleTypeRef): FormType {
  const facets = facetsOf(set, ref);
  return {
    name: typeNameOf(set, ref),
    base: baseFor(set, ref),
    ...(facets.enum !== undefined ? { enum: facets.enum } : {}),
    ...(facets.pattern !== undefined ? { pattern: facets.pattern } : {}),
    ...(facets.min !== undefined ? { min: facets.min } : {}),
    ...(facets.max !== undefined ? { max: facets.max } : {}),
  };
}

/** Namespace prefixes in scope, plus a table that invents one when a new URI turns up. */
class NameScope {
  private readonly byUri = new Map<string, string>();
  private readonly fresh: PrefixTable;
  /** Prefix → URI this build had to invent; declared on the form root. */
  readonly invented: Record<string, string> = {};

  constructor(prefixes: Readonly<Record<string, string>>) {
    for (const [uri, prefix] of Object.entries(prefixes)) {
      this.byUri.set(uri, prefix);
    }
    this.fresh = new PrefixTable({});
  }

  /** Records the prefixes an element declares, so its subtree can reuse them. */
  declare(declarations: Readonly<Record<string, string>>): void {
    for (const [prefix, uri] of Object.entries(declarations)) {
      if (!this.byUri.has(uri)) {
        this.byUri.set(uri, prefix);
      }
    }
  }

  /** The lexical name to write for `name`, allocating and recording a prefix when needed. */
  qualify(name: QName): string {
    if (name.namespaceUri === '') {
      return name.localName;
    }
    const existing = this.byUri.get(name.namespaceUri);
    if (existing !== undefined) {
      return existing === '' ? name.localName : `${existing}:${name.localName}`;
    }
    const prefix = this.fresh.prefixFor(name.namespaceUri);
    this.byUri.set(name.namespaceUri, prefix);
    this.invented[prefix] = name.namespaceUri;
    return `${prefix}:${name.localName}`;
  }
}

interface Ctx {
  readonly set: SchemaSet;
  readonly maxDepth: number;
  readonly sampleValues: boolean;
  readonly scope: NameScope;
  readonly problems: string[];
  /** The whole source document, for slicing `any` nodes verbatim. */
  readonly source: string;
  /**
   * True when a document was supplied. With one, "present" means "written in
   * the XML"; without one, a fresh form starts with every required node live so
   * it serialises to the same shape the sample generator would produce.
   */
  readonly hasDocument: boolean;
  /** Added to every reported range so they address the enclosing document, not the fragment. */
  readonly offset: number;
}

/** Moves a fragment-relative range into the enclosing document's coordinates. */
function absolute(ctx: Ctx, range: TextRange): TextRange {
  return ctx.offset === 0 ? range : { start: range.start + ctx.offset, end: range.end + ctx.offset };
}

/** The unconsumed source children of one element, claimed by name as particles are walked. */
class Pool {
  private readonly used: boolean[];

  constructor(readonly children: readonly ScannedElement[]) {
    this.used = children.map(() => false);
  }

  /** Claims the next unused child whose expanded name is in `names`. */
  take(names: readonly QName[]): ScannedElement | undefined {
    for (let i = 0; i < this.children.length; i += 1) {
      const child = this.children[i] as ScannedElement;
      if (this.used[i] === true) {
        continue;
      }
      if (names.some((n) => n.localName === child.localName && n.namespaceUri === child.namespaceUri)) {
        this.used[i] = true;
        return child;
      }
    }
    return undefined;
  }

  /** True when any unused child matches one of `names` — used to size a repeating compositor. */
  has(names: readonly QName[]): boolean {
    return this.children.some(
      (child, i) =>
        this.used[i] !== true &&
        names.some((n) => n.localName === child.localName && n.namespaceUri === child.namespaceUri),
    );
  }

  /** Every child no particle claimed, in source order. */
  leftovers(): readonly ScannedElement[] {
    return this.children.filter((_, i) => this.used[i] !== true);
  }
}

/** The declaration a particle points at, plus every name that may stand in for it. */
interface ParticleTarget {
  readonly decl: ElementDecl;
  readonly names: readonly QName[];
}

function targetOf(ctx: Ctx, particle: Particle): ParticleTarget | undefined {
  if (particle.kind === 'localElement') {
    return { decl: particle.decl, names: [particle.decl.name] };
  }
  if (particle.kind !== 'elementRef') {
    return undefined;
  }
  const decl = ctx.set.lookupElement(particle.ref);
  if (decl === undefined) {
    return undefined;
  }
  const substitutions = ctx.set.substitutionsFor(particle.ref);
  return { decl, names: [decl.name, ...substitutions.map((s) => s.name)] };
}

/** The concrete declaration to build: an abstract head is replaced by a substitution member. */
function effectiveDecl(ctx: Ctx, decl: ElementDecl, source: ScannedElement | undefined): ElementDecl {
  if (source !== undefined) {
    const match = ctx.set
      .substitutionsFor(decl.name)
      .find((c) => c.name.localName === source.localName && c.name.namespaceUri === source.namespaceUri);
    if (match !== undefined) {
      return match;
    }
  }
  if (!decl.abstract) {
    return decl;
  }
  return ctx.set.substitutionsFor(decl.name).find((c) => !c.abstract) ?? decl;
}

/** Splits a source element's attributes into the schema ones (by lexical name) and the rest. */
function splitAttributes(
  ctx: Ctx,
  source: ScannedElement | undefined,
  declared: readonly ResolvedAttribute[],
): { matched: Map<string, ScannedAttribute>; extras: FormExtraAttribute[] } {
  const matched = new Map<string, ScannedAttribute>();
  const extras: FormExtraAttribute[] = [];
  if (source === undefined) {
    return { matched, extras };
  }
  for (const attr of source.attributes) {
    const local = attr.name.includes(':') ? attr.name.slice(attr.name.indexOf(':') + 1) : attr.name;
    // SOAP-encoding bookkeeping (`soapenc:arrayType`) is never an editable form
    // field, so it stays an extra and is re-emitted exactly as written.
    const decl = declared.find((d) => d.name.localName === local && d.name.namespaceUri !== NS.SOAP11_ENC);
    if (decl !== undefined && !attr.name.startsWith('xmlns')) {
      matched.set(qnameToString(decl.name), attr);
    } else {
      extras.push({ name: attr.name, value: attr.value });
    }
  }
  return { matched, extras };
}

function attributeNode(
  ctx: Ctx,
  attribute: ResolvedAttribute,
  source: ScannedAttribute | undefined,
  id: string,
): FormNode {
  const ref = attribute.type ?? attribute.anonymousType;
  const forced = attribute.fixed ?? attribute.default;
  return {
    id,
    kind: 'attribute',
    name: attribute.name,
    label: source?.name ?? ctx.scope.qualify(attribute.name),
    required: attribute.use === 'required',
    occurs: attribute.use === 'required' ? ONCE : { min: 0, max: 1 },
    type: formTypeOf(ctx.set, ref),
    value: source?.value ?? forced ?? sampleValueFor(ctx.set, ref, { sampleValues: ctx.sampleValues }),
    ...(source !== undefined ? { valueRange: absolute(ctx, source.valueRange) } : {}),
    present: source !== undefined || (!ctx.hasDocument && attribute.use === 'required'),
    ...(attribute.fixed !== undefined ? { fixed: attribute.fixed } : {}),
    children: [],
  };
}

/** Wraps a source element that no schema particle describes, keeping its text verbatim. */
function rawNode(ctx: Ctx, source: ScannedElement, id: string): FormNode {
  return {
    id,
    kind: 'any',
    name: { namespaceUri: source.namespaceUri, localName: source.localName },
    label: source.name,
    required: false,
    occurs: { min: 0, max: 'unbounded' },
    present: true,
    raw: ctx.source.slice(source.range.start, source.range.end),
    ...(source.leadingComments.length > 0 ? { comments: source.leadingComments } : {}),
    children: [],
  };
}

/** Builds one element node: its attributes, then either simple content or its child particles. */
function buildElementNode(
  ctx: Ctx,
  decl: ElementDecl,
  occurs: Occurs,
  source: ScannedElement | undefined,
  id: string,
  depth: number,
): FormNode {
  const effective = effectiveDecl(ctx, decl, source);
  if (source !== undefined) {
    ctx.scope.declare(source.declaredNamespaces);
  }
  const label = source?.name ?? ctx.scope.qualify(effective.name);
  const resolved = resolveType(ctx.set, effective.type ?? effective.anonymousType);
  const common = {
    id,
    name: effective.name,
    label,
    required: occurs.min > 0,
    occurs,
    present: source !== undefined || (!ctx.hasDocument && occurs.min > 0),
    ...(effective.nillable ? { nillable: true } : {}),
    ...(effective.documentation !== undefined ? { documentation: effective.documentation } : {}),
    ...(source !== undefined && source.leadingComments.length > 0 ? { comments: source.leadingComments } : {}),
    ...(source !== undefined && source.trailingComments.length > 0
      ? { trailingComments: source.trailingComments }
      : {}),
  } as const;
  const forced = effective.fixed ?? effective.default;

  if (resolved.kind !== 'complex') {
    const ref = resolved.kind === 'simple' ? resolved.ref : undefined;
    // A simple-typed element declares no attributes of its own, so everything
    // the source wrote on it (`xmlns:*`, `xsi:nil`, …) is kept verbatim.
    const extras = (source?.attributes ?? []).map((a) => ({ name: a.name, value: a.value }));
    return {
      ...common,
      ...(extras.length > 0 ? { extraAttributes: extras } : {}),
      kind: 'field',
      type: formTypeOf(ctx.set, ref),
      value: source?.text?.value ?? forced ?? sampleValueFor(ctx.set, ref, { sampleValues: ctx.sampleValues }),
      ...(source?.text !== undefined && !source.selfClosing ? { valueRange: absolute(ctx, source.text.range) } : {}),
      ...(effective.fixed !== undefined ? { fixed: effective.fixed } : {}),
      children: [],
    };
  }
  return buildComplexNode(ctx, common, resolved.type, source, depth, forced);
}

/** Shared shape every element node starts from, before its content decides its `kind`. */
type CommonFields = Omit<FormNode, 'kind' | 'children'>;

function buildComplexNode(
  ctx: Ctx,
  common: CommonFields,
  complexType: ComplexType,
  source: ScannedElement | undefined,
  depth: number,
  forced: string | undefined,
): FormNode {
  let effective = complexType;
  const invented: FormExtraAttribute[] = [];
  if (complexType.abstract) {
    const concrete = firstConcreteDerived(ctx.set, complexType);
    if (concrete?.name !== undefined) {
      effective = concrete;
      if (source === undefined) {
        ctx.scope.declare({ xsi: NS.XSI });
        invented.push({ name: 'xsi:type', value: ctx.scope.qualify(concrete.name) });
      }
    }
  }
  const content = ctx.set.resolveContent(effective);
  const { matched, extras } = splitAttributes(ctx, source, content.attributes);
  const attributeNodes = content.attributes
    .filter((a) => a.name.namespaceUri !== NS.SOAP11_ENC)
    .map((a, index) => attributeNode(ctx, a, matched.get(qnameToString(a.name)), `${common.id}/@${index}`))
    .filter((node) => node.present || node.required || source === undefined);
  const allExtras = [...extras, ...invented];
  const xsiType = allExtras.find((a) => a.name.endsWith(':type'))?.value;
  const base = {
    ...common,
    ...(allExtras.length > 0 ? { extraAttributes: allExtras } : {}),
    ...(xsiType !== undefined ? { xsiType } : {}),
  };

  if (content.simpleContentBase !== undefined) {
    const ref = content.simpleContentBase;
    return {
      ...base,
      kind: 'field',
      type: formTypeOf(ctx.set, ref),
      value: source?.text?.value ?? forced ?? sampleValueFor(ctx.set, ref, { sampleValues: ctx.sampleValues }),
      ...(source?.text !== undefined && !source.selfClosing ? { valueRange: absolute(ctx, source.text.range) } : {}),
      children: attributeNodes,
    };
  }

  // Only a *silent* source may be cut off: expanding what the document already
  // says can never diverge, while expanding what it does not say can recurse
  // forever (see the `Node`/`child` fixture).
  if (source === undefined && depth > ctx.maxDepth) {
    return { ...base, kind: 'group', truncated: true, children: attributeNodes };
  }

  const pool = new Pool(source?.children ?? []);
  const children: FormNode[] = [...attributeNodes];
  if (content.particle !== undefined) {
    buildParticle(ctx, content.particle, pool, base.id, children, depth + 1, source !== undefined);
  }
  for (const [index, leftover] of pool.leftovers().entries()) {
    children.push(rawNode(ctx, leftover, `${base.id}/~${index}`));
  }
  return { ...base, kind: 'group', children };
}

/** True when a particle may appear more than once. */
function repeatable(occurs: Occurs): boolean {
  return occurs.max === 'unbounded' || occurs.max > 1;
}

/** Every element name a particle subtree can contribute, used to size a repeating compositor. */
function namesUnder(ctx: Ctx, particle: Particle, out: QName[]): void {
  const target = targetOf(ctx, particle);
  if (target !== undefined) {
    out.push(...target.names);
    return;
  }
  if (particle.kind === 'sequence' || particle.kind === 'choice' || particle.kind === 'all') {
    for (const child of particle.particles) {
      namesUnder(ctx, child, out);
    }
  }
}

function buildRepeat(
  particle: Particle,
  id: string,
  hasSource: boolean,
  makeInstance: (instanceId: string) => FormNode | undefined,
  makeTemplate: (templateId: string) => FormNode,
): FormNode {
  const template = makeTemplate(`${id}#t`);
  const instances: FormNode[] = [];
  const limit = particle.occurs.max === 'unbounded' ? Number.POSITIVE_INFINITY : particle.occurs.max;
  while (instances.length < limit) {
    const next = makeInstance(`${id}#${instances.length}`);
    if (next === undefined) {
      break;
    }
    instances.push(next);
  }
  // With no document to read, a required repetition still needs one editable
  // occurrence on screen — the sample generator emits one too.
  if (!hasSource && instances.length === 0 && particle.occurs.min > 0) {
    instances.push(reidTemplate(template, `${id}#0`, true));
  }
  return {
    id,
    kind: 'repeat',
    name: template.name,
    label: template.label,
    required: particle.occurs.min > 0,
    occurs: particle.occurs,
    present: instances.length > 0,
    children: [],
    repeat: {
      instances,
      template,
      canAdd: instances.length < limit,
      canRemove: instances.length > particle.occurs.min,
    },
  };
}

/** Copies a template subtree under a new id, optionally marking the copy present. */
function reidTemplate(node: FormNode, id: string, present: boolean): FormNode {
  return {
    ...node,
    id,
    ...(present ? { present: true } : {}),
    children: node.children.map((child, i) => reidTemplate(child, `${id}/${i}`, present && child.required)),
  };
}

/** Emits the nodes one particle contributes to `out`, claiming source children as it goes. */
function buildParticle(
  ctx: Ctx,
  particle: Particle,
  pool: Pool,
  parentId: string,
  out: FormNode[],
  depth: number,
  hasSource: boolean,
): void {
  const id = `${parentId}/${out.length}`;
  const target = targetOf(ctx, particle);
  if (target !== undefined) {
    if (!repeatable(particle.occurs)) {
      const source = pool.take(target.names);
      // A not-present optional element is still modelled, so the Full view can
      // offer to add it; the renderer ghosts it until then.
      out.push(buildElementNode(ctx, target.decl, particle.occurs, source, id, depth));
      return;
    }
    out.push(
      buildRepeat(
        particle,
        id,
        hasSource,
        (instanceId) => {
          const source = pool.take(target.names);
          return source === undefined ? undefined : buildElementNode(ctx, target.decl, ONCE, source, instanceId, depth);
        },
        (templateId) => buildElementNode(ctx, target.decl, ONCE, undefined, templateId, depth),
      ),
    );
    return;
  }

  if (particle.kind === 'any') {
    out.push({
      id,
      kind: 'any',
      name: { namespaceUri: '', localName: 'any' },
      label: 'any',
      required: particle.occurs.min > 0,
      occurs: particle.occurs,
      present: false,
      children: [],
    });
    return;
  }

  if (particle.kind === 'groupRef') {
    // `resolveContent` expands group references; a stray one is skipped rather than guessed at.
    ctx.problems.push(`Unexpanded group reference ${qnameToString(particle.ref)}`);
    return;
  }

  if (particle.kind === 'choice') {
    out.push(buildChoice(ctx, particle, pool, id, depth, hasSource));
    return;
  }

  if (particle.kind !== 'sequence' && particle.kind !== 'all') {
    return;
  }

  // sequence / all
  if (!repeatable(particle.occurs)) {
    for (const child of particle.particles) {
      buildParticle(ctx, child, pool, parentId, out, depth, hasSource);
    }
    return;
  }
  const names: QName[] = [];
  namesUnder(ctx, particle, names);
  out.push(
    buildRepeat(
      particle,
      id,
      hasSource,
      (instanceId) => {
        if (!pool.has(names)) {
          return undefined;
        }
        const inner: FormNode[] = [];
        for (const child of particle.particles) {
          buildParticle(ctx, child, pool, instanceId, inner, depth, hasSource);
        }
        return groupWrapper(instanceId, particle.kind, inner, true);
      },
      (templateId) => {
        const inner: FormNode[] = [];
        const emptyPool = new Pool([]);
        for (const child of particle.particles) {
          buildParticle(ctx, child, emptyPool, templateId, inner, depth, false);
        }
        return groupWrapper(templateId, particle.kind, inner, false);
      },
    ),
  );
}

/** A synthetic, nameless group standing for one occurrence of a repeating compositor. */
function groupWrapper(id: string, kind: string, children: readonly FormNode[], present: boolean): FormNode {
  return {
    id,
    kind: 'group',
    name: { namespaceUri: '', localName: kind },
    label: '',
    required: false,
    occurs: ONCE,
    present,
    children,
  };
}

function buildChoice(
  ctx: Ctx,
  particle: Particle & { readonly particles: readonly Particle[] },
  pool: Pool,
  id: string,
  depth: number,
  hasSource: boolean,
): FormNode {
  const branches: FormNode[] = [];
  for (const [index, alternative] of particle.particles.entries()) {
    const collected: FormNode[] = [];
    buildParticle(ctx, alternative, pool, `${id}!${index}`, collected, depth, hasSource);
    const only = collected.length === 1 ? collected[0] : undefined;
    branches.push(only ?? groupWrapper(`${id}!${index}`, 'branch', collected, collected.some(isPresent)));
  }
  const selected = branches.findIndex(isPresent);
  return {
    id,
    kind: 'choice',
    name: { namespaceUri: '', localName: 'choice' },
    label: 'choice',
    required: particle.occurs.min > 0,
    occurs: particle.occurs,
    present: selected !== -1,
    children: branches,
    choice: selected === -1 ? {} : { selected },
  };
}

/** True when a node, or anything under it, exists in the document. */
function isPresent(node: FormNode): boolean {
  if (node.kind === 'attribute') {
    return node.valueRange !== undefined;
  }
  if (node.present) {
    return true;
  }
  return [...node.children, ...(node.repeat?.instances ?? [])].some(isPresent);
}

/**
 * Builds the form tree for one global element declaration.
 *
 * @param schemaSet the compiled schemas the element is declared in
 * @param element the global element to model
 * @param xml the fragment that currently stands for it, or `undefined` for a fresh form
 * @param options depth cut-off, sample values, and prefixes already in scope
 * @returns the root node; never throws — an unknown element yields an `any` node instead
 */
export function buildForm(schemaSet: SchemaSet, element: QName, xml?: string, options?: BuildFormOptions): FormNode {
  const scanned = xml !== undefined ? scanXml(xml, options?.inScope ?? {}) : undefined;
  const source = scanned?.elements[0];
  const ctx: Ctx = {
    set: schemaSet,
    maxDepth: options?.maxDepth ?? 5,
    sampleValues: options?.sampleValues ?? false,
    scope: new NameScope(options?.prefixes ?? {}),
    problems: [...(scanned?.problems ?? [])],
    source: xml ?? '',
    hasDocument: xml !== undefined,
    offset: options?.offset ?? 0,
  };
  const decl = schemaSet.lookupElement(element);
  if (decl === undefined) {
    return source !== undefined
      ? rawNode(ctx, source, 'r')
      : {
          id: 'r',
          kind: 'any',
          name: element,
          label: ctx.scope.qualify(element),
          required: true,
          occurs: ONCE,
          present: false,
          children: [],
        };
  }
  const root = buildElementNode(ctx, decl, ONCE, source, 'r', 0);
  const invented = ctx.scope.invented;
  return Object.keys(invented).length > 0 ? { ...root, namespaces: invented } : root;
}

/**
 * Builds the form tree for an element whose content is described by a *type*
 * rather than a global element declaration — the shape an rpc-style message
 * part takes.
 */
export function buildFormForType(
  schemaSet: SchemaSet,
  elementName: QName,
  type: QName,
  xml?: string,
  options?: BuildFormOptions,
): FormNode {
  const decl: ElementDecl = {
    kind: 'element',
    name: elementName,
    type,
    nillable: false,
    abstract: false,
    source: { location: '<synthetic>' },
  };
  const scanned = xml !== undefined ? scanXml(xml, options?.inScope ?? {}) : undefined;
  const ctx: Ctx = {
    set: schemaSet,
    maxDepth: options?.maxDepth ?? 5,
    sampleValues: options?.sampleValues ?? false,
    scope: new NameScope(options?.prefixes ?? {}),
    problems: [...(scanned?.problems ?? [])],
    source: xml ?? '',
    hasDocument: xml !== undefined,
    offset: options?.offset ?? 0,
  };
  const root = buildElementNode(ctx, decl, ONCE, scanned?.elements[0], 'r', 0);
  const invented = ctx.scope.invented;
  return Object.keys(invented).length > 0 ? { ...root, namespaces: invented } : root;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** Knobs {@link applyForm} accepts. */
export interface ApplyFormOptions {
  /** Indent per level; three spaces by default, matching the sample generator. */
  readonly indent?: string;
}

function attributesOf(node: FormNode): { name: string; value: string }[] {
  const out = Object.entries(node.namespaces ?? {}).map(([prefix, uri]) => ({
    name: `xmlns:${prefix}`,
    value: uri,
  }));
  for (const extra of node.extraAttributes ?? []) {
    out.push({ name: extra.name, value: extra.value });
  }
  for (const child of node.children) {
    if (child.kind === 'attribute' && child.present) {
      out.push({ name: child.label, value: child.value ?? '' });
    }
  }
  return out;
}

/** Verbatim source text, spliced back in unchanged; the writer's node types have no equivalent. */
interface RawNode {
  readonly kind: 'raw';
  readonly text: string;
}

/** What {@link emit} produces: writer nodes plus the verbatim passthrough. */
type EmitNode = XmlNode | RawNode;

/** Emits the XML nodes one form node contributes, leading comments included. */
function emit(node: FormNode, out: EmitNode[]): void {
  for (const text of node.comments ?? []) {
    out.push(comment(text));
  }
  switch (node.kind) {
    case 'attribute':
      return;
    case 'repeat':
      for (const instance of node.repeat?.instances ?? []) {
        emit(instance, out);
      }
      return;
    case 'choice': {
      // A sample fragment shows every alternative and lets the user delete the
      // ones they do not want, so emit each branch that is actually present —
      // selecting a branch is what removes the others (see `select-choice`).
      const live = node.children.filter(isPresent);
      for (const branch of live.length > 0 ? live : []) {
        emit(branch, out);
      }
      return;
    }
    case 'any':
      if (node.raw !== undefined) {
        out.push({ kind: 'raw', text: node.raw });
      }
      return;
    default:
      break;
  }
  if (!node.present) {
    return;
  }
  // A synthetic wrapper (a repeating compositor's occurrence, a choice branch
  // holding several particles) has no tag of its own: splice its children out.
  if (node.label === '') {
    for (const child of node.children) {
      emit(child, out);
    }
    for (const text of node.trailingComments ?? []) {
      out.push(comment(text));
    }
    return;
  }
  const element = xmlElement(node.label);
  element.attributes = attributesOf(node);
  if (node.kind === 'field') {
    element.text = node.value ?? '';
  }
  for (const child of node.children) {
    emit(child, element.children);
  }
  for (const text of node.trailingComments ?? []) {
    element.children.push(comment(text));
  }
  out.push(element);
}

/** Renders emitted nodes with a fixed indent; `raw` text is re-indented but never reformatted. */
function render(nodes: readonly EmitNode[], indent: string, depth: number, out: string[]): void {
  const pad = indent.repeat(depth);
  for (const node of nodes) {
    if (node.kind === 'raw') {
      for (const line of node.text.split('\n')) {
        out.push(`${pad}${line.trim()}`);
      }
      continue;
    }
    if (node.kind === 'comment') {
      out.push(`${pad}<!--${node.text.replace(/--/g, '- -')}-->`);
      continue;
    }
    const attrs = node.attributes.map((a) => ` ${a.name}="${escapeAttribute(a.value)}"`).join('');
    const open = `<${node.name}${attrs}`;
    if (node.children.length === 0 && node.text === undefined) {
      out.push(`${pad}${open}/>`);
      continue;
    }
    if (node.children.length === 0) {
      out.push(`${pad}${open}>${escapeText(node.text ?? '')}</${node.name}>`);
      continue;
    }
    out.push(`${pad}${open}>`);
    render(node.children, indent, depth + 1, out);
    out.push(`${pad}</${node.name}>`);
  }
}

/**
 * Serialises a form tree back to an XML fragment: the exact text that should
 * replace the element the tree was built from. Comments captured from the
 * source are re-emitted in place, and `any` nodes pass their source text
 * through verbatim, so nothing the user wrote is lost.
 */
export function applyForm(form: FormNode, options?: ApplyFormOptions): string {
  const nodes: EmitNode[] = [];
  emit(form, nodes);
  const lines: string[] = [];
  render(nodes, options?.indent ?? '   ', 0, lines);
  return lines.join('\n');
}
