/**
 * The REST half of the project model: an *API* and the folders and requests inside it.
 *
 * An API is the REST counterpart of a SOAP interface and lives beside one in the same project
 * (`apis/<slug>/`, see `project/paths.ts`), so one workspace, one project and one set of
 * environments serve both protocols. Everything here follows the same rules as the SOAP model:
 * every field is `readonly`, ids are ULIDs so an entity survives a rename, `slug` is the
 * file-system name derived from `name`, and nothing ever holds a secret — credentials are
 * `secretRef`s resolved from the OS keychain at send time (ADR-0004).
 *
 * `kind` is the discriminator the project format has carried since v1. It is `'rest'` here and
 * `'soap'` on an interface; `'grpc'` is reserved and refused by the loader (see `project/schema.ts`).
 */

import type { Assertion } from '../assert/model.js';
import type { KeyValueEntry } from '../http/entries.js';
import type { RawLanguage } from '../http/escape.js';
import type { RequestScripts } from '../script/model.js';
import type {
  AttachmentSource,
  AuthConfig,
  CreateOptions,
  DefinitionAuth,
  IdGenerator,
  Project,
} from '../project/model.js';
import { containersOf, generateId, withContainersOf } from '../project/model.js';
import { slugify } from '../project/paths.js';
import type { HookLink, WebhookSigning } from '../webhooks/model.js';

/**
 * An HTTP method. The seven a REST client needs are spelled out so the common case is
 * autocompleted and checked; a service that wants `PURGE`, `LOCK` or `REPORT` is not told it is
 * wrong, because HTTP does not say it is (RFC 9110 §9).
 */
export type RestMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | (string & {});

/** The methods the editor offers by name, in the order it offers them. */
export const COMMON_METHODS: readonly RestMethod[] = Object.freeze([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

// Declared in `http/`, which the gRPC and WebSocket folders share with this one; re-exported so REST
// code and the public exports keep reading them from here.
export { entry } from '../http/entries.js';
export type { KeyValueEntry, RawLanguage };

/** The `Content-Type` each {@link RawLanguage} implies when the request sets no header itself. */
export const RAW_LANGUAGE_CONTENT_TYPES: Readonly<Record<RawLanguage, string>> = Object.freeze({
  json: 'application/json',
  xml: 'application/xml',
  text: 'text/plain',
  html: 'text/html',
  javascript: 'application/javascript',
});

/** The file extension a raw body of each language is stored under, beside its request file. */
export const RAW_LANGUAGE_EXTENSIONS: Readonly<Record<RawLanguage, string>> = Object.freeze({
  json: 'json',
  xml: 'xml',
  text: 'txt',
  html: 'html',
  javascript: 'js',
});

/**
 * One part of a `multipart/form-data` body: either inline text or a file. Distinct from the SOAP
 * transport's `MultipartPart`, which is a MIME part of an already-built message.
 */
export type MultipartFormPart =
  | {
      readonly kind: 'text';
      readonly name: string;
      readonly value: string;
      readonly enabled: boolean;
      readonly contentType?: string;
    }
  | {
      readonly kind: 'file';
      readonly name: string;
      /** Where the bytes live; content-addressed in the project, or a path under the resource root. */
      readonly source: AttachmentSource;
      readonly enabled: boolean;
      /** The `filename` the part advertises. Defaults to the source file's own name. */
      readonly fileName?: string;
      readonly contentType?: string;
    };

/**
 * What a request sends as its body.
 *
 * A raw body's text lives in a sibling file rather than inside the YAML (`project/paths.ts`), so
 * a JSON payload diffs, highlights and merges as JSON; every other kind is small enough to stay
 * in the request document.
 */
export type RestBody =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'raw';
      readonly language: RawLanguage;
      /** Overrides the language's default `Content-Type`; a typed header still wins over both. */
      readonly contentType?: string;
      /** The body exactly as edited. Stored verbatim in the sibling file. */
      readonly text: string;
    }
  | { readonly kind: 'form'; readonly fields: readonly KeyValueEntry[] }
  | { readonly kind: 'multipart'; readonly parts: readonly MultipartFormPart[] }
  | { readonly kind: 'binary'; readonly source: AttachmentSource; readonly contentType: string };

/** The body a freshly created request starts with. */
export const NO_BODY: RestBody = Object.freeze({ kind: 'none' });

/**
 * Per-request transport settings. Every field is optional and an absent one means *inherit*, not
 * *off*: the send resolves request → API → project → preference, exactly as a SOAP request's
 * properties do (`send-input.ts`).
 */
export interface RestRequestSettings {
  readonly timeoutMs?: number;
  /** Unlike SOAP, REST follows redirects by default; see `rest/send.ts` for the per-status rules. */
  readonly followRedirects?: boolean;
  readonly maxRedirects?: number;
  /** Keep method and body across a 301/302 that would otherwise become a GET (RFC 9110 §15.4). */
  readonly keepBodyOnRedirect?: boolean;
  /** Percent-encode path and query values on send. On by default; off sends them verbatim. */
  readonly encodeUrl?: boolean;
  /**
   * Send even when the server's certificate does not verify. Per request, as `trustInvalid` is
   * per endpoint for SOAP, and badged in red wherever the request appears.
   */
  readonly trustInvalid?: boolean;
  /** Id of a `wss/keystores.yaml` entry: the client identity this request's TLS handshake presents. */
  readonly sslKeystoreRef?: string;
  readonly bindAddress?: string;
  readonly maxSizeBytes?: number;
  /** Send back the cookies this request's own last response set. Off by default. */
  readonly sendCookies?: boolean;
  /** JSON- or XML-escape every property value substituted into the body. Off by default. */
  readonly escapeProperties?: boolean;
}

/** A saved REST request: everything but a raw body lives in `<slug>.request.yaml`. */
export interface RestRequestDef {
  readonly kind: 'rest';
  readonly id: string;
  readonly name: string;
  /** File-system name (without the `.request.yaml` suffix). */
  readonly slug: string;
  readonly order: number;
  /** Markdown, shown in the Details inspector; imported from an operation's description. */
  readonly description?: string;
  readonly method: RestMethod;
  /** Absolute, or relative to the API's effective base URL. May contain `{param}` and `${…}`. */
  readonly url: string;
  /** One row per `{param}` in {@link url}; an unfilled one is a preflight problem, never a send. */
  readonly pathParams: readonly KeyValueEntry[];
  readonly query: readonly KeyValueEntry[];
  readonly headers: readonly KeyValueEntry[];
  readonly body: RestBody;
  /** `inherit` by default: the folder chain, then the API, decides. */
  readonly auth: AuthConfig;
  readonly settings: RestRequestSettings;
  /** Declarative checks a runner evaluates against this request's response. Empty when none. */
  readonly assertions: readonly Assertion[];
  /**
   * True when the operation this request was imported from is no longer in the API's definition,
   * the same flag a SOAP request carries after an Update Definition. Nothing is ever deleted on
   * a re-import; the request survives badged.
   */
  readonly orphaned?: boolean;
  /**
   * The operation of the API's definition this request calls: its lower-case method and its path as
   * the definition spells it (`/pets/{petId}`). Set by an import, kept by edits; absent when unknown.
   */
  readonly contract?: RestContractLink;
  /**
   * Set only on an item of a project's webhook collection that was imported from an OpenAPI
   * `webhooks` or `callbacks` entry: which one, so *Update definition* can keep it in step.
   */
  readonly hook?: HookLink;
  /**
   * Only on an item of a project's webhook collection: how it signs what it sends, overriding its
   * folders and the collection (spec `2026-09-29-…-webhook-signatures-design.md` §5.1).
   */
  readonly signing?: WebhookSigning;
  /** Pre-request and post-response scripts, in files beside the request (#63). */
  readonly scripts?: RequestScripts;
  /** Responses kept with the request, imported or saved by hand (#64). Absent when there are none. */
  readonly examples?: readonly RestResponseExample[];
}

/** One recorded response kept beside a request: what came back, never what to assert. */
export interface RestResponseExample {
  readonly id: string;
  readonly name: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly KeyValueEntry[];
  readonly contentType?: string;
  /** The body text; on disk it lives in `<slug>.examples/<id>.body.<ext>`. */
  readonly body?: string;
}

/** The extension an example's body file takes from its content type, so it opens as what it is. */
export function exampleBodyExtension(contentType: string | undefined): 'json' | 'xml' | 'html' | 'txt' {
  const type = (contentType ?? '').toLowerCase();
  if (/json/.test(type)) return 'json';
  if (/xml/.test(type)) return 'xml';
  if (/html/.test(type)) return 'html';
  return 'txt';
}

/** A request's link to an operation of its API's definition. */
export interface RestContractLink {
  readonly method: string;
  readonly path: string;
}

/** A named node in an API's tree, holding folders and requests. */
export interface RestFolder {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly order: number;
  readonly description?: string;
  /** Default credentials for everything inside, unless a child says otherwise. */
  readonly auth?: AuthConfig;
  readonly folders: readonly RestFolder[];
  readonly requests: readonly RestRequestDef[];
}

/** One server an imported definition declared, offered as a choice for the base URL. */
export interface RestServer {
  readonly url: string;
  readonly description?: string;
}

/** The definition an imported API came from, cached under `apis/<slug>/definition/`. */
export interface RestDefinitionRef {
  /** Where the document was fetched from: a URL, or a path as the user gave it. */
  readonly source: string;
  readonly cache: boolean;
  /** The OpenAPI version of the document, as it declared itself (e.g. `3.1.0`). */
  readonly version: string;
  /** Credentials the document is fetched with, sent to the source's own origin only. */
  readonly auth?: DefinitionAuth;
}

/** A REST API: a base URL, default credentials, and a tree of folders and requests. */
export interface RestApi {
  readonly kind: 'rest';
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  /**
   * Position among the project's interfaces *and* APIs, which share one ordering space so the
   * explorer can interleave them however the user arranged them.
   */
  readonly order: number;
  readonly description?: string;
  /** May contain `${…}` properties; a workspace environment can override it per environment. */
  readonly baseUrl: string;
  readonly servers: readonly RestServer[];
  readonly auth?: AuthConfig;
  readonly definition?: RestDefinitionRef;
  readonly folders: readonly RestFolder[];
  readonly requests: readonly RestRequestDef[];
}

/** Input to {@link createApi} beyond the name. */
export interface CreateApiInput extends CreateOptions {
  readonly baseUrl?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly servers?: readonly RestServer[];
  readonly auth?: AuthConfig;
  readonly definition?: RestDefinitionRef;
  readonly folders?: readonly RestFolder[];
  readonly requests?: readonly RestRequestDef[];
}

function idOf(options: CreateOptions | undefined): string {
  return options?.id ?? (options?.newId ?? generateId)();
}

/** Creates an empty API with no credentials of its own (so its requests authenticate as `none`). */
export function createApi(name: string, input: CreateApiInput = {}): RestApi {
  return {
    kind: 'rest',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    baseUrl: input.baseUrl ?? '',
    servers: input.servers ?? [],
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    ...(input.definition !== undefined ? { definition: input.definition } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

/** Input to {@link createFolder} beyond the name. */
export interface CreateFolderInput extends CreateOptions {
  readonly slug?: string;
  readonly description?: string;
  readonly auth?: AuthConfig;
  readonly folders?: readonly RestFolder[];
  readonly requests?: readonly RestRequestDef[];
}

/** Creates an empty folder. */
export function createFolder(name: string, input: CreateFolderInput = {}): RestFolder {
  return {
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.auth !== undefined ? { auth: input.auth } : {}),
    folders: input.folders ?? [],
    requests: input.requests ?? [],
  };
}

/** Input to {@link createRestRequest} beyond the name. */
export interface CreateRestRequestInput extends CreateOptions {
  readonly method?: RestMethod;
  readonly url?: string;
  readonly slug?: string;
  readonly description?: string;
  readonly pathParams?: readonly KeyValueEntry[];
  readonly query?: readonly KeyValueEntry[];
  readonly headers?: readonly KeyValueEntry[];
  readonly body?: RestBody;
  readonly auth?: AuthConfig;
  readonly settings?: RestRequestSettings;
  readonly contract?: RestContractLink;
  readonly hook?: HookLink;
  readonly signing?: WebhookSigning;
}

/** Creates a `GET` request with an empty URL, no body and inherited credentials. */
export function createRestRequest(name: string, input: CreateRestRequestInput = {}): RestRequestDef {
  return {
    kind: 'rest',
    id: idOf(input),
    name,
    slug: input.slug ?? slugify(name),
    order: input.order ?? 0,
    ...(input.description !== undefined ? { description: input.description } : {}),
    method: input.method ?? 'GET',
    url: input.url ?? '',
    pathParams: input.pathParams ?? [],
    query: input.query ?? [],
    headers: input.headers ?? [],
    body: input.body ?? NO_BODY,
    auth: input.auth ?? { type: 'inherit' },
    settings: input.settings ?? {},
    assertions: [],
    ...(input.contract !== undefined ? { contract: { method: input.contract.method, path: input.contract.path } } : {}),
    ...(input.hook !== undefined ? { hook: { ...input.hook } } : {}),
    ...(input.signing !== undefined ? { signing: input.signing } : {}),
  };
}

/** Generates entity ids; injectable so tests can produce deterministic APIs. */
export type { IdGenerator };

/** Every request in `folder` and, depth-first, in the folders below it. */
export function folderRequests(folder: Pick<RestFolder, 'folders' | 'requests'>): RestRequestDef[] {
  return [...folder.requests, ...folder.folders.flatMap((child) => folderRequests(child))];
}

/** Every request in `api`, its root requests first and then each folder depth-first. */
export function apiRequests(api: RestApi): RestRequestDef[] {
  return folderRequests(api);
}

/** Every folder in `api`, depth-first. */
export function apiFolders(api: RestApi): RestFolder[] {
  const walk = (folders: readonly RestFolder[]): RestFolder[] =>
    folders.flatMap((folder) => [folder, ...walk(folder.folders)]);
  return walk(api.folders);
}

/** The project's REST APIs, in the order the project holds them. */
export function restApisOf(project: Project): readonly RestApi[] {
  return containersOf(project, 'rest') as readonly RestApi[];
}

/** `project` with its REST APIs replaced; every other kind's containers are kept. */
export function withRestApis(project: Project, apis: readonly RestApi[]): Project {
  return withContainersOf(project, 'rest', apis);
}
