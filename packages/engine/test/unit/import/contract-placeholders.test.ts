/**
 * A `${…}` in a contract's own text is the contract's, not the user's: a request generated from it
 * holds the text escaped (`$${`), so expansion at send time puts the `${…}` on the wire literally
 * and never reads a property, an environment variable or a secret for it (#223).
 */
import { describe, expect, it } from 'vitest';
import { escapeExpansions, expand } from '../../../src/project/properties.js';
import type { PropertyScopes } from '../../../src/project/properties.js';
import { parseOpenApi } from '../../../src/rest/openapi/import.js';
import { apiFromDocument } from '../../../src/rest/openapi/map.js';
import type { RestFolder, RestRequestDef } from '../../../src/rest/model.js';
import { buildEmptyRequest, buildSampleRequest } from '../../../src/soap/request-builder.js';
import type { RequestBuildInput } from '../../../src/soap/request-builder.js';
import { createDefaultFetchDocument } from '../../../src/http/fetch-document.js';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';

const PROBE = '${#System#WB_PROBE}';
const scopes: PropertyScopes = { project: {}, global: {}, system: { WB_PROBE: 'leaked-from-env' } };
const sent = (text: string): string => expand(text, scopes).text;

describe('escapeExpansions', () => {
  it.each([
    ['plain', 'plain'],
    [PROBE, '$' + PROBE],
    ['a ${x} b ${y}', 'a $${x} b $${y}'],
    ['$${already}', '$$${already}'],
    ['$', '$'],
    ['{x}', '{x}'],
  ])('escapes %j so it expands back to itself', (text, escaped) => {
    expect(escapeExpansions(text)).toBe(escaped);
    expect(expand(escapeExpansions(text), scopes).text).toBe(text);
    expect(expand(escapeExpansions(text), scopes).unresolved).toEqual([]);
  });
});

const WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:xs="http://www.w3.org/2001/XMLSchema"
                  xmlns:tns="urn:probe"
                  targetNamespace="urn:probe">
  <wsdl:types>
    <xs:schema targetNamespace="urn:probe" elementFormDefault="qualified">
      <xs:element name="Ping">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="home" type="xs:string" fixed="${PROBE}"/>
          </xs:sequence>
          <xs:attribute name="tag" type="xs:string" default="${PROBE}"/>
        </xs:complexType>
      </xs:element>
    </xs:schema>
  </wsdl:types>
  <wsdl:message name="PingRequest"><wsdl:part name="parameters" element="tns:Ping"/></wsdl:message>
  <wsdl:portType name="ProbePort">
    <wsdl:operation name="Ping"><wsdl:input message="tns:PingRequest"/></wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="ProbeSoap" type="tns:ProbePort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Ping">
      <soap:operation soapAction="urn:probe/${PROBE}"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
    </wsdl:operation>
  </wsdl:binding>
</wsdl:definitions>`;

async function probeWsdl(): Promise<RequestBuildInput> {
  const definition = await parseWsdl(
    { location: 'inline:probe.wsdl', text: WSDL },
    { fetchDocument: createDefaultFetchDocument(), resolveImports: false },
  );
  return { definition, schemaSet: buildSchemaSet(definition) };
}

const PING = { bindingName: { namespaceUri: 'urn:probe', localName: 'ProbeSoap' }, operationName: 'Ping' };

describe('a SOAP request generated from a contract', () => {
  it("sends an XSD fixed or default value's ${ literally", async () => {
    const generated = buildSampleRequest(await probeWsdl(), PING, { includeOptional: true });

    expect(generated.problems).toEqual([]);
    expect(sent(generated.envelopeXml)).toContain(`<pro:home>${PROBE}</pro:home>`);
    expect(sent(generated.envelopeXml)).toContain(`<pro:Ping tag="${PROBE}">`);
    expect(sent(generated.envelopeXml)).not.toContain('leaked-from-env');
  });

  it("sends the SOAP action's ${ literally, for a sample and an empty request", async () => {
    const input = await probeWsdl();
    for (const generated of [buildSampleRequest(input, PING), buildEmptyRequest(input, PING)]) {
      expect(generated.soapAction).toBeDefined();
      expect(sent(generated.soapAction ?? '')).toBe(`urn:probe/${PROBE}`);
      expect(sent(generated.headers['SOAPAction'] ?? '')).toBe(`"urn:probe/${PROBE}"`);
    }
  });
});

const OPENAPI = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Probe', version: '1' },
  servers: [{ url: `https://probe.test/${PROBE}` }],
  paths: {
    [`/files/${PROBE}/{id}`]: {
      post: {
        summary: 'Upload',
        parameters: [
          { name: 'id', in: 'path', required: true, example: PROBE },
          { name: 'q', in: 'query', required: true, schema: { type: 'string', default: PROBE } },
          { name: 'X-Probe', in: 'header', schema: { type: 'string', example: PROBE } },
        ],
        requestBody: {
          content: {
            'application/json': {
              schema: { type: 'object', required: ['home'], properties: { home: { type: 'string', default: PROBE } } },
            },
          },
        },
        responses: { '200': { description: 'ok' } },
      },
    },
  },
});

function requestsOf(container: {
  readonly requests: readonly RestRequestDef[];
  readonly folders: readonly RestFolder[];
}): RestRequestDef[] {
  return [...container.requests, ...container.folders.flatMap((folder) => requestsOf(folder))];
}

describe('a REST request imported from an OpenAPI document', () => {
  it('sends the path, examples, defaults and server URL with ${ literally', async () => {
    const parsed = await parseOpenApi({ kind: 'text', text: OPENAPI }, { fetchDocument: createDefaultFetchDocument() });
    const { api } = apiFromDocument(parsed.document);
    const [request] = requestsOf(api);

    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(sent(request.url)).toBe(`/files/${PROBE}/{id}`);
    // The contract link still names the document's path as written, so an update still matches it.
    expect(request.contract?.path).toBe(`/files/${PROBE}/{id}`);
    expect(request.pathParams.map((row) => sent(row.value))).toEqual([PROBE]);
    expect(request.query.map((row) => sent(row.value))).toEqual([PROBE]);
    expect(request.headers.map((row) => sent(row.value))).toEqual([PROBE]);
    expect(request.body.kind).toBe('raw');
    if (request.body.kind === 'raw') {
      expect(JSON.parse(sent(request.body.text))).toEqual({ home: PROBE });
    }
    expect(sent(api.baseUrl)).toBe(`https://probe.test/${PROBE}`);
    expect(api.servers.map((server) => sent(server.url))).toEqual([`https://probe.test/${PROBE}`]);
  });
});
