import type { QName } from '../wsdl/qname.js';

/**
 * Occurrence constraints of a particle (`minOccurs`/`maxOccurs`). Both default
 * to `1`; `maxOccurs="unbounded"` is modelled as the literal `'unbounded'`.
 */
export interface Occurs {
  readonly min: number;
  readonly max: number | 'unbounded';
}

/** Where a schema component was declared, for diagnostics and "jump to source". */
export interface SourceRef {
  /** Document location, or `'<inline>'` when the caller supplied bare schema elements. */
  readonly location: string;
  readonly line?: number;
  readonly column?: number;
}

/** A wildcard's `processContents` mode. Defaults to `'strict'` in XSD 1.0. */
export type ProcessContents = 'strict' | 'lax' | 'skip';

/** How an attribute may appear on an element. */
export type AttributeUseKind = 'optional' | 'required' | 'prohibited';

/** A constraining facet on a simple type. */
export type Facet =
  | { readonly kind: 'enumeration'; readonly values: readonly string[] }
  | { readonly kind: 'pattern'; readonly value: string }
  | {
      readonly kind: 'length' | 'minLength' | 'maxLength' | 'totalDigits' | 'fractionDigits';
      readonly value: number;
    }
  | {
      // Bounds stay strings: they are lexical values of the base type (which may
      // be a date, duration or arbitrary-precision decimal), not JS numbers.
      readonly kind: 'minInclusive' | 'maxInclusive' | 'minExclusive' | 'maxExclusive';
      readonly value: string;
    }
  | { readonly kind: 'whiteSpace'; readonly value: 'preserve' | 'replace' | 'collapse' };

/** A simple type definition (named or anonymous). */
export interface SimpleType {
  readonly kind: 'simpleType';
  /** Absent for an anonymous type declared inline in an element/attribute/list/union. */
  readonly name?: QName;
  readonly variety: 'atomic' | 'list' | 'union';
  /** The `xs:restriction` base, for atomic varieties. */
  readonly base?: QName;
  /** An inline `xs:simpleType` used as the restriction base instead of `base`. */
  readonly baseType?: SimpleType;
  /** The list item type: a named reference or an inline definition. */
  readonly itemType?: QName | SimpleType;
  /** Union members, in declaration order: `memberTypes` first, then inline definitions. */
  readonly memberTypes?: readonly (QName | SimpleType)[];
  readonly facets: readonly Facet[];
  readonly documentation?: string;
  readonly source: SourceRef;
}

/** A global or local element declaration. */
export interface ElementDecl {
  readonly kind: 'element';
  readonly name: QName;
  /** A reference to a named type; mutually exclusive with {@link ElementDecl.anonymousType}. */
  readonly type?: QName;
  /** An inline `xs:complexType`/`xs:simpleType`. */
  readonly anonymousType?: ComplexType | SimpleType;
  readonly nillable: boolean;
  readonly abstract: boolean;
  readonly substitutionGroup?: QName;
  readonly default?: string;
  readonly fixed?: string;
  readonly documentation?: string;
  readonly source: SourceRef;
}

/** An element declared inline inside a particle. */
export interface LocalElement {
  readonly kind: 'localElement';
  readonly decl: ElementDecl;
  readonly occurs: Occurs;
}

/** An `<xs:element ref="…"/>` particle pointing at a global element declaration. */
export interface ElementRef {
  readonly kind: 'elementRef';
  readonly ref: QName;
  readonly occurs: Occurs;
}

/** An `<xs:any/>` element wildcard. */
export interface AnyParticle {
  readonly kind: 'any';
  /** Raw `namespace` attribute, e.g. `##any`, `##other`, or a space-separated URI list. */
  readonly namespace: string;
  readonly processContents: ProcessContents;
  readonly occurs: Occurs;
}

/** An `<xs:sequence>` compositor. */
export interface Sequence {
  readonly kind: 'sequence';
  readonly particles: readonly Particle[];
  readonly occurs: Occurs;
}

/** An `<xs:choice>` compositor. */
export interface Choice {
  readonly kind: 'choice';
  readonly particles: readonly Particle[];
  readonly occurs: Occurs;
}

/** An `<xs:all>` compositor. */
export interface All {
  readonly kind: 'all';
  readonly particles: readonly Particle[];
  readonly occurs: Occurs;
}

/** An `<xs:group ref="…"/>` particle. */
export interface GroupRef {
  readonly kind: 'groupRef';
  readonly ref: QName;
  readonly occurs: Occurs;
}

/** Any content-model particle. */
export type Particle = LocalElement | ElementRef | AnyParticle | Sequence | Choice | All | GroupRef;

/** A compositor particle (the only thing a named `xs:group` may contain). */
export type Compositor = Sequence | Choice | All;

/** A global or local attribute declaration. */
export interface AttributeDecl {
  readonly kind: 'attribute';
  readonly name: QName;
  readonly type?: QName;
  readonly anonymousType?: SimpleType;
  readonly use: AttributeUseKind;
  readonly default?: string;
  readonly fixed?: string;
  readonly documentation?: string;
  readonly source: SourceRef;
}

/** An `<xs:attribute ref="…"/>` pointing at a global attribute declaration. */
export interface AttributeRef {
  readonly kind: 'attributeRef';
  readonly ref: QName;
  readonly use: AttributeUseKind;
  readonly default?: string;
  readonly fixed?: string;
}

/** An `<xs:attributeGroup ref="…"/>`. */
export interface AttributeGroupRef {
  readonly kind: 'attributeGroupRef';
  readonly ref: QName;
}

/** An `<xs:anyAttribute/>` wildcard. */
export interface AnyAttribute {
  readonly kind: 'anyAttribute';
  readonly namespace: string;
  readonly processContents: ProcessContents;
}

/** Anything that may appear in a complex type's attribute list. */
export type AttributeUse = AttributeDecl | AttributeRef | AttributeGroupRef | AnyAttribute;

/** The content model of a complex type, discriminated by how it was declared. */
export type ComplexContentModel =
  | { readonly kind: 'empty'; readonly attributes: readonly AttributeUse[] }
  /** An implicit complex content: a compositor written directly under `xs:complexType`. */
  | { readonly kind: 'particle'; readonly particle: Particle; readonly attributes: readonly AttributeUse[] }
  | {
      readonly kind: 'complexContent';
      readonly derivation: 'extension' | 'restriction';
      readonly base: QName;
      readonly particle?: Particle;
      readonly attributes: readonly AttributeUse[];
    }
  | {
      readonly kind: 'simpleContent';
      readonly derivation: 'extension' | 'restriction';
      readonly base: QName;
      readonly attributes: readonly AttributeUse[];
      /** Facets on a `simpleContent restriction`. */
      readonly facets?: readonly Facet[];
    };

/** A complex type definition (named or anonymous). */
export interface ComplexType {
  readonly kind: 'complexType';
  /** Absent for an anonymous type declared inline in an element declaration. */
  readonly name?: QName;
  readonly abstract: boolean;
  readonly mixed: boolean;
  readonly content: ComplexContentModel;
  readonly documentation?: string;
  readonly source: SourceRef;
}

/** Either kind of type definition. */
export type TypeDefinition = ComplexType | SimpleType;

/** A named model group (`xs:group`). */
export interface Group {
  readonly kind: 'group';
  readonly name: QName;
  readonly particle: Compositor;
  readonly documentation?: string;
  readonly source: SourceRef;
}

/** A named attribute group (`xs:attributeGroup`). */
export interface AttributeGroup {
  readonly kind: 'attributeGroup';
  readonly name: QName;
  readonly attributes: readonly AttributeUse[];
  readonly documentation?: string;
  readonly source: SourceRef;
}

/** A non-fatal problem found while building a {@link SchemaSet}. */
export interface SchemaProblem {
  readonly code: 'unresolved-ref' | 'duplicate-component' | 'unsupported' | 'invalid-schema';
  readonly message: string;
  readonly location: string;
  readonly line?: number;
  readonly column?: number;
}

/** A single attribute after attribute groups and inheritance have been flattened. */
export interface ResolvedAttribute {
  readonly name: QName;
  readonly type?: QName;
  readonly anonymousType?: SimpleType;
  readonly use: 'optional' | 'required';
  readonly default?: string;
  readonly fixed?: string;
}

/** A complex type's effective content after derivation, groups and attribute groups are flattened. */
export interface ResolvedContent {
  /**
   * The effective particle: extension chains flattened base-first (wrapped in a
   * synthetic `sequence` when needed), `groupRef`s expanded in place, and
   * `all`/`choice` compositors kept as declared. Absent for empty content.
   */
  readonly particle?: Particle;
  /** Attributes from the whole derivation chain, deduped by name; prohibited ones removed. */
  readonly attributes: readonly ResolvedAttribute[];
  readonly mixed: boolean;
  /** For `simpleContent` types: the ultimate simple base of the derivation chain. */
  readonly simpleContentBase?: QName;
  /** The effective attribute wildcard, if any level of the chain declares one. */
  readonly anyAttribute?: { readonly namespace: string; readonly processContents: ProcessContents };
}
