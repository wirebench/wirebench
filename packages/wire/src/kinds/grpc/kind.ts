import type { KindModule } from '../kind-module.js';

export const grpcKind = {
  kind: 'grpc',
  feature: { id: 'grpc', title: 'gRPC', default: true, stage: 'stable', requires: [] },
  label: 'gRPC',
  tabs: { request: 'grpc-request', container: 'grpc-api' },
} as const satisfies KindModule<'grpc'>;
