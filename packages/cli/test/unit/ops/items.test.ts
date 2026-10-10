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

describe('resolveItem beside WebSocket and gRPC requests', () => {
  const login = createRestRequest('Login', { id: 'r-login' });
  const mixed: Project = {
    ...createProject('Mixed', { id: 'p2' }),
    containers: {
      rest: [createApi('Api', { id: 'api-1', order: 0, requests: [login] })],
      websocket: [
        createWsApi('Chat', {
          id: 'ws-1',
          order: 1,
          requests: [createWsRequest('Login', { id: 'w-login' }), createWsRequest('Feed', { id: 'w-feed' })],
        }),
      ],
      grpc: [
        createGrpcApi('Greeter', {
          id: 'g-1',
          order: 2,
          requests: [createGrpcRequest('Login', { id: 'g-login' }), createGrpcRequest('Hello', { id: 'g-hello' })],
        }),
      ],
    },
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

  it('takes a WebSocket request beside a REST one: a name both have is ambiguous, a gRPC one is set aside', () => {
    expect(refusalIn(mixed, 'Login')).toEqual({
      code: 'item-ambiguous',
      message: '"Login" names 2 requests; pass one path: Api/Login, Chat/Login',
    });
  });

  it('resolves a WebSocket request by its path, or by a name only it has', () => {
    expect(resolveItem(mixed, 'Chat/Login')).toMatchObject({ kind: 'websocket', path: 'Chat/Login' });
    expect(resolveItem(mixed, 'Feed')).toMatchObject({ kind: 'websocket', path: 'Chat/Feed' });
  });

  it('calls a WebSocket API of several requests ambiguous, and a reference into it that matches nothing not found', () => {
    expect(refusalIn(mixed, 'Chat').code).toBe('item-ambiguous');
    expect(refusalIn(mixed, 'Chat/Nope').code).toBe('item-not-found');
  });

  it('still refuses a gRPC request, path or API, as unsupported-kind', () => {
    expect(refusalIn(mixed, 'Greeter/Hello')).toEqual({
      code: 'unsupported-kind',
      message: '"Greeter/Hello" is a gRPC request; send takes SOAP, REST and WebSocket requests',
    });
    expect(refusalIn(mixed, 'Greeter').code).toBe('unsupported-kind');
    expect(refusalIn(mixed, 'Greeter/Nope')).toEqual({
      code: 'unsupported-kind',
      message: '"Greeter/Nope" is in the gRPC API "Greeter"; send takes SOAP, REST and WebSocket requests',
    });
  });
});
