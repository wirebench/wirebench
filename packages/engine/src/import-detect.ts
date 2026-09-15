/**
 * Format detection for API definition imports: WSDL, OpenAPI / Swagger, and Postman Collections.
 *
 * Inspects document text, file names, or URLs to classify definition formats before or during import.
 */

import { parse as parseYamlDocument } from 'yaml';
import { isPostmanCollection } from './rest/postman/parse.js';

export type ImportFormatKind = 'openapi' | 'postman' | 'wsdl' | 'unknown';

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
const WSDL_NS_REGEX = /xmlns(?::[a-zA-Z0-9_-]+)?=["']http:\/\/(?:schemas\.xmlsoap\.org\/wsdl|www\.w3\.org\/ns\/wsdl)/i;

/**
 * Detects the API definition format from text content, filename, or URL.
 */
export function detectImportFormat(input: ImportDetectInput): DetectedImportFormat {
  const text = input.text?.trim();

  if (text !== undefined && text.length > 0) {
    // 1. Check for WSDL (XML)
    if (text.startsWith('<') || text.startsWith('<?xml')) {
      if (WSDL_XML_REGEX.test(text) || WSDL_NS_REGEX.test(text)) {
        return { kind: 'wsdl', label: 'WSDL / SOAP', confidence: 'definite' };
      }
    }

    // 2. Check for JSON formats (Postman, OpenAPI/Swagger JSON)
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        const json = JSON.parse(text) as unknown;
        if (typeof json === 'object' && json !== null) {
          if (isPostmanCollection(json)) {
            const schema = (json as Record<string, any>).info?.schema;
            const isV21 = typeof schema === 'string' && schema.includes('v2.1');
            return {
              kind: 'postman',
              label: isV21 ? 'Postman Collection v2.1' : 'Postman Collection',
              confidence: 'definite',
            };
          }

          const record = json as Record<string, unknown>;
          if (typeof record['openapi'] === 'string') {
            return {
              kind: 'openapi',
              label: `OpenAPI ${record['openapi']}`,
              confidence: 'definite',
            };
          }
          if (typeof record['swagger'] === 'string') {
            return {
              kind: 'openapi',
              label: `Swagger ${record['swagger']}`,
              confidence: 'definite',
            };
          }
          if (typeof record['swaggerVersion'] === 'string') {
            return {
              kind: 'openapi',
              label: `Swagger ${record['swaggerVersion']}`,
              confidence: 'definite',
            };
          }
        }
      } catch {
        // Fall through to regex-based detection
      }
    }

    // 3. Check for YAML / general text OpenAPI or Swagger
    try {
      const parsed = parseYamlDocument(text);
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        if (typeof record['openapi'] === 'string') {
          return {
            kind: 'openapi',
            label: `OpenAPI ${record['openapi']}`,
            confidence: 'definite',
          };
        }
        if (typeof record['swagger'] === 'string') {
          return {
            kind: 'openapi',
            label: `Swagger ${record['swagger']}`,
            confidence: 'definite',
          };
        }
        if (typeof record['swaggerVersion'] === 'string') {
          return {
            kind: 'openapi',
            label: `Swagger ${record['swaggerVersion']}`,
            confidence: 'definite',
          };
        }
        if (isPostmanCollection(record)) {
          return {
            kind: 'postman',
            label: 'Postman Collection',
            confidence: 'definite',
          };
        }
      }
    } catch {
      // Fall through to pattern matching
    }

    // 4. Pattern matching fallback on text
    if (/^\s*openapi\s*:\s*['"]?3\.[012]/m.test(text)) {
      return { kind: 'openapi', label: 'OpenAPI 3.x', confidence: 'definite' };
    }
    if (/^\s*swagger(?:Version)?\s*:\s*['"]?[123]\./m.test(text)) {
      return { kind: 'openapi', label: 'Swagger', confidence: 'definite' };
    }
    if (text.includes('schema.getpostman.com/json/collection')) {
      return { kind: 'postman', label: 'Postman Collection', confidence: 'definite' };
    }
    if (WSDL_XML_REGEX.test(text) || WSDL_NS_REGEX.test(text)) {
      return { kind: 'wsdl', label: 'WSDL / SOAP', confidence: 'definite' };
    }
  }

  // Check by filename or URL
  const target = (input.filename ?? input.url ?? '').toLowerCase();
  if (target.length > 0) {
    if (target.endsWith('.wsdl') || target.includes('?wsdl') || target.includes('&wsdl') || target.endsWith('.wsdl.xml')) {
      return { kind: 'wsdl', label: 'WSDL / SOAP', confidence: 'probable' };
    }
    if (target.includes('postman_collection') || target.endsWith('.postman.json')) {
      return { kind: 'postman', label: 'Postman Collection', confidence: 'probable' };
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
