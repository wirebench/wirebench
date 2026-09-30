/** gRPC as a protocol module (spec §3). */
import { defineProtocol } from '../protocol/module.js';
import { grpcRun } from './run.js';

/** The gRPC protocol: APIs, their folders and their unary and streaming requests. */
export const grpcProtocol = defineProtocol({
  kind: 'grpc',
  feature: { id: 'grpc', title: 'gRPC', default: true, stage: 'stable', requires: [] },
  run: grpcRun,
});
