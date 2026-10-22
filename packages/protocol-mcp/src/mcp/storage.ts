/**
 * How MCP servers are stored in a project folder (#79): `apis/<slug>/api.yaml` with `kind: mcp`,
 * the server's lists in `catalogue.json` beside it, and a tree of folders and `*.request.yaml`
 * files under `requests/`, each call's arguments in a sibling `<slug>.args.json`.
 */

import type { Assertion } from '#core/assert/model';
import { toCallbackAssertion } from '#core/assert/schema';
import type { FsLike } from '#core/project/fs';
import { readFileIfExists } from '#core/project/fs';
import {
  abs,
  authConfig,
  exact,
  keyValueEntries,
  loadFolderContents,
  loadScripts,
  optional,
  readYaml,
} from '#core/project/load-helpers';
import type { RequestReader } from '#core/project/load-helpers';
import type { ProjectProblem } from '#core/project/load';
import { apiManagedFiles } from '#core/project/managed-files';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR } from '#core/project/paths';
import { assertSupportedKind, parseFile } from '#core/project/schema-parts';
import {
  addFolderFiles,
  authDocument,
  keyValueDocuments,
  scriptsDocument,
  writeScriptFiles,
} from '#core/project/serialize-helpers';
import type { RequestWriter } from '#core/project/serialize-helpers';
import { compact, stringifyYaml } from '#core/project/yaml';
import type { ProtocolStorage } from '#core/protocol/module';
import {
  MCP_CATALOGUE_FILE,
  mcpRequestFileSchema,
  mcpServerFileSchema,
  parseMcpCatalogue,
  serializeMcpCatalogue,
} from './files.js';
import type { McpRequestFile, McpServerFile } from './files.js';
import { mcpArgsFileName, mcpArgumentsEmpty, mcpServersOf, withMcpServers } from './model.js';
import type {
  McpCatalogue,
  McpOperation,
  McpRequestDef,
  McpRequestSettings,
  McpServer,
  McpServerSettings,
  McpTransport,
} from './model.js';

/** The catalogue's path relative to the project root. */
export function mcpCataloguePath(serverSlug: string): string {
  assertPathSegment(serverSlug);
  return `${APIS_DIR}/${serverSlug}/${MCP_CATALOGUE_FILE}`;
}

/**
 * A request's operation as loaded. A `tools/call`'s arguments file must be a name beside the
 * request, never a path out of its folder; one that is gone is a `missing-body` problem, and the
 * call loads with no arguments, so it sends `{}`.
 *
 * @throws ProjectError `project-path-invalid` for an arguments file name that leaves the folder
 */
async function operationOf(
  fs: FsLike,
  root: string,
  dir: string,
  parsed: McpRequestFile,
  unclaimed: Set<string>,
  problems: ProjectProblem[],
): Promise<McpOperation> {
  const operation = parsed.operation;
  switch (operation.method) {
    case 'tools/call': {
      let text = '';
      if (operation.arguments !== undefined) {
        const file = operation.arguments.file;
        assertPathSegment(file);
        unclaimed.delete(file);
        const relative = `${dir}/${file}`;
        const buffer = await readFileIfExists(fs, abs(root, relative));
        if (buffer === undefined) {
          problems.push({
            code: 'missing-body',
            message: `Request "${parsed.name}" has no arguments file; loaded with no arguments`,
            file: relative,
          });
        } else {
          text = buffer.toString('utf8');
        }
      }
      return { method: 'tools/call', tool: operation.tool, arguments: text };
    }
    case 'resources/read':
      return { method: 'resources/read', uri: operation.uri };
    case 'prompts/get':
      return { method: 'prompts/get', prompt: operation.prompt, arguments: keyValueEntries(operation.arguments) };
    default:
      return { method: operation.method };
  }
}

/** Reads an MCP request, its arguments file and its scripts. */
function mcpRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<McpRequestDef> {
  return async (dir, fileName, unclaimed) => {
    const relative = `${dir}/${fileName}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(mcpRequestFileSchema, document, relative);
    unclaimed.delete(fileName);
    const slug = fileName.slice(0, -REQUEST_SUFFIX.length);
    const operation = await operationOf(fs, root, dir, parsed, unclaimed, problems);
    const scripts = await loadScripts(
      fs,
      root,
      dir,
      slug,
      parsed.scripts,
      `Request "${parsed.name}"`,
      problems,
      (name) => unclaimed.delete(name),
    );
    return {
      kind: 'mcp',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      operation,
      settings: exact<McpRequestSettings>(parsed.settings),
      assertions: parsed.assertions.map((a) => (a.type === 'callback' ? toCallbackAssertion(a) : exact<Assertion>(a))),
      ...(scripts !== undefined ? { scripts } : {}),
    };
  };
}

/** An operation as written, and the arguments file it needs, if any. */
function operationDocument(request: McpRequestDef): {
  readonly document: Record<string, unknown>;
  readonly argsFile?: string;
} {
  const operation = request.operation;
  switch (operation.method) {
    case 'tools/call': {
      if (mcpArgumentsEmpty(operation.arguments)) {
        return { document: { method: operation.method, tool: operation.tool } };
      }
      const file = mcpArgsFileName(request.slug);
      assertPathSegment(file);
      return { document: { method: operation.method, tool: operation.tool, arguments: { file } }, argsFile: file };
    }
    case 'resources/read':
      return { document: { method: operation.method, uri: operation.uri } };
    case 'prompts/get':
      return {
        document: compact({
          method: operation.method,
          prompt: operation.prompt,
          arguments: operation.arguments.length > 0 ? keyValueDocuments(operation.arguments) : undefined,
        }),
      };
    default:
      return { document: { method: operation.method } };
  }
}

/**
 * An MCP request as written: a `tools/call`'s arguments go to `<slug>.args.json` beside the
 * document, and only when there are any, so a call's arguments are a JSON file in git.
 */
const writeMcpRequest: RequestWriter<McpRequestDef> = (files, dir, request) => {
  const operation = operationDocument(request);
  files.set(
    `${dir}/${request.slug}${REQUEST_SUFFIX}`,
    stringifyYaml(
      compact({
        kind: request.kind,
        id: request.id,
        name: request.name,
        order: request.order,
        description: request.description,
        operation: operation.document,
        settings: Object.keys(request.settings).length > 0 ? compact({ ...request.settings }) : undefined,
        assertions: request.assertions.length > 0 ? request.assertions.map((a) => compact({ ...a })) : undefined,
        scripts: scriptsDocument(request.scripts, request.slug).document,
      }),
    ),
  );
  if (operation.argsFile !== undefined && request.operation.method === 'tools/call') {
    files.set(`${dir}/${operation.argsFile}`, request.operation.arguments);
  }
  writeScriptFiles(files, dir, request.scripts, request.slug);
};

/** A transport as written: empty tables and an absent auth are left out. */
function transportDocument(transport: McpTransport): Record<string, unknown> {
  if (transport.type === 'stdio') {
    return compact({
      type: transport.type,
      command: transport.command,
      args: transport.args.length > 0 ? [...transport.args] : undefined,
      cwd: transport.cwd,
      env: transport.env.length > 0 ? keyValueDocuments(transport.env) : undefined,
    });
  }
  return compact({
    type: transport.type,
    url: transport.url,
    headers: transport.headers.length > 0 ? keyValueDocuments(transport.headers) : undefined,
    auth: transport.auth === undefined ? undefined : authDocument(transport.auth),
  });
}

/** A transport as loaded. */
function transportOf(parsed: McpServerFile['transport']): McpTransport {
  if (parsed.type === 'stdio') {
    return {
      type: 'stdio',
      command: parsed.command,
      args: parsed.args,
      ...optional('cwd', parsed.cwd),
      env: keyValueEntries(parsed.env),
    };
  }
  return {
    type: parsed.type,
    url: parsed.url,
    headers: keyValueEntries(parsed.headers),
    ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
  };
}

/** Every file one MCP server occupies. It shares `apis/` with the others; its `kind` says which it is. */
function addMcpServerFiles(files: Map<string, string>, server: McpServer): void {
  assertPathSegment(server.slug);
  const base = `${APIS_DIR}/${server.slug}`;
  files.set(
    `${base}/${API_FILE}`,
    stringifyYaml(
      compact({
        kind: server.kind,
        id: server.id,
        name: server.name,
        order: server.order,
        description: server.description,
        transport: transportDocument(server.transport),
        settings: Object.keys(server.settings).length > 0 ? compact({ ...server.settings }) : undefined,
        catalogue:
          server.catalogueInfo === undefined
            ? undefined
            : {
                fetchedAt: server.catalogueInfo.fetchedAt,
                serverInfo: {
                  name: server.catalogueInfo.serverInfo.name,
                  version: server.catalogueInfo.serverInfo.version,
                },
                protocolVersion: server.catalogueInfo.protocolVersion,
              },
      }),
    ),
  );
  if (server.catalogue !== undefined) {
    files.set(mcpCataloguePath(server.slug), serializeMcpCatalogue(server.catalogue));
  }
  addFolderFiles<McpRequestDef>(files, `${base}/${REQUESTS_DIR}`, server, 0, writeMcpRequest);
}

/**
 * The server's `catalogue.json`, or `undefined` when it has none. One that does not read as a
 * catalogue is a problem, and the server loads without it; the file is left as it is.
 */
async function loadCatalogue(
  fs: FsLike,
  root: string,
  slug: string,
  problems: ProjectProblem[],
): Promise<McpCatalogue | undefined> {
  const relative = mcpCataloguePath(slug);
  const buffer = await readFileIfExists(fs, abs(root, relative));
  if (buffer === undefined) return undefined;
  const catalogue = parseMcpCatalogue(buffer.toString('utf8'));
  if (catalogue === undefined) {
    problems.push({
      code: 'catalogue-file-invalid',
      message: `"${relative}" is not a catalogue; the server loaded without one, and the file is left as it is`,
      file: relative,
    });
  }
  return catalogue;
}

/** MCP's storage facet. */
export const mcpStorage: ProtocolStorage<McpServer> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const parsed = parseFile(mcpServerFileSchema, document, `${APIS_DIR}/${slug}/${API_FILE}`);
    const catalogue = await loadCatalogue(fs, root, slug, problems);
    const contents = await loadFolderContents(
      fs,
      root,
      `${APIS_DIR}/${slug}/${REQUESTS_DIR}`,
      0,
      problems,
      mcpRequestReader(fs, root, problems),
    );
    return {
      kind: 'mcp',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      transport: transportOf(parsed.transport),
      settings: exact<McpServerSettings>(parsed.settings),
      ...(parsed.catalogue !== undefined
        ? {
            catalogueInfo: {
              fetchedAt: parsed.catalogue.fetchedAt,
              serverInfo: { name: parsed.catalogue.serverInfo.name, version: parsed.catalogue.serverInfo.version },
              protocolVersion: parsed.catalogue.protocolVersion,
            },
          }
        : {}),
      ...(catalogue !== undefined ? { catalogue } : {}),
      folders: contents.folders,
      requests: contents.requests,
    };
  },

  files(server) {
    const files = new Map<string, string>();
    addMcpServerFiles(files, server);
    return files;
  },

  // `catalogue.json` is the server's while it reads as a catalogue; one that does not is left alone.
  async managed(fs, root, slug) {
    const managed = await apiManagedFiles(fs, root, slug);
    const relative = mcpCataloguePath(slug);
    const buffer = await readFileIfExists(fs, abs(root, relative));
    if (buffer !== undefined && parseMcpCatalogue(buffer.toString('utf8')) !== undefined) {
      managed.push(relative);
    }
    return managed;
  },

  containers: (project) => mcpServersOf(project),
  withContainers: (project, servers) => withMcpServers(project, servers),
};
