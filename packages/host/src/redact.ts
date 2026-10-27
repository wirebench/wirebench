/**
 * Redaction lives in the engine so the CLI runner's reports are masked by the same rules as the
 * app's HTTP log. This module stays as the desktop's import path for the pure helpers; the one thing
 * the pattern rules cannot know, the secret *values* main itself handed to a send, is held per host
 * by the `Redactor` (`host/redactor.ts`), reached through `HostState.redactor`.
 */

export { REDACTED_MARKER, SECRET_BODY_KEYS, containsRedaction, redactResponseAttachments } from '@wirebench/engine';

/**
 * Whether a body is XML: its content type says so, or it names none and opens with `<`. For the
 * callers that mask every body with both passes and must pick the marker.
 */
export function isXmlBody(text: string, contentType: string | undefined): boolean {
  if (contentType === undefined || contentType === '') return text.trimStart().startsWith('<');
  return contentType.toLowerCase().includes('xml');
}
