/**
 * The server host's send channels (hosted edition spec §20.7): the browser-served channels whose call makes the
 * server host send a request to a target on the user's behalf. Each is charged to the tenant's send budgets
 * (`budgets.ts`) on the host socket, as {@link chargeOf} says:
 *
 * - **`send`**: one token and one slot for the call: a single request, or an outbound call the host makes for the
 *   user (a token endpoint, an STS, a reflection or catalogue call, a definition fetched from its URL).
 * - **`run`** (owner ruling 2026-11-04): a run, a sequence or one request under several environments holds one slot
 *   for the whole call, and each request inside spends a token as it goes out (the host's `sendGate`): an empty
 *   bucket pauses the run until it refills, never fails it.
 * - **`session`** (owner ruling 2026-11-04): a WebSocket open spends one token and holds a slot only while it opens;
 *   the open session holds none.
 *
 * **Which channels count.** A served channel (`host/allowlist.ts`) whose last name segment says it sends, runs,
 * opens, fetches, refreshes or imports something ({@link looksLikeSend}) is listed in {@link SEND_CHANNELS}, in
 * {@link SENDS_WHEN_FETCHED} or in {@link NOT_SENDS} with its reason; `send-channels.test.ts` fails on one in none,
 * as the allowlist test fails on an unclassified channel. So a protocol kind that adds `request.sendSse` cannot
 * reach a target uncharged without someone saying why. Pure local work (a file read, a parse, the server's own
 * sync) is not charged.
 *
 * **Not charged:** a send through a paired agent (`agent.send` runs on the person's machine; the server host only
 * builds its bundle and records the exchange it made), and a scheduled run's requests, which the run slots govern.
 */

/** How a call is charged; see the file comment. */
export type SendCharge = 'send' | 'run' | 'session';

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
  // WebSocket: the call stays pending for the session's life; its slot is held only while it opens.
  'request.openWs',
  // GraphQL: the introspection query goes through the request as edited.
  'request.graphqlIntrospect',
  // The HTTP Log's resend, of any protocol.
  'log.resend',
  // Runs started in the tab.
  'runner.run',
  'sequence.run',
  // Outbound calls the host makes for the user: a token endpoint, an STS, server reflection, an MCP catalogue.
  'oauth2.fetchToken',
  'issuedTokens.fetch',
  'api.grpcRefresh',
  'api.refreshMcpCatalogue',
]);

/** Calls holding one slot whose every request inside spends a token as it goes out (paced). */
const RUN_CHANNELS: ReadonlySet<string> = new Set(['runner.run', 'sequence.run', 'request.sendToEnvironments']);
/** Calls that open a session: one token, and a slot only until it has opened. */
const SESSION_CHANNELS: ReadonlySet<string> = new Set(['request.openWs']);

/**
 * Imports charged as a send only when their source is fetched from a target (the `source.kind`s listed): a file,
 * a folder or pasted text is read here and sends nothing.
 */
export const SENDS_WHEN_FETCHED: Readonly<Record<string, readonly string[]>> = {
  'definition.import': ['url'],
  'api.importOpenApi': ['url'],
  'api.importAsyncApi': ['url'],
  'api.importProto': ['url', 'reflection'],
};

/** Served channels whose name looks like a send but that send nothing to a target, each with its reason. */
export const NOT_SENDS: Readonly<Record<string, string>> = {
  'exchanges.recordAgentSend': 'records the exchange a paired agent made; the agent sent it',
  'request.wsSend': 'one message on a WebSocket session `request.openWs` opened and holds',
  'hooks.open': 'opens a catch URL view; nothing is sent',
  'workspace.open': 'opens a workspace',
  'schedules.run': 'reads one scheduled run',
  'schedules.runNow': 'queues a scheduled run, which the run slots govern',
  'sync.fetch': 'reads the workspace from this server, in process; no target is reached',
  'request.importCurl': 'parses a pasted cURL command',
  'project.importLegacy': 'reads a project file picked or inside the project',
  'workspace.importSuggestion': 'opens a project folder the app recorded',
  'api.importGraphqlSchema': 'reads a schema file',
  'api.importWebhooks': 'adds requests from the API’s own loaded definition',
  'api.importPostman': 'reads a file or pasted text',
  'api.importPostmanFolder': 'reads a folder',
  'api.importPostmanEnvironment': 'reads a file or pasted text',
  'api.importPostmanGlobals': 'reads a file or pasted text',
  'api.importHar': 'reads a file or pasted text',
  'api.importHttpFile': 'reads a file or pasted text',
  'api.importHttpEnv': 'reads a file or pasted text',
  'api.importInsomnia': 'reads a file or pasted text',
  'api.importBruno': 'reads a folder',
  'api.importHoppscotch': 'reads a file or pasted text',
  'api.importThunderClient': 'reads a file or pasted text',
  'api.importOpenCollection': 'reads a folder',
  'api.importClientEnvironments': 'reads a file or pasted text',
};

/**
 * Whether `channel`'s name says it sends, runs, opens, fetches, refreshes or imports something: its last segment
 * starts with `send`, `resend`, `open`, `run`, `invoke`, `call`, `execute`, `connect`, `fetch`, `refresh` or
 * `import`, or ends in `Send`, `Introspect` or `Refresh`. A net for the registry test, not the charge.
 */
export function looksLikeSend(channel: string): boolean {
  const action = channel.slice(channel.lastIndexOf('.') + 1);
  return /^(send|resend|open|run|invoke|call|execute|connect|fetch|refresh|import)([A-Z]|$)|Send$|Introspect$|Refresh$/.test(
    action,
  );
}

const sourceKindOf = (request: unknown): unknown =>
  (request as { readonly source?: { readonly kind?: unknown } } | null | undefined)?.source?.kind;

/** How a call on `channel` with `request` is charged to the tenant's send budgets; `undefined` when it is not. */
export function chargeOf(channel: string, request?: unknown): SendCharge | undefined {
  if (RUN_CHANNELS.has(channel)) return 'run';
  if (SESSION_CHANNELS.has(channel)) return 'session';
  if (SEND_CHANNELS.has(channel)) return 'send';
  const fetched = SENDS_WHEN_FETCHED[channel];
  if (fetched !== undefined && fetched.includes(sourceKindOf(request) as string)) return 'send';
  return undefined;
}

/** Whether a call on `channel` is always charged to the tenant's send budgets. */
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
      served(channel) &&
      looksLikeSend(channel) &&
      !SEND_CHANNELS.has(channel) &&
      !Object.hasOwn(SENDS_WHEN_FETCHED, channel) &&
      !Object.hasOwn(NOT_SENDS, channel),
  );
}
