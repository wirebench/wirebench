/**
 * Pure mapping from Postman Collection v2.0/v2.1 documents to Wirebench REST entities.
 *
 * Recursively maps Postman items into `RestFolder` and `RestRequestDef` trees, preserving author
 * order, variable substitutions (`${var}`), path parameter definitions, headers, query parameters,
 * request bodies (raw, urlencoded, formdata, binary), and auth configurations.
 */

import { PostmanError } from '../../errors.js';
import { ReportBuilder } from '../../import/report.js';
import type { ImportedVariableSet } from '../../import/variables.js';
import { VariableSetBuilder } from '../../import/variables.js';
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
  PostmanUrl,
  PostmanVariable,
} from './model.js';
import { MAX_POSTMAN_DEPTH, translatePostmanVariables } from './parse.js';
import type { RequestScripts } from '../../script/model.js';

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
      properties.add(
        { name: v.key, value: translatePostmanVariables(text, dynamic), enabled: v.disabled !== true, secret: false },
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

  let scriptedRequests = 0;
  const unsupported = new Map<string, Set<string>>();
  const collectionParts = scriptParts(collection.event, `the collection "${name}"`);

  const mapItems = (
    items: readonly PostmanItem[],
    depth: number,
    inherited: ScriptParts,
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
        const children = mapItems(
          item.item,
          depth + 1,
          joinParts(inherited, scriptParts(item.event, `the folder "${folderTrail.join(' / ')}"`)),
          folderTrail,
        );

        folders.push(
          createFolder(item.name, {
            id: newId(),
            slug,
            order: folders.length,
            ...(item.description !== undefined ? { description: item.description } : {}),
            ...(folderAuth !== undefined ? { auth: folderAuth } : {}),
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
        const parts = joinParts(inherited, scriptParts(item.event, 'the request'));
        const scripts = importedScripts(parts);
        if (scripts !== undefined) {
          scriptedRequests += 1;
          const calls = unsupportedCalls([...parts.pre, ...parts.post].map((part) => part.text).join('\n'));
          if (calls.length > 0) unsupported.set([...trail, item.name].join(' / '), new Set(calls));
        }
        requests.push(scripts !== undefined ? { ...mappedRequest, scripts } : mappedRequest);
      }
    }

    return { folders, requests };
  };

  const root = mapItems(collection.item, 1, collectionParts, []);
  if (scriptedRequests > 0) {
    warnings.push(
      `Scripts on ${String(scriptedRequests)} ${scriptedRequests === 1 ? 'request was' : 'requests were'} imported switched off: read them on each request's Scripts tab, then switch them on`,
    );
  }
  for (const [path, calls] of unsupported) {
    warnings.push(`The scripts of "${path}" call what Wirebench does not run: ${[...calls].sort().join(', ')}`);
  }
  if (dynamic.size > 0) {
    warnings.push(`Dynamic variables are kept as written and not expanded: ${[...dynamic].sort().join(', ')}`);
  }
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

  return { api, projectProperties: properties.build(), summary };
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
};

function hasCredentials(auth: PostmanAuth | undefined): boolean {
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

function mapPostmanAuth(
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
    case 'bearer':
      return { type: 'bearer' };
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
      if (!isAuthCode && grant !== 'client_credentials') {
        warnings?.push(`OAuth 2.0 grant "${grant}" is not supported; set to "none"`);
        return { type: 'none' };
      }
      const authUrl = asText(authUrlAttr?.value);
      const scopeText = asText(scopeAttr?.value);

      return {
        type: 'oauth2',
        grant: isAuthCode ? 'authorization-code' : 'client-credentials',
        tokenUrl: asText(tokenUrlAttr?.value) ?? '',
        ...(authUrl !== undefined ? { authorizationUrl: authUrl } : {}),
        clientId: asText(clientIdAttr?.value) ?? '',
        scopes: scopeText !== undefined ? scopeText.split(/[\s,]+/).filter(Boolean) : [],
        clientAuth: 'basic',
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
    default:
      if (type !== undefined) {
        warnings?.push(`Authentication type "${type}" is not supported; set to "none"`);
      }
      return { type: 'none' };
  }
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

/** One piece of a request's script, and where in the collection it came from. */
interface ScriptPart {
  readonly from: string;
  readonly text: string;
}

interface ScriptParts {
  readonly pre: readonly ScriptPart[];
  readonly post: readonly ScriptPart[];
}

function scriptParts(events: readonly PostmanEvent[] | undefined, from: string): ScriptParts {
  const pre: ScriptPart[] = [];
  const post: ScriptPart[] = [];
  for (const event of events ?? []) {
    (event.listen === 'prerequest' ? pre : post).push({ from, text: event.exec });
  }
  return { pre, post };
}

function joinParts(outer: ScriptParts, inner: ScriptParts): ScriptParts {
  return { pre: [...outer.pre, ...inner.pre], post: [...outer.post, ...inner.post] };
}

/** The parts concatenated in the order Postman runs them, each under a comment saying where it came from. */
function scriptText(parts: readonly ScriptPart[]): string {
  return parts.map((part) => `// --- From ${part.from} ---\n${part.text.replace(/\s+$/, '')}\n`).join('\n');
}

/**
 * A request's imported scripts: the collection's, then each enclosing folder's, then its own,
 * written against the Postman layer and switched off until someone has read them (#63).
 */
function importedScripts(parts: ScriptParts): RequestScripts | undefined {
  if (parts.pre.length === 0 && parts.post.length === 0) return undefined;
  return {
    ...(parts.pre.length > 0 ? { pre: { text: scriptText(parts.pre) } } : {}),
    ...(parts.post.length > 0 ? { post: { text: scriptText(parts.post) } } : {}),
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
  [/\bpm\.execution\.setNextRequest\b/, 'pm.execution.setNextRequest'],
  [/\bpostman\.setNextRequest\b/, 'postman.setNextRequest'],
  [/\brequire\s*\(/, 'require'],
  [/\bpm\.iterationData\b/, 'pm.iterationData'],
  [/\bpm\.vault\b/, 'pm.vault'],
];

export function unsupportedCalls(text: string): string[] {
  return UNSUPPORTED_CALLS.filter(([pattern]) => pattern.test(text)).map(([, name]) => name);
}
