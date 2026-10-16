/**
 * Format detection for API definition imports: WSDL, OpenAPI / Swagger, Postman Collections, HAR captures,
 * AsyncAPI, Protocol Buffers (`.proto`), legacy single-XML SOAP projects, and the exports of other
 * request clients (Insomnia, Bruno, Hoppscotch, Thunder Client).
 *
 * Inspects document text, file names, or URLs to classify definition formats before or during import.
 */

import { parse as parseYamlDocument } from 'yaml';
import { V3_DOCUMENT_KINDS } from './import/collection-v3/model.js';
import { isOpenCollection } from './import/opencollection/parse.js';
import { isHar } from './rest/har/parse.js';
import { isPostmanCollection, isPostmanVariables } from './rest/postman/parse.js';
import { looksLikeLegacyProject } from './soap/legacy-project/format.js';

export type ImportFormatKind =
  | 'openapi'
  | 'asyncapi'
  | 'postman'
  | 'postman-v3'
  | 'postman-environment'
  | 'postman-globals'
  | 'har'
  | 'http-file'
  | 'http-env'
  | 'opencollection'
  | 'insomnia'
  | 'insomnia-environment'
  | 'bruno'
  | 'hoppscotch'
  | 'hoppscotch-environment'
  | 'thunder-client'
  | 'thunder-client-environment'
  | 'wsdl'
  | 'proto'
  | 'legacy-soap-project'
  | 'unknown';

export interface DetectedImportFormat {
  readonly kind: ImportFormatKind;
  readonly label: string;
  readonly confidence: 'definite' | 'probable' | 'unknown';
}

export interface ImportDetectInput {
  readonly text?: string | undefined;
  readonly filename?: string | undefined;
  readonly url?: string | undefined;
}

const WSDL_XML_REGEX = /<(?:[a-zA-Z0-9_-]+:)?definitions[\s>]/i;
/** The statement a `.proto` opens with, once its leading comments are gone. */
const PROTO_SYNTAX_REGEX = /^(?:syntax\s*=\s*["']proto[23]["']|edition\s*=\s*["']\d{4}["'])\s*;/;

/**
 * `text` with the whitespace and `//` / `/* *\/` comments a `.proto` may open with removed, by a
 * linear scan: a regex with a repeated comment group backtracks badly on crafted input.
 */
export function stripLeadingProtoComments(text: string): string {
  let index = 0;
  for (;;) {
    while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      if (end === -1) return '';
      index = end + 1;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      if (end === -1) return '';
      index = end + 2;
      continue;
    }
    return text.slice(index);
  }
}
const PROTO_KEYWORD_REGEX =
  /^\s*(?:package\s+[\w.]+\s*;|import\s+"[^"]+\.proto"\s*;|service\s+\w+\s*\{|message\s+\w+\s*\{)/m;
/**
 * A `.http` request line with its method written out: the method, then a target that is an absolute
 * http(s) or ws(s) URL or starts with a `{{variable}}`, and nothing after it but an optional HTTP
 * version — so a sentence that happens to start with a method and a URL is not one. Anchored at both
 * ends, and each repeat is followed by a different character class, so a long line costs one pass.
 */
const HTTP_METHOD_LINE =
  /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT|WEBSOCKET|GRAPHQL|GRPC)[ \t]+(?:https?:\/\/|wss?:\/\/|\{\{)\S*(?:[ \t]+HTTP\/[\d.]+)?$/;
/** A request line with the method left out, which the parser reads as GET. */
const HTTP_BARE_URL_LINE = /^(?:https?|wss?):\/\/\S/;
/** A `@name = value` file variable, which may come before the first request. */
const HTTP_FILE_VARIABLE = /^@[A-Za-z_][\w.-]*[ \t]*=/;
const HTTP_ENV_FILES = ['http-client.env.json', 'http-client.private.env.json'];
const HTTP_ENV_FORMAT: DetectedImportFormat = {
  kind: 'http-env',
  label: 'HTTP client environment file',
  confidence: 'definite',
};

const POSTMAN_V3_FORMAT: DetectedImportFormat = {
  kind: 'postman-v3',
  label: 'Postman Collection v3 (folder)',
  confidence: 'definite',
};
/** The file names only a folder (v3) collection uses: its definitions and request files. */
const POSTMAN_V3_DEFINITION = /(?:^|[\\/])\.resources[\\/]definition\.ya?ml$/;
const POSTMAN_V3_REQUEST = /\.request\.ya?ml$/;

const WSDL_NS_REGEX = /xmlns(?::[a-zA-Z0-9_-]+)?=["']http:\/\/(?:schemas\.xmlsoap\.org\/wsdl|www\.w3\.org\/ns\/wsdl)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `text` reads as a `.http` file. Blank lines, `#` and `//` comments (`###` separators
 * among them) and `@name = value` variables may come first; the first line after them must be a
 * request line with its method written out. A file that opens with a bare URL counts only when a
 * request with a written method follows a `###` separator, as the parser would read it: a bare list
 * of URLs is not a request file. One pass over the lines.
 */
function looksLikeHttpFile(text: string): boolean {
  let openedBare = false;
  let separated = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('###')) {
      separated = openedBare;
      continue;
    }
    if (line === '' || line.startsWith('#') || line.startsWith('//')) continue;
    if (!openedBare) {
      if (HTTP_FILE_VARIABLE.test(line)) continue;
      if (HTTP_METHOD_LINE.test(line)) return true;
      if (!HTTP_BARE_URL_LINE.test(line)) return false;
      openedBare = true;
      continue;
    }
    if (separated && HTTP_METHOD_LINE.test(line)) return true;
  }
  return false;
}

/** `{ "<env>": { "<name>": scalar } }` with at least one environment. */
function looksLikeHttpEnv(parsed: Record<string, unknown>): boolean {
  const sets = Object.values(parsed);
  const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  return (
    sets.length > 0 &&
    sets.every((set) => isRecord(set) && Object.values(set).every(isScalar)) &&
    sets.some((set) => isRecord(set) && Object.keys(set).length > 0)
  );
}

/** Another request client's export, by its content (spec 2026-10-15 §3.3). */
const INSOMNIA_FORMAT: DetectedImportFormat = { kind: 'insomnia', label: 'Insomnia export', confidence: 'definite' };
const INSOMNIA_ENV_FORMAT: DetectedImportFormat = {
  kind: 'insomnia-environment',
  label: 'Insomnia environments',
  confidence: 'definite',
};
const BRUNO_FORMAT: DetectedImportFormat = { kind: 'bruno', label: 'Bruno collection', confidence: 'definite' };
const HOPPSCOTCH_FORMAT: DetectedImportFormat = {
  kind: 'hoppscotch',
  label: 'Hoppscotch collection',
  confidence: 'definite',
};
const HOPPSCOTCH_ENV_FORMAT: DetectedImportFormat = {
  kind: 'hoppscotch-environment',
  label: 'Hoppscotch environments',
  confidence: 'definite',
};
const THUNDER_FORMAT: DetectedImportFormat = {
  kind: 'thunder-client',
  label: 'Thunder Client collection',
  confidence: 'definite',
};
const THUNDER_ENV_FORMAT: DetectedImportFormat = {
  kind: 'thunder-client-environment',
  label: 'Thunder Client environment',
  confidence: 'definite',
};
const OPENCOLLECTION_FOLDER_FORMAT: DetectedImportFormat = {
  kind: 'opencollection',
  label: 'OpenCollection',
  confidence: 'definite',
};

const THUNDER_MARKER = 'Thunder Client';
/** How many collections and requests a Hoppscotch check looks at before it settles. */
const HOPPSCOTCH_LOOK = 1000;

/** The Thunder Client export kind `parsed` is, by its `clientName` (or older `client`) marker. */
function thunderKindOf(parsed: Record<string, unknown>): DetectedImportFormat | undefined {
  if ((parsed['clientName'] ?? parsed['client']) !== THUNDER_MARKER) return undefined;
  if (typeof parsed['environmentName'] === 'string' && Array.isArray(parsed['variables'])) return THUNDER_ENV_FORMAT;
  return THUNDER_FORMAT;
}

/**
 * Whether `items` are Hoppscotch collections: each has a `name`, `folders` and `requests`, and the
 * requests carry `endpoint` and `method` (REST), `url` and `query` (GraphQL) or `url` and `path`
 * (the oldest REST). `probable` when no request was found to tell.
 */
function hoppscotchCollections(items: readonly unknown[]): 'definite' | 'probable' | undefined {
  const queue: unknown[] = [...items];
  let sawRequest = false;
  for (let at = 0; at < queue.length && at < HOPPSCOTCH_LOOK; at += 1) {
    const collection = queue[at];
    if (!isRecord(collection)) return undefined;
    const folders = collection['folders'];
    const requests = collection['requests'];
    if (typeof collection['name'] !== 'string' || !Array.isArray(folders) || !Array.isArray(requests)) return undefined;
    if ('colId' in collection || 'colName' in collection) return undefined;
    for (const request of requests) {
      if (!isRecord(request)) return undefined;
      const rest = typeof request['endpoint'] === 'string' && typeof request['method'] === 'string';
      const graphql = typeof request['url'] === 'string' && typeof request['query'] === 'string';
      const legacy = typeof request['url'] === 'string' && typeof request['path'] === 'string';
      if (!rest && !graphql && !legacy) return undefined;
      sawRequest = true;
    }
    queue.push(...(folders as unknown[]));
  }
  return sawRequest ? 'definite' : 'probable';
}

/** Whether `items` are Hoppscotch environments: a `name` and `variables` whose entries carry `key`. */
function hoppscotchEnvironments(items: readonly unknown[]): 'definite' | 'probable' | undefined {
  let sawVariable = false;
  for (const environment of items.slice(0, HOPPSCOTCH_LOOK)) {
    if (!isRecord(environment) || typeof environment['name'] !== 'string') return undefined;
    const variables = environment['variables'];
    if (!Array.isArray(variables) || 'values' in environment) return undefined;
    for (const variable of variables) {
      if (!isRecord(variable) || typeof variable['key'] !== 'string') return undefined;
      sawVariable = true;
    }
  }
  return sawVariable ? 'definite' : 'probable';
}

/** The Hoppscotch kind of a parsed file: one object or an array of them. */
function hoppscotchKindOf(parsed: unknown): DetectedImportFormat | undefined {
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length === 0) return undefined;
  const collections = hoppscotchCollections(items);
  if (collections !== undefined) return { ...HOPPSCOTCH_FORMAT, confidence: collections };
  const environments = hoppscotchEnvironments(items);
  if (environments !== undefined) return { ...HOPPSCOTCH_ENV_FORMAT, confidence: environments };
  return undefined;
}

/** The Insomnia kind: a v1–v4 export by `__export_format`, a v5 file by its `type`. */
function insomniaKindOf(parsed: Record<string, unknown>): DetectedImportFormat | undefined {
  const format = parsed['__export_format'];
  if (typeof format === 'number' && Number.isInteger(format) && format >= 1 && format <= 4) {
    return { ...INSOMNIA_FORMAT, label: `Insomnia export (v${String(format)})` };
  }
  const type = parsed['type'];
  if (typeof type !== 'string' || !(type.endsWith('.insomnia.rest/5.0') || type.endsWith('.insomnia/5.0'))) {
    return undefined;
  }
  return type.startsWith('environment.') ? INSOMNIA_ENV_FORMAT : { ...INSOMNIA_FORMAT, label: 'Insomnia export (v5)' };
}

/** A Bruno JSON export: a string `version` and `name`, an `items` array, and none of OpenCollection's keys. */
function isBrunoExport(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed['version'] === 'string' &&
    parsed['version'] !== '' &&
    typeof parsed['name'] === 'string' &&
    Array.isArray(parsed['items']) &&
    !('info' in parsed) &&
    !('opencollection' in parsed)
  );
}

/** Another request client's export, from its parsed content; checked before the Postman rules. */
function detectClientExport(parsed: unknown): DetectedImportFormat | undefined {
  if (isRecord(parsed)) {
    const thunder = thunderKindOf(parsed);
    if (thunder !== undefined) return thunder;
  }
  const hoppscotch = hoppscotchKindOf(parsed);
  if (hoppscotch !== undefined) return hoppscotch;
  if (!isRecord(parsed)) return undefined;
  const insomnia = insomniaKindOf(parsed);
  if (insomnia !== undefined) return insomnia;
  return isBrunoExport(parsed) ? BRUNO_FORMAT : undefined;
}

/**
 * A picked folder's format from its direct children's names, a folder's with a trailing `/`. An
 * `opencollection.yml` beats a `bruno.json` beside it; Thunder Client's own files name it. A
 * `thunder-tests` folder holding only `collections/` and `environments/` looks like a folder
 * collection's workspace here: the host, which can look inside, settles that.
 */
export function detectImportFolder(children: readonly string[]): DetectedImportFormat {
  const names = new Set(children.map((child) => child.toLowerCase()));
  if (names.has('opencollection.yml') || names.has('opencollection.yaml')) return OPENCOLLECTION_FOLDER_FORMAT;
  if (names.has('bruno.json')) return BRUNO_FORMAT;
  if (
    names.has('thunderclient.json') ||
    names.has('thundercollection.json') ||
    names.has('thunderenvironment.json') ||
    names.has('thunderactivity.json')
  ) {
    return THUNDER_FORMAT;
  }
  if (names.has('.resources/') || children.some((child) => POSTMAN_V3_REQUEST.test(child))) return POSTMAN_V3_FORMAT;
  return { ...POSTMAN_V3_FORMAT, confidence: 'probable' };
}

/** The format `text` shows by its content, or `undefined` when it shows none. */
function detectFromText(text: string): DetectedImportFormat | undefined {
  // 0. A .proto file: a syntax statement, or the keywords nothing else opens with
  const protoHead = stripLeadingProtoComments(text);
  if (PROTO_SYNTAX_REGEX.test(protoHead)) {
    const edition = protoHead.startsWith('edition')
      ? 'editions'
      : /^syntax\s*=\s*["']proto2/.test(protoHead)
        ? 'proto2'
        : 'proto3';
    return { kind: 'proto', label: `Protocol Buffers (${edition})`, confidence: 'definite' };
  }
  if (PROTO_KEYWORD_REGEX.test(text) && !text.startsWith('<') && !text.startsWith('{')) {
    return { kind: 'proto', label: 'Protocol Buffers', confidence: 'probable' };
  }

  // 1. A legacy SOAP project, before WSDL: it carries its interfaces' WSDLs inside it
  if (text.startsWith('<') && looksLikeLegacyProject(text)) {
    return { kind: 'legacy-soap-project', label: 'Legacy SOAP project', confidence: 'definite' };
  }

  // 2. Check for WSDL (XML)
  if (text.startsWith('<') || text.startsWith('<?xml')) {
    if (WSDL_XML_REGEX.test(text) || WSDL_NS_REGEX.test(text)) {
      return { kind: 'wsdl', label: 'WSDL / SOAP', confidence: 'definite' };
    }
  }

  // 3. Try JSON or YAML parsing once (avoiding duplicate parsing work)
  let parsed: unknown;
  let didParse = false;
  let parsedAsJson = false;

  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      parsed = JSON.parse(text);
      didParse = true;
      parsedAsJson = true;
    } catch {
      // Fall through to YAML parse or regex
    }
  }

  if (!didParse) {
    try {
      parsed = parseYamlDocument(text);
      didParse = true;
    } catch {
      // Fall through to pattern matching
    }
  }

  if (didParse) {
    const client = detectClientExport(parsed);
    if (client !== undefined) return client;
  }

  if (didParse && isRecord(parsed)) {
    if (isHar(parsed)) {
      const version = String((parsed['log'] as Record<string, unknown>)['version']);
      return { kind: 'har', label: `HAR ${version}`, confidence: 'definite' };
    }

    const variables = isPostmanVariables(parsed);
    if (variables !== undefined) {
      const scopeKnown = typeof parsed['_postman_variable_scope'] === 'string';
      return variables === 'globals'
        ? { kind: 'postman-globals', label: 'Postman globals', confidence: 'definite' }
        : {
            kind: 'postman-environment',
            label: 'Postman environment',
            confidence: scopeKnown ? 'definite' : 'probable',
          };
    }

    if (isPostmanCollection(parsed)) {
      const info = isRecord(parsed['info']) ? parsed['info'] : undefined;
      const schema = typeof info?.['schema'] === 'string' ? info['schema'] : undefined;
      const isV21 = schema?.includes('v2.1') ?? false;
      return {
        kind: 'postman',
        label: isV21 ? 'Postman Collection v2.1' : 'Postman Collection',
        confidence: 'definite',
      };
    }

    // A file of a folder (v3) collection: a definition, request, example or message, by its `$kind`
    if (typeof parsed['$kind'] === 'string' && V3_DOCUMENT_KINDS.has(parsed['$kind'])) {
      return POSTMAN_V3_FORMAT;
    }

    if (isOpenCollection(parsed)) {
      return {
        kind: 'opencollection',
        label: `OpenCollection ${String(parsed['opencollection'])}`,
        confidence: 'definite',
      };
    }

    if (typeof parsed['asyncapi'] === 'string') {
      return { kind: 'asyncapi', label: `AsyncAPI ${parsed['asyncapi']}`, confidence: 'definite' };
    }
    if (typeof parsed['openapi'] === 'string') {
      return {
        kind: 'openapi',
        label: `OpenAPI ${parsed['openapi']}`,
        confidence: 'definite',
      };
    }
    if (typeof parsed['swagger'] === 'string') {
      return {
        kind: 'openapi',
        label: `Swagger ${parsed['swagger']}`,
        confidence: 'definite',
      };
    }
    if (typeof parsed['swaggerVersion'] === 'string') {
      return {
        kind: 'openapi',
        label: `Swagger ${parsed['swaggerVersion']}`,
        confidence: 'definite',
      };
    }

    // Last of the JSON checks: any record of scalar records could be an environment file
    if (parsedAsJson && looksLikeHttpEnv(parsed)) return { ...HTTP_ENV_FORMAT, confidence: 'probable' };
  }

  // 4. Pattern matching fallback on raw text
  if (looksLikeHttpFile(text)) {
    return { kind: 'http-file', label: '.http file', confidence: 'probable' };
  }
  if (/^asyncapi\s*:\s*['"]?[23]\./m.test(text)) {
    return { kind: 'asyncapi', label: 'AsyncAPI', confidence: 'probable' };
  }
  if (/^\s*openapi\s*:\s*['"]?3\.[012]/m.test(text)) {
    return { kind: 'openapi', label: 'OpenAPI 3.x', confidence: 'probable' };
  }
  if (/^\s*swagger(?:Version)?\s*:\s*['"]?[123]\./m.test(text)) {
    return { kind: 'openapi', label: 'Swagger', confidence: 'probable' };
  }
  if (text.includes('schema.getpostman.com/json/collection')) {
    return { kind: 'postman', label: 'Postman Collection', confidence: 'probable' };
  }
  if (WSDL_XML_REGEX.test(text) || WSDL_NS_REGEX.test(text)) {
    return { kind: 'wsdl', label: 'WSDL / SOAP', confidence: 'definite' };
  }
  return undefined;
}

/** The formats a file name settles on its own: a `.http` file and its environment files. */
function definiteByName(target: string): DetectedImportFormat | undefined {
  if (HTTP_ENV_FILES.some((name) => target === name || target.endsWith(`/${name}`) || target.endsWith(`\\${name}`))) {
    return HTTP_ENV_FORMAT;
  }
  if (target.endsWith('.http') || target.endsWith('.rest')) {
    return { kind: 'http-file', label: '.http file', confidence: 'definite' };
  }
  return undefined;
}

/**
 * Detects the API definition format from text content, filename, or URL. What the content shows
 * comes first, except that a file name settling the format (`.http`, `.rest`, an HTTP client
 * environment file) wins over content that only probably shows another one.
 */
export function detectImportFormat(input: ImportDetectInput): DetectedImportFormat {
  const text = input.text?.trim();
  // Check by filename or URL (treating empty string as absent)
  const candidate =
    input.filename !== undefined && input.filename.trim().length > 0
      ? input.filename.trim()
      : input.url !== undefined && input.url.trim().length > 0
        ? input.url.trim()
        : undefined;
  const byName = candidate === undefined ? undefined : definiteByName(candidate.toLowerCase());

  if (text !== undefined && text.length > 0) {
    const fromText = detectFromText(text);
    if (fromText !== undefined && (fromText.confidence === 'definite' || byName === undefined)) return fromText;
  }
  if (byName !== undefined) return byName;

  if (candidate !== undefined) {
    const target = candidate.toLowerCase();
    if (target.endsWith('.proto')) {
      return { kind: 'proto', label: 'Protocol Buffers', confidence: 'probable' };
    }
    if (
      target.endsWith('.wsdl') ||
      target.includes('?wsdl') ||
      target.includes('&wsdl') ||
      target.endsWith('.wsdl.xml')
    ) {
      return { kind: 'wsdl', label: 'WSDL / SOAP', confidence: 'probable' };
    }
    if (target.endsWith('.har')) return { kind: 'har', label: 'HAR', confidence: 'probable' };
    if (target.endsWith('.postman_environment.json')) {
      return { kind: 'postman-environment', label: 'Postman environment', confidence: 'probable' };
    }
    if (target.endsWith('.postman_globals.json')) {
      return { kind: 'postman-globals', label: 'Postman globals', confidence: 'probable' };
    }
    const base = target.split(/[\\/]/).at(-1) ?? target;
    if (base === 'bruno.json') return { ...BRUNO_FORMAT, confidence: 'probable' };
    if (base.startsWith('insomnia_') || base.includes('.insomnia.')) {
      return { ...INSOMNIA_FORMAT, confidence: 'probable' };
    }
    if (base.startsWith('hoppscotch-') && base.endsWith('.json')) {
      return base.includes('environment')
        ? { ...HOPPSCOTCH_ENV_FORMAT, confidence: 'probable' }
        : { ...HOPPSCOTCH_FORMAT, confidence: 'probable' };
    }
    if (base.startsWith('thunder-environment_')) return { ...THUNDER_ENV_FORMAT, confidence: 'probable' };
    if (base.startsWith('thunder-collection_')) return { ...THUNDER_FORMAT, confidence: 'probable' };
    if (target.includes('postman_collection') || target.endsWith('.postman.json')) {
      return { kind: 'postman', label: 'Postman Collection', confidence: 'probable' };
    }
    if (target.includes('asyncapi')) {
      return { kind: 'asyncapi', label: 'AsyncAPI', confidence: 'probable' };
    }
    if (POSTMAN_V3_DEFINITION.test(target) || POSTMAN_V3_REQUEST.test(target)) {
      return { ...POSTMAN_V3_FORMAT, confidence: 'probable' };
    }
    if (/(^|[\\/])opencollection\.ya?ml$/.test(target)) {
      return { kind: 'opencollection', label: 'OpenCollection', confidence: 'probable' };
    }
    if (
      target.includes('openapi') ||
      target.includes('swagger') ||
      target.endsWith('.yaml') ||
      target.endsWith('.yml')
    ) {
      return { kind: 'openapi', label: 'OpenAPI / Swagger', confidence: 'probable' };
    }
  }

  return { kind: 'unknown', label: 'Auto-detect', confidence: 'unknown' };
}
