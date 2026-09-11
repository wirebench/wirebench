import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { importDefinition } from '../../src/import.js';
import { generateRequest } from '../../src/generate.js';
import { sendSoapRequest } from '../../src/send.js';
import { messageBindingFor, runMessageAssertions } from '../../src/validate/wsi/run-message.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-soap-server.js';

const calculator = fileURLToPath(new URL('../../../../fixtures/wsdl/public/calculator/service.wsdl', import.meta.url));

const OPERATION = {
  bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorSoap' },
  operationName: 'Add',
};

describe('WS-I message assertions over a real exchange', () => {
  let server: TestSoapServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('reports no failure for an echo exchange the engine itself produced', async () => {
    server = await startTestSoapServer();
    const result = await importDefinition({ kind: 'file', path: calculator });
    const binding = messageBindingFor(result.definition, OPERATION);
    expect(binding).toEqual({
      soapVersion: '1.1',
      style: 'document',
      use: 'literal',
      operation: 'Add',
      soapAction: 'http://tempuri.org/Add',
    });

    const envelopeXml = generateRequest(result, OPERATION).envelopeXml;
    const exchange = await sendSoapRequest({
      endpoint: `${server.url}/soap`,
      envelopeXml,
      soapVersion: '1.1',
      soapAction: binding?.soapAction ?? '',
    });

    expect(exchange.http.status).toBe(200);
    const report = runMessageAssertions(exchange, {
      // `binding` is proven defined above; the non-null path keeps the test honest about it.
      binding: binding ?? { soapVersion: '1.1', style: 'document', use: 'literal' },
      direction: 'request',
      requestEnvelopeXml: envelopeXml,
      verbose: true,
    });

    expect(report.summary.failed).toBe(0);
    expect(report.summary.warning).toBe(0);
    expect(report.summary.passed).toBeGreaterThan(0);
    expect(report.target).toContain('/soap');
  });

  it('derives no binding for an operation the binding does not have', async () => {
    const result = await importDefinition({ kind: 'file', path: calculator });
    expect(messageBindingFor(result.definition, { ...OPERATION, operationName: 'Nope' })).toBeUndefined();
    expect(
      messageBindingFor(result.definition, {
        ...OPERATION,
        bindingName: { namespaceUri: 'http://tempuri.org/', localName: 'CalculatorHttpGet' },
      }),
    ).toBeUndefined();
  });
});
