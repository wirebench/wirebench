/**
 * `@wirebench/host`: the main-process code behind every IPC channel, run behind an injected
 * {@link HostPlatform}. An embedding builds one host with `createHost(platform)`, serves its
 * {@link HandlerTable}, and attaches a {@link Caller} per window or connection (ADR-0033).
 */
export { createHost } from './host/create-host.js';
export type { AttachOptions, Host, HostOptions, HostWindows } from './host/create-host.js';
export type { Caller, Capability, HostPlatform } from './host/platform.js';
export { HandlerTable } from './ipc/register.js';
