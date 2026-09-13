/**
 * Turns a {@link Project} into the exact set of files it occupies on disk.
 *
 * Keeping this pure (project in, `relative path -> file content` out) means the
 * saver only has to diff two maps, and tests can assert on the layout without
 * touching a file system.
 */

import { ProjectError } from '../errors.js';
import type { AuthConfig, Interface, Project, PropertyMap, RequestDef, WssRef } from './model.js';
import type { KeyValueEntry, RestApi, RestBody, RestFolder, RestRequestDef } from '../rest/model.js';
import { RAW_LANGUAGE_EXTENSIONS } from '../rest/model.js';
import {
  API_FILE,
  APIS_DIR,
  assertPathSegment,
  assertWssRelativePath,
  ENVIRONMENTS_DIR,
  FOLDER_FILE,
  INTERFACES_DIR,
  MAX_FOLDER_DEPTH,
  OPERATIONS_DIR,
  REQUEST_SUFFIX,
  REQUESTS_DIR,
  restBodyFileName,
  WSS_DIR,
  slugify,
} from './paths.js';
import { compact, stringifyYaml } from './yaml.js';

/** A project's files, keyed by path relative to the project root (always `/`-separated). */
export type ProjectFiles = ReadonlyMap<string, string>;

/** Relative path of the manifest. */
export const MANIFEST_PATH = 'wirebench.yaml';

/** Relative path of the keystore registry. */
export const KEYSTORES_PATH = `${WSS_DIR}/keystores.yaml`;

/**
 * The `disabled` list as written: sorted, deduplicated, and dropped entirely once it would be
 * empty — a name with no entry left in `properties` never outlives its map, so it is filtered
 * out here rather than merely sorted.
 */
function disabledList(disabled: readonly string[], properties: PropertyMap): readonly string[] | undefined {
  const known = new Set(Object.keys(properties));
  const kept = [...new Set(disabled.filter((name) => known.has(name)))].sort();
  return kept.length > 0 ? kept : undefined;
}

/**
 * One authentication configuration as written: its own fields only, in the schema's spelling,
 * with absent optionals and an empty scope list dropped. Every scheme's secret is a reference,
 * so there is nothing here to redact — the values live in the keychain (ADR-0004).
 */
export function authDocument(auth: AuthConfig): Record<string, unknown> {
  if (auth.type === 'oauth2') {
    return compact({ ...auth, scopes: auth.scopes.length > 0 ? [...auth.scopes] : undefined });
  }
  return compact({ ...auth });
}

function requestDocument(request: RequestDef): Record<string, unknown> {
  return compact({
    kind: request.kind,
    id: request.id,
    name: request.name,
    order: request.order,
    description: request.description,
    endpointId: request.endpointId,
    endpointUrl: request.endpointUrl,
    soapVersion: request.soapVersion,
    soapAction: request.soapAction,
    headers: request.headers.map((h) => ({ name: h.name, value: h.value })),
    attachments: request.attachments.map((a) => compact({ ...a })),
    auth: request.auth === undefined ? undefined : authDocument(request.auth),
    wsa: request.wsa === undefined ? undefined : compact({ ...request.wsa }),
    wssOutgoingRef: request.wssOutgoingRef,
    wssIncomingRef: request.wssIncomingRef,
    properties: compact({ ...request.properties }),
    orphaned: request.orphaned === true ? true : undefined,
  });
}

function interfaceDocument(iface: Interface): Record<string, unknown> {
  return compact({
    kind: iface.kind,
    id: iface.id,
    name: iface.name,
    order: iface.order,
    definitionUrl: iface.definitionUrl,
    cacheDefinition: iface.cacheDefinition,
    targetNamespace: iface.targetNamespace,
    endpoints: iface.endpoints.map((e) =>
      compact({ ...e, auth: e.auth === undefined ? undefined : authDocument(e.auth) }),
    ),
    defaultEndpointId: iface.defaultEndpointId,
    wsa: compact({ ...iface.wsa }),
    auth: iface.auth === undefined ? undefined : authDocument(iface.auth),
    operations: iface.operations.map((op) => ({
      name: op.name,
      bindingName: op.bindingName,
      slug: op.slug,
      order: op.order,
    })),
  });
}

/** One table row as written: `enabled` only when `false`, so a file stays quiet about the default. */
function keyValueDocuments(rows: readonly KeyValueEntry[]): Record<string, unknown>[] {
  return rows.map((row) =>
    compact({
      name: row.name,
      value: row.value,
      enabled: row.enabled ? undefined : false,
      description: row.description,
    }),
  );
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
    orphaned: request.orphaned === true ? true : undefined,
  });
}

/**
 * Adds one folder's own file, its requests (and their body files) and, recursively, the folders
 * below it.
 *
 * @throws ProjectError `project-path-invalid` for an unsafe slug, `project-folder-too-deep` for a
 * tree deeper than {@link MAX_FOLDER_DEPTH} — before any path is built, never after.
 */
function addFolderFiles(
  files: Map<string, string>,
  dir: string,
  node: { readonly folders: readonly RestFolder[]; readonly requests: readonly RestRequestDef[] },
  depth: number,
): void {
  for (const request of node.requests) {
    assertPathSegment(request.slug);
    const body = bodyDocument(request.body, request.slug);
    files.set(`${dir}/${request.slug}${REQUEST_SUFFIX}`, stringifyYaml(restRequestDocument(request)));
    if (body.file !== undefined) {
      files.set(`${dir}/${body.file[0]}`, body.file[1]);
    }
  }
  for (const folder of node.folders) {
    assertPathSegment(folder.slug);
    if (depth + 1 > MAX_FOLDER_DEPTH) {
      throw new ProjectError(
        'project-folder-too-deep',
        `Folder "${folder.name}" would nest more than ${String(MAX_FOLDER_DEPTH)} deep`,
        { details: { folder: folder.slug, depth: depth + 1, max: MAX_FOLDER_DEPTH } },
      );
    }
    const childDir = `${dir}/${folder.slug}`;
    files.set(
      `${childDir}/${FOLDER_FILE}`,
      stringifyYaml(
        compact({
          id: folder.id,
          name: folder.name,
          order: folder.order,
          description: folder.description,
          auth: folder.auth === undefined ? undefined : authDocument(folder.auth),
        }),
      ),
    );
    addFolderFiles(files, childDir, folder, depth + 1);
  }
}

/** Every file one API occupies, keyed by path relative to the project root. */
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
        definition: api.definition === undefined ? undefined : compact({ ...api.definition }),
      }),
    ),
  );
  addFolderFiles(files, `${base}/${REQUESTS_DIR}`, api, 0);
}

function wssDocument(ref: WssRef): string {
  return stringifyYaml(ref.document);
}

/**
 * Relative path of a WS-Security configuration file.
 *
 * @throws ProjectError `project-path-invalid` when `ref.file` is not a
 * relative path rooted at `wss/` with only safe segments.
 */
export function wssRefPath(direction: 'outgoing' | 'incoming', ref: WssRef): string {
  if (ref.file !== undefined) {
    assertWssRelativePath(ref.file);
    return ref.file;
  }
  return `${WSS_DIR}/${direction}/${slugify(ref.name)}.yaml`;
}

/** Options for {@link projectFiles}. */
export interface ProjectFilesOptions {
  /** Recorded in the manifest as `writtenBy`. Defaults to `'wirebench'`. */
  readonly writer?: string;
}

/**
 * Builds the complete `relative path -> content` map for a project.
 *
 * Every slug is validated with {@link assertPathSegment} (and every
 * `WssRef.file` with {@link assertWssRelativePath}) before any path is built,
 * so a corrupted slug or an unvalidated file reference throws
 * `ProjectError('project-path-invalid')` here — before `saveProject` ever
 * touches the file system.
 */
export function projectFiles(project: Project, options?: ProjectFilesOptions): ProjectFiles {
  const files = new Map<string, string>();
  const writer = options?.writer ?? 'wirebench';

  files.set(
    MANIFEST_PATH,
    stringifyYaml(
      compact({
        formatVersion: project.formatVersion,
        id: project.id,
        name: project.name,
        description: project.description,
        settings: compact({ ...project.settings }),
        properties: { ...project.properties },
        disabled: disabledList(project.disabledProperties, project.properties),
        activeEnvironmentId: project.activeEnvironmentId,
        writtenBy: writer,
      }),
    ),
  );

  for (const environment of project.environments) {
    assertPathSegment(environment.slug);
    files.set(
      `${ENVIRONMENTS_DIR}/${environment.slug}.yaml`,
      stringifyYaml(
        compact({
          id: environment.id,
          name: environment.name,
          order: environment.order,
          endpoints: { ...environment.endpoints },
          properties: { ...environment.properties },
          disabled: disabledList(environment.disabledProperties, environment.properties),
        }),
      ),
    );
  }

  for (const iface of project.interfaces) {
    assertPathSegment(iface.slug);
    const base = `${INTERFACES_DIR}/${iface.slug}`;
    files.set(`${base}/interface.yaml`, stringifyYaml(interfaceDocument(iface)));
    for (const operation of iface.operations) {
      assertPathSegment(operation.slug);
      const dir = `${base}/${OPERATIONS_DIR}/${operation.slug}`;
      for (const request of operation.requests) {
        assertPathSegment(request.slug);
        files.set(`${dir}/${request.slug}${REQUEST_SUFFIX}`, stringifyYaml(requestDocument(request)));
        files.set(`${dir}/${request.slug}.xml`, request.envelopeXml);
      }
    }
  }

  for (const api of project.apis) {
    addApiFiles(files, api);
  }

  for (const [direction, refs] of [
    ['outgoing', project.wss.outgoing],
    ['incoming', project.wss.incoming],
  ] as const) {
    for (const ref of refs) {
      files.set(wssRefPath(direction, ref), wssDocument(ref));
    }
  }
  if (project.wss.keystores.length > 0) {
    files.set(KEYSTORES_PATH, stringifyYaml({ keystores: project.wss.keystores.map((k) => k.document) }));
  }

  return files;
}
