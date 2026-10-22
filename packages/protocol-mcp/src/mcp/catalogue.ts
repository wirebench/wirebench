/**
 * *Refresh catalogue* (#79): one session that lists what the server has. Initialize, then each list
 * the server advertised in its capabilities (`tools/list`, `resources/list`,
 * `resources/templates/list`, `prompts/list`), each followed through `nextCursor` up to
 * {@link MCP_CATALOGUE_MAX_PAGES} pages, then close.
 *
 * A refresh reaches the server as a send does: the same transport resolution, the same auth, and a
 * stdio command line only once the host has approved it. It records nothing to History: the
 * catalogue is what it is for, and the host writes it into the project.
 *
 * The catalogue comes back in the form storage writes it, sorted and with each entry's keys in a
 * fixed order, so a refresh that finds nothing new compares equal to what is on disk.
 */
import { McpError } from '#core/errors';
import type { RunScope } from '#core/protocol/module';
import type { RunContext } from '#core/run/context';
import type { SendHost } from '#core/run/host';
import { dropRefusedToken, unresolvedError } from '#core/run/send-helpers';
import { parseMcpCatalogue, serializeMcpCatalogue } from './files.js';
import { MCP_DEFAULT_TIMEOUT_MS } from './limits.js';
import type { McpCatalogue, McpCatalogueInfo, McpListMethod, McpServer } from './model.js';
import { mcpResultWarnings } from './operation.js';
import { connectMcp, MCP_CLIENT_VERSION, resolveMcpTransport } from './run.js';
import { runDrivenMcpSession } from './session.js';
import type { McpCapability, McpMessage, McpSessionBaseOptions, McpSessionOutcome } from './session.js';

/** The most pages one list is followed through; a server still offering a cursor after that is cut off. */
export const MCP_CATALOGUE_MAX_PAGES = 50;

/** What a refresh found: the lists in their stored form, and where they came from. */
export interface McpCatalogueRefresh {
  readonly catalogue: McpCatalogue;
  readonly info: McpCatalogueInfo;
  /** One line per list cut off at the page cap. */
  readonly warnings: readonly string[];
}

/** Options for {@link refreshMcpCatalogue}. */
export interface RefreshMcpCatalogueOptions {
  readonly signal?: AbortSignal;
  /** Called with each message as it is kept. */
  readonly onMessage?: (message: McpMessage) => void;
  /** The clock `fetchedAt` is read from. Default: now. */
  readonly now?: () => Date;
}

/** One list of the catalogue: its method, the capability it needs, and where its entries are in a page. */
interface ListSpec {
  readonly method: McpListMethod;
  readonly capability: McpCapability;
  readonly key: keyof McpCatalogue;
}

const LISTS: readonly ListSpec[] = [
  { method: 'tools/list', capability: 'tools', key: 'tools' },
  { method: 'resources/list', capability: 'resources', key: 'resources' },
  { method: 'resources/templates/list', capability: 'resources', key: 'resourceTemplates' },
  { method: 'prompts/list', capability: 'prompts', key: 'prompts' },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What one catalogue session collected, before it is put into its stored form. */
export interface CollectedMcpCatalogue {
  readonly outcome: McpSessionOutcome;
  /** The raw lists, as the server sent them; only the advertised ones. */
  readonly lists: Readonly<Record<string, readonly unknown[]>>;
  readonly warnings: readonly string[];
}

/**
 * Runs one catalogue session over `options.transport`: every advertised list, every page. Never
 * rejects; a failure is the outcome's `failure`. A list the server answers with a JSON-RPC error
 * fails the session with `mcp-catalogue-failed`.
 */
export async function collectMcpCatalogue(options: McpSessionBaseOptions): Promise<CollectedMcpCatalogue> {
  const lists: Record<string, unknown[]> = {};
  const warnings: string[] = [];
  const outcome = await runDrivenMcpSession(options, async (session) => {
    const capabilities = session.initialize?.['capabilities'];
    for (const spec of LISTS) {
      const advertised = isRecord(capabilities) ? capabilities[spec.capability] : undefined;
      if (advertised === undefined || advertised === null) continue;
      const entries: unknown[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        if (pages === MCP_CATALOGUE_MAX_PAGES) {
          warnings.push(`${spec.method} still had more after ${MCP_CATALOGUE_MAX_PAGES} pages; the rest was not read`);
          break;
        }
        pages += 1;
        const response = await session.call({
          method: spec.method,
          capability: spec.capability,
          ...(cursor !== undefined ? { params: { cursor } } : {}),
          validateResult: (result) => mcpResultWarnings(spec.method, result),
        });
        if ('error' in response) {
          throw new McpError(
            'mcp-catalogue-failed',
            `The MCP server refused ${spec.method}: ${response.error.code} ${response.error.message}`.trimEnd(),
            { details: { method: spec.method, error: response.error } },
          );
        }
        const page = isRecord(response.result) ? response.result : {};
        const found = page[spec.key];
        if (Array.isArray(found)) entries.push(...(found as unknown[]));
        const next = page['nextCursor'];
        cursor = typeof next === 'string' && next !== '' ? next : undefined;
      } while (cursor !== undefined);
      lists[spec.key] = entries;
    }
    return undefined;
  });
  return { outcome, lists, warnings };
}

/**
 * The collected lists in the form storage writes them: sorted, each entry's keys in a fixed order.
 *
 * @throws McpError `mcp-catalogue-invalid` when an entry lacks what the catalogue file requires
 * (a tool's `name` and `inputSchema`, a resource's `uri` and `name`, …)
 */
export function storedMcpCatalogue(lists: Readonly<Record<string, readonly unknown[]>>): McpCatalogue {
  const text = serializeMcpCatalogue(lists);
  if (parseMcpCatalogue(text) === undefined) {
    throw new McpError(
      'mcp-catalogue-invalid',
      'The MCP server listed an entry the catalogue cannot keep: a tool needs a name and an input schema, a resource a URI and a name, a template a URI template and a name, a prompt a name',
    );
  }
  // The written text read back keeps the written key order, which a schema's parse would not.
  return JSON.parse(text) as McpCatalogue;
}

/** The `initialize` result's `serverInfo`, as the catalogue's metadata keeps it. */
function serverInfoOf(initialize: Readonly<Record<string, unknown>> | undefined): McpCatalogueInfo['serverInfo'] {
  const info = initialize?.['serverInfo'];
  const name = isRecord(info) && typeof info['name'] === 'string' ? info['name'] : '';
  const version = isRecord(info) && typeof info['version'] === 'string' ? info['version'] : '';
  return { name, version };
}

/** A session failure, with a stdio server's stderr in its details so the host can show why it ended. */
function withStderr(failure: McpError, wire: unknown): McpError {
  const stderr = (wire as { stderr?: unknown }).stderr;
  if (typeof stderr !== 'string' || stderr === '') return failure;
  return new McpError(failure.code, failure.message, {
    details: { ...(failure.details ?? {}), stderr },
    cause: failure,
  });
}

/**
 * Refreshes `server`'s catalogue: one session, every advertised list and page. Writes nothing:
 * neither History nor the project; the host keeps what it returns.
 *
 * @throws McpError `mcp-command-unapproved` and the other errors of a send's connect, the session's
 * failure (`mcp-timeout`, `mcp-cancelled`, `mcp-connection-closed`, …), `mcp-catalogue-failed`,
 * `mcp-catalogue-invalid`; WirebenchError `mcp-unresolved-properties`
 */
export async function refreshMcpCatalogue(
  server: McpServer,
  scope: RunScope,
  host: SendHost,
  options: RefreshMcpCatalogueOptions = {},
): Promise<McpCatalogueRefresh> {
  const context: RunContext = {
    ...scope.context,
    host,
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  };
  const resolved = await resolveMcpTransport(server, context);
  if (resolved.unresolved.length > 0) {
    throw unresolvedError('mcp-unresolved-properties', server.name, resolved.unresolved);
  }
  const timeoutMs = context.timeoutMs ?? server.settings.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
  const connection = await connectMcp(
    server,
    context,
    { transport: resolved.input, commandLine: resolved.commandLine, timeoutMs },
    server.name,
  );
  const { protocolVersion } = server.settings;
  const collected = await collectMcpCatalogue({
    transport: connection.wire,
    clientVersion: MCP_CLIENT_VERSION,
    timeoutMs,
    ...(protocolVersion !== undefined ? { protocolVersion } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onMessage !== undefined ? { onMessage: options.onMessage } : {}),
  });
  const calls = (connection.wire as { calls?: readonly { readonly status?: number }[] }).calls;
  const refused = calls?.some((call) => call.status === 401) === true;
  dropRefusedToken(context, connection.auth, refused && options.signal?.aborted !== true);
  const { outcome } = collected;
  if (outcome.failure !== undefined) throw withStderr(outcome.failure, connection.wire);
  return {
    catalogue: storedMcpCatalogue(collected.lists),
    info: {
      fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
      serverInfo: serverInfoOf(outcome.initialize),
      protocolVersion: outcome.protocolVersion ?? '',
    },
    warnings: collected.warnings,
  };
}
