import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ContractChange } from '../../../../src/contract-diff/model.js';
import { diffOpenApiContracts } from '../../../../src/rest/openapi/contract-diff.js';
import { parseOpenApi } from '../../../../src/rest/openapi/import.js';
import type { OpenApiDocument } from '../../../../src/rest/openapi/model.js';

const fixtures = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/contract-diff/', import.meta.url));

async function load(name: string): Promise<OpenApiDocument> {
  const path = join(fixtures, name);
  const text = await readFile(path, 'utf8');
  const parsed = await parseOpenApi(
    { kind: 'text', text, location: pathToFileURL(path).href },
    { fetchDocument: () => Promise.reject(new Error('no fetch')) },
  );
  return parsed.document;
}

const row = (change: ContractChange): string =>
  [change.severity, change.kind, change.operation ?? '-', change.location ?? '-'].join(' ');

let v1: OpenApiDocument;
let v2: OpenApiDocument;

beforeAll(async () => {
  v1 = await load('v1.yaml');
  v2 = await load('v2.yaml');
});

const SIDES = { old: { label: 'v1.yaml' }, new: { label: 'v2.yaml' } };

describe('diffOpenApiContracts', () => {
  it('finds every change of the fixture pair, classified, breaking first', () => {
    const diff = diffOpenApiContracts(v1, v2, SIDES);
    expect(diff.format).toBe('openapi');
    expect(diff.operationsCompared).toBe(2);
    expect(diff.changes.map(row)).toEqual([
      'breaking operation-removed DELETE /orders/{id} -',
      'breaking endpoint-moved - -',
      'breaking field-required GET /orders request.query.limit',
      'breaking enum-values-added GET /orders response.200[].status',
      'breaking type-narrowed POST /orders request.body.quantity',
      'breaking field-required POST /orders request.body.note',
      'breaking enum-values-removed POST /orders request.body.priority',
      'breaking enum-values-added POST /orders response.201.status',
      'compatible operation-added GET /orders/{id} -',
      'compatible field-added GET /orders response.200[].eta',
      'compatible field-added POST /orders response.201.eta',
    ]);
  });

  it('takes the title and version from each document', () => {
    const diff = diffOpenApiContracts(v1, v2, SIDES);
    expect(diff.old).toEqual({ label: 'v1.yaml', title: 'Orders', version: '1.0.0' });
    expect(diff.new).toEqual({ label: 'v2.yaml', title: 'Orders', version: '2.0.0' });
  });

  it('finds nothing between a document and itself, cycles and all', () => {
    expect(diffOpenApiContracts(v1, v1, SIDES).changes).toEqual([]);
  });

  it('classifies responses, media types, request bodies and security', async () => {
    const base = await load('v1.yaml');
    const post = base.operations.find((op) => op.method === 'post');
    if (post === undefined) throw new Error('fixture has no POST');
    const changedPost = {
      ...post,
      security: [{ key: [] }],
      requestBody: { required: true, content: { 'application/xml': { schema: { type: 'string' } } } },
      responses: { '400': { description: 'bad' } },
    };
    const next: OpenApiDocument = {
      ...base,
      operations: base.operations.map((op) => (op === post ? changedPost : op)),
    };
    const rows = diffOpenApiContracts(base, next, SIDES).changes.map(row);
    expect(rows).toEqual([
      'breaking security-changed POST /orders -',
      'breaking field-required POST /orders request.body',
      'breaking media-type-removed POST /orders request.body',
      'breaking response-removed POST /orders response.201',
      'compatible media-type-added POST /orders request.body',
      'compatible response-added POST /orders response.400',
    ]);
  });
});
