/**
 * Pure mapping from Postman Collection v2.0/v2.1 documents to Wirebench REST entities.
 *
 * Recursively maps Postman items into `RestFolder` and `RestRequestDef` trees, preserving author
 * order, variable substitutions (`${var}`), path parameter definitions, headers, query parameters,
 * request bodies (raw, urlencoded, formdata, binary), and auth configurations.
 */

import { PostmanError } from '../../errors.js';
import { MAX_EXAMPLE_BODY_CHARS, maskRecordedResponse } from '../../import/examples.js';
import { ReportBuilder } from '../../import/report.js';
import type { ImportedVariableSet } from '../../import/variables.js';
import { VariableSetBuilder, warnCredentialLookingNames } from '../../import/variables.js';
import type { AuthConfig, IdGenerator } from '../../project/model.js';
import { generateId } from '../../project/model.js';
import { slugify, uniqueSlug } from '../../project/paths.js';
import type {
  KeyValueEntry,
  MultipartFormPart,
  RawLanguage,
  RestApi,
  RestBody,
  RestFolder,
  RestRequestDef,
  RestResponseExample,
  RestServer,
} from '../model.js';
import { createApi, createFolder, createRestRequest, entry, NO_BODY } from '../model.js';
import { splitQuery } from '../url.js';
import type {
  PostmanAuth,
  PostmanBody,
  PostmanCollection,
  PostmanHeader,
  PostmanEvent,
  PostmanImportSummary,
  PostmanItem,
  PostmanQueryParam,
  PostmanRequest,
  PostmanResponse,
  PostmanUrl,
  PostmanVariable,
} from './model.js';
import { MAX_POSTMAN_DEPTH, translatePostmanVariables } from './parse.js';
import type { RequestScripts } from '../../script/model.js';
import { JWT_ALGORITHMS } from '../../http/auth/jwt-algorithms.js';
import type { JwtAlgorithm } from '../../http/auth/jwt-algorithms.js';

/** Matches a leading `${baseUrl}` / `${base_url}` reference in any letter case. */
const BASE_URL_REFERENCE = /^\$\{(baseurl|base_url)\}/i;

function isBaseUrlKey(key: string): boolean {
  const lower = key.toLowerCase();
  return lower === 'baseurl' || lower === 'base_url';
}

function tooDeep(): PostmanError {
  return new PostmanError(
    'postman-too-deep',
    `The collection nests folders more than ${MAX_POSTMAN_DEPTH} levels deep`,
  );
}

export interface MapPostmanOptions {
  /** The API's name. Defaults to collection `info.name`. */
  readonly name?: string;
  /** The base URL. Defaults to the inferred base URL, baseUrl variable, or empty. */
  readonly baseUrl?: string;
  /** Injectable id generator. */
  readonly newId?: IdGenerator;
  /** Order in project. */
  readonly order?: number;
}

export interface MappedPostmanApi {
  readonly api: RestApi;
  /** The collection's and folders' variables, for the project's properties. */
  readonly projectProperties: ImportedVariableSet;
  readonly summary: PostmanImportSummary;
}

/**
 * Maps a parsed Postman Collection into a Wirebench REST API and import summary.
 */
export function apiFromPostmanCollection(
  collection: PostmanCollection,
  options: MapPostmanOptions = {},
): MappedPostmanApi {
  const newId = options.newId ?? generateId;
  const name = options.name?.trim() || collection.info.name || 'Imported Collection';

  // Every dynamic name, from parsing and from the variables and base URL below, is reported once.
  const dynamic = new Set<string>(collection.dynamicVariables);

  // Determine base URL: options.baseUrl -> collection variable baseUrl/base_url -> inferred from first request -> empty
  let baseUrl = options.baseUrl?.trim();
  if (baseUrl === undefined || baseUrl === '') {
    const baseVar = collection.variable?.find((v) => isBaseUrlKey(v.key));
    if (baseVar?.value !== undefined && String(baseVar.value).trim().length > 0) {
      baseUrl = translatePostmanVariables(String(baseVar.value).trim(), dynamic);
    } else {
      baseUrl = inferBaseUrl(collection.item, 1);
    }
  }

  const warnings: string[] = [...(collection.warnings ?? [])];
  const variableReport = new ReportBuilder();
  const properties = new VariableSetBuilder('Project properties', variableReport);
  const addVariables = (vars: readonly PostmanVariable[] | undefined, where: string | undefined): void => {
    for (const v of vars ?? []) {
      if (where === undefined && isBaseUrlKey(v.key)) continue;
      const raw: unknown = v.value;
      const text =
        raw === undefined || raw === null
          ? ''
          : typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean'
            ? String(raw)
            : undefined;
      if (text === undefined) {
        variableReport.warn(`Variable "${v.key}" has a value that is not text and was skipped.`);
        continue;
      }
      const enabled = v.disabled !== true;
      properties.add(
        v.type === 'secret'
          ? { name: v.key, value: '', enabled, secret: true, ...(text !== '' ? { secretValue: text } : {}) }
          : { name: v.key, value: translatePostmanVariables(text, dynamic), enabled, secret: false },
        where,
      );
    }
  };
  addVariables(collection.variable, undefined);
  const credentialCount = { value: hasCredentials(collection.auth) ? 1 : 0 };
  const servers: RestServer[] = baseUrl !== '' ? [{ url: baseUrl, description: 'Collection Base URL' }] : [];

  const apiAuth = mapPostmanAuth(collection.auth, false, warnings);

  let folderCount = 0;
  let requestCount = 0;

  // Each level keeps its own scripts (#334): the collection's on the API, a folder's on the folder.
  const scripted = { api: false, folders: 0, requests: 0 };
  const unsupported = new Map<string, Set<string>>();
  const steering = new Map<string, readonly string[]>();
  const scriptsAt = (events: readonly PostmanEvent[] | undefined, path: string): RequestScripts | undefined => {
    const scripts = importedScripts(events);
    if (scripts !== undefined) {
      const text = [scripts.pre?.text ?? '', scripts.post?.text ?? ''].join('\n');
      const calls = unsupportedCalls(text);
      if (calls.length > 0) unsupported.set(path, new Set(calls));
      const steers = runControlCalls(text);
      if (steers.length > 0) steering.set(path, steers);
    }
    return scripts;
  };
  const apiScripts = scriptsAt(collection.event, name);
  scripted.api = apiScripts !== undefined;

  const mapItems = (
    items: readonly PostmanItem[],
    depth: number,
    trail: readonly string[],
  ): { folders: RestFolder[]; requests: RestRequestDef[] } => {
    if (depth > MAX_POSTMAN_DEPTH) {
      throw tooDeep();
    }
    const folders: RestFolder[] = [];
    const requests: RestRequestDef[] = [];
    const folderSlugs = new Set<string>();
    const requestSlugs = new Set<string>();

    for (const item of items) {
      addVariables(item.variable, `folder "${item.name}"`);
      if (hasCredentials(item.auth)) credentialCount.value += 1;
      if (typeof item.request === 'object' && hasCredentials(item.request.auth)) credentialCount.value += 1;
      if (Array.isArray(item.item)) {
        // Folder item
        folderCount += 1;
        const slug = uniqueSlug(item.name, folderSlugs);
        folderSlugs.add(slug);
        const folderAuth = mapPostmanAuth(item.auth, false, warnings);
        const folderTrail = [...trail, item.name];
        const folderScripts = scriptsAt(item.event, folderTrail.join(' / '));
        if (folderScripts !== undefined) scripted.folders += 1;
        const children = mapItems(item.item, depth + 1, folderTrail);

        folders.push(
          createFolder(item.name, {
            id: newId(),
            slug,
            order: folders.length,
            ...(item.description !== undefined ? { description: item.description } : {}),
            ...(folderAuth !== undefined ? { auth: folderAuth } : {}),
            ...(folderScripts !== undefined ? { scripts: folderScripts } : {}),
            folders: children.folders,
            requests: children.requests,
          }),
        );
      } else if (item.request !== undefined) {
        // Request item
        requestCount += 1;
        const slug = uniqueSlug(item.name, requestSlugs);
        requestSlugs.add(slug);

        const mappedRequest = mapRequest(item.name, slug, requests.length, item, newId, baseUrl, warnings);
        const scripts = scriptsAt(item.event, [...trail, item.name].join(' / '));
        if (scripts !== undefined) scripted.requests += 1;
        const examples = mapExamples(item.response ?? [], item.responsesDropped ?? 0, item.name, newId, warnings);
        const behaviour = item.protocolProfileBehavior;
        requests.push({
          ...mappedRequest,
          ...(behaviour !== undefined ? { settings: { ...mappedRequest.settings, ...behaviour } } : {}),
          ...(scripts !== undefined ? { scripts } : {}),
          ...(examples.length > 0 ? { examples } : {}),
        });
      }
    }

    return { folders, requests };
  };

  const root = mapItems(collection.item, 1, []);
  const scriptedPlaces = [
    ...(scripted.api ? ['the API'] : []),
    ...(scripted.folders > 0 ? [`${String(scripted.folders)} ${scripted.folders === 1 ? 'folder' : 'folders'}`] : []),
    ...(scripted.requests > 0
      ? [`${String(scripted.requests)} ${scripted.requests === 1 ? 'request' : 'requests'}`]
      : []),
  ];
  if (scriptedPlaces.length > 0) {
    const listed =
      scriptedPlaces.length === 1
        ? scriptedPlaces[0]!
        : `${scriptedPlaces.slice(0, -1).join(', ')} and ${scriptedPlaces[scriptedPlaces.length - 1]!}`;
    warnings.push(`Scripts on ${listed} were imported switched off: read each on its Scripts tab, then switch them on`);
  }
  for (const [path, calls] of unsupported) {
    // A request a script sends is the one call people most often need, so its warning says what to do instead.
    if (calls.delete('pm.sendRequest')) {
      warnings.push(
        `The scripts of "${path}" call pm.sendRequest, which a script cannot do: send that request as a sequence step, or use OAuth2 auth for a token`,
      );
    }
    if (calls.size > 0) {
      warnings.push(`The scripts of "${path}" call what Wirebench does not run: ${[...calls].sort().join(', ')}`);
    }
  }
  for (const [path, calls] of steering) {
    warnings.push(`The scripts of "${path}" steer the run (${calls.join(', ')}): obeyed in API and folder runs only`);
  }
  if (dynamic.size > 0) {
    warnings.push(`Dynamic variables are kept as written and not expanded: ${[...dynamic].sort().join(', ')}`);
  }
  const projectProperties = properties.build();
  warnCredentialLookingNames(variableReport, [projectProperties]);
  const variableResult = variableReport.build();
  warnings.push(...variableResult.warnings, ...variableResult.notes);
  if (credentialCount.value > 0) {
    warnings.push(
      `Credentials are not copied from the collection; re-enter them for ${credentialCount.value} auth ${credentialCount.value === 1 ? 'configuration' : 'configurations'}`,
    );
  }

  const api = createApi(name, {
    id: newId(),
    slug: slugify(name),
    order: options.order ?? 0,
    baseUrl,
    servers,
    ...(collection.info.description !== undefined ? { description: collection.info.description } : {}),
    ...(apiAuth !== undefined ? { auth: apiAuth } : {}),
    ...(apiScripts !== undefined ? { scripts: apiScripts } : {}),
    folders: root.folders,
    requests: root.requests,
  });

  const summary: PostmanImportSummary = {
    name,
    ...(collection.info.description !== undefined ? { description: collection.info.description } : {}),
    folders: folderCount,
    requests: requestCount,
    ...(apiAuth !== undefined ? { auth: apiAuth.type } : {}),
    projectProperties: properties.size,
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  return { api, projectProperties, summary };
}

function mapRequest(
  name: string,
  slug: string,
  order: number,
  item: PostmanItem,
  newId: IdGenerator,
  effectiveBaseUrl: string,
  warnings?: string[],
): RestRequestDef {
  const req: PostmanRequest =
    typeof item.request === 'string' ? { method: 'GET', url: item.request } : (item.request ?? {});
  const method = (req.method ?? 'GET').toUpperCase();

  // Normalize URL and extract query and path params
  const rawUrlObj: PostmanUrl = typeof req.url === 'string' ? { raw: req.url } : (req.url ?? {});
  const rawUrlString = rawUrlObj.raw ?? '';
  const { path: urlPath, query: inlineQuery } = splitQuery(rawUrlString);

  // Relative URL with base URL stripped if it matches
  let cleanUrl = urlPath;
  if (effectiveBaseUrl !== '') {
    if (cleanUrl === effectiveBaseUrl) {
      cleanUrl = '/';
    } else if (cleanUrl.startsWith(`${effectiveBaseUrl}/`)) {
      cleanUrl = cleanUrl.slice(effectiveBaseUrl.length);
    }
  }
  const baseReference = BASE_URL_REFERENCE.exec(cleanUrl)?.[0];
  if (baseReference !== undefined) {
    const rest = cleanUrl.slice(baseReference.length);
    if (rest === '') {
      cleanUrl = '/';
    } else if (rest.startsWith('/')) {
      cleanUrl = rest;
    }
  }

  // Query parameters: prefer explicit query array from Postman, fallback to inline query from URL
  const query: KeyValueEntry[] = [];
  const rawQuery: readonly PostmanQueryParam[] = rawUrlObj.query ?? [];
  if (rawQuery.length > 0) {
    for (const q of rawQuery) {
      if (q.key !== undefined) {
        query.push(
          entry(q.key, q.value ?? '', {
            enabled: q.disabled !== true,
            ...(q.description !== undefined ? { description: q.description } : {}),
          }),
        );
      }
    }
  } else if (inlineQuery.length > 0) {
    query.push(...inlineQuery);
  }

  // Path parameters: match {param} in cleanUrl (ignoring ${var} properties), populate from rawUrlObj.variable
  const urlParamNames: string[] = [];
  for (const match of cleanUrl.matchAll(/(?<!\$)\{([^{}/?#]+)\}/g)) {
    const name = match[1]!;
    if (!urlParamNames.includes(name)) {
      urlParamNames.push(name);
    }
  }
  const pathParams: KeyValueEntry[] = [];
  for (const paramName of urlParamNames) {
    const matched = rawUrlObj.variable?.find((v) => v.key === paramName);
    pathParams.push(
      entry(paramName, asText(matched?.value) ?? '', {
        enabled: true,
        ...(matched?.description !== undefined ? { description: matched.description } : {}),
      }),
    );
  }

  // Headers
  const headers: KeyValueEntry[] = [];
  const rawHeaders: readonly PostmanHeader[] = Array.isArray(req.header) ? req.header : [];
  for (const h of rawHeaders) {
    if (h.key.trim().length > 0) {
      headers.push(
        entry(h.key, h.value, {
          enabled: h.disabled !== true,
          ...(h.description !== undefined ? { description: h.description } : {}),
        }),
      );
    }
  }

  // Body
  const body = mapBody(
    req.body,
    rawHeaders.filter((h) => h.disabled !== true),
  );

  // Auth: request-level auth, or item-level auth, or inherit
  const auth = mapPostmanAuth(req.auth ?? item.auth, true, warnings) ?? { type: 'inherit' };

  const description = item.description ?? req.description;

  return createRestRequest(name, {
    id: newId(),
    slug,
    order,
    method,
    url: cleanUrl,
    ...(description !== undefined ? { description } : {}),
    pathParams,
    query,
    headers,
    body,
    auth,
  });
}

/** A content type for a saved body that names none in its headers, by the language it was shown as. */
const PREVIEW_TYPES: Readonly<Record<string, string>> = {
  json: 'application/json',
  xml: 'application/xml',
  html: 'text/html',
  text: 'text/plain',
  javascript: 'application/javascript',
};

/**
 * A request's saved responses as examples: each with a status code, masked as every importer masks
 * a recorded response, its body cut at {@link MAX_EXAMPLE_BODY_CHARS}.
 */
function mapExamples(
  responses: readonly PostmanResponse[],
  dropped: number,
  label: string,
  newId: IdGenerator,
  warnings: string[],
): RestResponseExample[] {
  const out: RestResponseExample[] = [];
  let skipped = dropped;
  let masked = false;
  for (const response of responses) {
    const status = response.code;
    if (status === undefined) {
      skipped += 1;
      continue;
    }
    const recorded = response.header.map((h) => ({ name: h.key, value: h.value }));
    const contentType =
      recorded.find((h) => h.name.toLowerCase() === 'content-type')?.value ??
      (response.previewLanguage !== undefined && Object.hasOwn(PREVIEW_TYPES, response.previewLanguage.toLowerCase())
        ? PREVIEW_TYPES[response.previewLanguage.toLowerCase()]
        : undefined);
    const kept = maskRecordedResponse(recorded, response.body, contentType);
    masked ||= kept.masked;
    let body = kept.body;
    if (body !== undefined && body.length > MAX_EXAMPLE_BODY_CHARS) {
      body = body.slice(0, MAX_EXAMPLE_BODY_CHARS);
      warnings.push(`${label}: a ${String(status)} example body was larger than 256 KB and was cut`);
    }
    out.push({
      id: newId(),
      name: response.name !== undefined && response.name !== '' ? response.name : String(status),
      status,
      statusText: response.status ?? '',
      headers: kept.headers,
      ...(contentType !== undefined ? { contentType } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  }
  if (masked) warnings.push(`${label}: credentials in a saved response were masked in its example`);
  if (skipped > 0) {
    warnings.push(
      `${label}: ${String(skipped)} saved ${skipped === 1 ? 'response' : 'responses'} without a status code ${skipped === 1 ? 'was' : 'were'} skipped`,
    );
  }
  return out;
}

function mapBody(body: PostmanBody | undefined, headers: readonly PostmanHeader[]): RestBody {
  if (body === undefined) {
    return NO_BODY;
  }

  if (body.mode === 'raw') {
    const rawText = body.raw ?? '';
    const language = detectLanguage(body, headers, rawText);
    return {
      kind: 'raw',
      language,
      text: rawText,
    };
  }

  if (body.mode === 'urlencoded') {
    const fields: KeyValueEntry[] = (body.urlencoded ?? []).map((p) =>
      entry(p.key, p.value, {
        enabled: p.disabled !== true,
        ...(p.description !== undefined ? { description: p.description } : {}),
      }),
    );
    return { kind: 'form', fields };
  }

  if (body.mode === 'formdata') {
    const parts: MultipartFormPart[] = (body.formdata ?? []).flatMap((p): MultipartFormPart[] => {
      if (p.type === 'file') {
        const paths = typeof p.src === 'string' ? [p.src] : p.src !== undefined && p.src.length > 0 ? p.src : [''];
        return paths.map((path) => ({
          kind: 'file',
          name: p.key,
          source: { kind: 'path', path },
          enabled: p.disabled !== true,
          ...(p.contentType !== undefined ? { contentType: p.contentType } : {}),
        }));
      }
      return [
        {
          kind: 'text',
          name: p.key,
          value: p.value ?? '',
          enabled: p.disabled !== true,
          ...(p.contentType !== undefined ? { contentType: p.contentType } : {}),
        },
      ];
    });
    return { kind: 'multipart', parts };
  }

  if (body.mode === 'graphql' && body.graphql !== undefined) {
    const { query, variables, operationName } = body.graphql;
    return { kind: 'graphql', query, variables, ...(operationName !== undefined ? { operationName } : {}) };
  }

  if (body.mode === 'file') {
    const ctHeader = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value;
    return {
      kind: 'binary',
      source: { kind: 'path', path: body.file?.src ?? '' },
      contentType: ctHeader ?? 'application/octet-stream',
    };
  }

  return NO_BODY;
}

function detectLanguage(body: PostmanBody, headers: readonly PostmanHeader[], rawText: string): RawLanguage {
  const optLang = body.options?.raw?.language?.toLowerCase();
  if (optLang === 'json' || optLang === 'xml' || optLang === 'text' || optLang === 'html' || optLang === 'javascript') {
    return optLang;
  }

  const ctHeader = headers.find((h) => h.key.toLowerCase() === 'content-type')?.value?.toLowerCase();
  if (ctHeader?.includes('xml')) return 'xml';
  if (ctHeader?.includes('html')) return 'html';
  if (ctHeader?.includes('javascript')) return 'javascript';
  if (ctHeader?.includes('text/plain')) return 'text';
  if (ctHeader?.includes('json')) return 'json';

  const trimmed = rawText.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return 'xml';
  }
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return 'json';
  }

  return trimmed.length > 0 ? 'text' : 'json';
}

/** Secret attribute keys per auth type; a non-empty value means the user must re-enter it. */
const SECRET_KEYS: Readonly<Record<string, readonly string[]>> = {
  basic: ['password'],
  bearer: ['token'],
  apikey: ['value'],
  oauth2: ['clientSecret', 'accessToken', 'password', 'refreshToken'],
  ntlm: ['password'],
  digest: ['password'],
  awsv4: ['accessKey', 'secretKey', 'sessionToken'],
  // No `jwt`: every JWT gets its own line (mapJwtAuth), whether or not the file held a secret.
};

/** Whether `auth` carries a secret the import does not copy. */
export function hasCredentials(auth: PostmanAuth | undefined): boolean {
  const type = auth?.type?.toLowerCase();
  if (auth === undefined || type === undefined) return false;
  const keys = SECRET_KEYS[type];
  const attrs = (auth as Readonly<Record<string, unknown>>)[type];
  if (keys === undefined || !Array.isArray(attrs)) return false;
  return (attrs as readonly { key: string; value: unknown }[]).some(
    (a) => keys.includes(a.key) && a.value !== undefined && a.value !== null && a.value !== '',
  );
}

function asText(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return undefined;
}

/**
 * A v2.1 auth as Wirebench's: `inherit` for a request with none, `none` (and a warning) for a type
 * Wirebench does not take. Secrets are never copied.
 */
export function mapPostmanAuth(
  auth: PostmanAuth | undefined,
  isRequest: boolean,
  warnings?: string[],
): AuthConfig | undefined {
  const type = auth?.type?.toLowerCase();
  if (auth === undefined || type === 'inherit') {
    return isRequest ? { type: 'inherit' } : undefined;
  }

  switch (type) {
    case 'noauth':
      return { type: 'none' };
    case 'basic': {
      const usernameAttr = auth.basic?.find((a) => a.key === 'username');
      const username = asText(usernameAttr?.value);
      return {
        type: 'basic',
        ...(username !== undefined ? { username } : {}),
      };
    }
    case 'bearer': {
      // `scheme` is no v2.1 key: the other clients' converters set it for a token prefix other than Bearer.
      const scheme = asText(auth.bearer?.find((a) => a.key === 'scheme')?.value);
      return { type: 'bearer', ...(scheme !== undefined && scheme !== '' ? { scheme } : {}) };
    }
    case 'apikey': {
      const keyAttr = auth.apikey?.find((a) => a.key === 'key' || a.key === 'name');
      const inAttr = auth.apikey?.find((a) => a.key === 'in');
      const inLoc = inAttr?.value === 'query' ? 'query' : 'header';
      return {
        type: 'api-key',
        name: asText(keyAttr?.value) ?? 'api_key',
        in: inLoc,
      };
    }
    case 'oauth2': {
      const grantAttr = auth.oauth2?.find((a) => a.key === 'grant_type');
      const tokenUrlAttr = auth.oauth2?.find((a) => a.key === 'accessTokenUrl' || a.key === 'tokenUrl');
      const authUrlAttr = auth.oauth2?.find((a) => a.key === 'authUrl' || a.key === 'authorizationUrl');
      const clientIdAttr = auth.oauth2?.find((a) => a.key === 'clientId');
      const scopeAttr = auth.oauth2?.find((a) => a.key === 'scope');
      const grant = asText(grantAttr?.value) ?? 'client_credentials';
      const isAuthCode = grant === 'authorization_code' || grant === 'authorization_code_with_pkce';
      const isPassword = grant === 'password_credentials';
      if (!isAuthCode && !isPassword && grant !== 'client_credentials') {
        warnings?.push(`OAuth 2.0 grant "${grant}" is not supported; set to "none"`);
        return { type: 'none' };
      }
      const authUrl = asText(authUrlAttr?.value);
      const scopeText = asText(scopeAttr?.value);
      // The resource owner's name only: the password, like the client secret, is never imported.
      const username = isPassword ? asText(auth.oauth2?.find((a) => a.key === 'username')?.value) : undefined;
      const placement = asText(auth.oauth2?.find((a) => a.key === 'client_authentication')?.value);

      return {
        type: 'oauth2',
        grant: isAuthCode ? 'authorization-code' : isPassword ? 'password' : 'client-credentials',
        tokenUrl: asText(tokenUrlAttr?.value) ?? '',
        ...(authUrl !== undefined ? { authorizationUrl: authUrl } : {}),
        clientId: asText(clientIdAttr?.value) ?? '',
        ...(username !== undefined ? { username } : {}),
        scopes: scopeText !== undefined ? scopeText.split(/[\s,]+/).filter(Boolean) : [],
        clientAuth: placement === 'body' ? 'body' : 'basic',
        pkce: isAuthCode,
      };
    }
    case 'ntlm': {
      const userAttr = auth.ntlm?.find((a) => a.key === 'username');
      const domainAttr = auth.ntlm?.find((a) => a.key === 'domain');
      const workstationAttr = auth.ntlm?.find((a) => a.key === 'workstation');
      const username = asText(userAttr?.value);
      const domain = asText(domainAttr?.value);
      const workstation = asText(workstationAttr?.value);
      return {
        type: 'ntlm',
        ...(username !== undefined ? { username } : {}),
        ...(domain !== undefined ? { domain } : {}),
        ...(workstation !== undefined ? { workstation } : {}),
      };
    }
    case 'digest': {
      // The username only: the password, like every secret, is never imported.
      const username = asText(auth.digest?.find((a) => a.key === 'username')?.value);
      return { type: 'digest', ...(username !== undefined ? { username } : {}) };
    }
    case 'awsv4': {
      // Region and service only: the keys and the session token are never imported.
      const attr = (key: string): string => asText(auth.awsv4?.find((a) => a.key === key)?.value) ?? '';
      const region = attr('region');
      const service = attr('service');
      // Without them the request cannot be signed; say so rather than fail at the first send.
      if (region === '') warnings?.push('AWS Signature: region is not set');
      if (service === '') warnings?.push('AWS Signature: service is not set');
      return { type: 'aws-sigv4', region, service };
    }
    case 'jwt':
      return mapJwtAuth(auth.jwt ?? [], warnings);
    default:
      if (type !== undefined) {
        warnings?.push(`Authentication type "${type}" is not supported; set to "none"`);
      }
      return { type: 'none' };
  }
}

/** A JSON attribute (`payload`, `header`) as text: a string as written, anything else as its JSON. */
function jsonText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * A v2.1 `jwt` auth as Wirebench's: the algorithm, claims, extra header and where the token goes.
 * The signing secret or private key is never imported; an algorithm Wirebench cannot sign with is
 * `none`, named in a warning.
 */
function mapJwtAuth(
  attrs: readonly { readonly key: string; readonly value: unknown }[],
  warnings?: string[],
): AuthConfig {
  const attr = (key: string): unknown => attrs.find((a) => a.key === key)?.value;
  const algorithm = asText(attr('algorithm')) ?? 'HS256';
  if (!(JWT_ALGORITHMS as readonly string[]).includes(algorithm)) {
    warnings?.push(`JWT algorithm "${algorithm}" is not supported; set to "none"`);
    return { type: 'none' };
  }
  // The token cannot be signed until the user sets what the file never carries across.
  warnings?.push('JWT: the secret or key is not copied; set the secret (HS*) or key (RS*/ES*/PS*) before sending');
  const header = jsonText(attr('header'));
  const toQuery = asText(attr('addTokenTo')) === 'queryParam';
  const queryKey = asText(attr('queryParamKey'));
  const prefix = asText(attr('headerPrefix'));
  return {
    type: 'jwt',
    algorithm: algorithm as JwtAlgorithm,
    claims: jsonText(attr('payload')) ?? '{}',
    ...(header !== undefined && header !== '{}' ? { header } : {}),
    issuedAt: false,
    jwtId: false,
    in: toQuery ? 'query' : 'header',
    ...(toQuery
      ? queryKey !== undefined && queryKey !== ''
        ? { name: queryKey }
        : {}
      : { prefix: prefix ?? 'Bearer' }),
  };
}

/** Recursively looks for the first absolute URL to infer a collection base URL. */
function inferBaseUrl(items: readonly PostmanItem[], depth: number): string {
  if (depth > MAX_POSTMAN_DEPTH) {
    throw tooDeep();
  }
  for (const item of items) {
    if (item.request !== undefined) {
      const req = typeof item.request === 'string' ? { url: item.request } : item.request;
      const rawUrl = typeof req.url === 'string' ? req.url : req.url?.raw;
      if (rawUrl !== undefined && rawUrl.length > 0) {
        if (/^https?:\/\//i.test(rawUrl)) {
          try {
            const parsed = new URL(rawUrl);
            return parsed.origin;
          } catch {
            // If URL constructor fails (e.g. contains variables), extract up to the first single slash
            const match = rawUrl.match(/^(https?:\/\/[^/?#]+)/i);
            if (match) return match[1]!;
          }
        } else if (rawUrl.startsWith('${')) {
          const closeIndex = rawUrl.indexOf('}');
          if (closeIndex !== -1) {
            return rawUrl.slice(0, closeIndex + 1);
          }
        }
      }
    }
    if (Array.isArray(item.item)) {
      const found = inferBaseUrl(item.item, depth + 1);
      if (found !== '') return found;
    }
  }
  return '';
}

/** A level's scripts of one kind, in the order Postman runs them; two of one kind are joined. */
function scriptText(texts: readonly string[]): string {
  return texts.map((text) => `${text.replace(/\s+$/, '')}\n`).join('\n');
}

/**
 * One level's imported scripts (a collection's, a folder's or a request's), written against the
 * Postman layer and switched off until someone has read them (#63, #334).
 */
function importedScripts(events: readonly PostmanEvent[] | undefined): RequestScripts | undefined {
  const pre: string[] = [];
  const post: string[] = [];
  for (const event of events ?? []) {
    (event.listen === 'prerequest' ? pre : post).push(event.exec);
  }
  if (pre.length === 0 && post.length === 0) return undefined;
  return {
    ...(pre.length > 0 ? { pre: { text: scriptText(pre) } } : {}),
    ...(post.length > 0 ? { post: { text: scriptText(post) } } : {}),
    api: 'postman',
    enabled: false,
    secrets: [],
  };
}

/** The Postman calls a script makes that the layer does not run (spec §Postman), found by name. */
const UNSUPPORTED_CALLS: readonly [RegExp, string][] = [
  [/\bpm\.sendRequest\b/, 'pm.sendRequest'],
  [/\bpm\.cookies\.jar\b/, 'pm.cookies.jar'],
  [/\bpm\.visualizer\b/, 'pm.visualizer'],
  [/\brequire\s*\(/, 'require'],
  [/\bpm\.iterationData\b/, 'pm.iterationData'],
  [/\bpm\.vault\b/, 'pm.vault'],
];

export function unsupportedCalls(text: string): string[] {
  return UNSUPPORTED_CALLS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}

/** The Postman calls that steer a run (#335), found by name: obeyed in API and folder runs only. */
const RUN_CONTROL_CALLS: readonly [RegExp, string][] = [
  [/\bpm\.execution\.setNextRequest\b/, 'pm.execution.setNextRequest'],
  [/\bpostman\.setNextRequest\b/, 'postman.setNextRequest'],
  [/\bpm\.execution\.skipRequest\b/, 'pm.execution.skipRequest'],
];

export function runControlCalls(text: string): string[] {
  return RUN_CONTROL_CALLS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}
