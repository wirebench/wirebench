import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findBinding } from '../../../src/wsdl/model.js';
import { parseWsdlDocument } from '../../../src/wsdl/parse-wsdl.js';
import { parseXml } from '../../../src/xml/parse.js';
import { summarizeOperations } from '../../../src/operations.js';
import type { WsdlDefinition } from '../../../src/wsdl/model.js';

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url));

function loadCrafted(name: string): WsdlDefinition {
  const location = `${repoRoot}fixtures/wsdl/crafted/${name}/service.wsdl`;
  return parseWsdlDocument(parseXml(readFileSync(location, 'utf-8'), { location }), location);
}

function operationOf(definition: WsdlDefinition, binding: string, operation: string) {
  const found = findBinding(definition, { namespaceUri: definition.targetNamespace, localName: binding });
  return found?.operations.find((candidate) => candidate.name === operation);
}

describe('WSDL mime:multipartRelated parts', () => {
  const definition = loadCrafted('attachments');

  it('lists each mime:content part of a multipartRelated input', () => {
    const upload = operationOf(definition, 'AttachmentsBinding', 'Upload');
    expect(upload?.input?.mimeParts).toEqual([{ part: 'file', type: 'application/octet-stream' }]);
  });

  it('reads the soap:body nested inside the multipartRelated part that carries it', () => {
    const upload = operationOf(definition, 'AttachmentsBinding', 'Upload');
    expect(upload?.input?.body).toEqual({ use: 'literal', parts: ['body'] });
  });

  it('leaves mimeParts absent for a plain soap:body binding message', () => {
    const sendRef = operationOf(definition, 'AttachmentsBinding', 'SendRef');
    expect(sendRef?.input?.mimeParts).toBeUndefined();
    expect(operationOf(definition, 'AttachmentsBinding', 'Upload')?.output?.mimeParts).toBeUndefined();
  });

  it('surfaces the input mime parts on the operation summary', () => {
    const summaries = summarizeOperations(definition);
    const upload = summaries.find((summary) => summary.operationName === 'Upload');
    const sendRef = summaries.find((summary) => summary.operationName === 'SendRef');
    expect(upload?.inputMimeParts).toEqual([{ part: 'file', type: 'application/octet-stream' }]);
    expect(sendRef?.inputMimeParts).toEqual([]);
  });
});

describe('WSDL mime:content without a part attribute', () => {
  // A `mime:content` names the `wsdl:part` it carries; one without that attribute has nothing
  // to bind an attachment to, so it is skipped rather than surfaced as a nameless slot.
  const wsdl = `<?xml version="1.0"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
  xmlns:mime="http://schemas.xmlsoap.org/wsdl/mime/"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:tns="urn:wb:nameless" targetNamespace="urn:wb:nameless">
  <wsdl:message name="In"><wsdl:part name="body" type="xsd:string"/></wsdl:message>
  <wsdl:portType name="PT"><wsdl:operation name="Op"><wsdl:input message="tns:In"/></wsdl:operation></wsdl:portType>
  <wsdl:binding name="B" type="tns:PT">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Op">
      <wsdl:input>
        <mime:multipartRelated>
          <mime:part><soap:body use="literal" parts="body"/></mime:part>
          <mime:part><mime:content type="application/octet-stream"/></mime:part>
        </mime:multipartRelated>
      </wsdl:input>
    </wsdl:operation>
  </wsdl:binding>
</wsdl:definitions>`;

  it('skips it, leaving the message with an empty (but present) mimeParts', () => {
    const location = 'inline://nameless.wsdl';
    const definition = parseWsdlDocument(parseXml(wsdl, { location }), location);
    expect(operationOf(definition, 'B', 'Op')?.input?.mimeParts).toEqual([]);
  });
});
