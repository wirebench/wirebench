/**
 * gRPC's share of the IPC registry (kind modules spec §4.3): its channels and events, with
 * the names, groups and payloads they always had. `ipc.ts` composes them with core's.
 */
import { defineChannel, defineEvent } from '../../ipc-contract.js';
import { apiIdRequestSchema } from '../../wire-base.js';
import {
  apiGrpcRefreshResponseSchema,
  apiImportProtoResponseSchema,
  requestPreflightResponseSchema,
} from '../../wire-types.js';
import {
  apiGrpcDefinitionResponseSchema,
  apiGrpcFieldsRequestSchema,
  apiGrpcFieldsResponseSchema,
  apiGrpcRefreshRequestSchema,
  apiGrpcSampleRequestSchema,
  apiGrpcSampleResponseSchema,
  apiImportProtoRequestSchema,
  grpcExchangeSummarySchema,
  grpcLiveEventSchema,
  historyResendGrpcRequestSchema,
  requestGrpcHalfCloseRequestSchema,
  requestGrpcHalfCloseResponseSchema,
  requestGrpcPushRequestSchema,
  requestGrpcPushResponseSchema,
  requestPreflightGrpcRequestSchema,
  requestSendGrpcRequestSchema,
} from './wire.js';

/** gRPC's IPC channels, by the group each sits in; `ipc.ts` spreads them into `channels`. */
export const grpcChannels = {
  request: {
    /** A gRPC send: its own channel for the same reason `sendRest` is, and its own summary shape. */
    sendGrpc: defineChannel('request.sendGrpc', requestSendGrpcRequestSchema, grpcExchangeSummarySchema),
    preflightGrpc: defineChannel(
      'request.preflightGrpc',
      requestPreflightGrpcRequestSchema,
      requestPreflightResponseSchema,
    ),
    /**
     * One more message on a gRPC call opened with `interactive`. An ordinary invoke rather than a
     * channel of its own kind: the call it belongs to is named by the same `sendId` the send used,
     * which is how `request.cancel` already addresses a send in flight.
     */
    grpcPush: defineChannel('request.grpcPush', requestGrpcPushRequestSchema, requestGrpcPushResponseSchema),
    /** Half-closes an interactive gRPC call's request side; the server may still be answering. */
    grpcHalfClose: defineChannel(
      'request.grpcHalfClose',
      requestGrpcHalfCloseRequestSchema,
      requestGrpcHalfCloseResponseSchema,
    ),
  },
  api: {
    importProto: defineChannel('api.importProto', apiImportProtoRequestSchema, apiImportProtoResponseSchema),
    /** The services and files of a gRPC API's cached `.proto` set, for the method picker. */
    grpcDefinition: defineChannel('api.grpcDefinition', apiIdRequestSchema, apiGrpcDefinitionResponseSchema),
    /** A sample message for one type of a gRPC API's definition. */
    grpcSample: defineChannel('api.grpcSample', apiGrpcSampleRequestSchema, apiGrpcSampleResponseSchema),
    grpcFields: defineChannel('api.grpcFields', apiGrpcFieldsRequestSchema, apiGrpcFieldsResponseSchema),
    /** Asks a reflection-sourced API's server to describe itself again. */
    grpcRefresh: defineChannel('api.grpcRefresh', apiGrpcRefreshRequestSchema, apiGrpcRefreshResponseSchema),
  },
  history: {
    resendGrpc: defineChannel('history.resendGrpc', historyResendGrpcRequestSchema, grpcExchangeSummarySchema),
  },
} as const;

/** gRPC's main-to-renderer events; `ipc.ts` spreads them into `events`. */
export const grpcEvents = {
  grpc: {
    /** A gRPC call in flight reporting what has arrived so far, keyed by the send's id. */
    live: defineEvent('grpc.live', grpcLiveEventSchema),
  },
} as const;
