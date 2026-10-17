/**
 * The script project changes (#63): `update-request-scripts` edits one request's scripts, and
 * `enable-scripts` switches on the scripts of many at once. Both work the same on a SOAP, REST or
 * gRPC request, found by id wherever it sits, and on a level above requests (#334): a SOAP
 * interface, a REST or gRPC API, or one of their folders.
 *
 * The file names are never part of an edit: the save derives them from the request's slug, so an
 * edit cannot point a script at a file outside the request's directory.
 */

import { ProjectError, SCRIPT_LIMITS } from '@wirebench/engine';
import type { Project, RequestScripts, ScriptSource } from '@wirebench/engine';
import type { RequestScriptsPatchWire } from '../shared/wire-base.js';
import { mapRequests, mapScriptLevels } from './project-request-map.js';
import type { Identified } from './project-request-map.js';

/** A request of any protocol, or a level above requests, as far as its scripts go. */
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
  const postResponseOrder = patch.postResponseOrder ?? scripts?.postResponseOrder;
  const secrets = patch.secrets ?? scripts?.secrets ?? [];
  if (pre === undefined && post === undefined && secrets.length === 0 && postResponseOrder !== 'inner-first') {
    return undefined;
  }
  return {
    ...(pre !== undefined ? { pre } : {}),
    ...(post !== undefined ? { post } : {}),
    api: scripts?.api ?? 'wirebench',
    enabled: patch.enabled ?? scripts?.enabled ?? true,
    secrets: [...new Set(secrets)],
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(postResponseOrder !== undefined ? { postResponseOrder } : {}),
  };
}

function withScripts<R extends Scripted>(request: R, scripts: RequestScripts | undefined): R {
  if (scripts !== undefined) {
    return { ...request, scripts };
  }
  return Object.fromEntries(Object.entries(request).filter(([key]) => key !== 'scripts')) as unknown as R;
}

/**
 * Applies an edit to the scripts of one request, interface, API or folder; `null` removes them.
 *
 * @throws ProjectError `unknown-entity` when nothing that can carry scripts has that id
 */
export function updateRequestScripts(
  project: Project,
  ownerId: string,
  patch: RequestScriptsPatchWire | null,
): { readonly project: Project } {
  let found = false;
  const edit = <R extends Scripted>(owner: R): R => {
    if (owner.id !== ownerId) return owner;
    found = true;
    return withScripts(owner, patch === null ? undefined : patchedScripts(owner.scripts, patch));
  };
  let next = mapRequests<Scripted>(project, edit);
  if (!found) next = mapScriptLevels<Scripted>(project, edit);
  if (!found) {
    throw new ProjectError('unknown-entity', `No request, API, interface or folder with id "${ownerId}"`, {
      details: { requestId: ownerId },
    });
  }
  return { project: next };
}

/**
 * Switches on the scripts of every listed request, interface, API or folder that has any. An id
 * that names nothing, or something without scripts, is passed over: the explorer sends every
 * request and folder under the one it was asked on.
 */
export function enableScripts(project: Project, ids: readonly string[]): { readonly project: Project } {
  const listed = new Set(ids);
  const enable = <R extends Scripted>(owner: R): R =>
    listed.has(owner.id) && owner.scripts !== undefined && !owner.scripts.enabled
      ? { ...owner, scripts: { ...owner.scripts, enabled: true } }
      : owner;
  return { project: mapScriptLevels<Scripted>(mapRequests<Scripted>(project, enable), enable) };
}
