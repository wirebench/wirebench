import { describe, expect, it } from 'vitest';
import { createInterface, createProject, createRequest } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { requestFileLocation } from '../../../src/project/request-location.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { createApi, createFolder, createRestRequest } from '../../../src/rest/model.js';
import { createGrpcApi, createGrpcRequest } from '../../../src/grpc/model.js';
import { createWsApi, createWsRequest } from '../../../src/ws/model.js';

function projectWith(patch: Partial<Project>): Project {
  return { ...createProject('Demo', { id: 'P1' }), ...patch };
}

describe('requestFileLocation', () => {
  it('locates a SOAP request', () => {
    const request = createRequest('Ping', { id: 'r1', envelopeXml: '<x/>', soapVersion: '1.1' });
    const iface = createInterface('Country Info', {
      id: 'i1',
      definitionUrl: 'https://example.test/wsdl',
      operations: [{ name: 'Ping', bindingName: '{ns}Ping', slug: 'ping', order: 0, requests: [request] }],
    });
    const project = projectWith({ interfaces: [iface] });

    const location = requestFileLocation(project, 'r1');
    expect(location).toEqual({ dir: 'interfaces/Country Info/operations/ping', slug: 'Ping' });
    const files = projectFiles(project);
    expect(files.has(`${location!.dir}/${location!.slug}.request.yaml`)).toBe(true);
  });

  it('locates a REST request at the root of an API', () => {
    const request = createRestRequest('Get pet', { id: 'r1', url: '/pets/1' });
    const api = createApi('Pets', { id: 'a1', requests: [request] });
    const project = projectWith({ apis: [api] });

    const location = requestFileLocation(project, 'r1');
    expect(location).toEqual({ dir: 'apis/Pets/requests', slug: 'Get pet' });
    const files = projectFiles(project);
    expect(files.has(`${location!.dir}/${location!.slug}.request.yaml`)).toBe(true);
  });

  it('locates a REST request nested in folders', () => {
    const request = createRestRequest('List orders', { id: 'r1', url: '/orders' });
    const inner = createFolder('Orders v2', { id: 'f2', requests: [request] });
    const outer = createFolder('Internal', { id: 'f1', folders: [inner] });
    const api = createApi('Pets', { id: 'a1', folders: [outer] });
    const project = projectWith({ apis: [api] });

    const location = requestFileLocation(project, 'r1');
    expect(location).toEqual({ dir: 'apis/Pets/requests/Internal/Orders v2', slug: 'List orders' });
    const files = projectFiles(project);
    expect(files.has(`${location!.dir}/${location!.slug}.request.yaml`)).toBe(true);
  });

  it('returns undefined for an unknown id', () => {
    const project = projectWith({});
    expect(requestFileLocation(project, 'missing')).toBeUndefined();
  });

  it('returns undefined for a gRPC request', () => {
    const request = createGrpcRequest('Unary call', { id: 'r1' });
    const api = createGrpcApi('Greeter', { id: 'a1', requests: [request] });
    const project = projectWith({ grpcApis: [api] });

    expect(requestFileLocation(project, 'r1')).toBeUndefined();
  });

  it('returns undefined for a WebSocket request', () => {
    const request = createWsRequest('Connect', { id: 'r1' });
    const api = createWsApi('Chat', { id: 'a1', requests: [request] });
    const project = projectWith({ wsApis: [api] });

    expect(requestFileLocation(project, 'r1')).toBeUndefined();
  });
});
