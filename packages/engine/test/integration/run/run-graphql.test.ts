/**
 * A GraphQL request in a run (#77): sent as JSON to a real GraphQL service, its errors failing the run
 * even on HTTP 200, and its data checked against the API's stored schema.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Project } from '#core/project/model';
import { createProject } from '#core/project/model';
import { writeGraphqlSchema } from '#protocol-rest/rest/graphql/schema';
import { createApi, createRestRequest, withRestApis } from '#protocol-rest/rest/model';
import type { RestBody } from '#protocol-rest/rest/model';
import type { RunContext } from '#core/run/context';
import { runRequests } from '#core/run/run';
import type { SentRequest } from '#core/run/run';
import { selectRequests } from '#core/run/select';
import { GRAPHQL_SDL, startTestRestServer } from '../../helpers/index.js';
import type { TestRestServer } from '../../helpers/index.js';
import { testHost } from '../../helpers/send-host.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

let server: TestRestServer;
let dir: string;

beforeAll(async () => {
  server = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-run-graphql-'));
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(body: Extract<RestBody, { kind: 'graphql' }>): Project {
  const request = { ...createRestRequest('Q', { id: 'r1', slug: 'q', method: 'POST', url: '/graphql' }), body };
  return withRestApis(createProject('GraphQL', { id: 'p-gql' }), [
    { ...createApi('Shop', { id: 'api-shop', slug: 'shop', baseUrl: server.url }), requests: [request] },
  ]);
}

async function run(body: Extract<RestBody, { kind: 'graphql' }>) {
  const p = project(body);
  const context: RunContext = { project: p, projectDir: dir, overrides: {}, host: testHost() };
  const result = await runRequests(selectRequests(p, []).selected, context, {
    onSent: (_item, sent) => {
      last = sent;
    },
  });
  return result.requests[0]!;
}

let last: SentRequest | undefined;

describe('a GraphQL request in a run', () => {
  it('passes a response without errors, with a passed GraphQL check', async () => {
    const result = await run({
      kind: 'graphql',
      query: 'query P($id: ID!) { product(id: $id) { id name price } }',
      variables: '{"id": "1"}',
    });
    expect(result.outcome).toBe('passed');
    expect(result.assertions).toEqual([
      { type: 'graphql', label: 'GraphQL errors', outcome: 'passed', expected: 'none', actual: 'none' },
    ]);
    expect(result.unasserted).toBe(true);
  });

  it('fails a 200 response that carries errors', async () => {
    const result = await run({ kind: 'graphql', query: '{ boom }', variables: '' });
    expect(result.status).toBe(200);
    expect(result.outcome).toBe('failed');
    expect(result.assertions[0]).toMatchObject({
      type: 'graphql',
      outcome: 'failed',
      actual: '1 error: Boom from the resolver',
    });
  });

  it('checks the data against the stored schema', async () => {
    await writeGraphqlSchema(dir, 'shop', GRAPHQL_SDL.replace('price: Float', 'price: Int'));
    try {
      await run({ kind: 'graphql', query: '{ product(id: "1") { price } }', variables: '' });
      const graphql = last?.exchange?.kind === 'rest' ? last.exchange.graphql : undefined;
      expect(graphql?.schema).toBe('checked');
      expect(graphql?.problems).toEqual([{ pointer: '/data/product/price', message: 'Not a Int' }]);
    } finally {
      rmSync(join(dir, 'apis'), { recursive: true, force: true });
    }
  });

  it('says there was no schema to check against', async () => {
    await run({ kind: 'graphql', query: '{ product(id: "1") { name } }', variables: '' });
    expect(last?.exchange?.kind === 'rest' ? last.exchange.graphql?.schema : undefined).toBe('no-schema');
  });

  it('errors a send whose variables are not JSON', async () => {
    const result = await run({ kind: 'graphql', query: '{ boom }', variables: '{' });
    expect(result.outcome).toBe('errored');
    expect(result.error?.code).toBe('graphql-variables-invalid');
  });
});
