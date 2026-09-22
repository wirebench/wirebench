/**
 * Update Definition's plan for a REST API: which operations a new version of the document adds,
 * removes and changes (and why), and what changes at the API level.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseOpenApi } from '../../../../src/rest/openapi/import.js';
import type { OpenApiDocument, OpenApiOperation } from '../../../../src/rest/openapi/model.js';
import { planRestUpdate } from '../../../../src/rest/openapi/update.js';

const updateDir = fileURLToPath(new URL('../../../../../../fixtures/openapi/crafted/update/', import.meta.url));

async function load(name: string): Promise<OpenApiDocument> {
  const text = readFileSync(`${updateDir}${name}`, 'utf-8');
  const parsed = await parseOpenApi(
    { kind: 'text', text },
    { fetchDocument: () => Promise.reject(new Error('no fetch expected')) },
  );
  return parsed.document;
}

function doc(operations: OpenApiOperation[], extra: Partial<OpenApiDocument> = {}): OpenApiDocument {
  return {
    version: '3.0',
    declaredVersion: '3.0.3',
    info: { title: 'T', version: '1' },
    servers: [{ url: 'https://a.test' }],
    operations,
    securitySchemes: [],
    tags: [],
    skipped: [],
    ...extra,
  };
}

const op = (extra: Partial<OpenApiOperation> = {}): OpenApiOperation => ({
  method: 'get',
  path: '/pets',
  parameters: [],
  ...extra,
});

describe('planRestUpdate', () => {
  it('reports every difference between the two fixture versions', async () => {
    const plan = planRestUpdate(await load('petstore-update-old.yaml'), await load('petstore-update-next.yaml'));

    expect(plan.added).toEqual([{ method: 'get', path: '/owners', summary: 'List owners' }]);
    expect(plan.removed).toEqual([{ method: 'delete', path: '/pets/{id}', summary: 'Delete a pet' }]);
    expect(plan.changed).toEqual([
      { op: { method: 'get', path: '/pets', summary: 'List pets' }, reasons: ['parameters'] },
      { op: { method: 'post', path: '/pets', summary: 'Add a pet' }, reasons: ['request-body'] },
      { op: { method: 'get', path: '/pets/{id}', summary: 'Get a pet' }, reasons: ['responses'] },
    ]);
    expect(plan.api).toEqual(['servers', 'version']);
  });

  it('finds nothing between a document and itself, cyclic schemas included', async () => {
    const plan = planRestUpdate(await load('petstore-update-old.yaml'), await load('petstore-update-old.yaml'));
    expect(plan).toEqual({ added: [], removed: [], changed: [], api: [] });
  });

  it('compares cyclic schemas built separately without throwing or a false change', () => {
    const cyclic = (): Record<string, unknown> => {
      const node: Record<string, unknown> = { type: 'object', properties: {} };
      (node['properties'] as Record<string, unknown>)['self'] = node;
      return node;
    };
    const withBody = (schema: unknown): OpenApiOperation =>
      op({
        method: 'post',
        requestBody: { content: { 'application/json': { schema: schema as never } } },
        responses: { '200': { content: { 'application/json': { schema } } } },
      });
    const plan = planRestUpdate(doc([withBody(cyclic())]), doc([withBody(cyclic())]));
    expect(plan.changed).toEqual([]);
  });

  it('notices a change deep inside a cyclic schema', () => {
    const a: Record<string, unknown> = { type: 'object' };
    a['properties'] = { self: a, n: { type: 'string' } };
    const b: Record<string, unknown> = { type: 'object' };
    b['properties'] = { self: b, n: { type: 'integer' } };
    const plan = planRestUpdate(
      doc([op({ responses: { '200': { content: { 'application/json': { schema: a } } } } })]),
      doc([op({ responses: { '200': { content: { 'application/json': { schema: b } } } } })]),
    );
    expect(plan.changed.map((c) => c.reasons)).toEqual([['responses']]);
  });

  it('reports each operation reason on its own', () => {
    const base = op();
    const cases: [OpenApiOperation, string][] = [
      [op({ parameters: [{ name: 'q', in: 'query' }] }), 'parameters'],
      [op({ requestBody: { content: { 'text/plain': {} } } }), 'request-body'],
      [op({ responses: { '200': { description: 'ok' } } }), 'responses'],
      [op({ security: [] }), 'security'],
    ];
    for (const [next, reason] of cases) {
      const plan = planRestUpdate(doc([base]), doc([next]));
      expect(plan.changed).toEqual([{ op: { method: 'get', path: '/pets' }, reasons: [reason] }]);
      expect(plan.api).toEqual([]);
    }
  });

  it('ignores the order parameters are listed in', () => {
    const p1 = { name: 'a', in: 'query' as const };
    const p2 = { name: 'b', in: 'header' as const };
    expect(planRestUpdate(doc([op({ parameters: [p1, p2] })]), doc([op({ parameters: [p2, p1] })])).changed).toEqual(
      [],
    );
  });

  it('reports each API-level reason on its own', () => {
    const base = doc([op()]);
    expect(planRestUpdate(base, doc([op()], { servers: [{ url: 'https://b.test' }] })).api).toEqual(['servers']);
    expect(planRestUpdate(base, doc([op()], { security: [{ key: [] }] })).api).toEqual(['security']);
    expect(
      planRestUpdate(
        base,
        doc([op()], { securitySchemes: [{ name: 'key', type: 'apiKey', in: 'header', keyName: 'X' }] }),
      ).api,
    ).toEqual(['security']);
    expect(planRestUpdate(base, doc([op()], { info: { title: 'T', version: '2' } })).api).toEqual(['version']);
    expect(planRestUpdate(base, doc([op()])).changed).toEqual([]);
  });

  it('treats a renamed path as a removal plus an addition', () => {
    const plan = planRestUpdate(doc([op({ path: '/pets' })]), doc([op({ path: '/animals' })]));
    expect(plan.removed).toEqual([{ method: 'get', path: '/pets' }]);
    expect(plan.added).toEqual([{ method: 'get', path: '/animals' }]);
    expect(plan.changed).toEqual([]);
  });

  it('matches methods case-insensitively and keeps document order', () => {
    const plan = planRestUpdate(
      doc([op({ method: 'GET', path: '/b' }), op({ path: '/a' })]),
      doc([op({ path: '/z' }), op({ path: '/b' }), op({ path: '/y' })]),
    );
    expect(plan.added.map((r) => r.path)).toEqual(['/z', '/y']);
    expect(plan.removed.map((r) => r.path)).toEqual(['/a']);
  });
});
