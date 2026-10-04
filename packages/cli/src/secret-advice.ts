/**
 * What `wirebench run` and the ops say about secrets: the variable to set for one a run was not
 * given, and whether a text holds one a run resolved.
 */
import { envVariablesFor } from '@wirebench/engine';
import type { RequestResult, SecretNeed } from '@wirebench/engine';

/** The refusals that carry a `details.ref` naming a secret the run was not given. */
const EXPLAINED_CODES: ReadonlySet<string> = new Set(['secret-missing', 'webhook-signing-secret']);

/**
 * `Set A (or B) to run "path".` — the engine's wording is the app's advice, not a pipeline's.
 * Every missing secret reaches here as `secret-missing` with `details.ref`: an auth password, a
 * keystore password and a WS-Security password alike (`run/prepare.ts`'s `requiredSecret`, which
 * the WS-Security context's `secrets` also calls, and nothing on the way wraps it) — and a webhook
 * item's signing secret (`webhook-signing-secret`, webhook-signatures §5.2).
 */
export function explainMissingSecret(result: RequestResult, needs: readonly SecretNeed[]): RequestResult {
  const ref = EXPLAINED_CODES.has(result.error?.code ?? '') ? result.error?.details?.['ref'] : undefined;
  if (result.error === undefined || typeof ref !== 'string') {
    return result;
  }
  const [first, ...rest] = envVariablesFor(needs.find((need) => need.ref === ref) ?? { ref });
  const alternatives = rest.length > 0 ? ` (or ${rest.join(', ')})` : '';
  return {
    ...result,
    error: { ...result.error, message: `Set ${first ?? ''}${alternatives} to run "${result.path}".` },
  };
}

/**
 * Whether `value` contains one of `known`. Values shorter than the masker's floor are ignored for the
 * same reason the masker ignores them: that short, a match is more likely chance than a credential.
 */
export function knownSecretIn(value: string, known: Iterable<string>): boolean {
  for (const secret of known) {
    if (secret.length >= 4 && value.includes(secret)) {
      return true;
    }
  }
  return false;
}

/**
 * A `containsKnownSecret` that detects exactly what `masker` would mask: the secret itself and its
 * percent-, form-, XML- and JSON-escaped forms and `Basic <base64>` credentials. A text the masker
 * would change must not be written into a committed golden. `masker` is called afresh per check, so
 * it sees secrets and tokens added since the run began.
 */
export function maskerDetects(masker: () => (text: string) => string): (value: string) => boolean {
  return (value) => masker()(value) !== value;
}
