/**
 * MCP's run facet (#79). A run selects every request of every server. A send resolves the request
 * (one expansion pass over the server's transport and the request's operation) and refuses one with
 * a reference nothing resolves, then connects: a stdio server only once the host has approved its
 * command line, an HTTP one with its TLS, its proxy and its credentials (an OAuth2 token fetched once
 * per send). Then one session runs: initialize, the operation, close. Each message is a live event.
 *
 * The session's deadline is the run's timeout, else the request's, else the server's, else 30 s.
 * A run's send whose session could not finish fails with the session's error, so a dead server never
 * passes a run; a host's own send keeps the exchange as its result, the failure recorded in it.
 */
import { McpError } from '#core/errors';
import { applyAuth, resolveAuthChain } from '#core/http/auth/apply-auth';
import type { SendAuth } from '#core/http/auth/send-auth';
import type { KeyValueEntry } from '#core/http/entries';
import { resolveScopes } from '#core/project/environments';
import type { AuthConfig, Project } from '#core/project/model';
import { expand } from '#core/project/properties';
import type { PropertyScopes } from '#core/project/properties';
import type { ProtocolRun, RunGroup, ScriptedSend } from '#core/protocol/module';
import { scopesFor } from '#core/run/context';
import type { RunContext } from '#core/run/context';
import { exchangeController } from '#core/run/exchange';
import type { ExchangeController } from '#core/run/exchange';
import type { AttemptedRequest } from '#core/run/host';
import type { SentRequest } from '#core/run/run';
import {
  authFor,
  authSecretNeeds,
  dropRefusedToken,
  originOf,
  secretNamesInValue,
  tlsFor,
  unresolvedError,
  withSecrets,
} from '#core/run/send-helpers';
import type { Resolved } from '#core/run/send-helpers';
import { walkTree } from '#core/run/tree';
import { containerScriptLevels } from '#core/script/levels';
import type { SecretNeed } from '#core/secrets/env-names';
import { secretEnvName, secretPseudoRef } from '#core/secrets/secret-token';
import { approveMcpCommand, commandDisplay, commandFingerprint, sortedEnvNames } from './approval.js';
import { checkMcpResult } from './check.js';
import type { McpLiveEvent } from './events.js';
import { buildMcpExchange, mcpSubject } from './exchange.js';
import type { McpExchange, McpExchangeTransport } from './exchange.js';
import { expandMcpOperation, expandMcpTransport } from './expand.js';
import { withHeaders } from './http-calls.js';
import type { McpHttpConnectionOptions } from './http-calls.js';
import { openStreamableHttpTransport } from './http-transport.js';
import { MCP_DEFAULT_TIMEOUT_MS } from './limits.js';
import { mcpServersOf } from './model.js';
import type { McpFolder, McpOperation, McpRequestDef, McpServer, McpTransport } from './model.js';
import { mcpOperationCall } from './operation.js';
import { mcpScriptTypes, mcpToolFor } from './script-types.js';
import { applyMcpSnapshot, mcpRequestSnapshot, mcpResponseSnapshot } from './scripting.js';
import type { McpRequestSnapshot } from './scripting.js';
import { runMcpSession } from './session.js';
import type { McpMessage } from './session.js';
import { openSseTransport } from './sse-transport.js';
import { openStdioTransport, resolveMcpCwd } from './stdio.js';
import type { McpWireTransport } from './transport.js';

/** `clientInfo.version` in `initialize`: the version of this client implementation. */
export const MCP_CLIENT_VERSION = '1.0.0';

/** One saved MCP request selected for a run. */
export interface McpSelected {
  readonly kind: 'mcp';
  readonly path: string;
  readonly group: string;
  readonly server: McpServer;
  readonly chain: readonly McpFolder[];
  readonly request: McpRequestDef;
}

/** An MCP request resolved for its send: the transport and the operation expanded, the deadline chosen. */
export interface McpResolvedInput {
  /** Expanded. A stdio `cwd` is absolute, resolved against the project folder. */
  readonly transport: McpTransport;
  /** Expanded: the arguments with their values JSON-escaped. */
  readonly operation: McpOperation;
  /** The whole session's deadline. */
  readonly timeoutMs: number;
  readonly protocolVersion?: string;
  /** A stdio server's command line as a person is shown it, its secrets masked; empty for HTTP. */
  readonly commandLine: string;
}

/** A server's transport resolved for a send, with its command line as a person is shown it. */
export interface McpResolvedTransport extends Resolved<McpTransport> {
  /** The masked command line of a stdio server; empty for HTTP. */
  readonly commandLine: string;
}

/** A server's own auth, for an HTTP transport; none for stdio. */
export function mcpEffectiveAuth(selected: Pick<McpSelected, 'server'>): AuthConfig {
  const { transport } = selected.server;
  return resolveAuthChain([transport.type === 'stdio' ? undefined : transport.auth]);
}

function selectedOf(
  server: McpServer,
  request: McpRequestDef,
  chain: readonly McpFolder[],
  group: string,
): McpSelected {
  return { kind: 'mcp', path: `${group}/${request.name}`, group, server, chain, request };
}

/** The MCP item for `requestId`, built as a run builds it; undefined when no MCP request has that id. */
export function mcpItemFor(project: Project, requestId: string): McpSelected | undefined {
  const candidates: { item: McpSelected; diskPath: string }[] = [];
  for (const server of mcpServersOf(project)) {
    walkTree<McpFolder, McpRequestDef, McpSelected>(
      server,
      [],
      server.name,
      `apis/${server.slug}/requests`,
      (request, chain, group) => (request.id === requestId ? selectedOf(server, request, chain, group) : undefined),
      candidates,
    );
  }
  return candidates[0]?.item;
}

/** The deadline of a send: the run's timeout, else the request's, else the server's, else the default. */
export function mcpTimeoutMs(selected: Pick<McpSelected, 'server' | 'request'>, runTimeoutMs?: number): number {
  return (
    runTimeoutMs ?? selected.request.settings.timeoutMs ?? selected.server.settings.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS
  );
}

/** The transport's text, as the secret lookup reads it: auth is looked up through its own needs. */
function transportTexts(transport: McpTransport): string[] {
  const rows = (entries: readonly KeyValueEntry[]): string[] =>
    entries.filter((row) => row.enabled).flatMap((row) => [row.name, row.value]);
  return transport.type === 'stdio'
    ? [transport.command, ...transport.args, transport.cwd ?? '', ...rows(transport.env)]
    : [transport.url, ...rows(transport.headers)];
}

/**
 * The server's transport resolved for a send: secrets read, every string expanded, a stdio folder
 * made absolute. A stdio command line never stands behind a script's placeholders, since it is not
 * in a script's snapshot and what is approved must be what runs; an HTTP transport's URL is in the
 * snapshot, so for a scripted send its secrets stand behind them until the script has run. A
 * reference nothing resolves is reported, not thrown.
 *
 * @throws WirebenchError `secret-missing`, and the Sequence guards' errors
 */
export async function resolveMcpTransport(
  server: McpServer,
  context: RunContext,
  scopes: PropertyScopes = scopesFor(context),
): Promise<McpResolvedTransport> {
  const placeholders = server.transport.type === 'stdio' ? undefined : context.secretPlaceholders;
  const withTokens = await withSecrets(transportTexts(server.transport), scopes, context.host.getSecret, placeholders);
  const { value, unresolved } = expandMcpTransport(server.transport, withTokens);
  const transport: McpTransport =
    value.type === 'stdio' ? { ...value, cwd: resolveMcpCwd(context.projectDir, value.cwd) } : value;
  return { input: transport, unresolved, commandLine: maskedCommandLine(server.transport, scopes) };
}

/**
 * An MCP request resolved for its send (#79), nothing connected: the server's transport and the
 * request's operation expanded against one set of scopes, so a `${#Dynamic#…}` value is the same in
 * both, and the deadline. A reference nothing resolves is reported in `unresolved`: the send refuses
 * it, a preview shows it.
 *
 * @throws WirebenchError `secret-missing`, and the Sequence guards' errors
 */
export async function resolveMcp(selected: McpSelected, context: RunContext): Promise<Resolved<McpResolvedInput>> {
  const scopes = scopesFor(context);
  const transport = await resolveMcpTransport(selected.server, context, scopes);
  const { operation } = selected.request;
  const withTokens = await withSecrets(operation, scopes, context.host.getSecret, context.secretPlaceholders);
  const expanded = expandMcpOperation(operation, withTokens);
  const { protocolVersion } = selected.server.settings;
  return {
    input: {
      transport: transport.input,
      operation: expanded.value,
      timeoutMs: mcpTimeoutMs(selected, context.timeoutMs),
      commandLine: transport.commandLine,
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    },
    unresolved: [...transport.unresolved, ...expanded.unresolved],
  };
}

/** A stdio transport's own variables, enabled and named; a later row wins over an earlier one. */
function stdioEnv(transport: Extract<McpTransport, { type: 'stdio' }>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of transport.env) if (row.enabled && row.name !== '') out[row.name] = row.value;
  return out;
}

/**
 * The command line as a person is shown it: the saved command and arguments expanded, against the
 * same scopes as what runs, with every secret left as its `${secret:…}` reference, so the prompt
 * never shows a value.
 */
function maskedCommandLine(transport: McpTransport, scopes: PropertyScopes): string {
  if (transport.type !== 'stdio') return '';
  const texts = [transport.command, ...transport.args];
  const names = secretNamesInValue(texts, scopes);
  const masked: PropertyScopes = {
    ...scopes,
    secrets: Object.fromEntries(names.map((name) => [name, `\${secret:${name}}`])),
  };
  const [command = '', ...args] = texts.map((text) => expand(text, masked).text);
  return commandDisplay(command, args);
}

/** Credentials as headers and query rows on every HTTP call of the session. */
function authOnTheWire(auth: SendAuth | undefined): {
  readonly headers: Record<string, string>;
  readonly query: readonly { readonly name: string; readonly value: string }[];
} {
  if (auth === undefined) return { headers: {}, query: [] };
  if (auth.type === 'basic') {
    // Every call carries its credentials: an MCP session cannot answer a challenge and resend.
    const encoded = Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64');
    return { headers: { Authorization: `Basic ${encoded}` }, query: [] };
  }
  const applied = applyAuth(auth);
  if (applied.transportAuth !== undefined) {
    throw new McpError(
      'mcp-auth-unsupported',
      `${auth.type} authentication is not applied to an MCP session, whose calls carry their credentials up front. Use Basic, Bearer, an API key, a JWT or OAuth2 instead.`,
      { details: { type: auth.type } },
    );
  }
  return { headers: { ...applied.headers }, query: applied.query };
}

/** `url` with `query` appended. @throws McpError `mcp-bad-url` for a URL that cannot take one */
function withQuery(url: string, query: readonly { readonly name: string; readonly value: string }[]): string {
  if (query.length === 0) return url;
  try {
    const parsed = new URL(url);
    for (const row of query) parsed.searchParams.append(row.name, row.value);
    return parsed.toString();
  } catch (error) {
    throw new McpError('mcp-bad-url', `The MCP server URL "${url}" is not a valid URL`, {
      details: { url },
      cause: error,
    });
  }
}

/** A connected session's transport, what its exchange records of it, and what was sent with. */
interface McpConnection {
  readonly wire: McpWireTransport;
  readonly transport: McpExchangeTransport;
  readonly auth?: SendAuth;
  readonly attempted?: AttemptedRequest;
}

/**
 * The wire transport a resolved send runs over. A stdio server is asked of the host first; an HTTP
 * one gets its TLS, proxy and credentials.
 *
 * @throws McpError `mcp-command-unapproved` | `mcp-auth-unsupported` | `mcp-bad-url`, and
 * WirebenchError `secret-missing` | `auth-grant-unsupported` | `keystore-missing` | the OAuth2 errors
 */
export async function connectMcp(
  server: McpServer,
  context: RunContext,
  resolved: Pick<McpResolvedInput, 'transport' | 'commandLine' | 'timeoutMs'>,
  path: string,
): Promise<McpConnection> {
  const { transport, timeoutMs } = resolved;
  if (transport.type === 'stdio') {
    const env = stdioEnv(transport);
    const envNames = sortedEnvNames(Object.keys(env));
    const cwd = resolveMcpCwd(context.projectDir, transport.cwd);
    const display = resolved.commandLine;
    const fingerprint = commandFingerprint({ command: transport.command, args: transport.args, cwd, envNames });
    await approveMcpCommand(context.host, { fingerprint, display, cwd, envNames, serverName: server.name });
    return {
      wire: openStdioTransport({ command: transport.command, args: transport.args, cwd, env }),
      transport: { type: 'stdio', command: transport.command, args: [...transport.args], cwd, env },
    };
  }
  const tls = await tlsFor(context, undefined, false);
  const proxy = await context.host.proxyFor?.(transport.url);
  const auth = await authFor(mcpEffectiveAuth({ server }), path, context, tls);
  const wire = authOnTheWire(auth);
  const base: Record<string, string> = {};
  for (const row of transport.headers) if (row.enabled && row.name !== '') base[row.name] = row.value;
  const options: McpHttpConnectionOptions = {
    url: withQuery(transport.url, wire.query),
    headers: withHeaders(base, wire.headers),
    timeoutMs,
    ...(tls !== undefined ? { tls } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(context.host.egress !== undefined ? { egress: context.host.egress } : {}),
  };
  return {
    wire: transport.type === 'http' ? openStreamableHttpTransport(options) : openSseTransport(options),
    // The URL as saved and expanded: an API key in the query is a credential, not recorded.
    transport: { type: transport.type, url: transport.url },
    ...(auth !== undefined ? { auth } : {}),
    attempted: { url: options.url, method: transport.type === 'http' ? 'POST' : 'GET', headers: options.headers },
  };
}

/** The operation's own request and its answer, as the raw exchange shows them. */
function rawOf(exchange: McpExchange): SentRequest['raw'] {
  const ofMethod = (message: McpMessage): boolean => message.method === exchange.method;
  const sent = exchange.messages.find((m) => m.direction === 'sent' && m.kind === 'request' && ofMethod(m));
  const answer = exchange.messages.find(
    (m) => m.direction === 'received' && (m.kind === 'result' || m.kind === 'error') && ofMethod(m),
  );
  const encoder = new TextEncoder();
  return { rawRequest: encoder.encode(sent?.text ?? ''), rawResponse: encoder.encode(answer?.text ?? '') };
}

/**
 * One MCP request as a run or a host sends it: resolve, run its pre-request script when `scripts` is
 * given, connect, one session, then its post-response script. A failure before the session (a
 * reference nothing resolves, a script, arguments that are not a JSON object, a command not
 * approved, credentials) is told to the host as the prepare stage's. A cancelled session, and any
 * session of a run that could not finish, is the send stage's, with the exchange it recorded.
 */
async function sendMcpItem(
  selected: McpSelected,
  context: RunContext,
  controller: ExchangeController<McpLiveEvent>,
  run: boolean,
  scripts: ScriptedSend | undefined,
): Promise<SentRequest> {
  let startedAt = Date.now();
  // Never masks the send's own error: a row that cannot be built, or a host that throws, is dropped.
  const failed = (
    stage: 'prepare' | 'send',
    error: unknown,
    attempted: AttemptedRequest | undefined,
    input: McpResolvedInput | undefined,
    exchange?: McpExchange,
  ): void => {
    try {
      context.host.events?.onFailed?.(selected, {
        stage,
        error,
        startedAt,
        durationMs: Date.now() - startedAt,
        ...(attempted !== undefined ? { attempted, input } : {}),
        ...(exchange !== undefined ? { exchange } : {}),
      });
    } catch {
      // Deliberately ignored — see above.
    }
  };

  let input: McpResolvedInput | undefined;
  let connection: McpConnection;
  let call: ReturnType<typeof mcpOperationCall>;
  let sent: McpRequestSnapshot | undefined;
  try {
    const resolved = await resolveMcp(
      selected,
      scripts !== undefined ? { ...context, secretPlaceholders: scripts.placeholders } : context,
    );
    input = resolved.input;
    if (resolved.unresolved.length > 0) {
      throw unresolvedError('mcp-unresolved-properties', selected.path, resolved.unresolved);
    }
    if (scripts !== undefined) {
      const before = mcpRequestSnapshot(input);
      sent = await scripts.session.pre(before);
      input = await scripts.placeholders.restore(applyMcpSnapshot(input, before, sent), context.host.getSecret);
    }
    // Arguments that are not a JSON object refuse the send before anything is spawned or dialled.
    call = mcpOperationCall(input.operation);
    connection = await connectMcp(selected.server, context, input, selected.path);
  } catch (error) {
    failed('prepare', error, undefined, input);
    throw error;
  }

  // The send stage's own clock: a send-stage failure never counts resolve, the approval or the token.
  startedAt = Date.now();
  const outcome = await runMcpSession({
    transport: connection.wire,
    operation: call,
    clientVersion: MCP_CLIENT_VERSION,
    timeoutMs: input.timeoutMs,
    signal: controller.signal,
    onMessage: (message) => controller.queue.push({ protocol: 'mcp', kind: 'message', message }),
    ...(input.protocolVersion !== undefined ? { protocolVersion: input.protocolVersion } : {}),
  });
  const exchange = buildMcpExchange({
    transport: connection.transport,
    wire: connection.wire,
    operation: input.operation,
    outcome,
    ...(selected.server.catalogue !== undefined ? { catalogue: selected.server.catalogue } : {}),
  });
  // Only a 401 says the token is stale, as for REST; a cancel says nothing.
  const refused = exchange.httpCalls?.some((one) => one.status === 401) === true;
  dropRefusedToken(context, connection.auth, refused && !controller.signal.aborted);
  const failure = outcome.failure;
  if (failure !== undefined && (run || failure.code === 'mcp-cancelled')) {
    failed('send', failure, connection.attempted, input, exchange);
    throw failure;
  }
  return {
    subject: mcpSubject(exchange),
    raw: rawOf(exchange),
    exchange: { kind: 'mcp', mcp: exchange },
    checks: [checkMcpResult(exchange)],
    ...(input.transport.type !== 'stdio' ? originOf(input.transport.url) : {}),
    ...(scripts !== undefined
      ? { script: await scripts.session.post(sent as McpRequestSnapshot, mcpResponseSnapshot(exchange)) }
      : {}),
  };
}

/** The `${secret:…}` names a server's transport reaches, under the project's scopes and each environment's. */
function transportSecretNeeds(project: Project, transport: McpTransport): SecretNeed[] {
  const scopeSets = [
    resolveScopes(project, undefined, {}, {}),
    ...project.environments.map((environment) => resolveScopes(project, environment.id, {}, {})),
  ];
  const texts = transportTexts(transport);
  const names = new Set(scopeSets.flatMap((scopes) => secretNamesInValue(texts, scopes)));
  return [...names].map((name) => ({
    ref: secretPseudoRef(name),
    envName: secretEnvName(name),
    purpose: `secret "${name}"`,
  }));
}

/** MCP's run facet. */
export const mcpRun: ProtocolRun<McpSelected> = {
  groups(project) {
    return mcpServersOf(project).map((server) => {
      const candidates: RunGroup<McpSelected>['candidates'][number][] = [];
      walkTree<McpFolder, McpRequestDef, McpSelected>(
        server,
        [],
        server.name,
        `apis/${server.slug}/requests`,
        (request, chain, group) => selectedOf(server, request, chain, group),
        candidates,
      );
      return { order: server.order, name: server.name, candidates };
    });
  },

  whyNotRunnable() {
    // Every saved MCP request is runnable: an operation has no contract to fall out of.
    return undefined;
  },

  open(selected, scope, host, options) {
    const controller = exchangeController<McpLiveEvent>('mcp', options);
    const context: RunContext = { ...scope.context, host, signal: controller.signal };
    return controller.handle(() => sendMcpItem(selected, context, controller, options.run === true, options.scripts));
  },

  resolve(selected, scope, host) {
    return resolveMcp(selected, { ...scope.context, host });
  },

  scriptTypes(selected) {
    const tool = mcpToolFor(selected.server.catalogue, selected.request.operation);
    return Promise.resolve({ generated: mcpScriptTypes(tool) });
  },

  scriptLevels(selected) {
    // A server keeps no scripts of its own, so only its folders' run around a request's.
    return containerScriptLevels(selected.server, 'api', selected.chain);
  },

  secretNeeds(selected, project) {
    const { transport } = selected.server;
    return [
      ...transportSecretNeeds(project, transport),
      ...(transport.type === 'stdio' ? [] : authSecretNeeds(project, mcpEffectiveAuth(selected))),
    ];
  },
};

/** This protocol's member of the unions over every composed protocol (package split spec §3.4). */
declare module '#core/protocol/unions' {
  interface SelectedRequests {
    mcp: McpSelected;
  }
  interface SentExchanges {
    mcp: {
      readonly kind: 'mcp';
      /** The session whole: every message both ways, the transport's record, and the operation's answer. */
      readonly mcp: McpExchange;
    };
  }
}
