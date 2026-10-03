import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../src/main.js';
import type { CliIo } from '../../src/main.js';
import { addEnvironment, removeTempDirs, restProject, soapProject, startServer, tempDir } from './ops/helpers.js';
import type { Fixture, TestServer } from './ops/helpers.js';

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await removeTempDirs();
});

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: { write: (chunk: string) => ((stdout += chunk), true) } as unknown as CliIo['stdout'],
    stderr: { write: (chunk: string) => ((stderr += chunk), true) } as unknown as CliIo['stderr'],
    env: {},
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}

async function calculator(fixture: Fixture): Promise<void> {
  const server = await startServer(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
  servers.push(server);
  await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
}

const where = (fixture: Fixture): string[] => ['--project', fixture.dir, '--history-dir', fixture.historyDir];

describe('wirebench call', () => {
  it('prints the input schema and sends nothing with --schema, by ref or by tool name', async () => {
    const fixture = await soapProject();
    for (const operation of ['CalculatorService/Add', 'calculator_service_add']) {
      const { code, stdout } = await run(['call', operation, '--schema', ...where(fixture)]);
      expect(code).toBe(0);
      expect(Object.keys((JSON.parse(stdout) as { properties: object }).properties)).toEqual([
        'environment',
        'a',
        'b',
        'note',
      ]);
    }
  });

  it('resolves API/operationId, API/METHOD /path and a tool name for a REST operation', async () => {
    const fixture = await restProject();
    const schemas: string[] = [];
    for (const operation of ['Pets/listPets', 'Pets/GET /pets', 'pets_list_pets']) {
      const { code, stdout, stderr } = await run(['call', operation, '--schema', ...where(fixture)]);
      expect({ operation, code, stderr }).toEqual({ operation, code: 0, stderr: '' });
      schemas.push(stdout);
    }
    expect(new Set(schemas).size).toBe(1);
  });

  it('calls with --args and -e, printing the result for a person or as JSON', async () => {
    const fixture = await soapProject();
    await calculator(fixture);
    const human = await run([
      'call',
      'calculator_service_add',
      '--args',
      '{"a":2,"b":3}',
      '-e',
      'local',
      ...where(fixture),
    ]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('200');
    expect(human.stdout).toContain('"result": 5');

    const file = join(await tempDir(), 'args.json');
    await writeFile(file, '{"a":2,"b":3}');
    const json = await run([
      'call',
      'CalculatorService/Add',
      '--args',
      `@${file}`,
      '-e',
      'local',
      '--json',
      ...where(fixture),
    ]);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      result: { result: 5 },
      historyId: expect.any(String) as unknown,
    });
  });

  it('exits 2 for bad arguments or an unknown operation, and 3 when nothing answers', async () => {
    const fixture = await soapProject();
    expect(await run(['call', 'calculator_service_add', '--args', '{"a":"x","b":3}', ...where(fixture)])).toMatchObject(
      {
        code: 2,
        stderr: expect.stringContaining('invalid-input') as unknown,
      },
    );
    expect(await run(['call', 'calculator_service_add', '--args', '[1]', ...where(fixture)])).toMatchObject({
      code: 2,
    });
    expect(await run(['call', 'nope', ...where(fixture)])).toMatchObject({
      code: 2,
      stderr: expect.stringContaining('operation-not-found') as unknown,
    });
    // The WSDL's own address, 127.0.0.1:9, refuses the connection.
    expect((await run(['call', 'calculator_service_add', '--args', '{"a":1,"b":2}', ...where(fixture)])).code).toBe(3);
  });
});
