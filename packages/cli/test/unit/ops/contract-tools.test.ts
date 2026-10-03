// packages/cli/test/unit/ops/contract-tools.test.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProject } from '@wirebench/engine';
import {
  assignNames,
  capMessage,
  checkArgs,
  CONTRACT_TOOL_CAP,
  deriveContractTools,
  FIXED_TOOL_NAMES,
  snakeName,
  toolBaseName,
} from '../../../src/ops/contract-tools.js';
import { runOp } from '../../../src/ops/context.js';
import { OpsError } from '../../../src/ops/errors.js';
import { importOp } from '../../../src/ops/import.js';
import { OPS } from '../../../src/ops/index.js';
import {
  CALCULATOR_WSDL,
  emptyProject,
  manyOperationsOpenApi,
  removeTempDirs,
  restProject,
  tempDir,
  soapProject,
  twoBindingWsdl,
  updateProject,
} from './helpers.js';
import type { Fixture } from './helpers.js';

afterEach(removeTempDirs);

const GATES = { write: false, send: true };

async function derive(fixture: Fixture, containers?: readonly string[]) {
  const { project } = await loadProject(fixture.dir);
  return deriveContractTools(project, {
    projectDir: fixture.dir,
    gates: GATES,
    ...(containers !== undefined ? { containers } : {}),
  });
}

describe('tool names', () => {
  it('are snake_case, split on case changes, with every other run of characters one underscore', () => {
    expect(snakeName('CalculatorService')).toBe('calculator_service');
    expect(snakeName('listPets')).toBe('list_pets');
    expect(snakeName('HTTPServer v2')).toBe('http_server_v2');
    expect(snakeName('get_/pets/{petId}')).toBe('get_pets_pet_id');
    expect(snakeName('--')).toBe('');
  });

  it('keep the operation part, cutting the container first and then the end, at 64 characters', () => {
    expect(toolBaseName('Pets', 'listPets')).toBe('pets_list_pets');
    const long = toolBaseName('A'.repeat(40), 'b'.repeat(40));
    expect(long).toHaveLength(64);
    expect(long.endsWith(`_${'b'.repeat(40)}`)).toBe(true);
    expect(toolBaseName('Pets', 'c'.repeat(80))).toBe('c'.repeat(64));
    expect(toolBaseName('***', '???')).toBe('contract_operation');
  });

  it('take a numeric suffix after a fixed tool or an earlier name', () => {
    expect(FIXED_TOOL_NAMES).toEqual(Object.keys(OPS));
    expect(assignNames(['send', 'a_b', 'a_b', 'a_b'])).toEqual(['send_2', 'a_b', 'a_b_2', 'a_b_3']);
    expect(assignNames(['x'.repeat(64), 'x'.repeat(64)])).toEqual(['x'.repeat(64), `${'x'.repeat(62)}_2`]);
  });
});

describe('deriveContractTools', () => {
  it('makes one tool per SOAP operation, its schema the body plus environment, its description the gate', async () => {
    const set = await derive(await soapProject());
    expect(set.overCap).toBe(false);
    expect(set.counts).toEqual({ CalculatorService: 1 });
    const [tool] = set.tools;
    expect(tool).toMatchObject({
      name: 'calculator_service_add',
      ref: 'CalculatorService/Add',
      kind: 'soap',
      container: 'CalculatorService',
      environmentKey: 'environment',
    });
    expect(Object.keys(tool?.inputSchema['properties'] as object)).toEqual(['environment', 'a', 'b', 'note']);
    expect(tool?.inputSchema['required']).toEqual(['a', 'b']);
    expect(tool?.description).toContain('"CalculatorService"');
    expect(tool?.description).toContain('--allow-send');
    expect(tool?.description).toContain('History');
  });

  it('names a REST endpoint by its operationId and builds path, query, headers and body', async () => {
    const set = await derive(await restProject());
    expect(set.tools.map((tool) => tool.name)).toEqual(['pets_list_pets', 'pets_create_pet', 'pets_show_pet']);
    expect(set.tools[2]?.inputSchema).toMatchObject({
      properties: {
        path: {
          type: 'object',
          properties: { petId: { type: 'integer' } },
          required: ['petId'],
          additionalProperties: false,
        },
      },
      required: ['path'],
    });
    expect(set.tools[1]?.inputSchema).toMatchObject({
      properties: { body: { type: 'object', required: ['name'] } },
      required: ['body'],
    });
    expect(set.tools[1]?.description.startsWith('Create a pet')).toBe(true);
  });

  it('makes two tools of one operation bound twice, the second suffixed and naming its binding', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await twoBindingWsdl() }, fixture.base());
    const set = await derive(fixture);
    expect(set.tools.map((tool) => tool.name)).toEqual(['calculator_service_add', 'calculator_service_add_2']);
    expect(set.tools[1]?.description).toContain('CalculatorSoap12');
  });

  it('keeps only the containers --tools names, none for an empty list, and refuses an unknown one', async () => {
    const fixture = await restProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    expect((await derive(fixture, ['Pets'])).tools.map((tool) => tool.kind)).toEqual(['rest', 'rest', 'rest']);
    // Names are the whole project's, whatever the filter.
    expect((await derive(fixture, ['CalculatorService'])).tools.map((tool) => tool.name)).toEqual([
      'calculator_service_add',
    ]);
    expect((await derive(fixture, [])).tools).toEqual([]);
    await expect(derive(fixture, ['Nope'])).rejects.toMatchObject({ code: 'container-not-found' });
  });

  it('withdraws every tool over the cap, and says how many each container has', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: await manyOperationsOpenApi(CONTRACT_TOOL_CAP + 2) }, fixture.base());
    const set = await derive(fixture);
    expect(set).toMatchObject({ overCap: true, tools: [], total: 130, counts: { Many: 130 } });
    expect(capMessage(set)).toContain('Many: 130');
    expect(capMessage(set)).toContain('--tools');
  });

  it('counts per container add up to the total', async () => {
    const fixture = await restProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    const set = await derive(fixture);
    expect(set.counts).toEqual({ CalculatorService: 1, Pets: 3 });
    expect(Object.values(set.counts).reduce((sum, count) => sum + count, 0)).toBe(set.total);
    expect(set.total).toBe(set.tools.length);
  });

  it('notes a schema over 64 KiB of JSON by its UTF-8 size, and serves it in full', async () => {
    // 33,000 two-byte characters: under 64 Ki characters, over 64 KiB.
    const description = 'é'.repeat(33_000);
    const file = join(await tempDir(), 'wide.openapi.yaml');
    await writeFile(
      file,
      `openapi: 3.0.3
info:
  title: Wide
  version: 1.0.0
servers:
  - url: http://127.0.0.1:9
paths:
  /w:
    post:
      operationId: put
      requestBody:
        content:
          application/json:
            schema:
              type: string
              description: ${description}
      responses:
        '200':
          description: ok
`,
    );
    const fixture = await emptyProject();
    await runOp(importOp, { source: file }, fixture.base());
    const set = await derive(fixture);
    expect(set.tools.map((tool) => tool.name)).toEqual(['wide_put']);
    expect(JSON.stringify(set.tools[0]?.inputSchema)).toContain(description);
    expect(set.notes).toEqual([expect.stringMatching(/^wide_put: its input schema is 6\d KiB/)]);
  });

  it('notes an interface with no cached definition rather than failing', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      settings: { ...project.settings, cacheDefinitions: false },
    }));
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    const set = await derive(fixture);
    expect(set.tools).toEqual([]);
    expect(set.notes).toEqual([expect.stringContaining('CalculatorService')]);
  });
});

describe('checkArgs', () => {
  it('validates against the schema with $refs followed, and refuses ${', async () => {
    const [tool] = (await derive(await soapProject())).tools;
    const schema = tool?.inputSchema ?? {};
    expect(() => checkArgs(schema, { a: 1, b: 2 })).not.toThrow();
    const refused = (args: Record<string, unknown>): OpsError => {
      try {
        checkArgs(schema, args);
      } catch (error) {
        return error as OpsError;
      }
      throw new Error('not refused');
    };
    expect(refused({ a: 'x', b: 2 })).toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('/a') as unknown,
    });
    expect(refused({ a: 1, b: 2, c: 3 }).code).toBe('invalid-input');
    expect(refused({ a: 1, b: 2, note: 'x ${#System#HOME}' }).message).toContain('${');
    expect(refused({ a: 1, b: 2, note: 'x ${#System#HOME}' })).toBeInstanceOf(OpsError);
  });

  it('follows a recursive $defs reference', () => {
    const schema = {
      type: 'object',
      properties: { tree: { $ref: '#/$defs/Tree' } },
      additionalProperties: false,
      $defs: {
        Tree: {
          type: 'object',
          properties: { label: { type: 'string' }, child: { type: 'array', items: { $ref: '#/$defs/Tree' } } },
          required: ['label'],
          additionalProperties: false,
        },
      },
    };
    expect(() => checkArgs(schema, { tree: { label: 'a', child: [{ label: 'b' }] } })).not.toThrow();
    expect(() => checkArgs(schema, { tree: { label: 'a', child: [{ label: 1 }] } })).toThrow(/child\/0\/label/);
  });

  it('refuses only real violations: an unchecked pattern or a spent node budget is no refusal', () => {
    const schema = {
      type: 'object',
      properties: {
        code: { type: 'string', pattern: '^(?:([A-Z]+ ?)+)$' },
        word: { type: 'string', pattern: '^[a-z]+$' },
        list: { type: 'array', items: { type: 'integer' } },
      },
      additionalProperties: false,
    };
    // The nested quantifier is not run (unsafe), and a mismatch is left to the XSD check.
    expect(() => checkArgs(schema, { code: 'abc' })).not.toThrow();
    // A value longer than the validator tests against a pattern.
    expect(() => checkArgs(schema, { word: 'a'.repeat(5_000) })).not.toThrow();
    // More nodes than the validator's budget.
    expect(() => checkArgs(schema, { list: Array.from({ length: 20_000 }, (_, index) => index) })).not.toThrow();
    // A real violation is still refused.
    expect(() => checkArgs(schema, { word: 'A1' })).toThrow(/\/word pattern/);
  });
});
