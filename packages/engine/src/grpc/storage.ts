/**
 * How gRPC APIs are stored in a project folder (spec §3.2): `apis/<slug>/api.yaml` with
 * `kind: grpc`, and a tree of folders and `*.request.yaml` files under `requests/`, each request's
 * message in the sibling `<slug>.body.json`.
 */

import type { Assertion } from '../assert/model.js';
import { toCallbackAssertion } from '../assert/schema.js';
import type { FsLike } from '../project/fs.js';
import { readFileIfExists } from '../project/fs.js';
import {
  abs,
  authConfig,
  exact,
  keyValueEntries,
  loadFolderContents,
  loadScripts,
  optional,
  readYaml,
} from '../project/load-helpers.js';
import type { RequestReader } from '../project/load-helpers.js';
import type { ProjectProblem } from '../project/load.js';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { grpcApiFileSchema, grpcRequestFileSchema } from './files.js';
import type { GrpcApi, GrpcRequestDef, GrpcRequestSettings } from './model.js';

/**
 * Reads a gRPC request and its message file. A request whose message file is gone loads with an
 * empty message and a `missing-body` problem, exactly as a REST raw body does.
 */
function grpcRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<GrpcRequestDef> {
  return async (dir, fileName, unclaimed) => {
    const relative = `${dir}/${fileName}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(grpcRequestFileSchema, document, relative);
    unclaimed.delete(fileName);
    let message = '';
    if (parsed.message !== undefined) {
      // As a REST body file: a name beside the request, never a path out of it.
      assertPathSegment(parsed.message);
      unclaimed.delete(parsed.message);
      const messageRelative = `${dir}/${parsed.message}`;
      const text = await readFileIfExists(fs, abs(root, messageRelative));
      if (text === undefined) {
        problems.push({
          code: 'missing-body',
          message: `Request "${parsed.name}" has no message file; loaded with an empty message`,
          file: messageRelative,
        });
      } else {
        message = text.toString('utf8');
      }
    }
    const scripts = await loadScripts(
      fs,
      root,
      dir,
      fileName.slice(0, -REQUEST_SUFFIX.length),
      parsed.scripts,
      parsed.name,
      problems,
      (name) => unclaimed.delete(name),
    );
    return {
      kind: 'grpc',
      id: parsed.id,
      name: parsed.name,
      slug: fileName.slice(0, -REQUEST_SUFFIX.length),
      order: parsed.order,
      ...optional('description', parsed.description),
      service: parsed.service,
      method: parsed.method,
      methodKind: parsed.methodKind,
      metadata: keyValueEntries(parsed.metadata),
      message,
      auth: authConfig(parsed.auth),
      settings: exact<GrpcRequestSettings>(parsed.settings),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
      ...(parsed.assertions.length > 0
        ? {
            assertions: parsed.assertions.map((a) =>
              a.type === 'callback' ? toCallbackAssertion(a) : exact<Assertion>(a),
            ),
          }
        : {}),
      ...(scripts !== undefined ? { scripts } : {}),
    };
  };
}

/** gRPC's storage facet. */
export const grpcStorage: ProtocolStorage<GrpcApi> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const parsed = parseFile(grpcApiFileSchema, document, `${APIS_DIR}/${slug}/${API_FILE}`);
    const contents = await loadFolderContents(
      fs,
      root,
      `${APIS_DIR}/${slug}/${REQUESTS_DIR}`,
      0,
      problems,
      grpcRequestReader(fs, root, problems),
    );
    return {
      kind: 'grpc',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      target: parsed.target,
      tls: parsed.tls,
      metadata: keyValueEntries(parsed.metadata),
      ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      ...(parsed.definition !== undefined
        ? {
            definition: {
              kind: parsed.definition.kind,
              source: parsed.definition.source,
              cache: parsed.definition.cache,
              roots: parsed.definition.roots,
              ...optional('reflectionVersion', parsed.definition.reflectionVersion),
              ...optional('trustInvalid', parsed.definition.trustInvalid),
            },
          }
        : {}),
      folders: contents.folders,
      requests: contents.requests,
    };
  },

  // Task 3.3 moves the writer here. Until then core writes this protocol's files itself.
  files() {
    throw new Error('grpcStorage.files is not implemented yet');
  },
  managed() {
    return Promise.reject(new Error('grpcStorage.managed is not implemented yet'));
  },

  containers: (project) => project.grpcApis,
  withContainers: (project, grpcApis) => ({ ...project, grpcApis }),
};
