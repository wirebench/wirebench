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
import { mapRequests } from './project-request-map.js';
import type { Identified } from './project-request-map.js';

/** A request of any protocol, as far as its scripts go. */
type Scripted = Identified & { readonly scripts?: RequestScripts };

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
  const next = mapRequests<Scripted>(project, (request) => {
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
    project: mapRequests<Scripted>(project, (request) =>
      ids.has(request.id) && request.scripts !== undefined && !request.scripts.enabled
        ? { ...request, scripts: { ...request.scripts, enabled: true } }
        : request,
    ),
  };
}
