/**
 * The request a desktop send sends: the saved one, built as a run builds its item, with the editor's
 * unsaved draft laid over it for this send only. Nothing here is persisted. Unlike a run, a person
 * may send a request its contract no longer has (orphaned), as the app always let them.
 */
import { restItemFor, signingAlong, webhookPath } from '@wirebench/engine';
import type { Project, RestRequestDef, RestRequestSettings, RestSelected, SelectedRequest } from '@wirebench/engine';
import { toEngineAuthConfig, toEngineBody, toEngineRows, toEngineSigning } from '../project-rest-mutations.js';
import type { RestRequestPatchWire } from '../../shared/wire-types.js';

/** What the editor holds for one send, by protocol. Tasks 9, 11 and 13 add SOAP, gRPC and WebSocket. */
export type DraftOf = { readonly kind: 'rest'; readonly draft?: RestRequestPatchWire };

/** The saved request as a run item with the editor's draft applied. Undefined: no such request of that kind. */
export function selectedFor(project: Project, requestId: string, draft: DraftOf): SelectedRequest | undefined {
  switch (draft.kind) {
    case 'rest': {
      // An API request or a webhook item, orphaned or not.
      const found = restItemFor(project, requestId);
      return found === undefined ? undefined : withRestDraft(project, found, draft.draft);
    }
  }
}

/**
 * A REST item with the draft applied. A draft's auth replaces the first link of the auth chain, since
 * `restEffectiveAuth` starts from the request; a webhook item's signing is climbed again from the
 * drafted request, so an unsaved Signing tab signs as the user sees it.
 */
function withRestDraft(project: Project, item: RestSelected, draft: RestRequestPatchWire | undefined): RestSelected {
  if (draft === undefined) return item;
  const request = withDraft(item.request, draft);
  const collection = project.webhooks;
  const path = item.signing === undefined || collection === undefined ? undefined : webhookPath(collection, request.id);
  return {
    ...item,
    request,
    ...(collection !== undefined && path !== undefined
      ? { signing: signingAlong(collection, path.chain, request) }
      : {}),
  };
}

/** The saved request with the editor's draft applied, for this send only — nothing is persisted. */
export function withDraft(request: RestRequestDef, draft: RestRequestPatchWire | undefined): RestRequestDef {
  if (draft === undefined) {
    return request;
  }
  const merged: RestRequestDef = {
    ...request,
    ...(draft.method !== undefined ? { method: draft.method } : {}),
    ...(draft.url !== undefined ? { url: draft.url } : {}),
    ...(draft.pathParams !== undefined ? { pathParams: toEngineRows(draft.pathParams) } : {}),
    ...(draft.query !== undefined ? { query: toEngineRows(draft.query) } : {}),
    ...(draft.headers !== undefined ? { headers: toEngineRows(draft.headers) } : {}),
    ...(draft.body !== undefined ? { body: toEngineBody(draft.body) } : {}),
    ...(draft.auth !== undefined ? { auth: toEngineAuthConfig(draft.auth) } : {}),
    ...(draft.settings !== undefined ? { settings: cleanSettings(draft.settings) } : {}),
    ...(draft.signing !== undefined && draft.signing !== null ? { signing: toEngineSigning(draft.signing) } : {}),
  };
  if (draft.signing !== null) {
    return merged;
  }
  // An unsaved *Inherit* on the Signing tab: send as the parents would sign.
  const inherited: Record<string, unknown> = { ...merged };
  delete inherited['signing'];
  return inherited as unknown as RestRequestDef;
}

/** Settings from the wire, with the keys the sender left undefined dropped (they mean *inherit*). */
function cleanSettings(settings: NonNullable<RestRequestPatchWire['settings']>): RestRequestSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
}
