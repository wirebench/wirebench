/** gRPC as a protocol module (spec §3). */
import { defineProtocol } from '../protocol/module.js';
import { grpcSecrets } from './secrets.js';
import { grpcRun } from './run.js';
import { grpcScripting } from './scripting.js';
import { grpcStorage } from './storage.js';

/** The gRPC protocol: APIs, their folders and their unary and streaming requests. */
export const grpcProtocol = defineProtocol({
  kind: 'grpc',
  feature: { id: 'grpc', title: 'gRPC', default: true, stage: 'stable', requires: [] },
  storage: grpcStorage,
  secrets: grpcSecrets,
  run: grpcRun,
  scripting: grpcScripting,
});
