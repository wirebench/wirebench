/**
 * How WebSocket APIs are stored in a project folder (spec §3.2): `apis/<slug>/api.yaml` with
 * `kind: websocket`, and a tree of folders and `*.request.yaml` files under `requests/`, each saved
 * message in a sibling `<slug>.msg-<message slug>.<ext>`.
 */

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
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { wsApiFileSchema, wsRequestFileSchema } from './files.js';
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
      ...(parsed.contract !== undefined ? { contract: { channel: parsed.contract.channel } } : {}),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
    };
  };
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

  // Task 3.3 moves the writer here. Until then core writes this protocol's files itself.
  files() {
    throw new Error('wsStorage.files is not implemented yet');
  },
  managed() {
    return Promise.reject(new Error('wsStorage.managed is not implemented yet'));
  },

  containers: (project) => project.wsApis,
  withContainers: (project, wsApis) => ({ ...project, wsApis }),
};
