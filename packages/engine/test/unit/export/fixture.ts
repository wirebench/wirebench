/** A small project with one container of each kind, for the exporter tests. */
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import type { Project } from '../../../src/project/model.js';
import { createInterface, createProject, createRequest } from '../../../src/project/model.js';
import { createApi, createFolder, createRestRequest } from '../../../src/rest/model.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../src/ws/model.js';

let counter = 0;
export const newId = (): string => `id-${(counter += 1)}`;

export function sampleProject(): Project {
  const getUser = createRestRequest('Get User', {
    newId,
    order: 0,
    method: 'GET',
    url: '/users/{id}?verbose=true',
    pathParams: [{ name: 'id', value: '1', enabled: true }],
    query: [{ name: 'verbose', value: 'true', enabled: true }],
    headers: [{ name: 'X-Trace', value: '${trace}', enabled: true }],
  });
  const createUser = createRestRequest('Create User', {
    newId,
    order: 1,
    method: 'POST',
    url: '/users',
    body: { kind: 'raw', language: 'json', text: '{"name":"${name}"}' },
  });
  const upload = createRestRequest('Upload', {
    newId,
    order: 0,
    method: 'POST',
    url: '/upload',
    body: {
      kind: 'multipart',
      parts: [
        { kind: 'text', name: 'note', value: 'hi', enabled: true },
        { kind: 'file', name: 'file', source: { kind: 'path', path: '/tmp/a.png' }, enabled: true },
      ],
    },
  });
  const rest = createApi('Pets', {
    newId,
    order: 1,
    baseUrl: 'https://pets.example.com',
    auth: { type: 'bearer', tokenRef: 'keychain-ref-123' },
    folders: [
      createFolder('Users', {
        newId,
        order: 0,
        auth: { type: 'basic', username: '${user}', passwordRef: 'keychain-ref-456' },
        requests: [
          {
            ...getUser,
            assertions: [
              { type: 'status', equals: 200 },
              { type: 'match', language: 'jsonpath', expression: '$.name', exists: true },
              { type: 'match', language: 'xpath', expression: '//a', exists: true },
            ],
            scripts: { pre: { text: "pm.environment.set('a', '1');" }, api: 'postman', enabled: false, secrets: [] },
          },
          {
            ...createUser,
            examples: [
              {
                id: 'ex1',
                name: 'created',
                status: 201,
                statusText: 'Created',
                headers: [{ name: 'Content-Type', value: 'application/json', enabled: true }],
                contentType: 'application/json',
                body: '{"id":1}',
              },
            ],
          },
        ],
      }),
    ],
    requests: [upload],
  });
  const iface = createInterface('Orders', {
    newId,
    order: 0,
    definitionUrl: 'https://orders.example.com/orders?wsdl',
    endpoints: [{ id: 'ep1', name: 'main', url: 'https://orders.example.com/soap', authMode: 'override' }],
    operations: [
      {
        name: 'Submit',
        bindingName: '{urn:orders}OrdersBinding',
        slug: 'submit',
        order: 0,
        requests: [
          {
            ...createRequest('Request 1', {
              newId,
              envelopeXml: '<soap:Envelope><soap:Body><id>${orderId}</id></soap:Body></soap:Envelope>',
              soapVersion: '1.1',
              soapAction: 'urn:submit',
              endpointId: 'ep1',
            }),
            wssOutgoingRef: 'signing',
          },
        ],
      },
    ],
  });
  const grpc = createGrpcApi('Pets gRPC', {
    newId,
    order: 2,
    target: 'localhost:50051',
    tls: false,
    requests: [
      createGrpcRequest('Get Pet', {
        newId,
        service: 'pets.v1.Pets',
        method: 'Get',
        methodKind: 'unary',
        message: '{"id":1}',
      }),
    ],
  });
  const ws = createWsApi('Socket', {
    newId,
    order: 3,
    url: 'wss://pets.example.com/ws',
    requests: [
      createWsRequest('Chat', {
        newId,
        url: '',
        messages: [createWsSavedMessage('Hello', { newId, content: '{"hi":"${name}"}', format: 'text' })],
      }),
    ],
  });
  return {
    ...createProject('Pet Store', { newId }),
    properties: { host: 'pets.example.com', apiToken: '${secret:petsToken}', off: 'x' },
    disabledProperties: ['off'],
    containers: { soap: [iface], rest: [rest], grpc: [grpc], websocket: [ws] },

    environments: [
      {
        id: 'env1',
        name: 'Staging',
        slug: 'staging',
        order: 0,
        endpoints: {},
        properties: { host: 'staging.example.com', token: '${secret:stagingToken}' },
        disabledProperties: [],
      },
    ],
  };
}
