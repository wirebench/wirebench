/**
 * The request a desktop send sends: the saved one, built as a run builds its item, with the editor's
 * unsaved draft laid over it for this send only. Nothing here is persisted. Unlike a run, a person
 * may send a request its contract no longer has (orphaned), as the app always let them.
 */
import {
  createInterface,
  createRequest,
  grpcItemFor,
  normalizeWsa,
  restItemFor,
  signingAlong,
  soapItemFor,
  webhookPath,
} from '@wirebench/engine';
import type {
  Project,
  RequestProperties,
  RestRequestDef,
  RestRequestSettings,
  RestSelected,
  SelectedRequest,
  SoapOverride,
  SoapSelected,
  WsaConfigPatch,
} from '@wirebench/engine';
import { withGrpcPatch } from '../project-grpc-mutations.js';
import { toEngineAuthConfig, toEngineBody, toEngineRows, toEngineSigning } from '../project-rest-mutations.js';
import type { HistoryNameFallback } from './record.js';
import type { GrpcRequestPatchWire, ResolvedSendInputWire, RestRequestPatchWire } from '../../shared/wire-types.js';

/** What the editor holds for one send, by protocol. Task 13 adds WebSocket. */
export type DraftOf =
  | { readonly kind: 'rest'; readonly draft?: RestRequestPatchWire }
  | { readonly kind: 'soap'; readonly override?: SoapOverride }
  | { readonly kind: 'grpc'; readonly draft?: GrpcRequestPatchWire };

/** The request id a send with no saved request behind it goes by (`SendOptions.adHoc`). */
export const AD_HOC_ID = 'ad-hoc';

/** The saved request as a run item with the editor's draft applied. Undefined: no such request of that kind. */
export function selectedFor(project: Project, requestId: string, draft: DraftOf): SelectedRequest | undefined {
  switch (draft.kind) {
    case 'rest': {
      // An API request or a webhook item, orphaned or not.
      const found = restItemFor(project, requestId);
      return found === undefined ? undefined : withRestDraft(project, found, draft.draft);
    }
    case 'soap': {
      // Orphaned or not: the editor sends what it shows.
      const found = soapItemFor(project, requestId);
      return found === undefined || draft.override === undefined ? found : { ...found, override: draft.override };
    }
    case 'grpc': {
      // Any method kind, orphaned or not: a run skips streams, a person sends them.
      const found = grpcItemFor(project, requestId);
      return found === undefined || draft.draft === undefined
        ? found
        : { ...found, request: withGrpcPatch(found.request, draft.draft) };
    }
  }
}

/**
 * What the editor sends of a SOAP request: its envelope, the endpoint it resolved, and its headers.
 * The rest of the renderer's input (timeout, encoding, …) is built from the saved request's
 * properties, and its SOAP version and SOAPAction are the saved request's, as they always were.
 */
export function soapOverrideOf(input: ResolvedSendInputWire): SoapOverride {
  return {
    envelopeXml: input.envelopeXml,
    endpoint: input.endpoint,
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
  };
}

/**
 * A send with no saved request behind it (an ad-hoc send, or the resend of a request deleted since)
 * as an engine item: an interface of its own with no definition and no endpoints, one operation
 * named as History names it, and a request holding the input — its envelope, version, SOAPAction,
 * headers and the properties `toSoapSendInput` reads back — sent to the input's endpoint with the
 * input's own TLS floor, compression, HTTP/2 offer and WS-Addressing, as the renderer built it (the
 * WS-Addressing default action rides on the ad-hoc context).
 */
export function adHocSoapItem(input: ResolvedSendInputWire, names: HistoryNameFallback): SoapSelected {
  const request = createRequest(names.requestName, {
    id: AD_HOC_ID,
    envelopeXml: input.envelopeXml,
    soapVersion: input.soapVersion,
    ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
    headers: Object.entries(input.headers ?? {}).map(([name, value]) => ({ name, value })),
    properties: adHocProperties(input),
  });
  const wsa = input.wsa === undefined ? undefined : normalizeWsa(definedOnly(input.wsa.config));
  const operation = {
    name: names.operationName,
    bindingName: '',
    slug: 'ad-hoc',
    order: 0,
    requests: [wsa === undefined ? request : { ...request, wsa }],
  };
  const iface = createInterface(names.interfaceName, {
    id: AD_HOC_ID,
    definitionUrl: '',
    cacheDefinition: false,
    operations: [operation],
  });
  const group = `${iface.name}/${operation.name}`;
  return {
    kind: 'soap',
    path: `${group}/${request.name}`,
    group,
    iface,
    operation,
    request: operation.requests[0] ?? request,
    override: {
      endpoint: input.endpoint,
      ...(input.tls?.minVersion !== undefined ? { tlsMinVersion: input.tls.minVersion } : {}),
      ...(input.compressBody !== undefined ? { compressBody: input.compressBody } : {}),
      ...(input.allowH2 !== undefined ? { allowH2: input.allowH2 } : {}),
    },
  };
}

/** A wire configuration without the keys a zod-parsed optional leaves explicitly `undefined`. */
function definedOnly(config: NonNullable<ResolvedSendInputWire['wsa']>['config']): WsaConfigPatch {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

/** The request properties an input's own settings stand for, as `toSoapSendInput` reads them back. */
function adHocProperties(input: ResolvedSendInputWire): Partial<RequestProperties> {
  return {
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
    ...(input.followRedirects !== undefined ? { followRedirects: input.followRedirects } : {}),
    ...(input.maxSizeBytes !== undefined ? { maxSizeBytes: input.maxSizeBytes } : {}),
    ...(input.skipSoapAction !== undefined ? { skipSoapAction: input.skipSoapAction } : {}),
    ...(input.localAddress !== undefined ? { bindAddress: input.localAddress } : {}),
    ...(input.entitize !== undefined ? { entitizeProperties: input.entitize } : {}),
  };
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
