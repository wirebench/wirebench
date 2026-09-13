/**
 * Turning a parsed OpenAPI document into an API, its folders and its requests.
 *
 * Kept apart from `import.ts` because this half is pure: given a document it always produces the
 * same tree, with no fetching, no clock and no file system. That is what makes an import reviewable
 * — a golden test can state the whole tree — and it is the only way the mapping rules stay legible.
 *
 * The mapping is deliberately conservative. An imported request is a *starting point a user edits*,
 * so where the document is ambiguous the import picks the reading that leaves the least hidden: a
 * required query parameter is enabled and an optional one is present but switched off, a header
 * parameter arrives switched off, and anything the mapping cannot represent is counted and named in
 * the summary rather than dropped in silence.
 */

import type { AuthConfig, IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { slugify, uniqueSlug } from '../../project/paths.js';
import type {
  KeyValueEntry,
  MultipartFormPart,
  RestApi,
  RestBody,
  RestDefinitionRef,
  RestFolder,
  RestRequestDef,
  RestServer,
} from '../model.js';
import { createApi, createFolder, createRestRequest, entry, RAW_LANGUAGE_CONTENT_TYPES } from '../model.js';
import type {
  JsonSchema,
  JsonValue,
  OpenApiDocument,
  OpenApiMediaType,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiSecurityRequirement,
  OpenApiSecurityScheme,
  OpenApiSkipped,
} from './model.js';
import { serverUrl } from './model.js';
import { sampleFromSchema, sampleXml } from './sample.js';

/** How the caller wants the document read. Every field has a documented default. */
export interface MapApiOptions {
  /** The API's name. Defaults to `info.title`, which the import dialog offers for editing. */
  readonly name?: string;
  /** The base URL. Defaults to the first server's URL with its variables' defaults substituted. */
  readonly baseUrl?: string;
  /**
   * The security scheme, by its name in `securitySchemes`, that becomes the API's own credentials.
   * Defaults to the scheme a single global `security` requirement names, and to none otherwise —
   * the choice then belongs to the user, in the import dialog.
   */
  readonly securityScheme?: string;
  /** Passed to the sample generator for every generated body. */
  readonly includeOptional?: boolean;
  /** Passed to the sample generator for every generated body. */
  readonly sampleValues?: boolean;
  /** Injectable id generator, so a test can state the whole tree. */
  readonly newId?: IdGenerator;
  /** The API's position among the project's interfaces and APIs. */
  readonly order?: number;
  /** Recorded on the API when the caller has cached the document. */
  readonly definition?: RestDefinitionRef;
}

/**
 * One security scheme the document declares, as a candidate for the API's own credentials.
 *
 * Every scheme is listed, mappable or not, because the import dialog offers the choice and a
 * scheme it cannot use has to say so rather than be missing from the list without explanation.
 */
export interface OpenApiSchemeCandidate {
  readonly name: string;
  readonly type: OpenApiSecurityScheme['type'];
  readonly description?: string;
  /** What picking it would set. Absent when this client has no equivalent for it. */
  readonly auth?: AuthConfig;
  /** Why it cannot be used, when {@link auth} is absent. */
  readonly reason?: string;
  /** True for the scheme the import already applied to the API. */
  readonly applied: boolean;
}

/** What an import did, for the summary the dialog shows when it finishes. */
export interface OpenApiImportSummary {
  /** The API's name, after {@link MapApiOptions.name} had its say. */
  readonly name: string;
  readonly title: string;
  /** The `openapi` string the document declared. */
  readonly declaredVersion: string;
  /** `info.version` — the version of the API, not of the specification. */
  readonly apiVersion?: string;
  readonly baseUrl: string;
  readonly servers: readonly RestServer[];
  readonly folders: number;
  readonly requests: number;
  readonly deprecated: number;
  /** The auth the API ended up with, by type, when it got any. */
  readonly auth?: AuthConfig['type'];
  /** Every scheme the document declares, so the dialog can offer a different one. */
  readonly securitySchemes: readonly OpenApiSchemeCandidate[];
  /** Everything the parser and the mapping could not use, in the order it was met. */
  readonly skipped: readonly OpenApiSkipped[];
}

/** An API mapped from a document, and what the mapping made of it. */
export interface MappedApi {
  readonly api: RestApi;
  readonly summary: OpenApiImportSummary;
}

/** Header parameters OpenAPI itself says to ignore, because the message decides them. */
const RESERVED_HEADERS: ReadonlySet<string> = new Set(['accept', 'content-type', 'authorization']);

/** The media types a *Binary* body is the honest reading of. */
function isBinaryMedia(type: string, schema: JsonSchema | undefined): boolean {
  if (schema?.format === 'binary') {
    return true;
  }
  return (
    type === 'application/octet-stream' ||
    type === 'application/pdf' ||
    type === 'application/zip' ||
    type.startsWith('image/') ||
    type.startsWith('audio/') ||
    type.startsWith('video/')
  );
}

const isJson = (type: string): boolean => type === 'application/json' || /^application\/[\w.+-]+\+json$/.test(type);
const isXml = (type: string): boolean =>
  type === 'application/xml' || type === 'text/xml' || /^application\/[\w.+-]+\+xml$/.test(type);
const isForm = (type: string): boolean => type === 'application/x-www-form-urlencoded';
const isMultipart = (type: string): boolean => type === 'multipart/form-data';

/** JSON > XML > form > multipart > anything else, as §3.6 orders them. */
const BODY_PREFERENCE: readonly ((type: string) => boolean)[] = [isJson, isXml, isForm, isMultipart, () => true];

/** A value as a table cell or a header: a string stays itself, anything else is written as JSON. */
function cellText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** The first of a parameter's or media type's named `examples`, in document order. */
function firstNamedExample(
  examples: Readonly<Record<string, { readonly value?: JsonValue }>> | undefined,
): JsonValue | undefined {
  for (const example of Object.values(examples ?? {})) {
    if (example.value !== undefined) {
      return example.value;
    }
  }
  return undefined;
}

/** A parameter's value: its `example`, else its schema's, else empty (§3.6). */
function parameterValue(parameter: OpenApiParameter, options: MapApiOptions): string {
  const stated = parameter.example ?? firstNamedExample(parameter.examples);
  if (stated !== undefined) {
    return cellText(stated);
  }
  if (parameter.schema === undefined) {
    return '';
  }
  const sampled = sampleFromSchema(parameter.schema, {
    ...(options.sampleValues !== undefined ? { sampleValues: options.sampleValues } : {}),
  });
  // A composite parameter value has a `style` this client does not serialise; an empty cell asks
  // the user for the one they want rather than inventing a JSON blob on the wire.
  return typeof sampled === 'object' && sampled !== null ? '' : cellText(sampled);
}

/** One row per parameter in `location`, in document order. */
function parameterRows(
  operation: OpenApiOperation,
  location: 'path' | 'query' | 'header',
  options: MapApiOptions,
  skipped: OpenApiSkipped[],
): KeyValueEntry[] {
  const rows: KeyValueEntry[] = [];
  for (const parameter of operation.parameters) {
    if (parameter.in !== location) {
      continue;
    }
    if (location === 'header' && RESERVED_HEADERS.has(parameter.name.toLowerCase())) {
      skipped.push({
        kind: 'parameter',
        where: `${operation.method.toUpperCase()} ${operation.path}`,
        reason: `The "${parameter.name}" header is decided by the request itself`,
      });
      continue;
    }
    rows.push(
      entry(parameter.name, parameterValue(parameter, options), {
        // A path parameter is always part of the URL; a query one only when the document requires
        // it; a header one never, so an import never silently changes what goes on the wire.
        enabled: location === 'path' || (location === 'query' && parameter.required === true),
        ...(parameter.description !== undefined ? { description: parameter.description } : {}),
      }),
    );
  }
  return rows;
}

/** Every cookie parameter, counted: this client has no cookie-parameter table. */
function noteCookieParameters(operation: OpenApiOperation, skipped: OpenApiSkipped[]): void {
  for (const parameter of operation.parameters) {
    if (parameter.in === 'cookie') {
      skipped.push({
        kind: 'parameter',
        where: `${operation.method.toUpperCase()} ${operation.path}`,
        reason: `Cookie parameter "${parameter.name}" is not imported`,
      });
    }
  }
}

/** The media type an operation's body is built from, under {@link BODY_PREFERENCE}. */
function preferredMedia(
  content: Readonly<Record<string, OpenApiMediaType>>,
): { readonly type: string; readonly media: OpenApiMediaType } | undefined {
  const types = Object.keys(content);
  for (const matches of BODY_PREFERENCE) {
    const type = types.find((candidate) => matches(candidate));
    const media = type === undefined ? undefined : content[type];
    if (type !== undefined && media !== undefined) {
      return { type, media };
    }
  }
  return undefined;
}

/** The text a raw body starts with: the media type's example, else the first of its examples, else a sample. */
function rawText(media: OpenApiMediaType, language: 'json' | 'xml' | 'text', options: MapApiOptions): string {
  const stated = media.example ?? firstNamedExample(media.examples);
  if (stated !== undefined) {
    if (typeof stated === 'string') {
      return stated;
    }
    return JSON.stringify(stated, null, 2);
  }
  if (media.schema === undefined) {
    return '';
  }
  const sampleOptions = {
    ...(options.includeOptional !== undefined ? { includeOptional: options.includeOptional } : {}),
    ...(options.sampleValues !== undefined ? { sampleValues: options.sampleValues } : {}),
  };
  if (language === 'xml') {
    return sampleXml(media.schema, sampleOptions);
  }
  const sample = sampleFromSchema(media.schema, sampleOptions);
  return language === 'json' ? JSON.stringify(sample, null, 2) : cellText(sample);
}

/** One row per property of a form schema, required ones enabled. */
function formFields(schema: JsonSchema | undefined, options: MapApiOptions): KeyValueEntry[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([name, property]) =>
    entry(name, cellText(sampleFromSchema(property, { ...options, maxDepth: 1 })), {
      enabled: required.has(name),
      ...(property.description !== undefined ? { description: property.description } : {}),
    }),
  );
}

/** One part per property of a multipart schema; a `format: binary` property becomes a file part. */
function multipartParts(schema: JsonSchema | undefined, options: MapApiOptions): MultipartFormPart[] {
  const required = new Set(schema?.required ?? []);
  return Object.entries(schema?.properties ?? {}).map(([name, property]): MultipartFormPart => {
    const enabled = required.has(name);
    if (property.format === 'binary') {
      // No file is chosen yet, exactly as a hand-added file part starts out.
      return { kind: 'file', name, source: { kind: 'path', path: '' }, enabled };
    }
    return { kind: 'text', name, value: cellText(sampleFromSchema(property, { ...options, maxDepth: 1 })), enabled };
  });
}

/** The body an operation's `requestBody` maps to, and the header its media type may need. */
function bodyOf(operation: OpenApiOperation, options: MapApiOptions, skipped: OpenApiSkipped[]): RestBody {
  const content = operation.requestBody?.content;
  if (content === undefined) {
    return { kind: 'none' };
  }
  const chosen = preferredMedia(content);
  if (chosen === undefined) {
    return { kind: 'none' };
  }
  const { type, media } = chosen;
  for (const other of Object.keys(content)) {
    if (other !== type) {
      skipped.push({
        kind: 'media-type',
        where: `${operation.method.toUpperCase()} ${operation.path}`,
        reason: `Offers "${other}" as well; imported as "${type}"`,
      });
    }
  }

  if (isBinaryMedia(type, media.schema)) {
    return { kind: 'binary', source: { kind: 'path', path: '' }, contentType: type };
  }
  if (isForm(type)) {
    return { kind: 'form', fields: formFields(media.schema, options) };
  }
  if (isMultipart(type)) {
    return { kind: 'multipart', parts: multipartParts(media.schema, options) };
  }
  const language = isJson(type) ? 'json' : isXml(type) ? 'xml' : 'text';
  return {
    kind: 'raw',
    language,
    // A vendor media type (`application/vnd.api+json`) edits as JSON but must travel as itself.
    ...(RAW_LANGUAGE_CONTENT_TYPES[language] === type ? {} : { contentType: type }),
    text: rawText(media, language, options),
  };
}

/**
 * The credentials one security scheme maps to, or the reason none does.
 *
 * Separate from {@link authFromScheme} because the summary lists *every* scheme the document
 * declares as a candidate the user may pick, and asking "what would this one become?" must not
 * itself record that something was skipped — only a scheme the import actually needed does that.
 */
export function mapScheme(scheme: OpenApiSecurityScheme): { auth?: AuthConfig; reason?: string } {
  switch (scheme.type) {
    case 'http':
      if (scheme.scheme === 'basic') {
        // Secrets are never invented: the fields are the user's to fill in (ADR-0004).
        return { auth: { type: 'basic' } };
      }
      if (scheme.scheme === 'bearer') {
        return { auth: { type: 'bearer' } };
      }
      return { reason: `HTTP scheme "${scheme.scheme ?? 'unnamed'}" is not supported` };
    case 'apiKey':
      if (scheme.in === 'header' || scheme.in === 'query') {
        return { auth: { type: 'api-key', name: scheme.keyName ?? '', in: scheme.in } };
      }
      return { reason: 'An API key in a cookie is not supported' };
    case 'oauth2': {
      const clientCredentials = scheme.flows?.clientCredentials;
      const authorizationCode = scheme.flows?.authorizationCode;
      const flow = clientCredentials ?? authorizationCode;
      if (flow === undefined) {
        return { reason: 'Only the client-credentials and authorization-code flows are supported' };
      }
      return {
        auth: {
          type: 'oauth2',
          grant: clientCredentials !== undefined ? 'client-credentials' : 'authorization-code',
          tokenUrl: flow.tokenUrl ?? '',
          ...(flow.authorizationUrl !== undefined ? { authorizationUrl: flow.authorizationUrl } : {}),
          clientId: '',
          scopes: Object.keys(flow.scopes ?? {}),
          clientAuth: 'basic',
          // PKCE is what makes an authorization-code flow safe in a public client; a
          // client-credentials flow has no authorization request to protect.
          pkce: clientCredentials === undefined,
        },
      };
    }
    default:
      return { reason: `Security scheme type "${scheme.type}" is not supported` };
  }
}

/** {@link mapScheme}, recording in `skipped` when the scheme the import needed has no equivalent. */
export function authFromScheme(scheme: OpenApiSecurityScheme, skipped: OpenApiSkipped[]): AuthConfig | undefined {
  const mapped = mapScheme(scheme);
  if (mapped.auth === undefined) {
    skipped.push({
      kind: 'security-scheme',
      where: scheme.name,
      reason: mapped.reason ?? 'Not supported',
    });
  }
  return mapped.auth;
}

/** The scheme a requirement names, when it names exactly one this client can use. */
function schemeOfRequirement(
  requirements: readonly OpenApiSecurityRequirement[] | undefined,
  schemes: readonly OpenApiSecurityScheme[],
): OpenApiSecurityScheme | undefined {
  const names = Object.keys(requirements?.[0] ?? {});
  const first = names[0];
  return first === undefined ? undefined : schemes.find((scheme) => scheme.name === first);
}

/** A request's own credentials, set only where the operation departs from the document's default. */
function operationAuth(
  operation: OpenApiOperation,
  document: OpenApiDocument,
  skipped: OpenApiSkipped[],
): AuthConfig | undefined {
  if (operation.security === undefined) {
    return undefined;
  }
  if (operation.security.length === 0) {
    // "Explicitly unauthenticated" is a statement, and `none` is how this client says it.
    return { type: 'none' };
  }
  const own = schemeOfRequirement(operation.security, document.securitySchemes);
  const global = schemeOfRequirement(document.security, document.securitySchemes);
  if (own === undefined || own.name === global?.name) {
    return undefined;
  }
  return authFromScheme(own, skipped);
}

/** The first segment of a path, which is the folder a tagless operation falls into. */
function firstPathSegment(path: string): string | undefined {
  for (const segment of path.split('/')) {
    if (segment.length > 0 && !segment.startsWith('{')) {
      return segment;
    }
  }
  return undefined;
}

/** The folder an operation belongs in: its first tag, else `Deprecated`, else its first path segment. */
function folderNameOf(operation: OpenApiOperation): string | undefined {
  const tag = operation.tags?.[0];
  if (tag !== undefined && tag.length > 0) {
    // A tag is the document's own answer, and it wins even for a deprecated operation: the author
    // filed it with its live siblings, and moving it would hide a rename the user has to make.
    return tag;
  }
  // Untagged and deprecated is the operation that would otherwise be lost among the live ones in a
  // path-segment folder, so this is where `Deprecated` earns its keep.
  if (operation.deprecated === true) {
    return 'Deprecated';
  }
  return firstPathSegment(operation.path);
}

/** A request's name: its summary, else its operation id, else what it does. */
function requestName(operation: OpenApiOperation): string {
  const summary = operation.summary?.trim();
  if (summary !== undefined && summary.length > 0) {
    return summary;
  }
  if (operation.operationId !== undefined && operation.operationId.length > 0) {
    return operation.operationId;
  }
  return `${operation.method.toUpperCase()} ${operation.path}`;
}

/** A request's description, with a deprecation marked where the operation says so. */
function requestDescription(operation: OpenApiOperation): string | undefined {
  const body = operation.description?.trim();
  if (operation.deprecated !== true) {
    return body !== undefined && body.length > 0 ? body : undefined;
  }
  return body !== undefined && body.length > 0 ? `**Deprecated.**\n\n${body}` : '**Deprecated.**';
}

/** Operations grouped by folder name, each group in document order, groups in first-met order. */
function groupByFolder(operations: readonly OpenApiOperation[]): Map<string | undefined, OpenApiOperation[]> {
  const groups = new Map<string | undefined, OpenApiOperation[]>();
  for (const operation of operations) {
    const name = folderNameOf(operation);
    const group = groups.get(name);
    if (group === undefined) {
      groups.set(name, [operation]);
    } else {
      group.push(operation);
    }
  }
  return groups;
}

/**
 * Maps a parsed document onto one API.
 *
 * @param document a document already parsed and `$ref`-resolved (see `import.ts`)
 * @returns the API, and a summary of what the mapping used and what it could not
 */
export function apiFromDocument(document: OpenApiDocument, options: MapApiOptions = {}): MappedApi {
  const newId = options.newId ?? generateId;
  const skipped: OpenApiSkipped[] = [...document.skipped];

  const servers: RestServer[] = document.servers.map((server) => ({
    url: serverUrl(server),
    ...(server.description !== undefined ? { description: server.description } : {}),
  }));
  const title = document.info.title.trim();
  const name = options.name?.trim() ?? (title.length > 0 ? title : 'API');
  const baseUrl = options.baseUrl ?? servers[0]?.url ?? '';

  const chosenScheme =
    options.securityScheme !== undefined
      ? document.securitySchemes.find((scheme) => scheme.name === options.securityScheme)
      : document.security?.length === 1
        ? schemeOfRequirement(document.security, document.securitySchemes)
        : undefined;
  const apiAuth = chosenScheme === undefined ? undefined : authFromScheme(chosenScheme, skipped);

  const tagDescriptions = new Map(document.tags.map((tag) => [tag.name, tag.description]));
  const groups = groupByFolder(document.operations);

  const rootRequests: RestRequestDef[] = [];
  const folders: RestFolder[] = [];
  const folderSlugs = new Set<string>();
  const rootSlugs = new Set<string>();
  let deprecated = 0;
  let requests = 0;

  const buildRequest = (operation: OpenApiOperation, order: number, taken: Set<string>): RestRequestDef => {
    noteCookieParameters(operation, skipped);
    if (operation.deprecated === true) {
      deprecated += 1;
    }
    requests += 1;
    const label = requestName(operation);
    const auth = operationAuth(operation, document, skipped);
    const description = requestDescription(operation);
    return createRestRequest(label, {
      id: newId(),
      slug: uniqueSlug(label, taken),
      order,
      method: operation.method.toUpperCase(),
      url: operation.path,
      ...(description !== undefined ? { description } : {}),
      pathParams: parameterRows(operation, 'path', options, skipped),
      query: parameterRows(operation, 'query', options, skipped),
      headers: parameterRows(operation, 'header', options, skipped),
      body: bodyOf(operation, options, skipped),
      ...(auth !== undefined ? { auth } : {}),
    });
  };

  for (const [folderName, operations] of groups) {
    if (folderName === undefined) {
      operations.forEach((operation, index) => {
        const request = buildRequest(operation, index, rootSlugs);
        rootSlugs.add(request.slug);
        rootRequests.push(request);
      });
      continue;
    }
    const taken = new Set<string>();
    const inside = operations.map((operation, index) => {
      const request = buildRequest(operation, index, taken);
      taken.add(request.slug);
      return request;
    });
    const description = tagDescriptions.get(folderName);
    const slug = uniqueSlug(folderName, folderSlugs);
    folderSlugs.add(slug);
    folders.push(
      createFolder(folderName, {
        id: newId(),
        slug,
        order: folders.length,
        ...(description !== undefined ? { description } : {}),
        requests: inside,
      }),
    );
  }

  const api = createApi(name, {
    id: newId(),
    slug: slugify(name),
    order: options.order ?? 0,
    baseUrl,
    servers,
    ...(document.info.description !== undefined ? { description: document.info.description } : {}),
    ...(apiAuth !== undefined ? { auth: apiAuth } : {}),
    ...(options.definition !== undefined ? { definition: options.definition } : {}),
    folders,
    requests: rootRequests,
  });

  return {
    api,
    summary: {
      name,
      title,
      declaredVersion: document.declaredVersion,
      ...(document.info.version !== undefined ? { apiVersion: document.info.version } : {}),
      baseUrl,
      servers,
      folders: folders.length,
      requests,
      deprecated,
      ...(apiAuth !== undefined ? { auth: apiAuth.type } : {}),
      securitySchemes: document.securitySchemes.map((scheme) => {
        const mapped = mapScheme(scheme);
        return {
          name: scheme.name,
          type: scheme.type,
          ...(scheme.description !== undefined ? { description: scheme.description } : {}),
          ...(mapped.auth !== undefined ? { auth: mapped.auth } : {}),
          ...(mapped.reason !== undefined ? { reason: mapped.reason } : {}),
          applied: scheme.name === chosenScheme?.name,
        };
      }),
      skipped: uniqueSkipped(skipped),
    },
  };
}

/**
 * The skipped list without repeats. A scheme this client cannot map is met once per operation
 * that names it — twenty operations behind one implicit flow would otherwise say the same thing
 * twenty times, and the summary is for reading.
 */
function uniqueSkipped(skipped: readonly OpenApiSkipped[]): OpenApiSkipped[] {
  const seen = new Set<string>();
  return skipped.filter((entry) => {
    const key = `${entry.kind}\u0000${entry.where}\u0000${entry.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
