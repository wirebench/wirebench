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
import { apiManagedFiles } from '../project/managed-files.js';
import {
  API_FILE,
  APIS_DIR,
  assertPathSegment,
  REQUEST_SUFFIX,
  REQUESTS_DIR,
  restBodyFileName,
  restExamplesDirName,
  WEBHOOKS_DIR,
} from '../project/paths.js';
import { assertSupportedKind, parseFile } from '../project/schema-parts.js';
import type { WebhookSigningFile } from '../project/schema-parts.js';
import {
  addFolderFiles,
  authDocument,
  definitionDocument,
  keyValueDocuments,
  scriptsDocument,
  writeScriptFiles,
} from '../project/serialize-helpers.js';
import type { RequestWriter } from '../project/serialize-helpers.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import type { ProtocolStorage } from '../protocol/module.js';
import type { HookLink, WebhookSigning } from '../webhooks/model.js';
import { toSignatureScheme } from '../http/webhook-signature.js';
import { apiFileSchema, restRequestFileSchema } from './files.js';
import { exampleBodyExtension, RAW_LANGUAGE_EXTENSIONS } from './model.js';
import type { RestApi, RestBody, RestRequestDef, RestRequestSettings, RestResponseExample } from './model.js';

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

/** The `examples` field of a parsed REST request document. */
type RestRequestFileExamples = NonNullable<ReturnType<typeof restRequestFileSchema.parse>['examples']>;

/** Where one example's body is written, relative to its request's directory: `<slug>.examples/<id>.body.<ext>`. */
function exampleFile(slug: string, id: string, contentType: string | undefined): string {
  const dir = restExamplesDirName(slug);
  assertPathSegment(dir);
  assertPathSegment(id);
  return `${dir}/${id}.body.${exampleBodyExtension(contentType)}`;
}

/**
 * A request's response examples as loaded, each body read from the file its entry names. The name
 * comes from the request file, so each of its `/` parts is checked as a path segment first, as a raw
 * body's is; a missing file is a problem and loads the example without a body.
 */
async function loadExamples(
  fs: FsLike,
  root: string,
  dir: string,
  documents: RestRequestFileExamples,
  requestName: string,
  problems: ProjectProblem[],
): Promise<RestResponseExample[]> {
  const examples: RestResponseExample[] = [];
  for (const { file, ...document } of documents) {
    let body: string | undefined;
    if (file !== undefined) {
      for (const part of file.split('/')) {
        assertPathSegment(part);
      }
      const relative = `${dir}/${file}`;
      const text = await readFileIfExists(fs, abs(root, relative));
      if (text === undefined) {
        problems.push({
          code: 'missing-body',
          message: `Request "${requestName}" has no file for example "${document.name}"; loaded without a body`,
          file: relative,
        });
      } else {
        body = text.toString('utf8');
      }
    }
    examples.push({
      id: document.id,
      name: document.name,
      status: document.status,
      statusText: document.statusText,
      headers: keyValueEntries(document.headers),
      ...optional('contentType', document.contentType),
      ...optional('body', body),
    });
  }
  return examples;
}

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
      ...(parsed.examples !== undefined
        ? { examples: await loadExamples(fs, root, dir, parsed.examples, parsed.name, problems) }
        : {}),
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

/** A `signing` key as written: the scheme's own fields, and references only. */
export function signingDocument(signing: WebhookSigning | undefined): Record<string, unknown> | undefined {
  if (signing === undefined) return undefined;
  if (signing.mode === 'none') return { mode: 'none' };
  return compact({
    mode: 'sign',
    scheme: compact({ ...signing.scheme }),
    secretRef: signing.secretRef,
    secretEnv: signing.secretEnv,
  });
}

/**
 * A body as written, plus the sibling file a raw body needs.
 *
 * The text of a raw body is deliberately *not* in the request document: it goes to
 * `<slug>.body.<ext>` beside it, so a JSON payload is a JSON file in git — reviewable, searchable
 * and mergeable — rather than a quoted blob inside YAML.
 */
function bodyDocument(
  body: RestBody,
  requestSlug: string,
): { readonly document: Record<string, unknown>; readonly file?: readonly [string, string] } {
  switch (body.kind) {
    case 'raw': {
      const name = restBodyFileName(requestSlug, RAW_LANGUAGE_EXTENSIONS[body.language]);
      assertPathSegment(name);
      return {
        document: compact({ kind: 'raw', language: body.language, contentType: body.contentType, file: name }),
        file: [name, body.text],
      };
    }
    case 'form':
      return { document: { kind: 'form', fields: keyValueDocuments(body.fields) } };
    case 'multipart':
      return {
        document: {
          kind: 'multipart',
          parts: body.parts.map((part) => compact({ ...part, enabled: part.enabled ? undefined : false })),
        },
      };
    case 'binary':
      return { document: { kind: 'binary', source: { ...body.source }, contentType: body.contentType } };
    default:
      return { document: { kind: 'none' } };
  }
}

function restRequestDocument(request: RestRequestDef): Record<string, unknown> {
  const body = bodyDocument(request.body, request.slug);
  return compact({
    kind: request.kind,
    id: request.id,
    name: request.name,
    order: request.order,
    description: request.description,
    method: request.method,
    url: request.url,
    pathParams: request.pathParams.length > 0 ? keyValueDocuments(request.pathParams) : undefined,
    query: request.query.length > 0 ? keyValueDocuments(request.query) : undefined,
    headers: request.headers.length > 0 ? keyValueDocuments(request.headers) : undefined,
    body: body.document,
    auth: authDocument(request.auth),
    settings: Object.keys(request.settings).length > 0 ? compact({ ...request.settings }) : undefined,
    assertions: request.assertions.length > 0 ? request.assertions.map((a) => compact({ ...a })) : undefined,
    orphaned: request.orphaned === true ? true : undefined,
    contract:
      request.contract === undefined ? undefined : { method: request.contract.method, path: request.contract.path },
    hook: request.hook === undefined ? undefined : { ...request.hook },
    signing: signingDocument(request.signing),
    scripts: scriptsDocument(request.scripts, request.slug).document,
    examples: request.examples?.map(({ body, headers, ...rest }) =>
      compact({
        ...rest,
        headers: headers.length > 0 ? keyValueDocuments(headers) : undefined,
        file: body === undefined ? undefined : exampleFile(request.slug, rest.id, rest.contentType),
      }),
    ),
  });
}

/** A REST request as written: its document, its raw body file and its script files. Core writes the webhook collection's items with it. */
export const writeRestRequest: RequestWriter<RestRequestDef> = (files, dir, request) => {
  const body = bodyDocument(request.body, request.slug);
  files.set(`${dir}/${request.slug}${REQUEST_SUFFIX}`, stringifyYaml(restRequestDocument(request)));
  if (body.file !== undefined) {
    files.set(`${dir}/${body.file[0]}`, body.file[1]);
  }
  writeScriptFiles(files, dir, request.scripts, request.slug);
  for (const example of request.examples ?? []) {
    if (example.body !== undefined) {
      files.set(`${dir}/${exampleFile(request.slug, example.id, example.contentType)}`, example.body);
    }
  }
};

/** Every file one REST API occupies, keyed by path relative to the project root. */
function addApiFiles(files: Map<string, string>, api: RestApi): void {
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
        baseUrl: api.baseUrl,
        servers: api.servers.length > 0 ? api.servers.map((server) => compact({ ...server })) : undefined,
        auth: api.auth === undefined ? undefined : authDocument(api.auth),
        definition: api.definition === undefined ? undefined : definitionDocument(api.definition),
      }),
    ),
  );
  addFolderFiles<RestRequestDef>(files, `${base}/${REQUESTS_DIR}`, api, 0, writeRestRequest);
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

  files(api) {
    const files = new Map<string, string>();
    addApiFiles(files, api);
    return files;
  },
  managed: (fs, root, slug) => apiManagedFiles(fs, root, slug),

  containers: (project) => project.apis,
  withContainers: (project, apis) => ({ ...project, apis }),
};
