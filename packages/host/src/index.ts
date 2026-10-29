/**
 * `@wirebench/host`: the main-process code behind every IPC channel, run behind an injected
 * {@link HostPlatform}. An embedding builds one host with `createHost(platform)`, serves its
 * {@link HandlerTable} (a connection's frames through `serveCall`), and attaches a {@link Caller} per
 * window or connection (ADR-0033).
 */
export { createHost } from './host/create-host.js';
export type { AttachOptions, Host, HostOptions, HostWindows, SecretEvent } from './host/create-host.js';
export type { Caller, Capability, HostPlatform } from './host/platform.js';
export { serveCall } from './host/serve-call.js';
export type { CallFrame, ReplyFrame } from './host/serve-call.js';
export { HOST_AUTH_TIMEOUT_MS, HOST_CLOSE, HOST_LIMITS, hostBusy, runHostSocket } from './host/host-socket.js';
export type {
  HostLimits,
  HostSocket,
  HostSocketOptions,
  HostSocketReady,
  RawFrameData,
  WebSocketLike,
} from './host/host-socket.js';
export { HandlerTable } from './ipc/register.js';
export { toIpcError } from './ipc/envelope.js';
export { agentSecretLabel, createSendSession } from './send/detached.js';
export type {
  AgentTeamSecretQuery,
  DetachedSendKind,
  DetachedSendResult,
  SendFromDirectoryInput,
  SendSession,
} from './send/detached.js';
