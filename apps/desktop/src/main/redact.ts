/**
 * Redaction lives in the engine so the CLI runner's reports are masked by the same rules as the
 * app's HTTP log. This module stays as the desktop's import path for it.
 */
export {
  REDACTED_MARKER,
  SECRET_BODY_KEYS,
  containsRedaction,
  redactHeaderPairs,
  redactHeaders,
  redactRawHttp,
  redactResponseAttachments,
  redactStructuredBody,
  redactUrl,
  redactXml,
} from '@wirebench/engine';
