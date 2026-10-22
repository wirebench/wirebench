/**
 * Feature switches on the command line (phase 4 spec §5): `--features` over `WIREBENCH_FEATURES`,
 * the registry every verb builds from them, and the refusals that follow from a feature being off.
 */
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { containersOf, createBuiltinRegistry, unsupportedOf } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCliArgs, UsageError } from '../../src/args.js';
import { mcpCommand } from '../../src/commands/mcp.js';
import { ExitCode } from '../../src/exit-codes.js';
import { parseFeatureSwitches, registryFor } from '../../src/features.js';
import { main } from '../../src/main.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { runOp } from '../../src/ops/context.js';
import type { OpsBase } from '../../src/ops/context.js';
import { generateOp } from '../../src/ops/generate.js';
import { importOp } from '../../src/ops/import.js';
import { openProject } from '../../src/ops/project.js';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../src/source-secrets.js';
import { CALCULATOR_WSDL, emptyProject, PETS_OPENAPI, removeTempDirs, soapProject } from './ops/helpers.js';

const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'runner-project');

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

/** Parses with a warning sink, returning both. */
function parse(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = {},
): { switches: Record<string, boolean>; warnings: string[] } {
  const warnings: string[] = [];
  const switches = parseFeatureSwitches(flag, env, (line) => warnings.push(line));
  return { switches, warnings };
}

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

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; json: unknown }> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  return { isError: result.isError === true, json: JSON.parse(first?.text ?? 'null') };
}

describe('parseFeatureSwitches', () => {
  it('reads the WIREBENCH_AREAS grammar: id=on|off, commas, any case, spaces trimmed', () => {
    expect(parse(' GRPC = Off , soap=ON ').switches).toEqual({ grpc: false, soap: true });
    expect(parse('', {}).switches).toEqual({});
    expect(parse(undefined, {}).switches).toEqual({});
    expect(parse('grpc=off,', {}).switches).toEqual({ grpc: false });
  });

  it('lays the flag over the variable per id', () => {
    const env = { WIREBENCH_FEATURES: 'grpc=off,soap=off' };
    expect(parse('soap=on', env).switches).toEqual({ grpc: false, soap: true });
    expect(parse(undefined, env).switches).toEqual({ grpc: false, soap: false });
  });

  it('refuses a malformed flag entry as a usage error and ignores a malformed variable entry', () => {
    expect(() => parse('grpc')).toThrow(UsageError);
    expect(() => parse('grpc=maybe')).toThrow(
      /--features takes a comma-separated list of <id>=on\|off, got "grpc=maybe"/,
    );
    expect(() => parse('=off')).toThrow(UsageError);
    expect(() => parse('grpc=off=on')).toThrow(UsageError);
    expect(parse(undefined, { WIREBENCH_FEATURES: 'grpc,soap=maybe,rest=off' }).switches).toEqual({ rest: false });
  });

  it('warns once per unknown id and drops it', () => {
    const { switches, warnings } = parse('mqtt=off,grpc=off', { WIREBENCH_FEATURES: 'mqtt=on' });
    expect(switches).toEqual({ grpc: false });
    expect(warnings).toEqual(['unknown feature "mqtt" ignored']);
  });

  it('names every built-in feature', () => {
    const ids = [
      'soap',
      'rest',
      'grpc',
      'websocket',
      'mcp',
      'scripts',
      'sequences',
      'webhooks',
      'server-sync',
      'team-secrets',
      'mcp-server',
    ];
    const { switches, warnings } = parse(ids.map((id) => `${id}=off`).join(','));
    expect(warnings).toEqual([]);
    expect(Object.keys(switches).sort()).toEqual([...ids].sort());
  });
});

describe('registryFor', () => {
  it('builds the built-in registry with the switches applied, requires included', () => {
    const registry = registryFor({ 'server-sync': false, grpc: false });
    expect(registry.features.isEnabled('grpc')).toBe(false);
    expect(registry.features.isEnabled('team-secrets')).toBe(false);
    expect(registry.features.whyDisabled('team-secrets')).toEqual({ by: 'requires', feature: 'server-sync' });
    expect(registry.features.isEnabled('soap')).toBe(true);
    expect(registry.status('grpc')).toBe('disabled');
  });
});

describe('--features on the command line', () => {
  it('is accepted by every verb and carried as typed', () => {
    expect(parseCliArgs(['run', 'p', '--features', 'grpc=off'])).toMatchObject({
      command: 'run',
      features: 'grpc=off',
    });
    expect(parseCliArgs(['send', 'r', '--features', 'soap=off'])).toMatchObject({
      command: 'op',
      features: 'soap=off',
    });
    expect(parseCliArgs(['mcp', '--features', 'mcp-server=off'])).toMatchObject({
      command: 'mcp',
      features: 'mcp-server=off',
    });
    expect(parseCliArgs(['mock', 'p', '--features', 'rest=off'])).toMatchObject({
      command: 'mock',
      features: 'rest=off',
    });
    expect(parseCliArgs(['call', 'op', '--features', 'rest=off'])).toMatchObject({
      command: 'call',
      features: 'rest=off',
    });
    expect(parseCliArgs(['export', 'postman', '--features', 'rest=off'])).toMatchObject({ command: 'export' });
    expect(parseCliArgs(['ssh', 'forward', 'h', '--features', 'grpc=off'])).toMatchObject({
      command: 'ssh-forward',
      features: 'grpc=off',
    });
  });

  it('is absent from the parsed arguments when not given', () => {
    expect(parseCliArgs(['run', 'p'])).not.toHaveProperty('features');
    expect(parseCliArgs(['mcp'])).not.toHaveProperty('features');
  });

  it('is in the help text', async () => {
    const stdout = sink();
    await main(['--help'], { stdout: stdout.stream, stderr: sink().stream, env: {} });
    expect(stdout.text()).toContain('--features <id=on|off,…>');
    expect(stdout.text()).toContain('WIREBENCH_FEATURES');
  });

  it('refuses a malformed list with exit 2 before anything runs', async () => {
    const stderr = sink();
    const code = await main(['run', FIXTURE, '--features', 'grpc'], {
      stdout: sink().stream,
      stderr: stderr.stream,
      env: {},
    });
    expect(code).toBe(ExitCode.Usage);
    expect(stderr.text()).toContain('--features takes a comma-separated list of <id>=on|off, got "grpc"');
  });
});

describe('wirebench run --sequence with sequences off', () => {
  it('exits 2 with feature-disabled before any send, from the flag or the variable', async () => {
    for (const [argv, env] of [
      [['run', FIXTURE, '--sequence', 'smoke', '--features', 'sequences=off'], {}],
      [['run', FIXTURE, '--sequence', 'smoke'], { WIREBENCH_FEATURES: 'sequences=off' }],
    ] as const) {
      const stdout = sink();
      const stderr = sink();
      const code = await main([...argv], { stdout: stdout.stream, stderr: stderr.stream, env: { ...env } });
      expect(code).toBe(ExitCode.Usage);
      expect(stderr.text()).toBe('feature-disabled: Sequences is switched off\n');
      expect(stdout.text()).toBe('');
    }
  });

  it('still runs requests, and warns about an unknown id once', async () => {
    const stderr = sink();
    const code = await main(['run', FIXTURE, '-e', 'local', 'apis/demo/nothing-here', '--features', 'mqtt=off'], {
      stdout: sink().stream,
      stderr: stderr.stream,
      env: { WIREBENCH_FEATURES: 'mqtt=off' },
    });
    // The selector matches nothing: refused as usage, after the feature line was parsed once.
    expect(code).toBe(ExitCode.Usage);
    expect(stderr.text().match(/unknown feature "mqtt" ignored/g)).toHaveLength(1);
  });
});

describe('wirebench mcp with mcp-server off', () => {
  const ARGS = {
    command: 'mcp',
    project: FIXTURE,
    allowWrite: false,
    allowSend: false,
    allowCommands: false,
    secretSources: DEFAULT_CLI_SECRET_SOURCES,
  } as const;

  it('writes feature-disabled to stderr and exits 2 before serving', async () => {
    const stdout = sink();
    const stderr = sink();
    const code = await mcpCommand(
      { ...ARGS, features: 'mcp-server=off' },
      { stdout: stdout.stream, stderr: stderr.stream, env: {} },
    );
    expect(code).toBe(ExitCode.Usage);
    expect(stderr.text()).toBe('feature-disabled: MCP server is switched off\n');
    expect(stdout.text()).toBe('');
  });

  it('reads the variable too', async () => {
    const stderr = sink();
    const code = await mcpCommand(ARGS, {
      stdout: sink().stream,
      stderr: stderr.stream,
      env: { WIREBENCH_FEATURES: 'MCP-SERVER=off' },
    });
    expect(code).toBe(ExitCode.Usage);
    expect(stderr.text()).toBe('feature-disabled: MCP server is switched off\n');
  });
});

describe('openProject through a switched registry', () => {
  it('holds a gRPC API as a placeholder when grpc is off', async () => {
    const warnings: string[] = [];
    const opened = await openProject({
      projectDir: FIXTURE,
      warn: (line) => warnings.push(line),
      registry: registryFor({ grpc: false }),
    });
    expect(containersOf(opened.project, 'grpc')).toEqual([]);
    expect(unsupportedOf(opened.project).map((placeholder) => placeholder.kind)).toEqual(['grpc']);
    expect(warnings.some((line) => line.startsWith('container-unsupported:'))).toBe(true);

    const all = await openProject({ projectDir: FIXTURE, warn: () => undefined, registry: registryFor({}) });
    expect(containersOf(all.project, 'grpc')).toHaveLength(1);
    expect(unsupportedOf(all.project)).toEqual([]);
  });
});

describe('the ops with a feature off', () => {
  it('refuses generate before its input is looked at', async () => {
    const fixture = await soapProject();
    const base = fixture.base({ registry: createBuiltinRegistry({ soap: false }) });
    await expect(runOp(generateOp, { not: 'the input' }, base)).rejects.toMatchObject({
      code: 'feature-disabled',
      message: 'SOAP is switched off',
      details: { feature: 'soap' },
    });
    await expect(runOp(generateOp, { not: 'the input' }, fixture.base())).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });

  it('import refuses a WSDL with soap off and an OpenAPI document with rest off, by detected format', async () => {
    const fixture = await emptyProject();
    await expect(
      runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base({ registry: createBuiltinRegistry({ soap: false }) })),
    ).rejects.toMatchObject({ code: 'feature-disabled', details: { feature: 'soap' } });
    await expect(
      runOp(importOp, { source: PETS_OPENAPI }, fixture.base({ registry: createBuiltinRegistry({ rest: false }) })),
    ).rejects.toMatchObject({ code: 'feature-disabled', details: { feature: 'rest' } });
    // The other kind still imports under each switch.
    await expect(
      runOp(importOp, { source: PETS_OPENAPI }, fixture.base({ registry: createBuiltinRegistry({ soap: false }) })),
    ).resolves.toMatchObject({ format: 'openapi' });
  });
});

describe('the MCP server with soap off', () => {
  it('omits generate and validate from tools/list and refuses a call to them with feature-disabled', async () => {
    const fixture = await soapProject();
    const client = await connect(fixture.base({ registry: createBuiltinRegistry({ soap: false }) }));
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'import',
      'operations',
      'send',
      'query',
      'history_list',
      'history_diff',
    ]);
    expect(await call(client, 'generate', { operation: 'CalculatorService/Add' })).toEqual({
      isError: true,
      json: { code: 'feature-disabled', message: 'SOAP is switched off' },
    });
    expect(await call(client, 'validate', { operation: 'CalculatorService/Add', text: '<a/>' })).toMatchObject({
      isError: true,
      json: { code: 'feature-disabled' },
    });
    // The interface imported before the switch is a placeholder now: operations lists nothing of it.
    expect(await call(client, 'operations', {})).toMatchObject({ isError: false, json: { operations: [] } });
    expect(client.getInstructions()).not.toContain('switch');
  });
});
