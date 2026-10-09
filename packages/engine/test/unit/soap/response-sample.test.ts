/**
 * Sample messages of either direction (mock services spec §Generating a mock): the output of an
 * operation is what a generated stub answers with.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefaultFetchDocument } from '../../../src/http/fetch-document.js';
import { buildLiteralSampleRequest, buildSampleMessage } from '../../../src/soap/request-builder.js';
import type { RequestBuildInput } from '../../../src/soap/request-builder.js';
import { parseWsdl } from '../../../src/wsdl/parse-wsdl.js';
import { buildSchemaSet } from '../../../src/xsd/schema-set.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

async function fromText(location: string, text: string): Promise<RequestBuildInput> {
  const definition = await parseWsdl(
    { location, text },
    { fetchDocument: createDefaultFetchDocument(), resolveImports: true },
  );
  return { definition, schemaSet: buildSchemaSet(definition) };
}

async function fixture(relative: string): Promise<RequestBuildInput> {
  const location = `${repoRoot}fixtures/wsdl/${relative}/service.wsdl`;
  return fromText(location, readFileSync(location, 'utf-8'));
}

const op = (input: RequestBuildInput, binding: string, operationName: string) => ({
  bindingName: { namespaceUri: input.definition.targetNamespace, localName: binding },
  operationName,
});

describe('buildSampleMessage', () => {
  it('builds a document/literal output from the output element', async () => {
    const input = await fixture('public/calculator');
    const output = buildSampleMessage(input, op(input, 'CalculatorSoap', 'Add'), 'output');
    expect(output.problems).toEqual([]);
    expect(output.envelopeXml).toContain(':AddResponse>');
    expect(output.envelopeXml).toContain(':AddResult>');
    expect(output.envelopeXml).not.toContain(':intA>');
    expect(output.soapVersion).toBe('1.1');
  });

  it('wraps an RPC output in <operation>Response in the body namespace', async () => {
    const input = await fixture('crafted/rpc-literal');
    const output = buildSampleMessage(input, op(input, 'RpcLiteralBinding', 'Multiply'), 'output');
    expect(output.problems).toEqual([]);
    expect(output.envelopeXml).toMatch(/<(\w+:)?MultiplyResponse[ >]/);
    expect(output.envelopeXml).toContain('urn:wb:rpclit');
  });

  it('builds the same input as the request builder', async () => {
    const input = await fixture('public/calculator');
    const ref = op(input, 'CalculatorSoap12', 'Divide');
    expect(buildSampleMessage(input, ref, 'input')).toEqual(buildLiteralSampleRequest(input, ref));
  });

  it('reports a one-way operation as having no output message', async () => {
    const input = await fromText(
      'urn:test:one-way.wsdl',
      `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
        xmlns:tns="urn:ow" xmlns:xs="http://www.w3.org/2001/XMLSchema" targetNamespace="urn:ow">
        <types><xs:schema targetNamespace="urn:ow" elementFormDefault="qualified">
          <xs:element name="Ping" type="xs:string"/></xs:schema></types>
        <message name="PingIn"><part name="p" element="tns:Ping"/></message>
        <portType name="P"><operation name="Ping"><input message="tns:PingIn"/></operation></portType>
        <binding name="B" type="tns:P"><soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
          <operation name="Ping"><soap:operation soapAction="urn:ping"/><input><soap:body use="literal"/></input></operation>
        </binding></definitions>`,
    );
    const output = buildSampleMessage(input, op(input, 'B', 'Ping'), 'output');
    expect(output.problems.map((p) => p.code)).toEqual(['missing-message']);
  });
});
