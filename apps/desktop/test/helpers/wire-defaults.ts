/**
 * Wire-shaped defaults for test fixtures: the request properties and project settings every
 * `RequestWire`/`ProjectWire` carries, so a test that does not care about them can spread one
 * constant instead of restating twenty booleans.
 */

import { DEFAULT_PROJECT_SETTINGS, DEFAULT_REQUEST_PROPERTIES } from '@wirebench/engine';
import type {
  GrpcApiWire,
  GrpcRequestWire,
  ProjectSettingsWire,
  ProjectWire,
  RequestPropertiesWire,
  RestApiWire,
  RestFolderWire,
  RestRequestWire,
} from '../../src/shared/wire-types.js';

/** The default §6.3 request properties, as the renderer mirrors them. */
export const REQUEST_PROPERTIES: RequestPropertiesWire = {
  ...DEFAULT_REQUEST_PROPERTIES,
};

/** The default project settings, as the renderer mirrors them. */
export const PROJECT_SETTINGS: ProjectSettingsWire = { ...DEFAULT_PROJECT_SETTINGS };

/**
 * The REST/gRPC/WebSocket halves of a `ProjectWire`, empty. Spread into a fixture that is about
 * SOAP so the snapshot stays complete without every such test having to mention APIs it does not
 * use.
 */
export const NO_REST: Pick<
  ProjectWire,
  'apis' | 'folders' | 'restRequests' | 'grpcApis' | 'grpcRequests' | 'wsApis' | 'wsRequests'
> = {
  apis: [],
  folders: [],
  restRequests: [],
  grpcApis: [],
  grpcRequests: [],
  wsApis: [],
  wsRequests: [],
};

/** One gRPC API on the wire. */
export function grpcApiWire(overrides: Partial<GrpcApiWire> = {}): GrpcApiWire {
  return {
    kind: 'grpc',
    id: 'grpc-api-1',
    name: 'Greeter',
    slug: 'greeter',
    order: 0,
    target: 'localhost:50051',
    tls: false,
    metadata: [],
    ...overrides,
  };
}

/** One gRPC request on the wire, a unary call with an empty message unless the caller says otherwise. */
export function grpcRequestWire(overrides: Partial<GrpcRequestWire> = {}): GrpcRequestWire {
  return {
    kind: 'grpc',
    id: 'grpc-1',
    apiId: 'grpc-api-1',
    name: 'SayHello',
    slug: 'SayHello',
    order: 0,
    service: 'wirebench.greet.Greeter',
    method: 'SayHello',
    methodKind: 'unary',
    metadata: [],
    message: '{\n  "name": ""\n}\n',
    auth: { type: 'inherit' },
    settings: {},
    ...overrides,
  };
}

/** One REST API on the wire, with everything a fixture rarely cares about filled in. */
export function restApiWire(overrides: Partial<RestApiWire> = {}): RestApiWire {
  return {
    kind: 'rest',
    id: 'api-1',
    name: 'Petstore',
    slug: 'petstore',
    order: 0,
    baseUrl: 'https://api.test',
    servers: [],
    ...overrides,
  };
}

/** One REST folder on the wire. */
export function restFolderWire(overrides: Partial<RestFolderWire> = {}): RestFolderWire {
  return { id: 'folder-1', apiId: 'api-1', name: 'Pets', slug: 'pets', order: 0, ...overrides };
}

/** One REST request on the wire, a bodyless `GET` unless the caller says otherwise. */
export function restRequestWire(overrides: Partial<RestRequestWire> = {}): RestRequestWire {
  return {
    kind: 'rest',
    id: 'rest-1',
    apiId: 'api-1',
    name: 'Get pet',
    slug: 'get-pet',
    order: 0,
    method: 'GET',
    url: '/pet/{petId}',
    pathParams: [],
    query: [],
    headers: [],
    body: { kind: 'none' },
    auth: { type: 'inherit' },
    settings: {},
    ...overrides,
  };
}
