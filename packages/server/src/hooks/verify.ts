/**
 * §3.3 step 1: a capture's verdict, from the catch URL's scheme and its opened secret, over the full
 * body before truncation. Never throws: a secret that will not open is `failed: key-error`, logged
 * without the secret; with no scheme there is nothing to check (`null`).
 */
import { verifyWebhook } from '@wirebench/engine';
import type { SignatureVerdict } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { HooksEnv } from './env.js';
import type { PublicCatchUrl } from './repo.js';
import { open } from './secret-box.js';
import type { HooksSettings } from './settings.js';

const KEY_ERROR: SignatureVerdict = { verdict: 'failed', reason: 'key-error' };

export function verifyCapture(
  env: Pick<HooksEnv, 'now'> & { readonly settings: Pick<HooksSettings, 'secretKey'> },
  hook: PublicCatchUrl,
  headers: readonly (readonly [string, string])[],
  body: Buffer,
  log: Pick<FastifyBaseLogger, 'error'>,
): SignatureVerdict | null {
  const signature = hook.signature;
  if (signature === undefined) return null;
  const key = env.settings.secretKey;
  if (key === undefined || signature.scheme === undefined) return KEY_ERROR;
  let secret: string;
  try {
    secret = open(key, signature.sealedSecret);
  } catch (error) {
    log.error(
      { hookId: hook.id, reason: error instanceof Error ? error.message : String(error) },
      'could not open a catch URL signature secret',
    );
    return KEY_ERROR;
  }
  return verifyWebhook(signature.scheme, secret, headers, body, { now: env.now() });
}
