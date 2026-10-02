/**
 * `resolveItem` on a reference into a placeholder: the container is there but this build did not
 * load it, and the refusal says which kind it is and why.
 */
import {
  createApi,
  createGrpcApi,
  createGrpcRequest,
  createProject,
  createRestRequest,
  createWsApi,
  createWsRequest,
} from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { OpsError } from '../../../src/ops/errors.js';
import { resolveItem } from '../../../src/ops/items.js';

const project: Project = {
  ...createProject('Placeholders', { id: 'p1' }),
  unsupported: [
    { dir: 'apis', slug: 'Graph', kind: 'graphql', reason: 'unknown-kind', name: 'Graph API', order: 0 },
    { dir: 'apis', slug: 'Greeter', kind: 'grpc', reason: 'feature-disabled' },
  ],
};

function refusal(ref: string): { readonly code: string; readonly message: string } {
  try {
    resolveItem(project, ref);
  } catch (error) {
    if (error instanceof OpsError) {
      return { code: error.code, message: error.message };
    }
    throw error;
  }
  throw new Error(`"${ref}" resolved to a request`);
}

describe('resolveItem and placeholders', () => {
  it('names the kind of a container this build has no protocol for, by its display name', () => {
    expect(refusal('Graph API/Query')).toEqual({
      code: 'unsupported-kind',
      message:
        '"Graph API/Query" is in "Graph API", a "graphql" container this build did not load: it has no such protocol',
    });
  });

  it('names a container whose protocol is switched off, by its folder on disk', () => {
    expect(refusal('apis/Greeter/requests/Hello')).toEqual({
      code: 'unsupported-kind',
      message:
        '"apis/Greeter/requests/Hello" is in "Greeter", a "grpc" container this build did not load: that protocol is switched off',
    });
  });

  it('still says not found for a reference into nothing', () => {
    expect(refusal('Nowhere/Nothing').code).toBe('item-not-found');
  });
});

describe('resolveItem beside requests send cannot take', () => {
  const login = createRestRequest('Login', { id: 'r-login' });
  const mixed: Project = {
    ...createProject('Mixed', { id: 'p2' }),
    apis: [createApi('Api', { id: 'api-1', order: 0, requests: [login] })],
    wsApis: [
      createWsApi('Chat', {
        id: 'ws-1',
        order: 1,
        requests: [createWsRequest('Login', { id: 'w-login' }), createWsRequest('Feed', { id: 'w-feed' })],
      }),
    ],
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'g-1',
        order: 2,
        requests: [createGrpcRequest('Login', { id: 'g-login' }), createGrpcRequest('Hello', { id: 'g-hello' })],
      }),
    ],
  };

  function refusalIn(p: Project, ref: string): { readonly code: string; readonly message: string } {
    try {
      resolveItem(p, ref);
    } catch (error) {
      if (error instanceof OpsError) return { code: error.code, message: error.message };
      throw error;
    }
    throw new Error(`"${ref}" resolved to a request`);
  }

  it('resolves a name a WebSocket and a gRPC request share to the one REST request', () => {
    expect(resolveItem(mixed, 'Login')).toMatchObject({ kind: 'rest', path: 'Api/Login' });
  });

  it('refuses a name only a WebSocket request has as unsupported-kind', () => {
    expect(refusalIn(mixed, 'Feed')).toEqual({
      code: 'unsupported-kind',
      message: '"Chat/Feed" is a WebSocket request; send takes SOAP and REST requests',
    });
  });

  it('refuses a WebSocket path, and a WebSocket API of several requests, as unsupported-kind', () => {
    expect(refusalIn(mixed, 'Chat/Login').code).toBe('unsupported-kind');
    expect(refusalIn(mixed, 'Chat').code).toBe('unsupported-kind');
    expect(refusalIn(mixed, 'Greeter').code).toBe('unsupported-kind');
  });
});
