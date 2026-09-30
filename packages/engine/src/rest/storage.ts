/**
 * How REST APIs are stored in a project folder (spec §3.2): `apis/<slug>/api.yaml` with
 * `kind: rest`, and a tree of folders and `*.request.yaml` files under `requests/`, a raw body in
 * the sibling `<slug>.body.<ext>`.
 *
 * `restRequestReader` and `signingOf` are exported for core's loader, which reads the project's
 * webhook collection (REST requests in a tree of their own) until phase 3 of #184 moves it here.
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
  loadScripts,
  optional,
  readYaml,
} from '../project/load-helpers.js';
import type { RequestReader } from '../project/load-helpers.js';
import type { ProjectProblem } from '../project/load.js';
import { API_FILE, APIS_DIR, assertPathSegment, REQUEST_SUFFIX, REQUESTS_DIR, WEBHOOKS_DIR } from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { WebhookSigningFile } from '../project/schema-parts.js';
import type { ProtocolStorage } from '../protocol/module.js';
import type { HookLink, WebhookSigning } from '../webhooks/model.js';
import { toSignatureScheme } from '../webhooks/signature.js';
import { apiFileSchema, restRequestFileSchema } from './files.js';
import type { RestApi, RestBody, RestRequestDef, RestRequestSettings } from './model.js';

/** A parsed `signing` key as the model holds it. */
export function signingOf(parsed: WebhookSigningFile): WebhookSigning {
  if (parsed.mode === 'none') return { mode: 'none' };
  return {
    mode: 'sign',
    scheme: toSignatureScheme(parsed.scheme),
    ...optional('secretRef', parsed.secretRef),
    ...optional('secretEnv', parsed.secretEnv),
  };
}

/**
 * One request body as loaded. A raw body's text lives in a sibling file, so it is read here and
 * the file name is dropped: the model holds the text, the layout holds the name
 * (`project/paths.ts` rebuilds it on save from the language).
 */
async function loadBody(
  fs: FsLike,
  root: string,
  dir: string,
  document: RestRequestFileBody,
  requestName: string,
  problems: ProjectProblem[],
): Promise<RestBody> {
  switch (document.kind) {
    case 'raw': {
      // The name comes from the request file, which a pull or an import may have written: it must
      // name a file beside the request, never one elsewhere on the machine (`../…`).
      assertPathSegment(document.file);
      const relative = `${dir}/${document.file}`;
      const text = await readFileIfExists(fs, abs(root, relative));
      if (text === undefined) {
        problems.push({
          code: 'missing-body',
          message: `Request "${requestName}" has no body file; loaded with an empty body`,
          file: relative,
        });
      }
      return {
        kind: 'raw',
        language: document.language,
        ...optional('contentType', document.contentType),
        text: text === undefined ? '' : text.toString('utf8'),
      };
    }
    case 'form':
      return { kind: 'form', fields: keyValueEntries(document.fields) };
    case 'multipart':
      return {
        kind: 'multipart',
        parts: document.parts.map((part) =>
          part.kind === 'text'
            ? exact<Extract<RestBody, { kind: 'multipart' }>['parts'][number]>({ ...part, kind: 'text' })
            : exact<Extract<RestBody, { kind: 'multipart' }>['parts'][number]>({ ...part, kind: 'file' }),
        ),
      };
    case 'binary':
      return { kind: 'binary', source: document.source, contentType: document.contentType };
    default:
      return { kind: 'none' };
  }
}

/** The `body` field of a parsed REST request document. */
type RestRequestFileBody = ReturnType<typeof restRequestFileSchema.parse>['body'];

/** Reads a REST request and its raw body file. */
export function restRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<RestRequestDef> {
  return async (dir, fileName, unclaimed) => {
    const relative = `${dir}/${fileName}`;
    const document = await readYaml(fs, root, relative);
    assertSupportedKind(document, relative);
    const parsed = parseFile(restRequestFileSchema, document, relative);
    unclaimed.delete(fileName);
    if (parsed.body.kind === 'raw') {
      unclaimed.delete(parsed.body.file);
    }
    const slug = fileName.slice(0, -REQUEST_SUFFIX.length);
    const scripts = await loadScripts(fs, root, dir, slug, parsed.scripts, parsed.name, problems, (name) =>
      unclaimed.delete(name),
    );
    return {
      kind: 'rest',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      method: parsed.method,
      url: parsed.url,
      pathParams: keyValueEntries(parsed.pathParams),
      query: keyValueEntries(parsed.query),
      headers: keyValueEntries(parsed.headers),
      body: await loadBody(fs, root, dir, parsed.body, parsed.name, problems),
      auth: authConfig(parsed.auth),
      settings: exact<RestRequestSettings>(parsed.settings),
      assertions: parsed.assertions.map((a) => (a.type === 'callback' ? toCallbackAssertion(a) : exact<Assertion>(a))),
      ...(parsed.orphaned === true ? { orphaned: true } : {}),
      ...(parsed.contract !== undefined
        ? { contract: { method: parsed.contract.method, path: parsed.contract.path } }
        : {}),
      ...(parsed.hook !== undefined ? { hook: exact<HookLink>(parsed.hook) } : {}),
      ...(parsed.signing !== undefined ? { signing: signingOf(parsed.signing) } : {}),
      ...(scripts !== undefined ? { scripts } : {}),
    };
  };
}

/** A REST request under `apis/`: the same as {@link restRequestReader}, but a `hook` or `signing` has no place there. */
function apiRequestReader(fs: FsLike, root: string, problems: ProjectProblem[]): RequestReader<RestRequestDef> {
  const read = restRequestReader(fs, root, problems);
  return async (dir, fileName, unclaimed) => {
    const request = await read(dir, fileName, unclaimed);
    const misplaced = request.hook !== undefined ? 'hook' : request.signing !== undefined ? 'signing' : undefined;
    if (misplaced !== undefined) {
      const file = `${dir}/${fileName}`;
      throw new ProjectError(
        'project-file-invalid',
        `Invalid project file ${file}: ${misplaced} is only allowed under ${WEBHOOKS_DIR}/`,
        {
          details: { file, issues: [{ path: misplaced, message: `only allowed under ${WEBHOOKS_DIR}/` }] },
        },
      );
    }
    return request;
  };
}

/** REST's storage facet. */
export const restStorage: ProtocolStorage<RestApi> = {
  dir: APIS_DIR,

  async load(ctx, slug, document) {
    const { fs, root, problems } = ctx;
    const parsed = parseFile(apiFileSchema, document, `${APIS_DIR}/${slug}/${API_FILE}`);
    const contents = await loadFolderContents(
      fs,
      root,
      `${APIS_DIR}/${slug}/${REQUESTS_DIR}`,
      0,
      problems,
      apiRequestReader(fs, root, problems),
    );
    return {
      kind: 'rest',
      id: parsed.id,
      name: parsed.name,
      slug,
      order: parsed.order,
      ...optional('description', parsed.description),
      baseUrl: parsed.baseUrl,
      servers: parsed.servers.map((server) => exact<{ url: string; description?: string }>(server)),
      ...(parsed.auth !== undefined ? { auth: authConfig(parsed.auth) } : {}),
      ...(parsed.definition !== undefined
        ? {
            definition: {
              source: parsed.definition.source,
              cache: parsed.definition.cache,
              version: parsed.definition.version,
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
    throw new Error('restStorage.files is not implemented yet');
  },
  managed() {
    return Promise.reject(new Error('restStorage.managed is not implemented yet'));
  },

  containers: (project) => project.apis,
  withContainers: (project, apis) => ({ ...project, apis }),
};
