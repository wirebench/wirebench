/**
 * The Wirebench project model: the in-memory shape of a project folder
 * (see the design spec, "Data model and project format").
 *
 * Every field is `readonly` and every polymorphic type carries a `kind`
 * discriminator (`'soap'` in v1, `'rest'` reserved). Ids are ULIDs so entities
 * keep a stable identity across renames; `slug` is the file-system name derived
 * from `name` and is what the folder layout is keyed by.
 *
 * Nothing here ever holds a secret: credentials are referenced by
 * `passwordRef` (a `secretRef` resolved from the OS keychain at send time).
 */

import { ulid } from 'ulidx';
import { slugify } from './paths.js';

/** The on-disk format version written to (and required by) `wirebench.yaml`. */
export const FORMAT_VERSION = 1;

/** A flat, ordered map of property name to value (project- or environment-scoped). */
export type PropertyMap = Readonly<Record<string, string>>;

/** How a request or endpoint authenticates. Passwords are always `secretRef`s, never values. */
export interface EndpointAuth {
  readonly type: 'none' | 'basic' | 'ntlm';
  readonly username?: string;
  /** Opaque reference into the OS-keychain-backed secret store. Never a password. */
  readonly passwordRef?: string;
  /** NTLM domain. */
  readonly domain?: string;
  /** Send the Authorization header without waiting for a 401 challenge. */
  readonly preemptive?: boolean;
}

/** One addressable endpoint (URL + optional credentials) of an interface. */
export interface Endpoint {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth?: EndpointAuth;
  /** `override` replaces request credentials, `complement` only fills in blanks. */
  readonly authMode: 'override' | 'complement';
}

/** WS-Addressing settings (fleshed out in the WS-A task; `enabled` is the stable part). */
export interface WsaConfig {
  readonly enabled: boolean;
  readonly version?: '2005/08' | '2004/08';
}

/** A reference to an attachment part of a request (populated by the attachments task). */
export interface AttachmentRef {
  readonly id: string;
  readonly name: string;
  readonly contentType?: string;
  /** Content-addressed file under `attachments/`, or a path relative to the resource root. */
  readonly path?: string;
  readonly cached: boolean;
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

/** A saved request: everything but the envelope lives in `<slug>.request.yaml`, the envelope in `<slug>.xml`. */
export interface RequestDef {
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
  readonly attachments: readonly AttachmentRef[];
  readonly auth?: EndpointAuth;
  readonly wsa?: WsaConfig;
  /** Name of a `wss/outgoing/<name>.yaml` configuration. */
  readonly wssOutgoingRef?: string;
  /** Name of a `wss/incoming/<name>.yaml` configuration. */
  readonly wssIncomingRef?: string;
  readonly properties: RequestProperties;
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
  readonly requests: readonly RequestDef[];
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
  readonly wsa: WsaConfig & { readonly version: '2005/08' | '2004/08' };
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
  readonly interfaces: readonly Interface[];
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
    interfaces: [],
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
    wsa: { enabled: false, version: '2005/08' },
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
