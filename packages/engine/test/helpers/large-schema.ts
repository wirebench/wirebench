/**
 * Deterministic generator for the `crafted/large-schema` performance fixture.
 *
 * The fixture is ~5 MB of XSD, which is far too large to commit, so only this generator and its
 * seed ({@link LARGE_SCHEMA_SEED}) live in the repo. `pnpm fixtures:refresh` writes it into
 * `fixtures/wsdl/crafted/large-schema/` (git-ignored) and the perf suite writes it into a temp
 * directory at run time. Output is byte-identical for a given seed — no clock, no randomness.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Shape knobs for {@link generateLargeSchema}; the defaults produce ~5 MB of XSD. */
export interface LargeSchemaSeed {
  /** Number of generated `xs:complexType` definitions. */
  readonly types: number;
  /** Number of `xs:element` particles inside each generated complex type. */
  readonly fieldsPerType: number;
  /** Number of `xs:simpleType` enumerations, each with {@link enumSize} values. */
  readonly enums: number;
  readonly enumSize: number;
  /** Number of operations (and therefore message/binding/portType entries) in the WSDL. */
  readonly operations: number;
}

/**
 * The committed seed: the single source of truth for the fixture's size and shape. Changing it
 * changes the fixture, so the perf budgets in `test/bench/budgets.ts` are tied to these numbers.
 */
export const LARGE_SCHEMA_SEED: LargeSchemaSeed = {
  types: 1280,
  fieldsPerType: 18,
  enums: 400,
  enumSize: 24,
  operations: 40,
};

/** The generated fixture's target namespace. */
export const LARGE_SCHEMA_NS = 'urn:wirebench:large-schema';

/** A generated `crafted/large-schema` fixture: the WSDL and the schema document it imports. */
export interface GeneratedLargeSchema {
  readonly wsdl: string;
  readonly xsd: string;
  /** Total bytes of both documents — what the perf report quotes as the fixture size. */
  readonly bytes: number;
}

/** Pads a number so generated names sort stably and have a predictable width. */
function pad(value: number): string {
  return String(value).padStart(5, '0');
}

/**
 * Builds the ~5 MB schema and the WSDL that imports it. Pure and deterministic: the same seed
 * always yields the same bytes, so golden-style comparisons and timing runs stay comparable.
 */
export function generateLargeSchema(seed: LargeSchemaSeed = LARGE_SCHEMA_SEED): GeneratedLargeSchema {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${LARGE_SCHEMA_NS}"` +
      ` targetNamespace="${LARGE_SCHEMA_NS}" elementFormDefault="qualified">`,
  );

  for (let i = 0; i < seed.enums; i++) {
    out.push(`  <xs:simpleType name="Code${pad(i)}">`);
    out.push('    <xs:restriction base="xs:string">');
    for (let v = 0; v < seed.enumSize; v++) {
      out.push(`      <xs:enumeration value="CODE_${pad(i)}_${pad(v)}"/>`);
    }
    out.push('    </xs:restriction>');
    out.push('  </xs:simpleType>');
  }

  const builtins = ['xs:string', 'xs:int', 'xs:boolean', 'xs:dateTime', 'xs:decimal', 'xs:base64Binary'];
  for (let t = 0; t < seed.types; t++) {
    out.push(`  <xs:complexType name="Type${pad(t)}">`);
    out.push('    <xs:sequence>');
    for (let f = 0; f < seed.fieldsPerType; f++) {
      // Every third field points at another generated type or enumeration, so the resolver has
      // real cross-references to chase instead of a flat wall of built-ins.
      const type =
        f % 3 === 0 && t > 0
          ? `tns:Type${pad((t * 7 + f) % t)}`
          : f % 3 === 1 && seed.enums > 0
            ? `tns:Code${pad((t * 3 + f) % seed.enums)}`
            : (builtins[(t + f) % builtins.length] ?? 'xs:string');
      out.push(
        `      <xs:element name="field${pad(f)}" type="${type}" minOccurs="0" maxOccurs="1">` +
          `<xs:annotation><xs:documentation>Generated field ${f} of type ${t}.</xs:documentation></xs:annotation>` +
          '</xs:element>',
      );
    }
    out.push('    </xs:sequence>');
    out.push(`    <xs:attribute name="id${pad(t)}" type="xs:string" use="optional"/>`);
    out.push('  </xs:complexType>');
  }

  for (let o = 0; o < seed.operations; o++) {
    out.push(`  <xs:element name="Op${pad(o)}Request" type="tns:Type${pad(o % seed.types)}"/>`);
    out.push(`  <xs:element name="Op${pad(o)}Response" type="tns:Type${pad((o + 1) % seed.types)}"/>`);
  }
  out.push('</xs:schema>');
  const xsd = out.join('\n') + '\n';

  const wsdl: string[] = [];
  wsdl.push('<?xml version="1.0" encoding="UTF-8"?>');
  wsdl.push(
    '<definitions name="LargeSchema" xmlns="http://schemas.xmlsoap.org/wsdl/"' +
      ' xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"' +
      ' xmlns:xs="http://www.w3.org/2001/XMLSchema"' +
      ` xmlns:tns="${LARGE_SCHEMA_NS}" targetNamespace="${LARGE_SCHEMA_NS}">`,
  );
  wsdl.push('  <types>');
  wsdl.push(`    <xs:schema targetNamespace="${LARGE_SCHEMA_NS}">`);
  wsdl.push(`      <xs:import namespace="${LARGE_SCHEMA_NS}" schemaLocation="large.xsd"/>`);
  wsdl.push('    </xs:schema>');
  wsdl.push('  </types>');
  for (let o = 0; o < seed.operations; o++) {
    wsdl.push(`  <message name="Op${pad(o)}In"><part name="parameters" element="tns:Op${pad(o)}Request"/></message>`);
    wsdl.push(`  <message name="Op${pad(o)}Out"><part name="parameters" element="tns:Op${pad(o)}Response"/></message>`);
  }
  wsdl.push('  <portType name="LargePortType">');
  for (let o = 0; o < seed.operations; o++) {
    wsdl.push(
      `    <operation name="Op${pad(o)}"><input message="tns:Op${pad(o)}In"/>` +
        `<output message="tns:Op${pad(o)}Out"/></operation>`,
    );
  }
  wsdl.push('  </portType>');
  wsdl.push('  <binding name="LargeBinding" type="tns:LargePortType">');
  wsdl.push('    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>');
  for (let o = 0; o < seed.operations; o++) {
    wsdl.push(`    <operation name="Op${pad(o)}">`);
    wsdl.push(`      <soap:operation soapAction="${LARGE_SCHEMA_NS}/Op${pad(o)}"/>`);
    wsdl.push('      <input><soap:body use="literal"/></input>');
    wsdl.push('      <output><soap:body use="literal"/></output>');
    wsdl.push('    </operation>');
  }
  wsdl.push('  </binding>');
  wsdl.push('  <service name="LargeService">');
  wsdl.push('    <port name="LargePort" binding="tns:LargeBinding">');
  wsdl.push('      <soap:address location="http://example.invalid/large"/>');
  wsdl.push('    </port>');
  wsdl.push('  </service>');
  wsdl.push('</definitions>');
  const wsdlText = wsdl.join('\n') + '\n';

  return {
    wsdl: wsdlText,
    xsd,
    bytes: Buffer.byteLength(wsdlText, 'utf-8') + Buffer.byteLength(xsd, 'utf-8'),
  };
}

/** Where {@link writeLargeSchemaFixture} put the fixture. */
export interface WrittenLargeSchema {
  readonly wsdlPath: string;
  readonly xsdPath: string;
  readonly bytes: number;
}

/**
 * Writes the generated fixture into `dir` as `service.wsdl` + `large.xsd`, creating `dir` when
 * it does not exist. Used by `pnpm fixtures:refresh` and by the perf suite (into a temp dir).
 */
export async function writeLargeSchemaFixture(
  dir: string,
  seed: LargeSchemaSeed = LARGE_SCHEMA_SEED,
): Promise<WrittenLargeSchema> {
  const generated = generateLargeSchema(seed);
  await mkdir(dir, { recursive: true });
  const wsdlPath = join(dir, 'service.wsdl');
  const xsdPath = join(dir, 'large.xsd');
  await writeFile(wsdlPath, generated.wsdl, 'utf-8');
  await writeFile(xsdPath, generated.xsd, 'utf-8');
  return { wsdlPath, xsdPath, bytes: generated.bytes };
}
