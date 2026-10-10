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
import { apiManagedFiles } from '../project/managed-files.js';
import {
  API_FILE,
  APIS_DIR,
  assertPathSegment,
  REQUEST_SUFFIX,
  REQUESTS_DIR,
  restBodyFileName,
} from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import {
  addFolderFiles,
  authDocument,
  keyValueDocuments,
  scriptsDocument,
  writeScriptFiles,
} from '../project/serialize-helpers.js';
import type { RequestWriter } from '../project/serialize-helpers.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import type { ProtocolStorage } from '../protocol/module.js';
import { grpcApiFileSchema, grpcRequestFileSchema } from './files.js';
import type { GrpcApi, GrpcRequestDef, GrpcRequestSettings } from './model.js';
import { grpcApisOf, withGrpcApis } from './model.js';

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

/**
 * A gRPC request as written: the message text goes to `<slug>.body.json` beside the document, the
 * same convention as a REST raw body, so a message is a JSON file in git.
 */
const writeGrpcRequest: RequestWriter<GrpcRequestDef> = (files, dir, request) => {
  const messageFile = restBodyFileName(request.slug, 'json');
  assertPathSegment(messageFile);
  files.set(
    `${dir}/${request.slug}${REQUEST_SUFFIX}`,
    stringifyYaml(
      compact({
        kind: request.kind,
        id: request.id,
        name: request.name,
        order: request.order,
        description: request.description,
        service: request.service,
        method: request.method,
        methodKind: request.methodKind,
        metadata: request.metadata.length > 0 ? keyValueDocuments(request.metadata) : undefined,
        message: messageFile,
        auth: authDocument(request.auth),
        settings: Object.keys(request.settings).length > 0 ? compact({ ...request.settings }) : undefined,
        orphaned: request.orphaned === true ? true : undefined,
        assertions:
          request.assertions !== undefined && request.assertions.length > 0
            ? request.assertions.map((a) => compact({ ...a }))
            : undefined,
        scripts: scriptsDocument(request.scripts, request.slug).document,
      }),
    ),
  );
  files.set(`${dir}/${messageFile}`, request.message);
  writeScriptFiles(files, dir, request.scripts, request.slug);
};

/** Every file one gRPC API occupies. It shares `apis/` with the REST ones; its `kind` says which it is. */
function addGrpcApiFiles(files: Map<string, string>, api: GrpcApi): void {
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
        target: api.target,
        tls: api.tls,
        metadata: api.metadata.length > 0 ? keyValueDocuments(api.metadata) : undefined,
        auth: api.auth === undefined ? undefined : authDocument(api.auth),
        definition:
          api.definition === undefined
            ? undefined
            : compact({
                kind: api.definition.kind,
                source: api.definition.source,
                cache: api.definition.cache,
                roots: [...api.definition.roots],
                reflectionVersion: api.definition.reflectionVersion,
                trustInvalid: api.definition.trustInvalid,
              }),
      }),
    ),
  );
  addFolderFiles<GrpcRequestDef>(files, `${base}/${REQUESTS_DIR}`, api, 0, writeGrpcRequest);
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

  files(api) {
    const files = new Map<string, string>();
    addGrpcApiFiles(files, api);
    return files;
  },
  managed: (fs, root, slug) => apiManagedFiles(fs, root, slug),

  containers: (project) => grpcApisOf(project),
  withContainers: (project, grpcApis) => withGrpcApis(project, grpcApis),
};
