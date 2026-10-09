/**
 * REST's mock facet (spec §Validation → REST, §Generating a mock): routes a request to an operation
 * of the API's cached OpenAPI document, checks its parameters and body, and answers what it refuses
 * with `application/problem+json`.
 */

import { WirebenchError } from '../errors.js';
import { resolveRefs } from '../json/schema/refs.js';
import type { ResolvedDocument } from '../json/schema/refs.js';
import { sampleFromSchema } from '../json/schema/sample.js';
import type {
  GeneratedMock,
  GeneratedMockResponse,
  MockContract,
  MockProblem,
  MockReply,
  MockRequest,
  MockRoute,
  ProtocolMocking,
} from '../mock/contract.js';
import { mockPathPrefix } from '../mock/model.js';
import type { MockResponse, MockValidation } from '../mock/model.js';
import { apiDefinitionDir } from '../project/paths.js';
import type { Project } from '../project/model.js';
import type { HeaderPair } from '../script/model.js';
import type { RestApi } from './model.js';
import { createCachedApiFetch, readApiDefinitionCache } from './openapi/cache.js';
import { askedDocument, openApiReply } from './mock-openapi.js';
import { matchOperation } from './openapi/match.js';
import type { OpenApiDocument, OpenApiOperation, OpenApiParameter, OpenApiResponse } from './openapi/model.js';
import { parseOpenApiDocument, parseSchema } from './openapi/parse.js';
import { checkRestRequest, isJsonMediaType } from './request-check.js';

/** Problems a refusal lists, at most. */
const MAX_LISTED = 20;

function definitionMissing(api: RestApi): WirebenchError {
  return new WirebenchError(
    'mock-definition-missing',
    `The API "${api.name}" has no readable cached OpenAPI document; import it again with definitions cached`,
    { details: { api: api.name } },
  );
}

type Node = Readonly<Record<string, unknown>>;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(node: Node | undefined, key: string): unknown {
  return node !== undefined && Object.prototype.hasOwnProperty.call(node, key) ? node[key] : undefined;
}

/** An own member that is itself an object, else undefined. */
function child(node: Node | undefined, key: string): Node | undefined {
  const value = own(node, key);
  return isNode(value) ? value : undefined;
}

/**
 * The API's cached document, parsed and also as the resolved tree. The parsed model keeps only the
 * sample generator's subset of a request schema and no response examples; validating a request needs
 * every keyword (`minimum`, `pattern`, …) and generating a stub wants the examples, so both read the
 * resolved nodes, as response validation already does. The cached documents themselves are what the
 * mock serves at `openapi.json`.
 */
async function loadContract(
  project: Project,
  root: string,
  containerId: string,
): Promise<{
  readonly document: OpenApiDocument;
  readonly resolved: unknown;
  readonly documents: readonly ResolvedDocument[];
}> {
  const api = project.apis.find((candidate) => candidate.id === containerId);
  if (api === undefined) {
    throw new WirebenchError('mock-container-missing', `The project has no API with id ${containerId}`, {
      details: { containerId },
    });
  }
  const dir = apiDefinitionDir(root, api.slug);
  try {
    const cached = await readApiDefinitionCache(dir);
    const offline = createCachedApiFetch(cached.manifest, dir, () => Promise.reject(definitionMissing(api)));
    const fetched = await offline(cached.manifest.rootLocation);
    const resolved = await resolveRefs(fetched.text, fetched.location, { fetchDocument: offline }, fetched.bytes);
    return {
      document: parseOpenApiDocument(resolved.document),
      resolved: resolved.document,
      documents: cached.documents,
    };
  } catch {
    throw definitionMissing(api);
  }
}

/** The resolved node of one operation: `paths[path][method]`, and the path item for its parameters. */
function rawOperation(resolved: unknown, operation: OpenApiOperation): { readonly item?: Node; readonly op?: Node } {
  const item = child(child(isNode(resolved) ? resolved : undefined, 'paths'), operation.path);
  const op = child(item, operation.method);
  return { ...(item !== undefined ? { item } : {}), ...(op !== undefined ? { op } : {}) };
}

function rawParameterSchema(list: unknown, parameter: OpenApiParameter): unknown {
  if (!Array.isArray(list)) return undefined;
  const found = list.find(
    (entry): entry is Node => isNode(entry) && entry['name'] === parameter.name && entry['in'] === parameter.in,
  );
  return own(found, 'schema');
}

/**
 * The operation with its parameter and body schemas replaced by the resolved nodes, every keyword
 * kept. A node the document does not have (a Swagger 2.0 parameter, synthesised by the parser) keeps
 * the parsed schema.
 */
function withFullSchemas(resolved: unknown, operation: OpenApiOperation): OpenApiOperation {
  const { item, op } = rawOperation(resolved, operation);
  const parameters = operation.parameters.map((parameter) => {
    const schema =
      rawParameterSchema(own(op, 'parameters'), parameter) ?? rawParameterSchema(own(item, 'parameters'), parameter);
    return isNode(schema) ? { ...parameter, schema } : parameter;
  });
  const body = operation.requestBody;
  const rawContent = child(child(op, 'requestBody'), 'content');
  const content =
    body === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(body.content).map(([type, media]) => {
            const schema = child(child(rawContent, type), 'schema');
            return [type, schema !== undefined ? { ...media, schema } : media];
          }),
        );
  return {
    ...operation,
    parameters,
    ...(body !== undefined && content !== undefined ? { requestBody: { ...body, content } } : {}),
  };
}

/** The resolved media object of one documented response, for its `example` and `examples`. */
function rawResponseMedia(
  resolved: unknown,
  operation: OpenApiOperation,
  status: string,
  type: string,
): Node | undefined {
  const { op } = rawOperation(resolved, operation);
  return child(child(child(child(op, 'responses'), status), 'content'), type);
}

/** An operation's key: its lower-case method and templated path. */
export function restOperationKey(operation: { readonly method: string; readonly path: string }): string {
  return `${operation.method.toLowerCase()} ${operation.path}`;
}

function problemJson(status: number, type: string, title: string, errors?: readonly MockProblem[]): MockReply {
  const document = {
    type: `urn:wirebench:mock:${type}`,
    title,
    status,
    ...(errors !== undefined && errors.length > 0
      ? {
          errors: errors.slice(0, MAX_LISTED).map((error) => ({
            ...(error.in !== undefined ? { in: error.in } : {}),
            ...(error.name !== undefined ? { name: error.name } : {}),
            path: error.path ?? '',
            message: error.message,
          })),
        }
      : {}),
  };
  return {
    status,
    headers: [['Content-Type', 'application/problem+json']],
    body: `${JSON.stringify(document, null, 2)}\n`,
  };
}

function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

/** The path parameters of `actual` under `template`, decoded; a segment that will not decode stays raw. */
function pathParamsOf(template: string, actual: string): Record<string, string> {
  const params = Object.create(null) as Record<string, string>;
  const wanted = segments(template);
  const got = segments(actual);
  wanted.forEach((segment, index) => {
    const match = /^\{([^}]+)\}$/.exec(segment);
    const value = got[index];
    if (match?.[1] !== undefined && value !== undefined) {
      try {
        params[match[1]] = decodeURIComponent(value);
      } catch {
        params[match[1]] = value;
      }
    }
  });
  return params;
}

function header(request: MockRequest, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return request.headers.find(([candidate]) => candidate.toLowerCase() === wanted)?.[1];
}

function bodyKindOf(contentType: string | undefined): 'xml' | 'json' | 'other' {
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (isJsonMediaType(type)) return 'json';
  if (type === 'application/xml' || type === 'text/xml' || type.endsWith('+xml')) return 'xml';
  return 'other';
}

function createContract(
  document: OpenApiDocument,
  resolved: unknown,
  documents: readonly ResolvedDocument[],
  mockPath: string,
): MockContract {
  const operations = document.operations.map((operation) => withFullSchemas(resolved, operation));
  const prefix = mockPathPrefix(mockPath);
  const relative = (path: string): string => {
    const rest = path.slice(prefix.length);
    return rest === '' ? '/' : rest;
  };

  function route(request: MockRequest, mode: MockValidation): MockRoute {
    const path = relative(request.path);
    const found = matchOperation(operations, request.method, path, []);
    if (found === undefined) {
      const allowed = [
        ...new Set(
          operations
            .filter((operation) => matchOperation([operation], operation.method, path, []) !== undefined)
            .map((operation) => operation.method.toUpperCase()),
        ),
      ];
      if (allowed.length > 0) {
        const problem = { code: 'mock-operation-not-found', message: `${request.method} is not allowed on ${path}` };
        const reply = problemJson(405, 'method-not-allowed', problem.message);
        return {
          kind: 'refused',
          problems: [problem],
          reply: { ...reply, headers: [...reply.headers, ['Allow', allowed.join(', ')]] },
        };
      }
      const problem = { code: 'mock-operation-not-found', message: `No operation matches ${request.method} ${path}` };
      return { kind: 'refused', problems: [problem], reply: problemJson(404, 'not-found', problem.message) };
    }
    const operation = operations.find(
      (candidate) => candidate.method === found.method && candidate.path === found.path,
    ) as OpenApiOperation;
    const key = restOperationKey(operation);
    const pathParams = pathParamsOf(operation.path, path);
    const view = { bodyKind: bodyKindOf(header(request, 'content-type')), pathParams };
    if (mode === 'off') {
      return { kind: 'operation', operation: key, problems: [], view };
    }
    const checked = checkRestRequest({
      operation,
      pathParams,
      query: request.query,
      headers: request.headers,
      bodyText: request.bodyText,
    });
    const problems: MockProblem[] = checked.problems.map((problem) => ({
      code: 'mock-request-invalid',
      message: problem.message,
      in: problem.in,
      ...(problem.name !== undefined ? { name: problem.name } : {}),
      path: problem.path,
    }));
    if (mode === 'reject' && problems.length > 0) {
      const status = checked.unsupportedMediaType ? 415 : 400;
      return {
        kind: 'refused',
        operation: key,
        problems,
        reply: problemJson(status, 'request-invalid', 'The request does not conform to the contract', problems),
      };
    }
    return { kind: 'operation', operation: key, problems, view };
  }

  return {
    operations: operations.map((operation) => ({
      key: restOperationKey(operation),
      name: `${operation.method.toUpperCase()} ${operation.path}`,
    })),

    definition(request: MockRequest, mockUrl: string): MockReply | undefined {
      if (request.method !== 'GET') return undefined;
      const path = relative(request.path);
      const asked = askedDocument(path);
      // An operation the API itself has at that path is routed, not shadowed by the document.
      if (asked === undefined || matchOperation(operations, 'GET', path, []) !== undefined) return undefined;
      return openApiReply(documents, asked.index, asked.format, mockUrl);
    },

    route(request: MockRequest, mode: MockValidation): Promise<MockRoute> {
      return Promise.resolve(route(request, mode));
    },

    fail(code: string, message: string): MockReply {
      const status = code === 'mock-no-stub' ? 501 : code === 'mock-operation-not-found' ? 404 : 500;
      return problemJson(status, code.replace(/^mock-/, ''), message);
    },

    defaults(response: MockResponse): readonly HeaderPair[] {
      switch (response.body) {
        case 'xml':
          return [['Content-Type', 'application/xml']];
        case 'json':
          return [['Content-Type', 'application/json']];
        case 'text':
          return [['Content-Type', 'text/plain; charset=utf-8']];
        case 'none':
          return [];
      }
    },
  };
}

/** The status a generated response uses: the lowest documented 2xx, else `2XX` or `default` as 200. */
function chooseStatus(responses: Readonly<Record<string, OpenApiResponse>>): {
  readonly status: number;
  readonly key?: string;
  readonly response?: OpenApiResponse | undefined;
} {
  const codes = Object.keys(responses)
    .filter((key) => /^2\d\d$/.test(key))
    .sort();
  const first = codes[0];
  if (first !== undefined) return { status: Number(first), key: first, response: responses[first] };
  for (const key of ['2XX', '2xx', 'default']) {
    if (responses[key] !== undefined) return { status: 200, key, response: responses[key] };
  }
  return { status: 200 };
}

interface ExampleMedia {
  readonly schema?: unknown;
  readonly example?: unknown;
  readonly examples?: Readonly<Record<string, { readonly value?: unknown }>>;
}

function exampleOf(media: ExampleMedia): unknown {
  if (media.example !== undefined) return media.example;
  for (const example of Object.values(media.examples ?? {})) {
    if (example.value !== undefined) return example.value;
  }
  return undefined;
}

function generateResponse(resolved: unknown, operation: OpenApiOperation): GeneratedMockResponse {
  const { status, key, response } = chooseStatus(operation.responses ?? {});
  const content = response?.content ?? {};
  const types = Object.keys(content);
  const type = types.find((candidate) => isJsonMediaType(candidate)) ?? types[0];
  if (type === undefined || status === 204) {
    return { status, body: 'none', bodyText: '' };
  }
  const media = (rawResponseMedia(resolved, operation, key ?? '', type) ?? content[type] ?? {}) as ExampleMedia;
  const json = isJsonMediaType(type);
  const headers =
    json && type.toLowerCase() !== 'application/json' ? [{ name: 'Content-Type', value: type }] : undefined;
  let value = exampleOf(media);
  if (value === undefined && media.schema !== undefined && json) {
    value = isNode(media.schema) ? sampleFromSchema(parseSchema(media.schema), { includeOptional: true }) : undefined;
  }
  if (value === undefined) {
    return { status, body: 'none', bodyText: '', ...(headers !== undefined ? { headers } : {}) };
  }
  if (json) {
    return {
      status,
      body: 'json',
      bodyText: `${JSON.stringify(value, null, 2)}\n`,
      ...(headers !== undefined ? { headers } : {}),
    };
  }
  const kind = bodyKindOf(type);
  return {
    status,
    body: kind === 'xml' ? 'xml' : 'text',
    bodyText: typeof value === 'string' ? value : JSON.stringify(value),
    headers: [{ name: 'Content-Type', value: type }],
  };
}

/** REST's mock facet. */
export const restMocking: ProtocolMocking = {
  async open({ project, root, mock }) {
    const { document, resolved, documents } = await loadContract(project, root, mock.source.containerId);
    return createContract(document, resolved, documents, mock.path);
  },

  async generate({ project, root, containerId }): Promise<GeneratedMock> {
    const { document, resolved } = await loadContract(project, root, containerId);
    return {
      operations: document.operations.map((operation) => ({
        key: restOperationKey(operation),
        name: operation.operationId ?? `${operation.method.toUpperCase()} ${operation.path}`,
        response: generateResponse(resolved, operation),
      })),
    };
  },
};
