/**
 * A new API never takes the slug of a placeholder: its directory holds a container this build did
 * not load, and a save would refuse to write into it.
 */
import { describe, expect, it } from 'vitest';
import { createApi, createGrpcApi, createProject } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { addGrpcApi, updateGrpcApi } from '../src/main/project-grpc-mutations.js';
import { addApi, updateApi } from '../src/main/project-rest-mutations.js';
import { addWsApi } from '../src/main/project-ws-mutations.js';

const project: Project = {
  ...createProject('Placeholders', { id: 'p1' }),
  unsupported: [{ dir: 'apis', slug: 'Shop', kind: 'graphql', reason: 'unknown-kind' }],
};

describe('adding an API beside a placeholder', () => {
  it('gives a REST API another slug', () => {
    expect(addApi(project, { name: 'Shop', baseUrl: '' }).project.apis.map((api) => api.slug)).toEqual(['Shop-2']);
  });

  it('gives a gRPC API another slug', () => {
    const added = addGrpcApi(project, { name: 'Shop', target: 'localhost:50051' });
    expect(added.project.grpcApis.map((api) => api.slug)).toEqual(['Shop-2']);
  });

  it('gives a WebSocket API another slug', () => {
    expect(addWsApi(project, { name: 'Shop' }).project.wsApis.map((api) => api.slug)).toEqual(['Shop-2']);
  });

  it('gives a REST API another slug than a gRPC API in the same directory', () => {
    const withGrpc: Project = { ...project, grpcApis: [createGrpcApi('Greeter', { id: 'g1' })] };
    expect(addApi(withGrpc, { name: 'Greeter', baseUrl: '' }).project.apis.map((api) => api.slug)).toEqual([
      'Greeter-2',
    ]);
  });

  it('keeps an API’s own slug on a rename that does not change it', () => {
    const withGrpc: Project = { ...project, grpcApis: [createGrpcApi('Greeter', { id: 'g1' })] };
    const renamed = updateGrpcApi(withGrpc, 'g1', { name: 'greeter' }).project.grpcApis;
    expect(renamed.map((api) => api.slug)).toEqual(['greeter']);
  });

  it('does not free a slug another container still holds when an API is renamed', () => {
    // Two APIs of different kinds sharing one slug, as an older build could leave them.
    const clashing: Project = {
      ...project,
      apis: [createApi('Greeter', { id: 'a1' })],
      grpcApis: [createGrpcApi('Greeter', { id: 'g1' })],
    };
    const renamed = updateApi(clashing, 'a1', { name: 'greeter' }).project.apis;
    expect(renamed.map((api) => api.slug)).toEqual(['greeter-2']);
  });

  it('gives a renamed gRPC API another slug than a placeholder', () => {
    const withGrpc: Project = { ...project, grpcApis: [createGrpcApi('Greeter', { id: 'g1' })] };
    const renamed = updateGrpcApi(withGrpc, 'g1', { name: 'Shop' }).project.grpcApis;
    expect(renamed.map((api) => api.slug)).toEqual(['Shop-2']);
  });
});
