import { isWirebenchError, WirebenchError } from '@wirebench/engine';
import { ExitCode } from '../exit-codes.js';
import { UsageError } from '../usage-error.js';

/** An op's refusal or failure (spec §2.1): an engine-style code and a message a person or an agent can act on. */
export class OpsError extends WirebenchError {
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(code, message, details !== undefined ? { details } : undefined);
    this.name = 'OpsError';
  }
}

/** The codes that mean "the call was wrong or refused": exit 2 on the command line. Everything else is exit 3. */
export const USAGE_CODES: ReadonlySet<string> = new Set([
  'invalid-input',
  'project-not-found',
  'workspace-not-project',
  'file-not-found',
  'item-not-found',
  'item-ambiguous',
  'operation-not-found',
  'container-not-found',
  'environment-required',
  'environment-not-found',
  'environment-not-allowed',
  'history-entry-not-found',
  'history-no-response',
  'unsupported-kind',
  'unsupported-format',
  'write-not-allowed',
  'send-not-allowed',
  'definition-cache-missing',
  'query-failed',
]);

/** Any thrown value as an `OpsError`, keeping an engine error's code and details. */
export function toOpsError(error: unknown): OpsError {
  if (error instanceof OpsError) {
    return error;
  }
  if (isWirebenchError(error)) {
    return new OpsError(error.code, error.message, error.details);
  }
  if (error instanceof UsageError) {
    // A malformed proxy variable, read on the first fetch: the user's input, not a fault here.
    return new OpsError('invalid-input', error.message);
  }
  return new OpsError('internal-error', error instanceof Error ? error.message : String(error));
}

export function exitCodeForError(error: OpsError): ExitCode {
  return USAGE_CODES.has(error.code) ? ExitCode.Usage : ExitCode.RunError;
}

/** What an MCP client reads from a refused call. */
export function errorPayload(error: OpsError): { readonly code: string; readonly message: string } {
  return { code: error.code, message: error.message };
}
