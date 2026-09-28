/**
 * The script project changes (#63): `update-request-scripts` edits one request's scripts, and
 * `enable-scripts` switches on the scripts of many at once. Both work the same on a SOAP, REST or
 * gRPC request, found by id wherever it sits.
 *
 * The file names are never part of an edit: the save derives them from the request's slug, so an
 * edit cannot point a script at a file outside the request's directory.
 */

import { ProjectError, SCRIPT_LIMITS } from '@wirebench/engine';
import type { Project, RequestScripts, ScriptSource } from '@wirebench/engine';
import type { RequestScriptsPatchWire } from '../shared/wire-types.js';

/** A request of any protocol, as far as its scripts go. */
interface Scripted {
  readonly id: string;
  readonly scripts?: RequestScripts;
}

type Update = <R extends Scripted>(request: R) => R;

interface Tree<R extends Scripted> {
  readonly requests: readonly R[];
  readonly folders: readonly Tree<R>[];
}

/** `container` with `update` applied to every request in it, folders included; the same object when none changed. */
function mapTree<T extends Tree<R>, R extends Scripted>(container: T, update: Update): T {
  const requests = container.requests.map((request) => update(request));
  const folders = container.folders.map((folder) => mapTree(folder, update));
  const changed =
    requests.some((request, index) => request !== container.requests[index]) ||
    folders.some((folder, index) => folder !== container.folders[index]);
  return changed ? { ...container, requests, folders } : container;
}

/** `items` mapped, or the same array when no item changed. */
function mapSame<T>(items: readonly T[], map: (item: T) => T): readonly T[] {
  const next = items.map(map);
  return next.some((item, index) => item !== items[index]) ? next : items;
}

/** `project` with `update` applied to every SOAP, REST and gRPC request in it. */
function mapRequests(project: Project, update: Update): Project {
  const interfaces = mapSame(project.interfaces, (iface) => {
    const operations = mapSame(iface.operations, (operation) => {
      const requests = mapSame(operation.requests, (request) => update(request));
      return requests === operation.requests ? operation : { ...operation, requests };
    });
    return operations === iface.operations ? iface : { ...iface, operations };
  });
  return {
    ...project,
    interfaces,
    apis: mapSame(project.apis, (api) => mapTree(api, update)),
    grpcApis: mapSame(project.grpcApis, (api) => mapTree(api, update)),
  };
}

/** A script's source as edited: text over the size limit is kept, and refuses to send, as a loaded one does. */
function sourceOf(text: string): ScriptSource {
  return Buffer.byteLength(text, 'utf8') > SCRIPT_LIMITS.fileBytes ? { text, problem: 'script-too-large' } : { text };
}

/** `scripts` with the edit applied; `undefined` when the edit leaves the request with no scripts at all. */
export function patchedScripts(
  scripts: RequestScripts | undefined,
  patch: RequestScriptsPatchWire,
): RequestScripts | undefined {
  const phase = (key: 'pre' | 'post'): ScriptSource | undefined => {
    const edit = patch[key];
    if (edit === null) return undefined;
    return edit === undefined ? scripts?.[key] : sourceOf(edit);
  };
  const pre = phase('pre');
  const post = phase('post');
  const timeoutMs = patch.timeoutMs === null ? undefined : (patch.timeoutMs ?? scripts?.timeoutMs);
  const secrets = patch.secrets ?? scripts?.secrets ?? [];
  if (pre === undefined && post === undefined && secrets.length === 0) {
    return undefined;
  }
  return {
    ...(pre !== undefined ? { pre } : {}),
    ...(post !== undefined ? { post } : {}),
    api: scripts?.api ?? 'wirebench',
    enabled: patch.enabled ?? scripts?.enabled ?? true,
    secrets: [...new Set(secrets)],
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

function withScripts<R extends Scripted>(request: R, scripts: RequestScripts | undefined): R {
  if (scripts !== undefined) {
    return { ...request, scripts };
  }
  return Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'scripts')) as unknown as R;
}

/**
 * Applies an edit to one request's scripts; `null` removes them.
 *
 * @throws ProjectError `unknown-entity` when no SOAP, REST or gRPC request has that id
 */
export function updateRequestScripts(
  project: Project,
  requestId: string,
  patch: RequestScriptsPatchWire | null,
): { readonly project: Project } {
  let found = false;
  const next = mapRequests(project, (request) => {
    if (request.id !== requestId) return request;
    found = true;
    return withScripts(request, patch === null ? undefined : patchedScripts(request.scripts, patch));
  });
  if (!found) {
    throw new ProjectError('unknown-entity', `No request with id "${requestId}"`, { details: { requestId } });
  }
  return { project: next };
}

/**
 * Switches on the scripts of every listed request that has any. An id that names no request, or a
 * request without scripts, is passed over: the explorer sends every request under a folder.
 */
export function enableScripts(project: Project, requestIds: readonly string[]): { readonly project: Project } {
  const ids = new Set(requestIds);
  return {
    project: mapRequests(project, (request) =>
      ids.has(request.id) && request.scripts !== undefined && !request.scripts.enabled
        ? { ...request, scripts: { ...request.scripts, enabled: true } }
        : request,
    ),
  };
}
