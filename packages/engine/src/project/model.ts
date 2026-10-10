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
import type { MockDef } from '../mock/model.js';
import type { SequenceDef } from '../sequence/model.js';
import type { WebhookCollection } from '../webhooks/model.js';
import type { ContainerBase } from '../protocol/module.js';

/**
 * The on-disk format version written to (and required by) `wirebench.yaml`.
 *
 * 4 added `assertions` on a request and the `…Env` name beside each secret reference. 5 let a SOAP
 * interface, endpoint or request carry `bearer`, `api-key` and `oauth2` auth (previously
 * REST-only) — new keys and new enum values on an existing field. 6 added `scripts` on a SOAP, REST or
 * gRPC request (#63), the project's webhook collection under `webhooks/`, `hook` on a request, `signing` on the
 * collection, its folders and its items, the `callback` assertion kind (callback-assertion spec §2.1), and `assertions` on a WebSocket request (#192).
 * 6 shipped in 3.1.0. 7 added `examples` on a REST request: recorded responses kept beside it (#64).
 * 8 added Kerberos auth (`type: kerberos`), so an older build refuses such a project as too new.
 * All are additive; this format does not round-trip unknown keys, so an older build would delete them on
 * its next save (see `schema.ts` and ADR-0003) — and would meanwhile send a request without its scripts.
 */
export const FORMAT_VERSION = 8;

/** A flat, ordered map of property name to value (project- or environment-scoped). */
export type PropertyMap = Readonly<Record<string, string>>;

/**
 * Every authentication scheme a request, endpoint, interface, API or folder can carry.
 *
 * `inherit` is valid only where there is something to inherit from — a REST request or folder,
 * which walks its folder chain up to its API. A SOAP interface, endpoint or request uses
 * {@link EndpointAuth}, the subset without it.
 */
export type AuthType = 'inherit' | 'none' | 'basic' | 'ntlm' | 'bearer' | 'api-key' | 'oauth2' | 'kerberos';

/** How a request or endpoint authenticates. Passwords are always `secretRef`s, never values. */
export interface EndpointAuth {
  readonly type: 'none' | 'basic' | 'ntlm';
  readonly username?: string;
  /** Opaque reference into the OS-keychain-backed secret store. Never a password. */
  readonly passwordRef?: string;
  /** The name CI supplies this secret under: `WIREBENCH_SECRET_<name>`. Not a secret; committed. */
  readonly passwordEnv?: string;
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
 * (see `http/auth/apply-auth.ts`).
 */
export interface InheritAuth {
  readonly type: 'inherit';
}

/** A token sent as `Authorization: <scheme> <token>`. The token itself is always a `secretRef`. */
export interface BearerAuth {
  readonly type: 'bearer';
  /** Opaque reference into the OS-keychain-backed secret store. Never a token value. */
  readonly tokenRef?: string;
  /** The name CI supplies this secret under: `WIREBENCH_SECRET_<name>`. Not a secret; committed. */
  readonly tokenEnv?: string;
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
  /** The name CI supplies this secret under: `WIREBENCH_SECRET_<name>`. Not a secret; committed. */
  readonly valueEnv?: string;
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
  /** The name CI supplies this secret under: `WIREBENCH_SECRET_<name>`. Not a secret; committed. */
  readonly clientSecretEnv?: string;
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

/** Kerberos over HTTP Negotiate (#40): the OS ticket by default; the account fields are Windows-only. */
export interface KerberosAuth {
  readonly type: 'kerberos';
  readonly spn?: string;
  readonly principal?: string;
  readonly username?: string;
  readonly domain?: string;
  readonly passwordRef?: string;
  readonly passwordEnv?: string;
}

/**
 * Authentication as configured anywhere in a project. A discriminated union on `type`, of which
 * {@link EndpointAuth} — the `none`/`basic`/`ntlm` member SOAP has always had — is one arm, so a
 * SOAP endpoint's credentials are already an `AuthConfig` and the same editor serves both
 * protocols.
 */
export type AuthConfig = InheritAuth | EndpointAuth | BearerAuth | ApiKeyAuth | OAuth2Auth | KerberosAuth;

/**
 * What a SOAP interface, endpoint or request may hold: every {@link AuthConfig} arm except
 * {@link InheritAuth} — a SOAP owner has no interface-like ancestor to inherit from, so the SOAP
 * chain stays request → endpoint (override/complement) → interface.
 */
export type SoapOwnerAuth = Exclude<AuthConfig, InheritAuth>;

/**
 * How a definition document is fetched: Basic, a bearer token, an API key or Kerberos. Secrets are keychain
 * references, as everywhere else. Separate from the API's own `auth`, which is what its requests send.
 */
export type DefinitionAuth = (EndpointAuth & { readonly type: 'basic' }) | BearerAuth | ApiKeyAuth | KerberosAuth;

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

/**
 * Where an attachment's bytes live: either content-addressed inside the project
 * (`attachments/<sha256>`, written by `project/attachments-cache.ts`) or a file
 * on disk, absolute or relative to the project's resource root.
 */
export type AttachmentSource =
  { readonly kind: 'cache'; readonly sha256: string } | { readonly kind: 'path'; readonly path: string };

/** One HTTP header of a request, kept in author-defined order (duplicates allowed). */
export interface HeaderEntry {
  readonly name: string;
  readonly value: string;
  /** `false` keeps the row in the request without sending it; absent means on. */
  readonly enabled?: boolean;
  readonly description?: string;
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

/**
 * A container whose kind has no enabled module: kept on disk exactly as it is (spec §6).
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export interface UnsupportedContainer {
  readonly dir: 'interfaces' | 'apis';
  readonly slug: string;
  /** As written in the container file. */
  readonly kind: string;
  readonly reason: 'unknown-kind' | 'feature-disabled';
  /** Read from the container file when present, for a placeholder row. */
  readonly name?: string;
  readonly order?: number;
}

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
  /**
   * Every container the project holds, keyed by its kind (`soap`, `rest`, `grpc`, `websocket`, or a
   * kind a host registered), each list in load order. A kind with none may be absent. `order` is shared
   * across every kind, so containers interleave in the explorer in whatever order the user arranged
   * them. Read a built-in protocol's with its folder's reader (`restApisOf`, `soapInterfacesOf`, …),
   * and any kind's with {@link containersOf}.
   */
  readonly containers: Readonly<Record<string, readonly ContainerBase[]>>;
  /**
   * Containers this build could not load and left untouched on disk. Absent means none.
   *
   * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
   */
  readonly unsupported?: readonly UnsupportedContainer[];
  /**
   * The project's sequences, one file each under `sequences/`. Not a container like the four above: a
   * sequence holds no requests of its own, only references to theirs by id.
   */
  readonly sequences: readonly SequenceDef[];
  /**
   * The project's mock services, one folder each under `mocks/` (ADR-0021). Like a sequence, a mock
   * refers to the interface or API it implements by id and holds no requests.
   */
  readonly mocks: readonly MockDef[];
  /**
   * The project's webhook collection (spec `…-openapi-webhooks-import-design.md`), absent until the
   * first webhook is created or imported. Not a list like the API containers: one per project.
   */
  readonly webhooks?: WebhookCollection;
  readonly environments: readonly Environment[];
  /** Id of the environment currently active for this project, if any. */
  readonly activeEnvironmentId?: string;
  readonly wss: {
    readonly outgoing: readonly WssRef[];
    readonly incoming: readonly WssRef[];
    readonly keystores: readonly WssRef[];
  };
}

/**
 * The project's placeholders; empty when it has none.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function unsupportedOf(project: Project): readonly UnsupportedContainer[] {
  return project.unsupported ?? [];
}

/**
 * The project's containers of `kind`; empty when it has none. A protocol's own reader narrows the type
 * (`restApisOf`, `soapInterfacesOf`, …).
 */
export function containersOf(project: Project, kind: string): readonly ContainerBase[] {
  return project.containers[kind] ?? [];
}

/**
 * `project` with its containers of `kind` replaced; every other kind's are kept. A kind left with none
 * is dropped from the map, as a load leaves it, so two projects holding the same containers are equal.
 */
export function withContainersOf(project: Project, kind: string, containers: readonly ContainerBase[]): Project {
  const next = { ...project.containers, [kind]: containers };
  return { ...project, containers: Object.fromEntries(Object.entries(next).filter(([, list]) => list.length > 0)) };
}

/** Every container the project holds, of every kind. */
export function allContainers(project: Project): readonly ContainerBase[] {
  return Object.values(project.containers).flat();
}

/**
 * The order a newly placed API (REST, gRPC or WebSocket) takes: one past the highest order any
 * interface or API holds, 0 when there is none. The explorer sorts them all together, so an API
 * placement must look at all of them; and a count would repeat an order still held once one was
 * deleted. Interface placements keep their own rule.
 *
 * @internal Exported for the engine's own hosts; not yet a plugin API (ADR-0017).
 */
export function nextApiOrder(project: Project): number {
  let highest = -1;
  for (const container of allContainers(project)) {
    if (container.order > highest) highest = container.order;
  }
  return highest + 1;
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

/** A new entity's id: the one `options` gives, else a fresh one from its generator. */
export function idOf(options: CreateOptions | undefined): string {
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
    containers: {},
    sequences: [],
    mocks: [],
    environments: [],
    wss: { outgoing: [], incoming: [], keystores: [] },
  };
}
