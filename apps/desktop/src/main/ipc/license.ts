/** `license.*` (licensing spec §3.8, §5.3): the License tab's calls, on the account's session. */
import { LICENSE_TEXT_PATTERN, licensePayloadSchema, WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler } from './register.js';

/**
 * The shared-schema parse before anything is sent (§3.8, plan ruling 14). Only the shape and the
 * payload are checked here; the signature is the server's to verify.
 */
export function checkLicenseText(input: string): string {
  const text = input.trim();
  const segment = text.split('.')[1] ?? '';
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    payload = undefined;
  }
  if (!LICENSE_TEXT_PATTERN.test(text) || !licensePayloadSchema.safeParse(payload).success) {
    throw new WirebenchError(
      'licensing-invalid',
      'This is not a Wirebench license, or part of it is missing. Paste the whole line again.',
    );
  }
  return text;
}

export interface LicenseChannelDeps {
  readonly client: Pick<ServerClient, 'getLicense' | 'installLicense' | 'removeLicense'>;
  readonly accounts: TokenSource;
}

export function registerLicenseChannels(deps: LicenseChannelDeps): void {
  const c = deps.client;
  registerHandler(channels.license.get, (r) => withToken(deps, r.url, (url, token) => c.getLicense(url, token)));
  // Async, so a refusal from checkLicenseText becomes the envelope's error rather than a sync throw.
  registerHandler(channels.license.install, async (r) => {
    const license = checkLicenseText(r.license);
    return withToken(deps, r.url, (url, token) => c.installLicense(url, token, license));
  });
  registerHandler(channels.license.remove, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.removeLicense(url, token);
      return { removed: true as const };
    }),
  );
}
