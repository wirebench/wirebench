/**
 * Format detection for API definition imports: WSDL, OpenAPI / Swagger, Postman Collections, HAR captures,
 * AsyncAPI, Protocol Buffers (`.proto`) and legacy single-XML SOAP projects.
 *
 * Inspects document text, file names, or URLs to classify definition formats before or during import.
 */

import { parse as parseYamlDocument } from 'yaml';
import { isHar } from './rest/har/parse.js';
import { isPostmanCollection, isPostmanVariables } from './rest/postman/parse.js';
import { looksLikeLegacyProject } from './soap/legacy-project/format.js';

export type ImportFormatKind =
  | 'openapi'
  | 'asyncapi'
  | 'postman'
  | 'postman-environment'
  | 'postman-globals'
  | 'har'
  | 'http-file'
  | 'http-env'
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
    if (target.includes('postman_collection') || target.endsWith('.postman.json')) {
      return { kind: 'postman', label: 'Postman Collection', confidence: 'probable' };
    }
    if (target.includes('asyncapi')) {
      return { kind: 'asyncapi', label: 'AsyncAPI', confidence: 'probable' };
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
