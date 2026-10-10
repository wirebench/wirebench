/**
 * The SOAP part of the project model: the project's *interfaces*, each a WSDL binding with its
 * endpoints and operations and the requests saved under them.
 */

import type { Assertion } from '../assert/model.js';
import type { AttachmentSource, CreateOptions, HeaderEntry, Project, SoapOwnerAuth } from '../project/model.js';
import { containersOf, idOf, withContainersOf } from '../project/model.js';
import { slugify } from '../project/paths.js';
import type { RequestScripts } from '../script/model.js';
import { DEFAULT_WSA_CONFIG } from '../wsa/model.js';
import type { WsaConfig } from '../wsa/model.js';

export type { WsaConfig, WsaConfigPatch, WsaMustUnderstand, WsaVersion } from '../wsa/model.js';

/** One addressable endpoint (URL + optional credentials) of an interface. */
export interface Endpoint {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth?: SoapOwnerAuth;
  /** `override` replaces request credentials, `complement` only fills in blanks. */
  readonly authMode: 'override' | 'complement';
  /**
   * Send to this endpoint even when its certificate does not verify (`rejectUnauthorized:
   * false`). Per endpoint only — there is no global equivalent — and the UI badges every
   * endpoint that has it in red, permanently, so a debugging shortcut cannot quietly become
   * the way the project always runs.
   */
  readonly trustInvalid?: boolean;
}

/**
 * How an attachment participates in the outgoing message, under the names classic SOAP
 * workbenches use:
 * `XOP` for an MTOM/XOP-optimised binary, `SWAREF` for a `ref:swaRef`-referenced part,
 * `MIME` for a WSDL `mime:content` part, `CONTENT` for an unreferenced body attachment,
 * and `UNKNOWN` when nothing in the definition says.
 */
export type AttachmentType = 'XOP' | 'MIME' | 'SWAREF' | 'CONTENT' | 'UNKNOWN';

/** One attachment part of a request. Bytes are never held here; see {@link AttachmentSource}. */
export interface Attachment {
  readonly id: string;
  /** Display/file name; may contain `${#...}` property expansions. */
  readonly name: string;
  readonly contentType: string;
  /** Size in bytes, as known when the attachment was added (informational for `path` sources). */
  readonly size: number;
  /** WSDL `mime:part` name this attachment fills, when the binding names one. */
  readonly part?: string;
  readonly type: AttachmentType;
  /** MIME Content-ID, stored without the angle brackets. Defaults to {@link defaultContentId}. */
  readonly contentId: string;
  /** True when the bytes were copied into the project's attachment cache. */
  readonly cached: boolean;
  readonly source: AttachmentSource;
}

/**
 * The Content-ID a freshly added attachment gets: its own id in the `wirebench`
 * domain, which is globally unique because ids are ULIDs.
 */
export function defaultContentId(attachmentId: string): string {
  return `${attachmentId}@wirebench`;
}

/** The per-request knobs of the request editor's Details panel. */
export interface RequestProperties {
  readonly encoding: string;
  readonly timeoutMs?: number;
  readonly bindAddress?: string;
  readonly followRedirects: boolean;
  readonly skipSoapAction: boolean;
  readonly enableMtom: boolean;
  readonly forceMtom: boolean;
  readonly inlineResponseAttachments: boolean;
  readonly expandMtomAttachments: boolean;
  readonly disableMultiparts: boolean;
  readonly encodeAttachments: boolean;
  readonly enableInlineFiles: boolean;
  readonly removeEmptyContent: boolean;
  readonly entitizeProperties: boolean;
  readonly prettyPrint: boolean;
  readonly stripWhitespaces: boolean;
  readonly dumpFile?: string;
  readonly maxSizeBytes?: number;
  readonly wssPasswordType?: 'text' | 'digest';
  readonly wssTimeToLive?: number;
  /** Id of a `wss/keystores.yaml` entry: the client identity this request's TLS handshake presents. */
  readonly sslKeystoreRef?: string;
}

/** The request property values applied to a freshly created request. */
export const DEFAULT_REQUEST_PROPERTIES: RequestProperties = Object.freeze({
  encoding: 'UTF-8',
  followRedirects: false,
  skipSoapAction: false,
  enableMtom: false,
  forceMtom: false,
  inlineResponseAttachments: false,
  expandMtomAttachments: false,
  disableMultiparts: false,
  encodeAttachments: false,
  enableInlineFiles: false,
  removeEmptyContent: false,
  entitizeProperties: false,
  prettyPrint: false,
  stripWhitespaces: false,
});

/** A saved SOAP request: everything but the envelope lives in `<slug>.request.yaml`, the envelope in `<slug>.xml`. */
export interface SoapRequestDef {
  readonly kind: 'soap';
  readonly id: string;
  readonly name: string;
  /** File-system name (without the `.request.yaml` / `.xml` suffix). */
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  /** Id of the interface endpoint to send to. */
  readonly endpointId?: string;
  /** A one-off URL that overrides {@link endpointId}. */
  readonly endpointUrl?: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly soapAction?: string;
  readonly headers: readonly HeaderEntry[];
  readonly attachments: readonly Attachment[];
  readonly auth?: SoapOwnerAuth;
  readonly wsa?: WsaConfig;
  /** Name of a `wss/outgoing/<name>.yaml` configuration. */
  readonly wssOutgoingRef?: string;
  /** Name of a `wss/incoming/<name>.yaml` configuration. */
  readonly wssIncomingRef?: string;
  readonly properties: RequestProperties;
  /** Declarative checks a runner evaluates against this request's response. Empty when none. */
  readonly assertions: readonly Assertion[];
  /**
   * True when the operation this request belongs to is no longer in the interface's definition
   * (see `wsdl/update-definition.ts`). Nothing is ever deleted on an update, so the request
   * survives with this flag and the UI badges it; clearing it is what a later definition that
   * brings the operation back does.
   */
  readonly orphaned?: boolean;
  /** Pre-request and post-response scripts, in files beside the request (#63). */
  readonly scripts?: RequestScripts;
  /** Stored verbatim in the sibling `.xml` file, byte for byte. */
  readonly envelopeXml: string;
}

/** A binding operation of an interface, holding its saved requests. */
export interface OperationDef {
  readonly name: string;
  /** The owning binding as `{namespace}localName`. */
  readonly bindingName: string;
  readonly slug: string;
  readonly order: number;
  readonly requests: readonly SoapRequestDef[];
}

/** An imported WSDL interface: its definition, endpoints and operations. */
export interface Interface {
  readonly kind: 'soap';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly definitionUrl: string;
  /** Cache the resolved definition under `interfaces/<slug>/definition/`. */
  readonly cacheDefinition: boolean;
  readonly targetNamespace?: string;
  readonly endpoints: readonly Endpoint[];
  readonly defaultEndpointId?: string;
  readonly wsa: WsaConfig;
  /** Interface-level default credentials, overridable per endpoint and per request. */
  readonly auth?: SoapOwnerAuth;
  readonly operations: readonly OperationDef[];
}

/** Input to {@link createInterface} beyond the name. */
export interface CreateInterfaceInput extends CreateOptions {
  readonly definitionUrl: string;
  readonly slug?: string;
  readonly targetNamespace?: string;
  readonly cacheDefinition?: boolean;
  readonly endpoints?: readonly Endpoint[];
  readonly defaultEndpointId?: string;
  readonly operations?: readonly OperationDef[];
}

/** Creates an interface with v1 defaults (WS-A off, definition cached, no auth). */
export function createInterface(name: string, input: CreateInterfaceInput): Interface {
  const endpoints = input.endpoints ?? [];
  return {
    kind: 'soap',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    definitionUrl: input.definitionUrl,
    cacheDefinition: input.cacheDefinition ?? true,
    ...(input.targetNamespace !== undefined ? { targetNamespace: input.targetNamespace } : {}),
    endpoints,
    ...(input.defaultEndpointId !== undefined
      ? { defaultEndpointId: input.defaultEndpointId }
      : endpoints[0] !== undefined
        ? { defaultEndpointId: endpoints[0].id }
        : {}),
    wsa: DEFAULT_WSA_CONFIG,
    operations: input.operations ?? [],
  };
}

/** Input to {@link createRequest} beyond the name. */
export interface CreateRequestInput extends CreateOptions {
  readonly envelopeXml: string;
  readonly soapVersion: '1.1' | '1.2';
  readonly slug?: string;
  readonly soapAction?: string;
  readonly endpointId?: string;
  readonly headers?: readonly HeaderEntry[];
  readonly properties?: Partial<RequestProperties>;
}

/** Creates a request with the default request properties applied. */
export function createRequest(name: string, input: CreateRequestInput): SoapRequestDef {
  return {
    kind: 'soap',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.endpointId !== undefined ? { endpointId: input.endpointId } : {}),
    soapVersion: input.soapVersion,
    ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
    headers: input.headers ?? [],
    attachments: [],
    properties: { ...DEFAULT_REQUEST_PROPERTIES, ...input.properties },
    assertions: [],
    envelopeXml: input.envelopeXml,
  };
}

/** The project's SOAP interfaces, in the order the project holds them. */
export function soapInterfacesOf(project: Project): readonly Interface[] {
  return containersOf(project, 'soap') as readonly Interface[];
}

/** `project` with its SOAP interfaces replaced; every other kind's containers are kept. */
export function withSoapInterfaces(project: Project, interfaces: readonly Interface[]): Project {
  return withContainersOf(project, 'soap', interfaces);
}
