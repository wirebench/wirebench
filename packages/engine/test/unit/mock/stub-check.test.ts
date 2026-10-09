/**
 * Checking a mock's stubs against its contract (#325): the status, the Content-Type and the body of
 * each stub, by the checks a received SOAP or REST response gets. REST bodies are checked in the
 * contract-check worker, so the engine must have been built.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createMock, createMockOperation, createMockResponse } from '../../../src/mock/model.js';
import type { MockResponse } from '../../../src/mock/model.js';
import { checkMockStubs } from '../../../src/mock/stub-check.js';
import { tempProjectDir } from '../project/fixture.js';
import { mockProject, wsdlFixture } from './fixture.js';

const CALCULATOR = wsdlFixture('public/calculator/service.wsdl');
const SOAP11 = 'http://schemas.xmlsoap.org/soap/envelope/';
const SOAP12 = 'http://www.w3.org/2003/05/soap-envelope';

function envelope(version: '1.1' | '1.2', body: string): string {
  return `<s:Envelope xmlns:s="${version === '1.1' ? SOAP11 : SOAP12}" xmlns:t="http://tempuri.org/"><s:Body>${body}</s:Body></s:Envelope>`;
}

const sum = (inner = '<t:AddResult>3</t:AddResult>') => `<t:AddResponse>${inner}</t:AddResponse>`;
const FAULT11 = '<s:Fault><faultcode>s:Client</faultcode><faultstring>no</faultstring></s:Fault>';
const FAULT12 =
  '<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code><s:Reason><s:Text xml:lang="en">no</s:Text></s:Reason></s:Fault>';

async function checkSoap(binding: string, responses: readonly MockResponse[]) {
  const mock = createMock(
    'Calc',
    { containerId: 'I1', binding: `{http://tempuri.org/}${binding}` },
    {
      id: 'M1',
      operations: [
        createMockOperation('Add', 'Add', { id: 'O1', responses }),
        createMockOperation('Gone', 'Gone', {
          id: 'O2',
          responses: [createMockResponse('Never', { id: 'G1', status: 599, body: 'json', bodyText: '[' })],
        }),
      ],
    },
  );
  const { dir, project } = await mockProject({ wsdl: CALCULATOR, mocks: [mock] });
  return checkMockStubs({ project, root: dir, mockId: 'M1' });
}

const OPENAPI = `openapi: 3.0.3
info: { title: Orders, version: '1' }
paths:
  /orders:
    post:
      responses:
        '201':
          description: created
          content:
            application/json:
              schema: { type: object, properties: { id: { type: integer } } }
        4XX:
          description: refused
          content:
            application/problem+json:
              schema: { type: object, required: [title] }
  /orders/{id}:
    delete:
      parameters:
        - { name: id, in: path, required: true, schema: { type: integer } }
      responses:
        '204': { description: gone }
`;

async function checkRestMock(operation: string, responses: readonly MockResponse[]) {
  const file = join(await tempProjectDir(), 'openapi.yaml');
  await writeFile(file, OPENAPI);
  const mock = createMock(
    'Orders',
    { containerId: 'A1' },
    { id: 'M1', operations: [createMockOperation('Op', operation, { id: 'O1', responses })] },
  );
  const { dir, project } = await mockProject({ openapi: pathToFileURL(file).href, mocks: [mock] });
  return checkMockStubs({ project, root: dir, mockId: 'M1' });
}

describe('checkMockStubs, SOAP', () => {
  it('passes a reply, a fault and a fault in SOAP 1.2, and skips an operation the contract lacks', async () => {
    const result = await checkSoap('CalculatorSoap', [
      createMockResponse('Sum', { id: 'R1', body: 'xml', bodyText: envelope('1.1', sum()) }),
      createMockResponse('Fault', { id: 'R2', status: 500, body: 'xml', bodyText: envelope('1.1', FAULT11) }),
    ]);
    expect(result).toEqual({ checked: 2, findings: [] });
    const v12 = await checkSoap('CalculatorSoap12', [
      createMockResponse('Fault', { id: 'R1', status: 400, body: 'xml', bodyText: envelope('1.2', FAULT12) }),
    ]);
    expect(v12.findings).toEqual([]);
  });

  it('lists a body the output message does not allow, with its position', async () => {
    const result = await checkSoap('CalculatorSoap', [
      createMockResponse('Wrong', { id: 'R1', body: 'xml', bodyText: envelope('1.1', sum('<t:Total>3</t:Total>')) }),
    ]);
    expect(result.findings).toHaveLength(1);
    const [finding] = result.findings;
    expect(finding).toMatchObject({ operationId: 'O1', operation: 'Add', responseId: 'R1', responseName: 'Wrong' });
    expect(finding?.problems[0]).toMatchObject({ code: 'mock-stub-invalid', in: 'body', line: 1 });
  });

  it('lists a wrong status, a missing body, a non-XML body and a Content-Type of the other version', async () => {
    const result = await checkSoap('CalculatorSoap', [
      createMockResponse('Not found', { id: 'R1', status: 404, body: 'xml', bodyText: envelope('1.1', sum()) }),
      createMockResponse('Fault 200', { id: 'R2', body: 'xml', bodyText: envelope('1.1', FAULT11) }),
      createMockResponse('Empty', { id: 'R3' }),
      createMockResponse('Json', { id: 'R4', body: 'json', bodyText: '{}' }),
      createMockResponse('Typed', {
        id: 'R5',
        body: 'xml',
        bodyText: envelope('1.1', sum()),
        headers: [{ name: 'Content-Type', value: 'application/soap+xml' }],
      }),
    ]);
    const byId = Object.fromEntries(result.findings.map((f) => [f.responseId, f.problems]));
    expect(byId['R1']).toEqual([
      {
        code: 'mock-stub-invalid',
        in: 'status',
        message: 'A SOAP reply that is not a fault is sent with 200, not 404',
      },
    ]);
    expect(byId['R2']?.[0]?.message).toBe('A SOAP 1.1 fault is sent with 500, not 200');
    expect(byId['R3']?.[0]?.message).toBe('Add returns a message; this response has no body');
    expect(byId['R4']?.[0]?.message).toBe('A SOAP response body is XML, not json');
    expect(byId['R5']).toHaveLength(1);
    expect(byId['R5']?.[0]).toMatchObject({ in: 'header', name: 'Content-Type' });
    expect(byId['R5']?.[0]?.message).toContain('text/xml');
    expect(result.checked).toBe(5);
  });
});

describe('checkMockStubs, REST', () => {
  it('passes a conforming stub and a body-less 204', async () => {
    expect(
      (
        await checkRestMock('post /orders', [
          createMockResponse('Created', { id: 'R1', status: 201, body: 'json', bodyText: '{"id":1}' }),
          createMockResponse('Refused', {
            id: 'R2',
            status: 409,
            body: 'json',
            bodyText: '{"title":"taken"}',
            headers: [{ name: 'Content-Type', value: 'application/problem+json' }],
          }),
        ])
      ).findings,
    ).toEqual([]);
    expect(
      (await checkRestMock('delete /orders/{id}', [createMockResponse('Gone', { status: 204 })])).findings,
    ).toEqual([]);
  });

  it('lists a body the schema refuses, by JSON Pointer', async () => {
    const result = await checkRestMock('post /orders', [
      createMockResponse('Created', { id: 'R1', status: 201, body: 'json', bodyText: '{"id":"one"}' }),
    ]);
    expect(result.findings[0]?.problems).toEqual([
      expect.objectContaining({ code: 'mock-stub-invalid', in: 'body', path: '/id' }),
    ]);
  });

  it('lists an undocumented status, an undeclared Content-Type and a body where none is declared', async () => {
    const created = await checkRestMock('post /orders', [
      createMockResponse('Server error', { id: 'R1', status: 500, body: 'json', bodyText: '{}' }),
      createMockResponse('Text', { id: 'R2', status: 201, body: 'text', bodyText: 'made' }),
    ]);
    const byId = Object.fromEntries(created.findings.map((f) => [f.responseId, f.problems]));
    expect(byId['R1']).toEqual([
      { code: 'mock-stub-invalid', in: 'status', message: 'The contract declares no 500 response' },
    ]);
    expect(byId['R2']).toEqual([
      {
        code: 'mock-stub-invalid',
        in: 'header',
        name: 'Content-Type',
        message:
          'The contract declares no text/plain; charset=utf-8 body for a 201 response; it declares application/json',
      },
    ]);
    const gone = await checkRestMock('delete /orders/{id}', [
      createMockResponse('Gone', { id: 'R1', status: 204, body: 'json', bodyText: '{}' }),
    ]);
    expect(gone.findings[0]?.problems).toEqual([
      { code: 'mock-stub-invalid', in: 'body', message: 'The contract declares no body for a 204 response' },
    ]);
  });
});
