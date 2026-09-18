/**
 * The browser-safe face of `grpc/`: pure helpers with no Node dependency, reachable from the
 * renderer as `@wirebench/engine/grpc` (ESLint allows this subpath and no other). Kept to what an
 * editor needs to display — the effective target, the method path, the status names — so the
 * renderer never reimplements a rule the transport enforces.
 */

export { clientStreams, defaultTlsFor, GRPC_REFLECTION_VERSIONS, grpcMethodPath, serverStreams } from './shape.js';
export type { GrpcMethodKind, GrpcReflectionVersion } from './shape.js';
export { GRPC_STATUS_NAMES, grpcStatusName } from './status.js';
export { parseGrpcTarget } from './target.js';
export type { GrpcTarget } from './target.js';
