/**
 * The GraphQL body (#77): stored as a sibling `.body.graphql` file with its variables in the request
 * document, and lowered to the JSON a server reads right after expansion.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../../src/errors.js';
import { loadProject } from '../../../../src/project/load.js';
import { createProject, FORMAT_VERSION } from '../../../../src/project/model.js';
import type { Project } from '../../../../src/project/model.js';
import type { PropertyScopes } from '../../../../src/project/properties.js';
import { saveProject } from '../../../../src/project/save.js';
import { projectFiles } from '../../../../src/project/serialize.js';
import { encodeRestBody } from '../../../../src/rest/body.js';
import { expandRestSendInput } from '../../../../src/rest/expand.js';
import { graphqlPayload, graphqlPayloadText } from '../../../../src/rest/graphql/body.js';
import { createApi, createRestRequest, restApisOf } from '../../../../src/rest/model.js';
import type { RestBody, RestRequestDef } from '../../../../src/rest/model.js';
import { restSecrets } from '../../../../src/rest/secrets.js';
import type { RestSendInput } from '../../../../src/rest/send.js';
import { tempProjectDir } from '../../project/fixture.js';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../../src/protocols.js';

const REQUESTS = 'apis/shop/requests';

const QUERY = 'query Product($id: ID!) {\n  product(id: $id) { name }\n}\n';

function graphql(overrides: Partial<Extract<RestBody, { kind: 'graphql' }>> = {}): RestBody {
  return { kind: 'graphql', query: QUERY, variables: '{"id": "1"}', ...overrides };
}

function request(body: RestBody = graphql()): RestRequestDef {
  return { ...createRestRequest('Product', { id: 'R1', slug: 'product', method: 'POST', url: '/graphql' }), body };
}

function shop(requests: readonly RestRequestDef[]): Project {
  return {
    ...createProject('Shop', { id: 'P1' }),
    containers: { rest: [createApi('shop', { id: 'A1', baseUrl: 'https://shop.test', requests })] },
  };
}

describe('GraphQL body on disk', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await tempProjectDir();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the query beside the request and the variables in it', () => {
    const files = projectFiles(shop([request(graphql({ operationName: 'Product' }))]));
    expect(files.get(`${REQUESTS}/product.body.graphql`)).toBe(QUERY);
    const document = files.get(`${REQUESTS}/product.request.yaml`)!;
    expect(document).toContain('kind: graphql');
    expect(document).toContain('file: product.body.graphql');
    expect(document).toContain('operationName: Product');
    expect(document).toContain('{"id": "1"}');
    expect(document).not.toContain('product(id: $id)');
  });

  it('leaves blank variables out of the document', () => {
    const document = projectFiles(shop([request(graphql({ variables: '  ' }))])).get(
      `${REQUESTS}/product.request.yaml`,
    )!;
    expect(document).not.toContain('variables');
  });

  it('round-trips through a save and a load', async () => {
    const project = shop([request(graphql({ operationName: 'Product' }))]);
    await saveProject(project, dir);
    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(restApisOf(loaded)[0]!.requests[0]!.body).toEqual(graphql({ operationName: 'Product' }));
  });

  it("round-trips the API's graphqlSchema, and leaves it out when unset", async () => {
    const api = {
      ...restApisOf(shop([request()]))[0]!,
      graphqlSchema: { source: 'https://shop.test/graphql', fetchedAt: '2026-10-13T10:00:00.000Z' },
    };
    const project = { ...shop([]), containers: { rest: [api] } };
    expect(projectFiles(project).get('apis/shop/api.yaml')).toContain('source: https://shop.test/graphql');
    expect(projectFiles(shop([])).get('apis/shop/api.yaml')).not.toContain('graphqlSchema');
    await saveProject(project, dir);
    const { project: loaded } = await loadProject(dir);
    expect(restApisOf(loaded)[0]!.graphqlSchema).toEqual(api.graphqlSchema);
  });

  it('belongs to format 10 or later', () => {
    expect(FORMAT_VERSION).toBeGreaterThanOrEqual(10);
  });

  it('loads a missing query file as an empty query, with a problem', async () => {
    await saveProject(shop([request()]), dir);
    await rm(join(dir, REQUESTS, 'product.body.graphql'));
    const { project, problems } = await loadProject(dir);
    expect(restApisOf(project)[0]!.requests[0]!.body).toEqual(graphql({ query: '' }));
    expect(problems.map((p) => p.code)).toEqual(['missing-body']);
  });

  it('refuses a query file outside the request directory', async () => {
    await saveProject(shop([request()]), dir);
    const file = join(dir, REQUESTS, 'product.request.yaml');
    const text = await readFile(file, 'utf8');
    await writeFile(file, text.replace('file: product.body.graphql', 'file: ../../secret.graphql'));
    await expect(loadProject(dir)).rejects.toThrow();
  });
});

describe('graphqlPayload', () => {
  it('writes query, variables and operation name as one JSON document', () => {
    const body = graphql({ operationName: 'Product' }) as Extract<RestBody, { kind: 'graphql' }>;
    expect(JSON.parse(graphqlPayload(body))).toEqual({
      query: QUERY,
      variables: { id: '1' },
      operationName: 'Product',
    });
  });

  it('leaves blank variables and an absent operation name out', () => {
    const body = graphql({ variables: '' }) as Extract<RestBody, { kind: 'graphql' }>;
    expect(JSON.parse(graphqlPayload(body))).toEqual({ query: QUERY });
  });

  it.each(['{"id": ', '[1]', '"x"'])('refuses variables that are not a JSON object: %s', (variables) => {
    const body = graphql({ variables }) as Extract<RestBody, { kind: 'graphql' }>;
    expect(() => graphqlPayload(body)).toThrow(WirebenchError);
    try {
      graphqlPayload(body);
    } catch (error) {
      expect((error as WirebenchError).code).toBe('graphql-variables-invalid');
    }
  });

  it('keeps unparsable variables as written in the text form', () => {
    const body = graphql({ variables: '{"id": ${id}}' }) as Extract<RestBody, { kind: 'graphql' }>;
    expect(graphqlPayloadText(body)).toBe(`{"query":${JSON.stringify(QUERY)},"variables":{"id": \${id}}}`);
  });

  it('encodes as application/json', async () => {
    const encoded = await encodeRestBody(graphql());
    expect(encoded.contentType).toBe('application/json');
    expect(JSON.parse(new TextDecoder().decode(encoded.bytes))).toEqual({ query: QUERY, variables: { id: '1' } });
  });
});

const scopes: PropertyScopes = {
  project: { id: '7', quote: 'a"b', op: 'Product' },
  global: {},
  system: {},
};

function sendInput(body: RestBody): RestSendInput {
  return {
    baseUrl: 'https://shop.test',
    request: { method: 'POST', url: '/graphql', pathParams: [], query: [], headers: [], body },
    settings: { timeoutMs: 1_000, followRedirects: true },
  };
}

describe('expanding a GraphQL body', () => {
  it('expands every part and lowers the body to JSON', () => {
    const { input, unresolved } = expandRestSendInput(
      sendInput(
        graphql({ query: '{ product(id: "${id}") { name } }', variables: '{"id": ${id}}', operationName: '${op}' }),
      ),
      scopes,
    );
    expect(unresolved).toEqual([]);
    expect(input.request.body).toEqual({
      kind: 'raw',
      language: 'json',
      text: JSON.stringify({ query: '{ product(id: "7") { name } }', variables: { id: 7 }, operationName: 'Product' }),
    });
  });

  it('escapes substituted values as JSON when the request asks for it', () => {
    const { input } = expandRestSendInput(
      sendInput(graphql({ query: '{ a(s: "${quote}") }', variables: '{"s": "${quote}"}' })),
      scopes,
      { escape: true },
    );
    expect(JSON.parse((input.request.body as { text: string }).text)).toEqual({
      query: '{ a(s: "a\\"b") }',
      variables: { s: 'a"b' },
    });
  });

  it('refuses variables that are not JSON once expanded', () => {
    expect(() => expandRestSendInput(sendInput(graphql({ variables: '{"s": ${quote}}' })), scopes)).toThrow(
      /not valid JSON/,
    );
  });

  it('reports an unresolved reference rather than invalid variables', () => {
    const { input, unresolved } = expandRestSendInput(sendInput(graphql({ variables: '{"s": ${missing}}' })), scopes);
    expect(unresolved).toHaveLength(1);
    expect(input.request.body.kind).toBe('raw');
  });
});

describe('the secret scan of a GraphQL body', () => {
  it('scans the query and the variables, and rewrites each', () => {
    const project = shop([request(graphql({ query: '{ a(token: "s3cr3t") }', variables: '{"token": "s3cr3t"}' }))]);
    const targets = [...restSecrets.scanTargets(project)].filter((t) => t.location.kind === 'rest-body');
    expect(targets.map((t) => t.label)).toEqual([
      'shop › Product › GraphQL query',
      'shop › Product › GraphQL variables',
    ]);
    const moved = restSecrets.applyMoves(project, {
      text: (_location: unknown, text: string) => text.replace('s3cr3t', '${secret:token}'),
    } as never);
    expect(restApisOf(moved)[0]!.requests[0]!.body).toEqual(
      graphql({ query: '{ a(token: "${secret:token}") }', variables: '{"token": "${secret:token}"}' }),
    );
  });
});
