/**
 * The server host's send channels (hosted edition spec §20.7): the browser-served channels whose call makes the
 * server host send a request to its target on the user's behalf. Each call of one is charged to the tenant's send
 * budgets (`budgets.ts`) on the host socket.
 *
 * **Which channels count.** A served channel (`host/allowlist.ts`) whose last name segment says it sends, runs or
 * opens something ({@link looksLikeSend}) is either listed in {@link SEND_CHANNELS} or in {@link NOT_SENDS} with
 * its reason; `send-channels.test.ts` fails on one in neither, as the allowlist test fails on an unclassified
 * channel. So a protocol kind that adds `request.sendSse` cannot reach a target uncharged without someone saying
 * why. A channel is a send when its handler sends a request item (saved, as edited, or recorded) to the item's
 * target, or opens the item's connection; not a send when it reads, opens a view, or carries one more message on a
 * connection a send opened (that send holds the slot).
 *
 * **Not charged:** a send through a paired agent (`agent.send` runs on the person's machine; the server host only
 * builds its bundle and records the exchange it made), and a scheduled run's requests, which the run slots govern.
 * A run (`runner.run`, `sequence.run`) and `request.sendToEnvironments` send several requests in one call; each
 * call is charged as one send and holds one slot for as long as it runs.
 */

/** Every send channel of the server host. */
export const SEND_CHANNELS: ReadonlySet<string> = new Set([
  // SOAP.
  'request.send',
  'history.resend',
  // REST, and one REST request under several environments.
  'request.sendRest',
  'request.sendToEnvironments',
  'history.resendRest',
  // gRPC.
  'request.sendGrpc',
  'history.resendGrpc',
  // MCP.
  'request.sendMcp',
  // WebSocket: the call stays pending for the session's life, so its slot is held while the connection is open.
  'request.openWs',
  // GraphQL: the introspection query goes through the request as edited.
  'request.graphqlIntrospect',
  // The HTTP Log's resend, of any protocol.
  'log.resend',
  // Runs started in the tab.
  'runner.run',
  'sequence.run',
]);

/** Served channels whose name looks like a send but that send nothing to a target, each with its reason. */
export const NOT_SENDS: Readonly<Record<string, string>> = {
  'exchanges.recordAgentSend': 'records the exchange a paired agent made; the agent sent it',
  'request.wsSend': 'one message on a WebSocket session `request.openWs` opened and holds',
  'hooks.open': 'opens a catch URL view; nothing is sent',
  'workspace.open': 'opens a workspace',
  'schedules.run': 'reads one scheduled run',
  'schedules.runNow': 'queues a scheduled run, which the run slots govern',
};

/**
 * Whether `channel`'s name says it sends, runs or opens something: its last segment starts with `send`, `resend`,
 * `open`, `run`, `invoke`, `call`, `execute` or `connect`, or ends in `Send` or `Introspect`. A net for the
 * registry test, not the charge: only {@link SEND_CHANNELS} is charged.
 */
export function looksLikeSend(channel: string): boolean {
  const action = channel.slice(channel.lastIndexOf('.') + 1);
  return /^(send|resend|open|run|invoke|call|execute|connect)([A-Z]|$)|Send$|Introspect$/.test(action);
}

/** Whether a call on `channel` is charged to the tenant's send budgets. */
export function isSendChannel(channel: string): boolean {
  return SEND_CHANNELS.has(channel);
}

/**
 * The served channels of `channels` that look like a send and are classified neither way: what the registry test
 * expects to be empty. `served` is the allowlist's `isServedChannel`.
 */
export function unclassifiedSends(channels: readonly string[], served: (channel: string) => boolean): string[] {
  return channels.filter(
    (channel) =>
      served(channel) && looksLikeSend(channel) && !SEND_CHANNELS.has(channel) && !Object.hasOwn(NOT_SENDS, channel),
  );
}
