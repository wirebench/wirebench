/**
 * The core channel modules register only what names no kind (kind modules spec §5.4); each kind's
 * `registerChannels` adds its own. A test that drives `request.*`, `api.*` or `history.*` registers
 * both halves of that module through these.
 */
import { registerApiChannels } from '../../src/ipc/api.js';
import { registerHistoryChannels } from '../../src/ipc/history.js';
import { registerRequestChannels } from '../../src/ipc/request.js';
import {
  registerGrpcApiChannels,
  registerGrpcHistoryChannels,
  registerGrpcRequestChannels,
} from '../../src/kinds/grpc/ipc.js';
import {
  registerRestApiChannels,
  registerRestHistoryChannels,
  registerRestRequestChannels,
} from '../../src/kinds/rest/ipc.js';
import { registerSoapHistoryChannels, registerSoapRequestChannels } from '../../src/kinds/soap/ipc.js';
import { registerWsApiChannels, registerWsRequestChannels } from '../../src/kinds/ws/ipc.js';

/** `request.*`: the core's channels and every kind's. */
export function registerRequestChannelsWithKinds(...args: Parameters<typeof registerRequestChannels>): void {
  registerRequestChannels(...args);
  registerSoapRequestChannels(...args);
  registerRestRequestChannels(...args);
  registerGrpcRequestChannels(...args);
  registerWsRequestChannels(...args);
}

/** `api.*`: the core's channels and every kind's. */
export function registerApiChannelsWithKinds(...args: Parameters<typeof registerApiChannels>): void {
  registerApiChannels(...args);
  registerRestApiChannels(...args);
  registerGrpcApiChannels(...args);
  registerWsApiChannels(...args);
}

/** `history.*`: the core's channels and every kind's resend. */
export function registerHistoryChannelsWithKinds(...args: Parameters<typeof registerHistoryChannels>): void {
  registerHistoryChannels(...args);
  registerSoapHistoryChannels(...args);
  registerRestHistoryChannels(...args);
  registerGrpcHistoryChannels(...args);
}
