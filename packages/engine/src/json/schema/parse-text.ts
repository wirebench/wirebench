/**
 * Reading the text of a description, JSON or YAML, into a value.
 *
 * In `json/schema/` because the OpenAPI and the AsyncAPI imports both start here, and no protocol
 * folder imports another (protocol modules spec §7.2). `rest/openapi/parse.ts` re-exports
 * {@link parseDocumentText}.
 */

import { parse as parseYamlDocument } from 'yaml';
import { OpenApiError } from '../../errors.js';

/**
 * Parses text as JSON when it looks like JSON, and as YAML otherwise.
 *
 * JSON is a subset of YAML, so one parser would do — but a JSON document with a syntax error gets a
 * far better message from `JSON.parse`, and that message is what the user has to act on.
 *
 * @throws OpenApiError `openapi-malformed` when the text parses as neither.
 */
export function parseDocumentText(text: string, where = 'the document'): unknown {
  const trimmed = text.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      throw new OpenApiError('openapi-malformed', `${where} is not valid JSON: ${messageOf(error)}`, { cause: error });
    }
  }
  try {
    return parseYamlDocument(trimmed);
  } catch (error) {
    throw new OpenApiError('openapi-malformed', `${where} is not valid YAML: ${messageOf(error)}`, { cause: error });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
