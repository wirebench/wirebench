import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startContractTools } from '../../../src/mcp/contract-tools.js';
import type { ContractToolsHost, StartContractToolsOptions, WatchProject } from '../../../src/mcp/contract-tools.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import {
  addEnvironment,
  emptyProject,
  manyOperationsOpenApi,
  PETS_OPENAPI,
  removeTempDirs,
  soapProject,
  startServer,
  twoBindingWsdl,
} from '../ops/helpers.js';

const TOOLS = ['import', 'operations', 'generate', 'send', 'validate', 'query', 'history_list', 'history_diff'];

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const ADD_RESPONSE_12 =
  '<env:Envelope xmlns:env="http://www.w3.org/2003/05/soap-envelope"><env:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>7</c:result></c:AddResponse>' +
  '</env:Body></env:Envelope>';

const closers: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const close of closers.splice(0).reverse()) {
    await close();
  }
  await removeTempDirs();
});

/** A watcher the test fires by hand. */
function fakeWatch(): { watch: WatchProject; fire(): void; fail(error: Error): void } {
  const listeners: (() => void)[] = [];
  const failures: ((error: Error) => void)[] = [];
  return {
    watch: (_dir, onChange, onError) => {
      listeners.push(onChange);
      failures.push(onError);
      return { close: () => undefined };
    },
    fire: () => {
      for (const listener of listeners) listener();
    },
    fail: (error) => {
      for (const failure of failures) failure(error);
    },
  };
}

async function host(
  base: OpsBase,
  watch: WatchProject,
  options: Omit<StartContractToolsOptions, 'watch'> = {},
): Promise<ContractToolsHost> {
  const started = await startContractTools(base, { watch, debounceMs: 10, ...options });
  closers.push(() => started.close());
  return started;
}

async function connect(base: OpsBase, tools: ContractToolsHost): Promise<Client> {
  const server = createMcpServer(base, '0.0.0-test', tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wirebench-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

function payload(result: Awaited<ReturnType<Client['callTool']>>): { isError: boolean; json: unknown } {
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, json: JSON.parse(first?.text ?? 'null') as unknown };
}

/** Lets queued promise callbacks and the in-memory transport's deliveries run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

describe('contract tools over MCP', () => {
  it('lists the fixed tools first, then one tool per operation with its JSON Schema', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const client = await connect(base, await host(base, fakeWatch().watch));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS, 'calculator_service_add']);
    const add = tools.at(-1);
    expect(add?.inputSchema).toMatchObject({ type: 'object', required: ['a', 'b'] });
    expect(add?.description).toContain('--allow-send');
  });

  it('refuses a call without --allow-send as isError, and calls through with it', async () => {
    const fixture = await soapProject();
    const calculator = await startServer(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    closers.push(() => calculator.close());
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });

    const closed = fixture.base({ gates: { write: false, send: false } });
    const refused = await (
      await connect(closed, await host(closed, fakeWatch().watch))
    ).callTool({
      name: 'calculator_service_add',
      arguments: { environment: 'local', a: 1, b: 2 },
    });
    expect(payload(refused)).toEqual({
      isError: true,
      json: expect.objectContaining({ code: 'send-not-allowed' }) as unknown,
    });

    const open = fixture.base();
    const called = await (
      await connect(open, await host(open, fakeWatch().watch))
    ).callTool({
      name: 'calculator_service_add',
      arguments: { environment: 'local', a: 2, b: 3 },
    });
    expect(payload(called)).toMatchObject({ isError: false, json: { ok: true, result: { result: 5 } } });
  });

  it('calls a SOAP 1.2 binding end to end: its content type and action, and the JSON result', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await twoBindingWsdl() }, fixture.base());
    const calculator = await startServer(() => ({
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8' },
      body: ADD_RESPONSE_12,
    }));
    closers.push(() => calculator.close());
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });

    const base = fixture.base();
    const client = await connect(base, await host(base, fakeWatch().watch));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([...TOOLS, 'calculator_service_add', 'calculator_service_add_2']);
    const called = await client.callTool({
      name: 'calculator_service_add_2',
      arguments: { environment: 'local', a: 3, b: 4 },
    });
    expect(payload(called)).toMatchObject({ isError: false, json: { ok: true, result: { result: 7 } } });
    expect(calculator.received).toHaveLength(1);
    const [sent] = calculator.received;
    expect(sent?.headers['content-type']).toMatch(/^application\/soap\+xml/);
    expect(sent?.headers['content-type']).toContain('action="urn:wirebench:calculator/Add"');
    expect(sent?.headers['soapaction']).toBeUndefined();
    expect(sent?.body).toContain('http://www.w3.org/2003/05/soap-envelope');
  });

  it('answers an unknown tool with operation-gone, and bad arguments with invalid-input', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const client = await connect(base, await host(base, fakeWatch().watch));
    expect(payload(await client.callTool({ name: 'nope', arguments: {} }))).toMatchObject({
      isError: true,
      json: { code: 'operation-gone' },
    });
    expect(
      payload(await client.callTool({ name: 'calculator_service_add', arguments: { a: 'x', b: 1 } })),
    ).toMatchObject({
      isError: true,
      json: { code: 'invalid-input' },
    });
  });

  it('answers a tool named after an Object.prototype member with operation-gone', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const client = await connect(base, await host(base, fakeWatch().watch));
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(payload(await client.callTool({ name, arguments: {} })), name).toMatchObject({
        isError: true,
        json: { code: 'operation-gone' },
      });
    }
  });

  it('checks a fixed tool through its own op: bad arguments are invalid-input', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const client = await connect(base, await host(base, fakeWatch().watch));
    expect(payload(await client.callTool({ name: 'generate', arguments: {} }))).toMatchObject({
      isError: true,
      json: { code: 'invalid-input' },
    });
  });

  it('sends tools/list_changed after an import, and lists the new tools', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const watcher = fakeWatch();
    const tools = await host(base, watcher.watch, { debounceMs: 500 });
    const client = await connect(base, tools);
    let changed = 0;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed += 1;
    });

    await runOp(importOp, { source: PETS_OPENAPI }, base);
    watcher.fire();
    await tools.whenSettled();

    await vi.waitFor(() => {
      expect(changed).toBe(1);
    });
    const { tools: listed } = await client.listTools();
    expect(listed.map((tool) => tool.name)).toContain('pets_show_pet');

    // A change that alters no tool sends nothing: wait past the debounce, then let every delivery run.
    vi.useFakeTimers();
    watcher.fire();
    await vi.advanceTimersByTimeAsync(600);
    await tools.whenSettled();
    await vi.advanceTimersByTimeAsync(600);
    await flush();
    vi.useRealTimers();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changed).toBe(1);
  });

  it('debounces a burst of changes into one rebuild', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const watcher = fakeWatch();
    vi.useFakeTimers();
    const tools = await host(base, watcher.watch, { debounceMs: 500 });
    let calls = 0;
    tools.subscribe(() => {
      calls += 1;
    });
    vi.useRealTimers();
    await runOp(importOp, { source: PETS_OPENAPI }, base);
    vi.useFakeTimers();
    watcher.fire();
    await vi.advanceTimersByTimeAsync(300);
    watcher.fire();
    await vi.advanceTimersByTimeAsync(300);
    // 600 ms after the first change, but only 300 ms after the last: nothing rebuilt yet.
    expect(calls).toBe(0);
    expect(tools.current().tools.map((tool) => tool.name)).toEqual(['calculator_service_add']);
    await vi.advanceTimersByTimeAsync(300);
    vi.useRealTimers();
    await tools.whenSettled();
    expect(calls).toBe(1);
    expect(tools.current().tools.map((tool) => tool.name)).toContain('pets_show_pet');
  });

  it('keeps later listeners and rebuilds going when a listener throws, and warns on stderr', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const watcher = fakeWatch();
    const tools = await host(base, watcher.watch);
    let later = 0;
    tools.subscribe(() => {
      throw new Error('listener broke');
    });
    tools.subscribe(() => {
      later += 1;
    });

    await runOp(importOp, { source: PETS_OPENAPI }, base);
    watcher.fire();
    await tools.whenSettled();
    expect(later).toBe(1);
    expect(fixture.warnings.some((line) => line.includes('listener broke'))).toBe(true);

    await runOp(importOp, { source: await manyOperationsOpenApi(3) }, base);
    watcher.fire();
    await tools.whenSettled();
    expect(later).toBe(2);
    expect(tools.current().tools.map((tool) => tool.name)).toContain('many_op0');
  });

  it('warns once on stderr when the project watch fails, and keeps serving the last set', async () => {
    const fixture = await soapProject();
    const watcher = fakeWatch();
    const tools = await host(fixture.base(), watcher.watch);
    watcher.fail(Object.assign(new Error('watch ENOSPC'), { code: 'ENOSPC' }));
    watcher.fail(new Error('again'));
    const lines = fixture.warnings.filter((line) => line.includes('no longer follow project changes'));
    expect(lines).toEqual(['wirebench mcp: contract tools no longer follow project changes: watch ENOSPC']);
    expect(tools.current().tools.map((tool) => tool.name)).toEqual(['calculator_service_add']);
  });

  it('keeps the last good set and warns when a rebuild cannot read the project', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    const watcher = fakeWatch();
    let calls = 0;
    const tools = await host(base, watcher.watch);
    tools.subscribe(() => {
      calls += 1;
    });
    await writeFile(join(fixture.dir, 'wirebench.yaml'), '{ half written');
    watcher.fire();
    await tools.whenSettled();
    expect(tools.current().tools.map((tool) => tool.name)).toEqual(['calculator_service_add']);
    expect(calls).toBe(0);
    expect(fixture.warnings.some((line) => line.startsWith('contract tools not rebuilt'))).toBe(true);
  });

  it('refuses to start above the cap, and withdraws the tools when a change takes it over', async () => {
    const many = await emptyProject();
    await runOp(importOp, { source: await manyOperationsOpenApi(130) }, many.base());
    await expect(startContractTools(many.base(), { watch: fakeWatch().watch })).rejects.toMatchObject({
      code: 'too-many-tools',
      message: expect.stringContaining('--tools') as unknown,
    });
    expect((await host(many.base(), fakeWatch().watch, { containers: [] })).current().tools).toEqual([]);

    const fixture = await soapProject();
    const base = fixture.base();
    const watcher = fakeWatch();
    const tools = await host(base, watcher.watch);
    await runOp(importOp, { source: await manyOperationsOpenApi(130) }, base);
    watcher.fire();
    await tools.whenSettled();
    expect(tools.current()).toMatchObject({ overCap: true, tools: [] });
    expect(fixture.warnings.some((line) => line.includes('--tools'))).toBe(true);
  });

  it('refuses a --tools name the project does not have', async () => {
    const fixture = await soapProject();
    await expect(
      startContractTools(fixture.base(), { watch: fakeWatch().watch, containers: ['Nope'] }),
    ).rejects.toMatchObject({
      code: 'container-not-found',
    });
  });

  it('stops watching on close, and a change after close rebuilds nothing', async () => {
    const fixture = await soapProject();
    const base = fixture.base();
    let closed = 0;
    let onChange: (() => void) | undefined;
    const tools = await startContractTools(base, {
      debounceMs: 10,
      watch: (_dir, listener) => {
        onChange = listener;
        return {
          close: () => {
            closed += 1;
          },
        };
      },
    });
    tools.close();
    expect(closed).toBe(1);
    await runOp(importOp, { source: PETS_OPENAPI }, base);
    onChange?.();
    await tools.whenSettled();
    expect(tools.current().tools.map((tool) => tool.name)).toEqual(['calculator_service_add']);
  });
});
