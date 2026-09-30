/**
 * What core's writer and every protocol's `storage.files` share when they turn a project into
 * files: authentication and a definition record as written, a request's `scripts` key and script
 * files, a table row, and the request tree an API (of any protocol) and the webhook collection
 * keep under `requests/`.
 *
 * A protocol's storage imports this file and never `serialize.ts`, which imports the protocols.
 */

import { ProjectError } from '../errors.js';
import type { KeyValueEntry } from '../rest/model.js';
import { scriptFileName } from '../script/model.js';
import type { RequestScripts } from '../script/model.js';
import type { AuthConfig, DefinitionAuth } from './model.js';
import { assertPathSegment, FOLDER_FILE, MAX_FOLDER_DEPTH } from './paths.js';
import { compact, stringifyYaml } from './yaml.js';

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

/**
 * A definition record as written (REST's and WebSocket's): its own fields, with the fetch
 * credentials in the schema's spelling through {@link authDocument} — references only, like every
 * other auth.
 */
export function definitionDocument(definition: { readonly auth?: DefinitionAuth }): Record<string, unknown> {
  return compact({ ...definition, auth: definition.auth === undefined ? undefined : authDocument(definition.auth) });
}

/**
 * A request's `scripts` key as written, plus the script files beside it (#63). Each file is named
 * from the slug; the key records the name only so the YAML reads on its own.
 */
export function scriptsDocument(
  scripts: RequestScripts | undefined,
  slug: string,
): { readonly document?: Record<string, unknown>; readonly files: readonly (readonly [string, string])[] } {
  if (scripts === undefined) {
    return { files: [] };
  }
  const files: [string, string][] = [];
  const nameOf = (phase: 'pre' | 'post'): string | undefined => {
    const source = scripts[phase];
    if (source === undefined) {
      return undefined;
    }
    const name = scriptFileName(slug, phase, scripts.api);
    assertPathSegment(name);
    files.push([name, source.text]);
    return name;
  };
  const pre = nameOf('pre');
  const post = nameOf('post');
  return {
    document: compact({
      pre,
      post,
      api: scripts.api === 'wirebench' ? undefined : scripts.api,
      enabled: scripts.enabled ? undefined : false,
      secrets: scripts.secrets.length > 0 ? [...scripts.secrets] : undefined,
      timeoutMs: scripts.timeoutMs,
    }),
    files,
  };
}

/** Writes a request's script files into `files` under `dir`. */
export function writeScriptFiles(
  files: Map<string, string>,
  dir: string,
  scripts: RequestScripts | undefined,
  slug: string,
): void {
  for (const [name, text] of scriptsDocument(scripts, slug).files) {
    files.set(`${dir}/${name}`, text);
  }
}

/** One table row as written: `enabled` only when `false`, so a file stays quiet about the default. */
export function keyValueDocuments(rows: readonly KeyValueEntry[]): Record<string, unknown>[] {
  return rows.map((row) =>
    compact({
      name: row.name,
      value: row.value,
      enabled: row.enabled ? undefined : false,
      description: row.description,
    }),
  );
}

/** A folder of either protocol's tree, for the writer that handles both. */
export interface FolderNode<R> {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly folders: readonly FolderNode<R>[];
  readonly requests: readonly R[];
}

/** Writes one request's files into `files` under `dir`: its document, and any sibling the body needs. */
export type RequestWriter<R> = (files: Map<string, string>, dir: string, request: R) => void;

/**
 * Adds one folder's own file, its requests (and their body files) and, recursively, the folders
 * below it.
 *
 * @throws ProjectError `project-path-invalid` for an unsafe slug, `project-folder-too-deep` for a
 * tree deeper than {@link MAX_FOLDER_DEPTH} — before any path is built, never after.
 */
export function addFolderFiles<R extends { readonly slug: string }>(
  files: Map<string, string>,
  dir: string,
  node: Pick<FolderNode<R>, 'folders' | 'requests'>,
  depth: number,
  writeRequest: RequestWriter<R>,
  folderExtra?: (folder: FolderNode<R>) => Record<string, unknown>,
): void {
  for (const request of node.requests) {
    assertPathSegment(request.slug);
    writeRequest(files, dir, request);
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
          ...(folderExtra?.(folder) ?? {}),
        }),
      ),
    );
    addFolderFiles(files, childDir, folder, depth + 1, writeRequest, folderExtra);
  }
}
