/** Where the secret scanner looks in gRPC's APIs, and how a move rewrites them. */
import type { ProtocolSecrets } from '../protocol/module.js';
import { keyed, keyedEntries, mapShared, mapTree, patch, SEP, tree } from '../secrets/scan/support.js';
import type { ScanTarget } from '../secrets/scan/support.js';
import type { Project } from '../project/model.js';
import { grpcApisOf, withGrpcApis } from './model.js';
import type { GrpcRequestDef } from './model.js';

function* grpcRequest(request: GrpcRequestDef, prefix: string): Generator<ScanTarget> {
  const path = `${prefix}${SEP}${request.name}`;
  yield* keyed('grpc-metadata', request.id, path, 'metadata', 'header', request.metadata);
  if (request.message !== '') {
    yield {
      location: { kind: 'grpc-message', requestId: request.id },
      label: `${path}${SEP}message`,
      text: request.message,
      context: { contentType: 'application/json' },
    };
  }
}

function* scanTargets(project: Project): Generator<ScanTarget> {
  for (const api of grpcApisOf(project)) {
    yield* keyed('grpc-api-metadata', api.id, api.name, 'metadata', 'header', api.metadata);
    yield* tree(api, api.name, grpcRequest);
  }
}

/** gRPC's metadata, on an API and on each request, and each request's message. */
export const grpcSecrets: ProtocolSecrets = {
  scanTargets,
  applyMoves: (project, rw) => {
    const apis = grpcApisOf(project);
    const next = mapShared(apis, (api) =>
      mapTree(
        patch(api, { metadata: keyedEntries(rw, 'grpc-api-metadata', { apiId: api.id }, api.metadata) }),
        (request: GrpcRequestDef) =>
          patch(request, {
            metadata: keyedEntries(rw, 'grpc-metadata', { requestId: request.id }, request.metadata),
            message: rw.text({ kind: 'grpc-message', requestId: request.id }, request.message),
          }),
      ),
    );
    return next === apis ? project : withGrpcApis(project, next);
  },
};
