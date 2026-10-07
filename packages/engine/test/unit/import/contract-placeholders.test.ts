/**
 * A `${…}` in a contract's own text is the contract's, not the user's: a request generated from it
 * holds the text escaped (`$${`), so expansion at send time puts the `${…}` on the wire literally
 * and never reads a property, an environment variable or a secret for it (#223).
 */
import { describe, expect, it } from 'vitest';
import { escapeExpansions, expand, unescapeExpansions } from '../../../src/project/properties.js';
import type { PropertyScopes } from '../../../src/project/properties.js';
import { parseOpenApi } from '../../../src/rest/openapi/import.js';
import { apiFromDocument } from '../../../src/rest/openapi/map.js';
import type { RestFolder, RestRequestDef } from '../../../src/rest/model.js';
import { buildEmptyRequest, buildSampleRequest } from '../../../src/soap/request-builder.js';
import type { RequestBuildInput } from '../../../src/soap/request-builder.js';
import { createDefaultFetchDocument } from '../../../src/http/fetch-document.js';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';
import { applyForm, buildForm } from '../../../src/xsd/form-model.js';
import type { FormNode } from '../../../src/xsd/form-model.js';
import { applyFormEdit } from '../../../src/xsd/form-edits.js';
import { mapScheme } from '../../../src/rest/openapi/map.js';
import { authFromScheme as asyncApiAuth } from '../../../src/asyncapi/security.js';
import { createRunTokenSource } from '../../../src/run/oauth2-token.js';
import type { HttpExchange, HttpRequest } from '../../../src/http/types.js';
import type { OAuth2Auth } from '../../../src/project/model.js';
import { buildLiteralSampleRequest } from '../../../src/soap/request-builder.js';

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
    expect(unescapeExpansions(escapeExpansions(text))).toBe(text);
  });

  it('unescapes only the escape, leaving a live ${…} as it is', () => {
    expect(unescapeExpansions('a $${x} b ${y} c $$${z}')).toBe('a ${x} b ${y} c $${z}');
  });
});

const WSDL = `<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:soap12="http://schemas.xmlsoap.org/wsdl/soap12/"
                  xmlns:xs="http://www.w3.org/2001/XMLSchema"
                  xmlns:tns="urn:probe"
                  targetNamespace="urn:probe">
  <wsdl:types>
    <xs:schema targetNamespace="urn:probe" elementFormDefault="qualified">
      <xs:element name="Ping">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="home" type="xs:string" fixed="${PROBE}"/>
            <xs:element name="note" type="xs:string" minOccurs="0" default="${PROBE}"/>
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
  <wsdl:binding name="ProbeSoap12" type="tns:ProbePort">
    <soap12:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Ping">
      <soap12:operation soapAction="urn:probe/${PROBE}"/>
      <wsdl:input><soap12:body use="literal"/></wsdl:input>
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

describe('more contract text a request is made from', () => {
  it('escapes the SOAP 1.2 action in the Content-Type as in the headers; the literal build keeps it', async () => {
    const input = await probeWsdl();
    const ping12 = { ...PING, bindingName: { ...PING.bindingName, localName: 'ProbeSoap12' } };
    for (const generated of [buildSampleRequest(input, ping12), buildEmptyRequest(input, ping12)]) {
      expect(generated.contentType).toContain(`action="urn:probe/$${PROBE}"`);
      expect(sent(generated.contentType)).toContain(`action="urn:probe/${PROBE}"`);
    }
    const literal = buildLiteralSampleRequest(input, ping12, { includeOptional: true });
    expect(literal.contentType).toContain(`action="urn:probe/${PROBE}"`);
    expect(literal.envelopeXml).toContain(`>${PROBE}</`);
    expect(literal.envelopeXml).not.toContain(`$${PROBE}`);
  });

  it('escapes a fixed or default value the form view inserts', async () => {
    const { schemaSet } = await probeWsdl();
    // A form with no document yet keeps the optional attribute on offer, as one built from a sample does not.
    let form = buildForm(schemaSet, { namespaceUri: 'urn:probe', localName: 'Ping' });
    const find = (node: FormNode, label: string): FormNode | undefined =>
      node.label === label ? node : node.children.map((child) => find(child, label)).find((hit) => hit !== undefined);
    for (const label of ['ns1:note', 'tag']) {
      const node = find(form, label);
      expect(node?.present).toBe(false);
      form = applyFormEdit(form, { kind: 'insert-optional', nodeId: node?.id ?? '' });
    }
    const written = applyForm(form);
    expect(written).toContain(`<ns1:note>$${PROBE}</ns1:note>`);
    expect(written).toContain(`tag="$${PROBE}"`);
    expect(sent(written)).not.toContain('leaked-from-env');
  });

  it('escapes an OAuth2 scheme and an API key name from OpenAPI, and the token fetch sends them literally', async () => {
    const oauth = mapScheme({
      name: 'oauth',
      type: 'oauth2',
      flows: {
        clientCredentials: {
          tokenUrl: `https://auth.test/${PROBE}/token`,
          authorizationUrl: `https://auth.test/${PROBE}/authorize`,
          scopes: { [`read:${PROBE}`]: 'Read' },
        },
      },
    }).auth;
    expect(oauth).toMatchObject({
      type: 'oauth2',
      tokenUrl: `https://auth.test/$${PROBE}/token`,
      authorizationUrl: `https://auth.test/$${PROBE}/authorize`,
      scopes: [`read:$${PROBE}`],
    });
    expect(mapScheme({ name: 'key', type: 'apiKey', in: 'header', keyName: `X-${PROBE}` }).auth).toEqual({
      type: 'api-key',
      name: `X-$${PROBE}`,
      in: 'header',
    });

    const sentRequests: HttpRequest[] = [];
    const body = new TextEncoder().encode(JSON.stringify({ access_token: 'tok', token_type: 'Bearer' }));
    const source = createRunTokenSource({
      getSecret: () => Promise.resolve('s3cret'),
      send: (request) => {
        sentRequests.push(request);
        return Promise.resolve({
          request,
          status: 200,
          statusText: '',
          headers: { 'content-type': 'application/json' },
          rawHeaders: [],
          body,
          rawBody: body,
        } as unknown as HttpExchange);
      },
    });
    const config = { ...(oauth as OAuth2Auth), clientId: 'svc', clientSecretRef: 'sec' };
    await expect(source.accessTokenFor(config, { scopes })).resolves.toBe('tok');
    expect(sentRequests[0]?.url).toBe(`https://auth.test/${PROBE}/token`);
    const form = new TextDecoder().decode(sentRequests[0]?.body);
    expect(decodeURIComponent(form.replaceAll('+', ' '))).toContain(`read:${PROBE}`);
    expect(JSON.stringify(sentRequests)).not.toContain('leaked-from-env');
  });

  it('escapes an OAuth2 scheme and an API key name from AsyncAPI', () => {
    expect(
      asyncApiAuth({
        type: 'oauth2',
        grant: 'client-credentials',
        tokenUrl: `https://auth.test/${PROBE}`,
        authorizationUrl: `https://auth.test/${PROBE}/a`,
        scopes: [PROBE],
      }),
    ).toMatchObject({
      tokenUrl: `https://auth.test/$${PROBE}`,
      authorizationUrl: `https://auth.test/$${PROBE}/a`,
      scopes: [`$${PROBE}`],
    });
    expect(asyncApiAuth({ type: 'httpApiKey', in: 'header', name: `X-${PROBE}` })).toEqual({
      type: 'api-key',
      name: `X-$${PROBE}`,
      in: 'header',
    });
  });
});
