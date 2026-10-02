/**
 * What a gRPC call reports while it runs (spec §3.2): the request side opening for pushes, the
 * initial metadata, each response message decoded, and the request side half-closed.
 */
import type { GrpcResponseMessage } from './call.js';

export type GrpcLiveEvent =
  | { readonly protocol: 'grpc'; readonly kind: 'open' }
  | {
      readonly protocol: 'grpc';
      readonly kind: 'headers';
      readonly httpStatus: number;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly protocol: 'grpc';
      readonly kind: 'message';
      readonly index: number;
      readonly message: GrpcResponseMessage;
    }
  | { readonly protocol: 'grpc'; readonly kind: 'closed' };
