/**
 * How WebSocket APIs are stored in a project folder (spec §3.2): `apis/<slug>/api.yaml` with
 * `kind: websocket`, and a tree of folders and `*.request.yaml` files under `requests/`, each saved
 * message in a sibling `<slug>.msg-<message slug>.<ext>`.
 */

import type { Assertion } from '../assert/model.js';
import { toCallbackAssertion } from '../assert/schema.js';
import { ProjectError } from '../errors.js';
import type { FsLike } from '../project/fs.js';
import { readFileIfExists } from '../project/fs.js';
import {
  abs,
  authConfig,
  definitionAuth,
  exact,
  keyValueEntries,
  loadFolderContents,
  optional,
  readYaml,
} from '../project/load-helpers.js';
import type { RequestReader } from '../project/load-helpers.js';
import type { ProjectProblem } from '../project/load.js';
import { apiManagedFiles } from '../project/managed-files.js';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import { addFolderFiles, authDocument, definitionDocument, keyValueDocuments } from '../project/serialize-helpers.js';
import type { RequestWriter } from '../project/serialize-helpers.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { wsApiFileSchema, wsRequestFileSchema } from './files.js';
import { withWsApis, wsApisOf, wsMessageFileName } from './model.js';
import type { WsApi, WsRequestDef, WsRequestSettings, WsSavedMessage } from './model.js';

/**
 * Reads a WebSocket request and its saved messages, each in its own sibling file. A message whose
 * file is gone loads with empty content and a `missing-body` problem, exactly as a gRPC message
 * does; its slug is recovered from the file name between the `.msg-` marker and the extension.
 */
function wsRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<WsRequestDef> {
  return async (dir, fileName, unclaimed) => {
    const relative = `${dir}/${fileName}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(wsRequestFileSchema, document, relative);
    unclaimed.delete(fileName);
    const requestSlug = fileName.slice(0, -REQUEST_SUFFIX.length);
    const messages: WsSavedMessage[] = [];
    for (const entry of parsed.messages) {
      assertPathSegment(entry.file);
      unclaimed.delete(entry.file);
      const messageRelative = `${dir}/${entry.file}`;
      const text = await readFileIfExists(fs, abs(root, messageRelative));
      if (text === undefined) {
        problems.push({
          code: 'missing-body',
          message: `Request "${parsed.name}" has no message file; loaded with an empty message`,
          file: messageRelative,
        });
      }
      const slug = entry.file.slice(`${requestSlug}.msg-`.length, entry.file.lastIndexOf('.'));
      messages.push({
        id: entry.id,
        name: entry.name,
        slug,
        format: entry.format,
        content: text === undefined ? '' : text.toString('utf8'),
        ...(entry.contract !== undefined
          ? { contract: { message: entry.contract.message, generated: entry.contract.generated } }
          : {}),
      });
    }
    return {
      kind: 'websocket',
      id: parsed.id,
      name: parsed.name,
      slug: requestSlug,
      order: parsed.order,
      ...optional('description', parsed.description),
      url: parsed.url,
      query: keyValueEntries(parsed.query),
      headers: keyValueEntries(parsed.headers),
      subprotocols: parsed.subprotocols,
      auth: authConfig(parsed.auth),
      settings: exact<WsRequestSettings>(parsed.settings),
      messages,
      assertions: parsed.assertions.map((a) => (a.type === 'callback' ? toCallbackAssertion(a) : exact<Assertion>(a))),
      ...(parsed.contract !== undefined ? { contract: { channel: parsed.contract.channel } } : {}),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
    };
  };
}

/**
 * A WebSocket request as written: each saved message goes to a sibling file, so a JSON message is a
 * JSON file in git. Siblings rather than a directory, because every directory here loads as a folder.
 *
 * @throws ProjectError `duplicate-slug` when two of the request's messages share a slug.
 */
const writeWsRequest: RequestWriter<WsRequestDef> = (files, dir, request) => {
  const messages = request.messages.map((message) => {
    const file = wsMessageFileName(request.slug, message);
    assertPathSegment(file);
    if (files.has(`${dir}/${file}`)) {
      throw new ProjectError('duplicate-slug', `Request "${request.name}" has two messages named "${message.slug}"`, {
        details: { file: `${dir}/${file}` },
      });
    }
    files.set(`${dir}/${file}`, message.content);
    return compact({
      id: message.id,
      name: message.name,
      format: message.format === 'binary' ? 'binary' : undefined,
      file,
      contract:
        message.contract === undefined
          ? undefined
          : { message: message.contract.message, generated: message.contract.generated },
    });
  });
  files.set(
    `${dir}/${request.slug}${REQUEST_SUFFIX}`,
    stringifyYaml(
      compact({
        kind: request.kind,
        id: request.id,
        name: request.name,
        order: request.order,
        description: request.description,
        url: request.url,
        query: request.query.length > 0 ? keyValueDocuments(request.query) : undefined,
        headers: request.headers.length > 0 ? keyValueDocuments(request.headers) : undefined,
        subprotocols: request.subprotocols.length > 0 ? [...request.subprotocols] : undefined,
        auth: authDocument(request.auth),
        settings: Object.keys(request.settings).length > 0 ? compact({ ...request.settings }) : undefined,
        messages: messages.length > 0 ? messages : undefined,
        assertions: request.assertions.length > 0 ? request.assertions.map((a) => compact({ ...a })) : undefined,
        contract: request.contract === undefined ? undefined : { channel: request.contract.channel },
        orphaned: request.orphaned === true ? true : undefined,
      }),
    ),
  );
};

/** Every file one WebSocket API occupies. It shares `apis/` with the others; its `kind` says which it is. */
function addWsApiFiles(files: Map<string, string>, api: WsApi): void {
  assertPathSegment(api.slug);
  const base = `${APIS_DIR}/${api.slug}`;
  files.set(
    `${base}/${API_FILE}`,
    stringifyYaml(
      compact({
        kind: api.kind,
        id: api.id,
        name: api.name,
        order: api.order,
        description: api.description,
        url: api.url,
        headers: api.headers.length > 0 ? keyValueDocuments(api.headers) : undefined,
        auth: api.auth === undefined ? undefined : authDocument(api.auth),
        definition: api.definition === undefined ? undefined : definitionDocument(api.definition),
      }),
    ),
  );
  addFolderFiles<WsRequestDef>(files, `${base}/${REQUESTS_DIR}`, api, 0, writeWsRequest);
}

/** WebSocket's storage facet. */
export const wsStorage: ProtocolStorage<WsApi> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const parsed = parseFile(wsApiFileSchema, document, `${APIS_DIR}/${slug}/${API_FILE}`);
    const contents = await loadFolderContents(
      fs,
      root,
      `${APIS_DIR}/${slug}/${REQUESTS_DIR}`,
      0,
      problems,
      wsRequestReader(fs, root, problems),
    );
    return {
      kind: 'websocket',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      url: parsed.url,
      headers: keyValueEntries(parsed.headers),
      ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      ...(parsed.definition !== undefined
        ? {
            definition: {
              kind: parsed.definition.kind,
              source: parsed.definition.source,
              cache: parsed.definition.cache,
              ...optional('server', parsed.definition.server),
              ...optional('auth', definitionAuth(parsed.definition.auth)),
            },
          }
        : {}),
      folders: contents.folders,
      requests: contents.requests,
    };
  },

  files(api) {
    const files = new Map<string, string>();
    addWsApiFiles(files, api);
    return files;
  },
  managed: (fs, root, slug) => apiManagedFiles(fs, root, slug),

  containers: (project) => wsApisOf(project),
  withContainers: (project, wsApis) => withWsApis(project, wsApis),
};
