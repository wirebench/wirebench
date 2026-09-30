/**
 * SOAP script types and the XML projection: types from an XSD element, the body of an envelope read
 * as the object those types describe, written back in schema order, and used from a script.
 */
import { DOMParser } from '@xmldom/xmldom';
import { afterAll, describe, expect, it } from 'vitest';
import { runScript } from '../../../src/script/run.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { apiDeclarations, secretNameType } from '../../../src/script/types/api.js';
import { projectSoapBody, replaceSoapBody, soapBodyElement, soapScriptTypes } from '../../../src/soap/script-types.js';
import type { SoapRequestSnapshot } from '../../../src/soap/scripting.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import { typeErrors } from './ts-check.js';

const NS = 'urn:shop';
const XSD = `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:tns="${NS}" targetNamespace="${NS}" elementFormDefault="qualified">
  <xs:simpleType name="Status">
    <xs:restriction base="xs:string"><xs:enumeration value="OPEN"/><xs:enumeration value="CLOSED"/></xs:restriction>
  </xs:simpleType>
  <xs:complexType name="Money">
    <xs:simpleContent><xs:extension base="xs:decimal"><xs:attribute name="currency" type="xs:string" use="required"/></xs:extension></xs:simpleContent>
  </xs:complexType>
  <xs:complexType name="Category">
    <xs:sequence>
      <xs:element name="name" type="xs:string"/>
      <xs:element name="parent" type="tns:Category" minOccurs="0"/>
    </xs:sequence>
  </xs:complexType>
  <xs:element name="PlaceOrder">
    <xs:complexType>
      <xs:sequence>
        <xs:element name="customerId" type="xs:long"/>
        <xs:element name="quantity" type="xs:int"/>
        <xs:element name="express" type="xs:boolean" minOccurs="0"/>
        <xs:element name="status" type="tns:Status"/>
        <xs:element name="note" type="xs:string" nillable="true"/>
        <xs:element name="line" maxOccurs="unbounded">
          <xs:complexType>
            <xs:sequence><xs:element name="sku" type="xs:string"/><xs:element name="price" type="tns:Money"/></xs:sequence>
            <xs:attribute name="id" type="xs:int"/>
          </xs:complexType>
        </xs:element>
        <xs:choice>
          <xs:element name="email" type="xs:string"/>
          <xs:element name="phone" type="xs:string"/>
        </xs:choice>
        <xs:element name="category" type="tns:Category" minOccurs="0"/>
        <xs:any namespace="##other" processContents="lax" minOccurs="0"/>
      </xs:sequence>
    </xs:complexType>
  </xs:element>
  <xs:element name="PlaceOrderResponse">
    <xs:complexType><xs:sequence><xs:element name="orderId" type="xs:string"/><xs:element name="total" type="tns:Money"/></xs:sequence></xs:complexType>
  </xs:element>
</xs:schema>`;

const schemaElement = new DOMParser().parseFromString(XSD, 'text/xml').documentElement!;
const set = buildSchemaSet({ schemaElements: [schemaElement] });
const INPUT = { namespaceUri: NS, localName: 'PlaceOrder' };
const OUTPUT = { namespaceUri: NS, localName: 'PlaceOrderResponse' };

const ENVELOPE = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:s="${NS}">
  <soapenv:Header/>
  <soapenv:Body>
    <s:PlaceOrder>
      <s:customerId>9007199254740993</s:customerId>
      <s:quantity>3</s:quantity>
      <s:status>OPEN</s:status>
      <s:note xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/>
      <s:line id="1"><s:sku>A&amp;B</s:sku><s:price currency="EUR">9.99</s:price></s:line>
      <s:line id="2"><s:sku>C</s:sku><s:price currency="EUR">1.00</s:price></s:line>
      <s:email>a@b.test</s:email>
      <s:category><s:name>toys</s:name><s:parent><s:name>all</s:name></s:parent></s:category>
    </s:PlaceOrder>
  </soapenv:Body>
</soapenv:Envelope>`;

describe('soapScriptTypes', () => {
  const types = soapScriptTypes(set, INPUT, OUTPUT);

  it('maps the XSD to TypeScript', () => {
    expect(types).toContain('customerId: string;');
    expect(types).toContain('quantity: number;');
    expect(types).toContain('express?: boolean;');
    expect(types).toContain('status: "OPEN" | "CLOSED";');
    expect(types).toContain('note: string | null;');
    expect(types).toContain('"@id"?: number;');
    expect(types).toContain('"@currency": string;');
    expect(types).toContain('"#text": string;');
    expect(types).toContain('email?: string;');
    expect(types).toContain('parent?: WbX_Category_');
  });

  it('compiles with a script, and catches a wrong path', () => {
    const declarations = apiDeclarations('soap', 'pre') + secretNameType([]) + types;
    const ok = `
      const body = request.body;
      body.quantity = body.quantity + 1;
      body.line.push({ sku: 'D', price: { '@currency': 'EUR', '#text': '2.50' } });
      const parent: string | undefined = body.category?.parent?.name;
      log(parent, body.customerId.length);
    `;
    expect(typeErrors(declarations, ok)).toEqual([]);
    expect(typeErrors(declarations, 'request.body.qty = 1;')).toHaveLength(1);
    expect(typeErrors(declarations, 'request.body.status = "PENDING";')).toHaveLength(1);
  });

  it('leaves a body without a schema element untyped', () => {
    expect(soapScriptTypes(undefined, INPUT, OUTPUT)).toContain('type WbSoapRequestBody = unknown;');
    expect(soapScriptTypes(set, { namespaceUri: NS, localName: 'Nope' }, OUTPUT)).toContain(
      'type WbSoapRequestBody = unknown;',
    );
  });
});

describe('the XML projection', () => {
  it('reads the body as the types describe it', () => {
    expect(projectSoapBody(set, INPUT, ENVELOPE)).toEqual({
      customerId: '9007199254740993',
      quantity: 3,
      status: 'OPEN',
      note: null,
      line: [
        { '@id': 1, sku: 'A&B', price: { '@currency': 'EUR', '#text': '9.99' } },
        { '@id': 2, sku: 'C', price: { '@currency': 'EUR', '#text': '1.00' } },
      ],
      email: 'a@b.test',
      category: { name: 'toys', parent: { name: 'all' } },
    });
  });

  it('is undefined when the body element is not the one described', () => {
    expect(projectSoapBody(set, OUTPUT, ENVELOPE)).toBeUndefined();
    expect(projectSoapBody(set, INPUT, '<not-an-envelope/>')).toBeUndefined();
  });

  it('writes a changed body back in schema order, keeping the rest of the envelope', () => {
    const body = projectSoapBody(set, INPUT, ENVELOPE) as Record<string, unknown>;
    const changed = { ...body, quantity: 4, express: true, email: 'x<y@b.test' };
    const envelope = replaceSoapBody(set, INPUT, ENVELOPE, changed);
    const bodyRange = soapBodyElement(ENVELOPE)!.range;
    expect(envelope.slice(0, bodyRange.start)).toBe(ENVELOPE.slice(0, bodyRange.start));
    expect(envelope.endsWith(ENVELOPE.slice(bodyRange.end))).toBe(true);
    expect(envelope).toContain(
      `<PlaceOrder xmlns="${NS}"><customerId>9007199254740993</customerId><quantity>4</quantity><express>true</express><status>OPEN</status><note xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:nil="true"/>`,
    );
    expect(envelope).toContain('<line id="1"><sku>A&amp;B</sku><price currency="EUR">9.99</price></line>');
    expect(envelope).toContain('<email>x&lt;y@b.test</email>');
    expect(projectSoapBody(set, INPUT, envelope)).toEqual(changed);
  });

  it('refuses a value the schema cannot hold', () => {
    const body = projectSoapBody(set, INPUT, ENVELOPE) as Record<string, unknown>;
    expect(() => replaceSoapBody(set, INPUT, ENVELOPE, { ...body, quantity: { a: 1 } })).toThrow(TypeError);
    expect(() => replaceSoapBody(set, INPUT, ENVELOPE, { ...body, status: null })).toThrow(/cannot be null/);
  });
});

describe('SOAP scripts with the projection', () => {
  const sandbox = createScriptSandbox();
  afterAll(async () => {
    await sandbox.dispose();
  });
  const REQUEST: SoapRequestSnapshot = {
    protocol: 'soap',
    endpoint: 'https://shop.test/soap',
    soapAction: 'urn:PlaceOrder',
    headers: [],
    envelope: ENVELOPE,
  };

  it('a pre-request script edits request.body, and the envelope carries it', async () => {
    const outcome = await runScript({
      sandbox,
      phase: 'pre',
      api: 'wirebench',
      source: 'request.body.quantity = 7; request.body.line[0]!.sku = "Z";',
      filename: 'Order.pre.ts',
      request: REQUEST,
      vars: {},
      props: {},
      secrets: {},
      requestName: 'Order',
      binding: { schemas: set, input: INPUT, output: OUTPUT },
    });
    expect(outcome.ok).toBe(true);
    const sent = outcome.ok ? (outcome.request as SoapRequestSnapshot) : undefined;
    expect(sent?.body).toBeUndefined();
    expect(projectSoapBody(set, INPUT, sent?.envelope ?? '')).toMatchObject({
      quantity: 7,
      line: [{ sku: 'Z' }, { sku: 'C' }],
    });
  });

  it('an untouched body leaves the envelope byte for byte', async () => {
    const outcome = await runScript({
      sandbox,
      phase: 'pre',
      api: 'wirebench',
      source: 'log(request.body.quantity);',
      filename: 'Order.pre.ts',
      request: REQUEST,
      vars: {},
      props: {},
      secrets: {},
      requestName: 'Order',
      binding: { schemas: set, input: INPUT, output: OUTPUT },
    });
    expect(outcome).toMatchObject({ ok: true, request: { envelope: ENVELOPE }, log: { lines: ['3'] } });
  });

  it('a post-response script reads response.body and selects with XPath', async () => {
    const text = `<e:Envelope xmlns:e="http://schemas.xmlsoap.org/soap/envelope/"><e:Body><r:PlaceOrderResponse xmlns:r="${NS}"><r:orderId>O-1</r:orderId><r:total currency="EUR">12.50</r:total></r:PlaceOrderResponse></e:Body></e:Envelope>`;
    const outcome = await runScript({
      sandbox,
      phase: 'post',
      api: 'wirebench',
      source: `
        test('id', () => expect(response.body.orderId).toBe('O-1'));
        test('select', () => expect(response.select('//r:total/@currency', { r: '${NS}' })).toEqual(['EUR']));
        vars.set('orderId', response.body.orderId);
      `,
      filename: 'Order.post.ts',
      request: REQUEST,
      response: { protocol: 'soap', status: 200, headers: [], text, durationMs: 4 },
      vars: {},
      props: {},
      secrets: {},
      requestName: 'Order',
      binding: { schemas: set, input: INPUT, output: OUTPUT },
    });
    expect(outcome).toMatchObject({
      ok: true,
      tests: [
        { name: 'id', passed: true },
        { name: 'select', passed: true },
      ],
      values: [{ name: 'orderId', value: 'O-1' }],
    });
  });

  it('without a schema, request.body says to use the envelope', async () => {
    const outcome = await runScript({
      sandbox,
      phase: 'pre',
      api: 'wirebench',
      source: 'log(request.body);',
      filename: 'Order.pre.ts',
      request: REQUEST,
      vars: {},
      props: {},
      secrets: {},
      requestName: 'Order',
    });
    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'script-error', message: expect.stringContaining('request.envelope') as unknown },
    });
  });
});
