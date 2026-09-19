import { envVariablesFor } from '@wirebench/engine';
import type { GetSecret, SecretNeed } from '@wirebench/engine';

export interface EnvSecrets {
  readonly getSecret: GetSecret;
  /** Every value handed out so far — what the masker must hide. */
  readonly values: () => string[];
}

/** Secrets for a pipeline: read from the process environment, never from a keychain or a file. */
export function createEnvSecrets(needs: readonly SecretNeed[], env: NodeJS.ProcessEnv): EnvSecrets {
  const byRef = new Map(needs.map((need) => [need.ref, need]));
  const handedOut = new Set<string>();
  const getSecret: GetSecret = (ref) => {
    for (const variable of envVariablesFor(byRef.get(ref) ?? { ref })) {
      const value = env[variable];
      if (value !== undefined && value.length > 0) {
        handedOut.add(value);
        return Promise.resolve(value);
      }
    }
    return Promise.resolve(undefined);
  };
  return { getSecret, values: () => [...handedOut] };
}
