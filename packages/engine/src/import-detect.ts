/**
 * Format detection for API definition imports: WSDL, OpenAPI / Swagger, Postman Collections,
 * AsyncAPI, Protocol Buffers (`.proto`) and legacy single-XML SOAP projects.
 *
 * Inspects document text, file names, or URLs to classify definition formats before or during import.
 */

import { parse as parseYamlDocument } from 'yaml';
import { isPostmanCollection } from './rest/postman/parse.js';
import { looksLikeLegacyProject } from './soap/legacy-project/format.js';

export type ImportFormatKind =
  'openapi' | 'asyncapi' | 'postman' | 'wsdl' | 'proto' | 'legacy-soap-project' | 'unknown';

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
const WSDL_NS_REGEX = /xmlns(?::[a-zA-Z0-9_-]+)?=["']http:\/\/(?:schemas\.xmlsoap\.org\/wsdl|www\.w3\.org\/ns\/wsdl)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detects the API definition format from text content, filename, or URL.
 */
export function detectImportFormat(input: ImportDetectInput): DetectedImportFormat {
  const text = input.text?.trim();

  if (text !== undefined && text.length > 0) {
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

    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        parsed = JSON.parse(text);
        didParse = true;
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
    }

    // 4. Pattern matching fallback on raw text
    if (/^\s*asyncapi\s*:\s*['"]?[23]\./m.test(text)) {
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
  }

  // Check by filename or URL (treating empty string as absent)
  const candidate =
    input.filename !== undefined && input.filename.trim().length > 0
      ? input.filename.trim()
      : input.url !== undefined && input.url.trim().length > 0
        ? input.url.trim()
        : undefined;

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
