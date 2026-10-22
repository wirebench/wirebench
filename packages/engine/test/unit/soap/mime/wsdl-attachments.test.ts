import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildSampleRequest } from '#protocol-soap/soap/request-builder';
import type { RequestBuildInput } from '#protocol-soap/soap/request-builder';
import { createDefaultFetchDocument } from '#core/http/fetch-document';
import { parseWsdl } from '#protocol-soap/wsdl/parse-wsdl';
import { buildSchemaSet } from '#protocol-soap/xsd/schema-set';

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url));
const location = `${repoRoot}fixtures/wsdl/crafted/attachments/service.wsdl`;

let input: RequestBuildInput;

beforeAll(async () => {
  const definition = await parseWsdl(
    { location, text: readFileSync(location, 'utf-8') },
    { fetchDocument: createDefaultFetchDocument(), resolveImports: true },
  );
  input = { definition, schemaSet: buildSchemaSet(definition) };
});

describe('the attachments fixture', () => {
  it('declares a mime:multipartRelated input with a named binary part', () => {
    const text = readFileSync(location, 'utf-8');
    expect(text).toContain('<mime:multipartRelated>');
    expect(text).toContain('<soap:body use="literal" parts="body"/>');
    expect(text).toContain('<mime:content part="file" type="application/octet-stream"/>');
  });

  it('parses into a SOAP binding with both operations', () => {
    const binding = input.definition.bindings.find((b) => b.name.localName === 'AttachmentsBinding');
    expect(binding?.soapVersion).toBe('1.1');
    expect(binding?.operations.map((operation) => operation.name)).toEqual(['Upload', 'SendRef']);
  });

  it('builds a swaRef request whose element can hold a cid: reference', () => {
    const request = buildSampleRequest(input, {
      bindingName: { namespaceUri: 'urn:wb:attachments', localName: 'AttachmentsBinding' },
      operationName: 'SendRef',
    });
    expect(request.envelopeXml).toContain('<att:SendRef>');
    expect(request.envelopeXml).toContain('<att:doc>');
    expect(request.soapAction).toBe('urn:wb:attachments/SendRef');
  });
});
