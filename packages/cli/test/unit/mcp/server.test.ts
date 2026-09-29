import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseCliArgs } from '../../../src/args.js';
import type { McpArgs } from '../../../src/args.js';
import { mcpBaseFor } from '../../../src/commands/mcp.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { OPS } from '../../../src/ops/index.js';
import {
  addEnvironment,
  CALCULATOR_WSDL,
  emptyProject,
  removeTempDirs,
  SOAP_ITEM,
  soapProject,
  startServer,
} from '../ops/helpers.js';
import type { TestServer } from '../ops/helpers.js';

const TOOLS = ['import', 'operations', 'generate', 'send', 'validate', 'query', 'history_list', 'history_diff'];

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await removeTempDirs();
});

async function connect(base: OpsBase): Promise<Client> {
  const server = createMcpServer(base, '0.0.0-test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wirebench-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

interface Called {
  readonly isError: boolean;
  readonly json: unknown;
  readonly text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Called> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  const text = first?.text ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, json, text };
}

describe('the MCP server', () => {
  it('lists every tool, gated ones included, with the gate in the description', async () => {
    const fixture = await soapProject();
    const client = await connect(fixture.base({ gates: { write: false, send: false } }));
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(tools.find((tool) => tool.name === 'import')?.description).toContain('--allow-write');
    expect(tools.find((tool) => tool.name === 'send')?.description).toContain('--allow-send');
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it("publishes each op's own schema as the tool's inputSchema", async () => {
    const fixture = await soapProject();
    const client = await connect(fixture.base());
    const { tools } = await client.listTools();

    for (const tool of tools) {
      const op = OPS[tool.name as keyof typeof OPS];
      const expected = z.toJSONSchema(op.input, { io: 'input' }) as { properties?: Record<string, unknown> };
      expect(Object.keys(tool.inputSchema.properties ?? {}), tool.name).toEqual(Object.keys(expected.properties ?? {}));
    }
  });

  it('answers the read-only tools with JSON results', async () => {
    const fixture = await soapProject();
    const client = await connect(fixture.base({ gates: { write: false, send: false } }));

    expect(await call(client, 'operations', {})).toMatchObject({
      isError: false,
      json: { operations: [{ ref: 'CalculatorService/Add' }] },
    });
    expect(await call(client, 'generate', { operation: 'CalculatorService/Add' })).toMatchObject({
      isError: false,
      json: { kind: 'soap', soapAction: 'urn:wirebench:calculator/Add' },
    });
    expect(await call(client, 'validate', { operation: 'CalculatorService/Add', text: ADD_RESPONSE })).toMatchObject({
      isError: false,
      json: { valid: true },
    });
    expect(await call(client, 'query', { expression: 'string(//*:result)', text: ADD_RESPONSE })).toMatchObject({
      isError: false,
      json: { results: ['5'] },
    });
    expect(await call(client, 'history_list', {})).toMatchObject({ isError: false, json: { entries: [], total: 0 } });
    expect(await call(client, 'history_diff', { from: 'a', to: 'b' })).toMatchObject({
      isError: true,
      json: { code: 'history-entry-not-found' },
    });
  });

  it('refuses gated tools as isError results that name the flag', async () => {
    const fixture = await soapProject();
    const client = await connect(fixture.base({ gates: { write: false, send: false } }));

    const imported = await call(client, 'import', { source: CALCULATOR_WSDL });
    expect(imported).toMatchObject({ isError: true, json: { code: 'write-not-allowed' } });
    expect(imported.text).toContain('--allow-write');
    const sent = await call(client, 'send', { item: SOAP_ITEM });
    expect(sent).toMatchObject({ isError: true, json: { code: 'send-not-allowed' } });
    expect(sent.text).toContain('--allow-send');
  });

  it('imports and sends when the gates are open, and reports bad arguments as isError', async () => {
    const fixture = await emptyProject();
    const client = await connect(fixture.base());
    expect(await call(client, 'import', { source: CALCULATOR_WSDL })).toMatchObject({
      isError: false,
      json: { format: 'wsdl' },
    });

    const calculator: TestServer = await startServer(() => ({
      headers: { 'Content-Type': 'text/xml' },
      body: ADD_RESPONSE,
    }));
    closers.push(() => calculator.close());
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });
    const sent = await call(client, 'send', { item: SOAP_ITEM, environment: 'local' });
    expect(sent).toMatchObject({ isError: false, json: { outcome: 'passed', status: 200 } });
    expect((sent.json as { historyId?: string }).historyId).toMatch(/^[0-9A-Z]{26}$/);

    expect((await call(client, 'generate', {})).isError).toBe(true);
  });
});

describe('mcpBaseFor', () => {
  const io = { stderr: { write: () => true } as unknown as NodeJS.WritableStream, env: {} };
  const parse = (argv: string[]): McpArgs => parseCliArgs(argv) as McpArgs;

  it('turns --allow-send and -e into the send gate and the environment list', () => {
    const base = mcpBaseFor(parse(['mcp', '--allow-send', '-e', 'a,b']), io);
    expect(base.gates).toEqual({ write: false, send: true, environments: ['a', 'b'] });
    expect(base.origin).toBe('mcp');
  });

  it('turns --allow-write alone into the write gate only', () => {
    const base = mcpBaseFor(parse(['mcp', '--allow-write']), io);
    expect(base.gates).toEqual({ write: true, send: false });
    expect(base.origin).toBe('mcp');
  });
});
