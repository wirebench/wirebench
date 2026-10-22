/**
 * Test helper: one request and response snapshot per protocol, as a send hands them to a script.
 * Shared by the layer tests over non-REST requests and the converter's equivalence harness.
 */
import type { GrpcRequestSnapshot, GrpcResponseSnapshot } from '#protocol-grpc/grpc/scripting';
import type { McpRequestSnapshot, McpResponseSnapshot } from '#protocol-mcp/mcp/scripting';
import type { RestRequestSnapshot, RestResponseSnapshot } from '#protocol-rest/rest/scripting';
import type { SoapRequestSnapshot, SoapResponseSnapshot } from '#protocol-soap/soap/scripting';

export const REST: RestRequestSnapshot = {
  protocol: 'rest',
  method: 'POST',
  url: 'https://shop.test/carts/7?full=1',
  headers: [
    ['X-Trace', '1'],
    ['Content-Type', 'application/json'],
  ],
  body: { kind: 'text', text: '{"id":"7"}', language: 'json' },
};
export const REST_RESPONSE: RestResponseSnapshot = {
  protocol: 'rest',
  status: 200,
  statusText: 'OK',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Server', 'carts-1'],
  ],
  text: '{"id":"9","items":2}',
  durationMs: 4,
};

export const GRPC: GrpcRequestSnapshot = {
  protocol: 'grpc',
  target: 'grpc.test:443',
  method: 'shop.Carts/Get',
  metadata: [['x-trace', '1']],
  message: { id: '7' },
};
export const GRPC_RESPONSE: GrpcResponseSnapshot = {
  protocol: 'grpc',
  status: { code: 0, name: 'OK', message: '' },
  metadata: [['x-server', 'carts-1']],
  trailers: [],
  message: { id: '9', items: 2 },
  durationMs: 3,
};

export const SOAP: SoapRequestSnapshot = {
  protocol: 'soap',
  endpoint: 'https://soap.test/stock',
  soapAction: 'urn:GetQuote',
  headers: [],
  envelope: '<soap:Envelope><soap:Body><q/></soap:Body></soap:Envelope>',
};
export const SOAP_RESPONSE: SoapResponseSnapshot = {
  protocol: 'soap',
  status: 200,
  headers: [['Content-Type', 'text/xml']],
  text: '<Envelope/>',
  durationMs: 5,
};

export const MCP: McpRequestSnapshot = {
  protocol: 'mcp',
  transport: 'http',
  url: 'https://mcp.test/mcp',
  method: 'tools/call',
  tool: 'search',
  arguments: { q: 'a' },
};
export const MCP_RESPONSE: McpResponseSnapshot = {
  protocol: 'mcp',
  method: 'tools/call',
  result: { content: [] },
  isError: false,
  messageCount: 4,
  durationMs: 6,
};
