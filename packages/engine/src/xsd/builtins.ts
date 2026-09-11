import { NS } from '../xml/namespaces.js';
import type { QName } from '../wsdl/qname.js';
import { qnameToString } from '../wsdl/qname.js';

/** A built-in XSD (or SOAP-encoding) type known to the engine without a schema declaration. */
export interface BuiltinType {
  readonly name: QName;
  /** The type this one derives from, for the derived built-ins. */
  readonly base?: QName;
  /** True for the 19 XSD primitive datatypes (plus the two ur-types, which have no base). */
  readonly primitive: boolean;
  /** True for `soapenc:Array`, the only complex built-in. */
  readonly complex?: boolean;
  /** Set on `soapenc:Array` so encoded-array handling can special-case it. */
  readonly soapEncArray?: boolean;
  /** For a `soapenc:*` alias: the XSD type it aliases. */
  readonly aliasOf?: QName;
  /**
   * A type-appropriate example value, used only when a caller explicitly asks
   * for realistic sample data. The default everywhere is {@link BuiltinType.placeholder}.
   */
  readonly sampleValue: string;
  /** The placeholder emitted by default for every built-in. */
  readonly placeholder: '?';
}

/** `[localName, baseLocalName | undefined, sampleValue]` for each XSD 1.0 built-in. */
const XSD_TABLE: readonly (readonly [string, string | undefined, string])[] = [
  // ur-types
  ['anyType', undefined, 'string'],
  ['anySimpleType', undefined, 'string'],
  // primitives
  ['string', undefined, 'string'],
  ['boolean', undefined, 'true'],
  ['decimal', undefined, '1.0'],
  ['float', undefined, '1.0'],
  ['double', undefined, '1.0'],
  ['duration', undefined, 'P1D'],
  ['dateTime', undefined, '2000-01-01T00:00:00'],
  ['time', undefined, '00:00:00'],
  ['date', undefined, '2000-01-01'],
  ['gYearMonth', undefined, '2000-01'],
  ['gYear', undefined, '2000'],
  ['gMonthDay', undefined, '--01-01'],
  ['gDay', undefined, '---01'],
  ['gMonth', undefined, '--01'],
  ['hexBinary', undefined, '61'],
  ['base64Binary', undefined, 'YQ=='],
  ['anyURI', undefined, 'http://example.com'],
  ['QName', undefined, 'QName'],
  ['NOTATION', undefined, 'NOTATION'],
  // derived from string
  ['normalizedString', 'string', 'string'],
  ['token', 'normalizedString', 'string'],
  ['language', 'token', 'en'],
  ['NMTOKEN', 'token', 'token'],
  ['NMTOKENS', 'NMTOKEN', 'token'],
  ['Name', 'token', 'name'],
  ['NCName', 'Name', 'name'],
  ['ID', 'NCName', 'id'],
  ['IDREF', 'NCName', 'id'],
  ['IDREFS', 'IDREF', 'id'],
  ['ENTITY', 'NCName', 'entity'],
  ['ENTITIES', 'ENTITY', 'entity'],
  // derived from decimal
  ['integer', 'decimal', '1'],
  ['nonPositiveInteger', 'integer', '-1'],
  ['negativeInteger', 'nonPositiveInteger', '-1'],
  ['long', 'integer', '1'],
  ['int', 'long', '1'],
  ['short', 'int', '1'],
  ['byte', 'short', '1'],
  ['nonNegativeInteger', 'integer', '1'],
  ['unsignedLong', 'nonNegativeInteger', '1'],
  ['unsignedInt', 'unsignedLong', '1'],
  ['unsignedShort', 'unsignedInt', '1'],
  ['unsignedByte', 'unsignedShort', '1'],
  ['positiveInteger', 'nonNegativeInteger', '1'],
];

function buildTable(): Map<string, BuiltinType> {
  const map = new Map<string, BuiltinType>();
  for (const [localName, base, sampleValue] of XSD_TABLE) {
    const name: QName = { namespaceUri: NS.XSD, localName };
    map.set(qnameToString(name), {
      name,
      ...(base !== undefined ? { base: { namespaceUri: NS.XSD, localName: base } } : {}),
      primitive: base === undefined,
      sampleValue,
      placeholder: '?',
    });
  }
  // SOAP 1.1 encoding mirrors the XSD simple types one-for-one; treat each as an
  // alias so `soapenc:int` behaves exactly like `xs:int` for generation purposes.
  for (const [localName, , sampleValue] of XSD_TABLE) {
    const name: QName = { namespaceUri: NS.SOAP11_ENC, localName };
    map.set(qnameToString(name), {
      name,
      aliasOf: { namespaceUri: NS.XSD, localName },
      primitive: false,
      sampleValue,
      placeholder: '?',
    });
  }
  const arrayName: QName = { namespaceUri: NS.SOAP11_ENC, localName: 'Array' };
  map.set(qnameToString(arrayName), {
    name: arrayName,
    primitive: false,
    complex: true,
    soapEncArray: true,
    sampleValue: '',
    placeholder: '?',
  });
  return map;
}

/** Every built-in type, keyed by Clark notation (`{ns}local`). */
export const BUILTIN_TYPES: ReadonlyMap<string, BuiltinType> = buildTable();

/** The local names of every XSD 1.0 built-in type. */
export const XSD_BUILTIN_NAMES: readonly string[] = XSD_TABLE.map(([localName]) => localName);

/**
 * Attributes the SOAP 1.1 encoding namespace defines (`soapenc:arrayType` and
 * friends). References to these never resolve against a user schema, so the
 * schema set treats them as known rather than reporting `unresolved-ref`.
 */
export const SOAP_ENC_ATTRIBUTES: readonly string[] = ['arrayType', 'offset', 'position', 'id', 'href', 'root'];

/** Looks up a built-in type by expanded name, or `undefined` when it is not one. */
export function lookupBuiltin(name: QName): BuiltinType | undefined {
  return BUILTIN_TYPES.get(qnameToString(name));
}

/** True when `name` denotes a built-in XSD (or SOAP-encoding) type. */
export function isBuiltinType(name: QName): boolean {
  return BUILTIN_TYPES.has(qnameToString(name));
}
