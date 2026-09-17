/**
 * The Wirebench project model: the in-memory shape of a project folder
 * (see the design spec, "Data model and project format").
 *
 * Every field is `readonly` and every polymorphic type carries a `kind`
 * discriminator (`'soap'` for a WSDL interface, `'rest'` for an API — see
 * `rest/model.ts` — with `'grpc'` reserved and refused by the loader). Ids are ULIDs so entities
 * keep a stable identity across renames; `slug` is the file-system name derived
 * from `name` and is what the folder layout is keyed by.
 *
 * Nothing here ever holds a secret: credentials are referenced by
 * `passwordRef` (a `secretRef` resolved from the OS keychain at send time).
 */

import { ulid } from 'ulidx';
import { slugify } from './paths.js';
import { DEFAULT_WSA_CONFIG } from '../wsa/model.js';
import type { WsaConfig } from '../wsa/model.js';
import type { GrpcApi, GrpcRequestDef } from '../grpc/model.js';
import type { RestApi, RestRequestDef } from '../rest/model.js';

export type { WsaConfig, WsaConfigPatch, WsaMustUnderstand, WsaVersion } from '../wsa/model.js';

/** The on-disk format version written to (and required by) `wirebench.yaml`. */
export const FORMAT_VERSION = 3;

/** A flat, ordered map of property name to value (project- or environment-scoped). */
export type PropertyMap = Readonly<Record<string, string>>;

/**
 * Every authentication scheme a request, endpoint, interface, API or folder can carry.
 *
 * `inherit` is valid only where there is something to inherit from — a REST request or folder,
 * which walks its folder chain up to its API. A SOAP interface, endpoint or request uses
 * {@link EndpointAuth}, the subset without it.
 */
export type AuthType = 'inherit' | 'none' | 'basic' | 'ntlm' | 'bearer' | 'api-key' | 'oauth2';

/** How a request or endpoint authenticates. Passwords are always `secretRef`s, never values. */
export interface EndpointAuth {
  readonly type: 'none' | 'basic' | 'ntlm';
  readonly username?: string;
  /** Opaque reference into the OS-keychain-backed secret store. Never a password. */
  readonly passwordRef?: string;
  /** NTLM domain. */
  readonly domain?: string;
  /** NTLM workstation name; optional, and only ever advertised, never verified. */
  readonly workstation?: string;
  /** Send the Authorization header without waiting for a 401 challenge. */
  readonly preemptive?: boolean;
}

/**
 * "Whatever the thing above me uses." Only a REST request or folder may say this; resolution
 * walks request → folder chain → API and takes the first configuration that is not `inherit`
 * (see `rest/auth.ts`).
 */
export interface InheritAuth {
  readonly type: 'inherit';
}

/** A token sent as `Authorization: <scheme> <token>`. The token itself is always a `secretRef`. */
export interface BearerAuth {
  readonly type: 'bearer';
  /** Opaque reference into the OS-keychain-backed secret store. Never a token value. */
  readonly tokenRef?: string;
  /** Authentication scheme placed before the token. Defaults to `Bearer`. */
  readonly scheme?: string;
}

/** A key sent as one header or one query parameter. The value is always a `secretRef`. */
export interface ApiKeyAuth {
  readonly type: 'api-key';
  /** Header or query-parameter name, e.g. `X-Api-Key`. */
  readonly name: string;
  /** Opaque reference into the OS-keychain-backed secret store. Never a key value. */
  readonly valueRef?: string;
  readonly in: 'header' | 'query';
}

/**
 * OAuth2, as much of it as a client needs to obtain a token: the two grants that suit a desktop
 * tool (client credentials for machine-to-machine, authorization code with PKCE for a user
 * sign-in). Access tokens are never persisted — they live in the host's memory for the session —
 * so the only secrets here are the client secret and, if the user opts in, a refresh token.
 */
export interface OAuth2Auth {
  readonly type: 'oauth2';
  readonly grant: 'client-credentials' | 'authorization-code';
  /** Token endpoint. Property expansion applies. */
  readonly tokenUrl: string;
  /** Authorization endpoint; required for, and only used by, the authorization-code grant. */
  readonly authorizationUrl?: string;
  readonly clientId: string;
  /** Opaque reference into the OS-keychain-backed secret store. Never a secret value. */
  readonly clientSecretRef?: string;
  readonly scopes: readonly string[];
  readonly audience?: string;
  /** Whether the client credentials go in an `Authorization: Basic` header or the request body. */
  readonly clientAuth: 'basic' | 'body';
  /** Proof Key for Code Exchange (RFC 7636); authorization-code only, on by default. */
  readonly pkce: boolean;
  /**
   * Set only when the user asked for the refresh token to be remembered: like every other
   * credential it is then a keychain reference, never a value (ADR-0004).
   */
  readonly refreshTokenRef?: string;
}

/**
 * Authentication as configured anywhere in a project. A discriminated union on `type`, of which
 * {@link EndpointAuth} — the `none`/`basic`/`ntlm` member SOAP has always had — is one arm, so a
 * SOAP endpoint's credentials are already an `AuthConfig` and the same editor serves both
 * protocols.
 */
export type AuthConfig = InheritAuth | EndpointAuth | BearerAuth | ApiKeyAuth | OAuth2Auth;

/** The OAuth2 fields a freshly configured entry starts with. */
export const DEFAULT_OAUTH2_AUTH: OAuth2Auth = Object.freeze({
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: '',
  clientId: '',
  scopes: Object.freeze([]),
  clientAuth: 'basic',
  pkce: true,
});

/** One addressable endpoint (URL + optional credentials) of an interface. */
export interface Endpoint {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth?: EndpointAuth;
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

/**
 * Where an attachment's bytes live: either content-addressed inside the project
 * (`attachments/<sha256>`, written by `project/attachments-cache.ts`) or a file
 * on disk, absolute or relative to the project's resource root.
 */
export type AttachmentSource =
  { readonly kind: 'cache'; readonly sha256: string } | { readonly kind: 'path'; readonly path: string };

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

/** One HTTP header of a request, kept in author-defined order (duplicates allowed). */
export interface HeaderEntry {
  readonly name: string;
  readonly value: string;
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
  readonly auth?: EndpointAuth;
  readonly wsa?: WsaConfig;
  /** Name of a `wss/outgoing/<name>.yaml` configuration. */
  readonly wssOutgoingRef?: string;
  /** Name of a `wss/incoming/<name>.yaml` configuration. */
  readonly wssIncomingRef?: string;
  readonly properties: RequestProperties;
  /**
   * True when the operation this request belongs to is no longer in the interface's definition
   * (see `wsdl/update-definition.ts`). Nothing is ever deleted on an update, so the request
   * survives with this flag and the UI badges it; clearing it is what a later definition that
   * brings the operation back does.
   */
  readonly orphaned?: boolean;
  /** Stored verbatim in the sibling `.xml` file, byte for byte. */
  readonly envelopeXml: string;
}

/**
 * The name this type had before REST requests existed, kept as an alias for one release so
 * callers that only ever mean a SOAP request need not be touched. Prefer {@link SoapRequestDef}.
 */
export type RequestDef = SoapRequestDef;

/**
 * A saved request of either protocol, which is what a lookup by request id can return: the id
 * space is one (ULIDs), so `kind` is how a caller finds out what it has.
 */
export type AnyRequestDef = SoapRequestDef | RestRequestDef | GrpcRequestDef;

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
  readonly auth?: EndpointAuth;
  readonly operations: readonly OperationDef[];
}

/** A named set of per-interface endpoint overrides and property values. */
export interface Environment {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  /** Interface slug to endpoint URL. */
  readonly endpoints: Readonly<Record<string, string>>;
  readonly properties: PropertyMap;
  /**
   * Names of {@link properties} entries that are switched off: resolution treats a disabled
   * property exactly as if it were absent from the map (see `project/properties.ts`), while its
   * value stays on disk. Written sorted and deduplicated, and only for names still present in
   * `properties` — see `serialize.ts`.
   */
  readonly disabledProperties: readonly string[];
}

/** A pointer to a WS-Security or keystore configuration file (contents land in later tasks). */
export interface WssRef {
  readonly id: string;
  readonly name: string;
  /**
   * Path relative to the project root. Omitted for keystore entries, which all
   * share the single `wss/keystores.yaml` registry.
   */
  readonly file?: string;
  /**
   * The document as loaded from (or to be written to) disk, verbatim. Tasks
   * 36-40 will replace this loose bag with a typed shape; until then, saving a
   * loaded `WssRef` back out must not drop fields this build does not
   * understand.
   */
  readonly document: Readonly<Record<string, unknown>>;
}

/** Project-wide settings persisted in `wirebench.yaml`. */
export interface ProjectSettings {
  readonly cacheDefinitions: boolean;
  readonly defaultTimeoutMs: number;
  /** Base directory for `file:` inline attachments; relative paths resolve against the project root. */
  readonly resourceRoot?: string;
  readonly prettyPrintResponses: boolean;
}

/** The settings a new project starts with. */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = Object.freeze({
  cacheDefinitions: true,
  defaultTimeoutMs: 60_000,
  prettyPrintResponses: true,
});

/** A whole Wirebench project, as loaded from (or saved to) a project folder. */
export interface Project {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly settings: ProjectSettings;
  readonly properties: PropertyMap;
  /** Names of {@link properties} entries switched off; see {@link Environment.disabledProperties}. */
  readonly disabledProperties: readonly string[];
  readonly interfaces: readonly Interface[];
  /**
   * The project's REST APIs. `order` is shared with {@link interfaces}, so the two kinds
   * interleave in the explorer in whatever order the user arranged them.
   */
  readonly apis: readonly RestApi[];
  /**
   * The project's gRPC APIs. On disk they share `apis/` with the REST ones, each `api.yaml` saying
   * which it is with `kind`; in memory they are their own list so every surface that handles one
   * protocol has to say what it does with the third (ADR-0007). `order` is shared with both lists.
   */
  readonly grpcApis: readonly GrpcApi[];
  readonly environments: readonly Environment[];
  /** Id of the environment currently active for this project, if any. */
  readonly activeEnvironmentId?: string;
  readonly wss: {
    readonly outgoing: readonly WssRef[];
    readonly incoming: readonly WssRef[];
    readonly keystores: readonly WssRef[];
  };
}

/** Generates entity ids; injectable so tests can produce deterministic projects. */
export type IdGenerator = () => string;

/** The default {@link IdGenerator}: a lexicographically sortable ULID. */
export const generateId: IdGenerator = () => ulid();

/** Options shared by the `create*` factories. */
export interface CreateOptions {
  readonly id?: string;
  readonly newId?: IdGenerator;
  readonly order?: number;
}

function idOf(options: CreateOptions | undefined): string {
  return options?.id ?? (options?.newId ?? generateId)();
}

/** Creates an empty project with default settings. */
export function createProject(name: string, options?: CreateOptions): Project {
  return {
    formatVersion: FORMAT_VERSION,
    id: idOf(options),
    name,
    settings: DEFAULT_PROJECT_SETTINGS,
    properties: {},
    disabledProperties: [],
    interfaces: [],
    apis: [],
    grpcApis: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
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
export function createRequest(name: string, input: CreateRequestInput): RequestDef {
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
    envelopeXml: input.envelopeXml,
  };
}
