/**
 * The MCP fifth of the project model (#79): an *MCP server* — how to reach it, the catalogue it
 * last advertised, and a tree of folders and requests, one request per operation the user wants to
 * keep.
 *
 * An MCP server is the fifth sibling container under `apis/`, beside REST, gRPC and WebSocket APIs
 * (ADR-0007). It identifies itself with `kind: mcp` at the top of every file it writes. In memory
 * it is kept in its own list on the project, so the compiler points at every surface that needs a
 * fifth branch.
 *
 * The same rules as the other models apply: every field is `readonly`, ids are ULIDs so an entity
 * survives a rename, `slug` is the file-system name derived from `name`, and nothing here ever
 * holds a secret: a value that is one is a `${secret:…}` reference, expanded at send time.
 */

import type { Assertion } from '../assert/model.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { AuthConfig, CreateOptions, Project } from '../project/model.js';
import { containersOf, generateId, withContainersOf } from '../project/model.js';
import { slugify } from '../project/paths.js';
import type { RequestScripts } from '../script/model.js';

// The pure tree and naming rules live in `shape.ts`, which imports nothing at run time, so the
// renderer can have them without `node:path` coming along; they are re-exported here because this
// is where callers expect an MCP model rule to be.
export { mcpArgsFileName, mcpArgumentsEmpty, mcpFolderRequests, mcpServerFolders, mcpServerRequests } from './shape.js';

/**
 * A local server, spawned with no shell as `command` with `args`. `cwd` is relative to the project
 * folder; absent, the server runs in the project folder. `env` is added to the few parent variables
 * the session passes on.
 */
export interface McpStdioTransport {
  readonly type: 'stdio';
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: readonly KeyValueEntry[];
}

/**
 * A server over HTTP: `http` is Streamable HTTP, and `sse` the legacy HTTP+SSE transport, whose
 * `url` is the event-stream endpoint. Auth is the auth a REST API has.
 */
export interface McpHttpTransport {
  readonly type: 'http' | 'sse';
  readonly url: string;
  readonly headers: readonly KeyValueEntry[];
  readonly auth?: AuthConfig;
}

/** How a session reaches its server. */
export type McpTransport = McpStdioTransport | McpHttpTransport;

/** A server's own settings. Absent means the default. */
export interface McpServerSettings {
  /** The deadline of a whole session; a request's own value wins. The default is 30 s. */
  readonly timeoutMs?: number;
  /** The protocol version `initialize` asks for; absent, the latest the client knows. */
  readonly protocolVersion?: string;
}

/** A request's own settings. Absent means the server's. */
export interface McpRequestSettings {
  readonly timeoutMs?: number;
}

/** Where the catalogue came from: kept in `api.yaml` under `catalogue`, written by a refresh. */
export interface McpCatalogueInfo {
  /** ISO 8601. */
  readonly fetchedAt: string;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly protocolVersion: string;
}

/** A tool as the server listed it. Fields the protocol adds later are kept as they came. */
export interface McpCatalogueTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

/** A resource as the server listed it. */
export interface McpCatalogueResource {
  readonly uri: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly [key: string]: unknown;
}

/** A resource template as the server listed it. */
export interface McpCatalogueResourceTemplate {
  readonly uriTemplate: string;
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly [key: string]: unknown;
}

/** One argument a prompt takes. Prompt arguments are strings. */
export interface McpCataloguePromptArgument {
  readonly name: string;
  readonly description?: string;
  readonly required?: boolean;
  readonly [key: string]: unknown;
}

/** A prompt as the server listed it. */
export interface McpCataloguePrompt {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly arguments?: readonly McpCataloguePromptArgument[];
  readonly [key: string]: unknown;
}

/**
 * The server's lists, kept in `catalogue.json` beside `api.yaml`. Only the lists the server
 * advertised are present; each is sorted by name (or URI) when written.
 */
export interface McpCatalogue {
  readonly tools?: readonly McpCatalogueTool[];
  readonly resources?: readonly McpCatalogueResource[];
  readonly resourceTemplates?: readonly McpCatalogueResourceTemplate[];
  readonly prompts?: readonly McpCataloguePrompt[];
}

/** The four operations that list what the server has. */
export type McpListMethod = 'tools/list' | 'resources/list' | 'resources/templates/list' | 'prompts/list';

/** Every operation a request can be. There are no free-form JSON-RPC methods. */
export type McpMethod = McpListMethod | 'tools/call' | 'resources/read' | 'prompts/get';

/**
 * The one operation a request runs. A `tools/call`'s `arguments` is the JSON text as edited, kept
 * in the sibling `<slug>.args.json`; blank text writes no file and sends `{}`.
 */
export type McpOperation =
  | { readonly method: McpListMethod }
  | { readonly method: 'tools/call'; readonly tool: string; readonly arguments: string }
  | { readonly method: 'resources/read'; readonly uri: string }
  | { readonly method: 'prompts/get'; readonly prompt: string; readonly arguments: readonly KeyValueEntry[] };

/** A saved MCP request: one operation, checked by its assertions. */
export interface McpRequestDef {
  readonly kind: 'mcp';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly operation: McpOperation;
  readonly settings: McpRequestSettings;
  /** Checked against the operation's result as JSON (request-assertions spec §3). */
  readonly assertions: readonly Assertion[];
  /** Pre-request and post-response scripts, in files beside the request (ADR-0016). */
  readonly scripts?: RequestScripts;
}

/** A named node in an MCP server's tree. */
export interface McpFolder {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly scripts?: RequestScripts;
  readonly folders: readonly McpFolder[];
  readonly requests: readonly McpRequestDef[];
}

/** An MCP server: its transport, its catalogue, and a tree of folders and requests. */
export interface McpServer {
  readonly kind: 'mcp';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly transport: McpTransport;
  readonly settings: McpServerSettings;
  /** Where {@link catalogue} came from; set by a refresh. */
  readonly catalogueInfo?: McpCatalogueInfo;
  /** The lists of the last refresh, in `catalogue.json`. */
  readonly catalogue?: McpCatalogue;
  readonly folders: readonly McpFolder[];
  readonly requests: readonly McpRequestDef[];
}

function idOf(options: CreateOptions | undefined): string {
  return options?.id ?? (options?.newId ?? generateId)();
}

/** Input to {@link createMcpServer} beyond the name. */
export interface CreateMcpServerInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly transport?: McpTransport;
  readonly settings?: McpServerSettings;
  readonly catalogueInfo?: McpCatalogueInfo;
  readonly catalogue?: McpCatalogue;
  readonly folders?: readonly McpFolder[];
  readonly requests?: readonly McpRequestDef[];
}

/** Creates an empty server: a stdio one with no command, unless `transport` says otherwise. */
export function createMcpServer(name: string, input: CreateMcpServerInput = {}): McpServer {
  return {
    kind: 'mcp',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    transport: input.transport ?? { type: 'stdio', command: '', args: [], env: [] },
    settings: input.settings ?? {},
    ...(input.catalogueInfo !== undefined ? { catalogueInfo: input.catalogueInfo } : {}),
    ...(input.catalogue !== undefined ? { catalogue: input.catalogue } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

/** Input to {@link createMcpFolder} beyond the name. */
export interface CreateMcpFolderInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly scripts?: RequestScripts;
  readonly folders?: readonly McpFolder[];
  readonly requests?: readonly McpRequestDef[];
}

/** Creates an empty folder. */
export function createMcpFolder(name: string, input: CreateMcpFolderInput = {}): McpFolder {
  return {
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.scripts !== undefined ? { scripts: input.scripts } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

/** Input to {@link createMcpRequest} beyond the name. */
export interface CreateMcpRequestInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly operation?: McpOperation;
  readonly settings?: McpRequestSettings;
  readonly assertions?: readonly Assertion[];
  readonly scripts?: RequestScripts;
}

/** Creates a request that lists the server's tools, unless `operation` says otherwise. */
export function createMcpRequest(name: string, input: CreateMcpRequestInput = {}): McpRequestDef {
  return {
    kind: 'mcp',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    operation: input.operation ?? { method: 'tools/list' },
    settings: input.settings ?? {},
    assertions: input.assertions ?? [],
    ...(input.scripts !== undefined ? { scripts: input.scripts } : {}),
  };
}

/** The project's MCP servers, in the order the project holds them. */
export function mcpServersOf(project: Project): readonly McpServer[] {
  return containersOf(project, 'mcp') as readonly McpServer[];
}

/** `project` with its MCP servers replaced; every other kind's containers are kept. */
export function withMcpServers(project: Project, servers: readonly McpServer[]): Project {
  return withContainersOf(project, 'mcp', servers);
}

/** This protocol's member of the unions over every composed protocol (package split spec §3.4). */
declare module '../protocol/unions.js' {
  interface RequestDefs {
    mcp: McpRequestDef;
  }
}
