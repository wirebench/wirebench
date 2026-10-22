/**
 * The errors a secret source raises (secret sources spec D5). `details` carry the name and kind (and a
 * field) only: never a locator, never a value.
 */

import { WirebenchError } from '../../errors.js';

export type SecretSourceErrorCode =
  | 'secret-source-untrusted'
  | 'secret-source-unavailable'
  | 'secret-source-unsupported'
  | 'secret-source-failed'
  | 'secret-source-invalid';

/** Where each tool's install instructions live, for `secret-source-unavailable`. */
export const TOOL_INSTALL_PAGES: Readonly<Record<string, string>> = {
  vault: 'https://developer.hashicorp.com/vault/install',
  aws: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
  gcloud: 'https://cloud.google.com/sdk/docs/install',
  az: 'https://learn.microsoft.com/cli/azure/install-azure-cli',
  op: 'https://developer.1password.com/docs/cli/get-started/',
  'secret-tool': 'https://wiki.gnome.org/Projects/Libsecret',
};

export function secretSourceError(
  code: SecretSourceErrorCode,
  name: string,
  kind: string,
  message: string,
  extra: { readonly field?: string } = {},
): WirebenchError {
  return new WirebenchError(code, message, { details: { name, kind, ...extra } });
}

/** The same error with the secret's name and its source's kind filled in, and the name leading the message. */
export function withSource(error: WirebenchError, name: string, kind: string): WirebenchError {
  return new WirebenchError(error.code, `Secret "${name}": ${error.message}`, {
    details: { ...(error.details ?? {}), name, kind },
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  });
}
