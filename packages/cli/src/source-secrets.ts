/**
 * The CLI's secrets: `WIREBENCH_SECRET_<NAME>` first, as always, then the workspace's shared secret
 * sources (secret sources spec D2, D8). The CLI never sees the desktop's `local.yaml`, so it has no local
 * overrides and no approval: trust comes from `--trust-secret-sources` or `--trust-secret-sources-hash`
 * (spec R7, amendment A2).
 */

import {
  effectiveSecretSources,
  secretSourcesHash,
  sourceGetter,
  type SecretNeed,
  type SecretSourcesTrust,
  type SourceCache,
  type Workspace,
} from '@wirebench/engine';
import { createEnvSecrets, type EnvSecrets } from './env-secrets.js';
import { UsageError } from './usage-error.js';

export interface CliSecretSourcesOptions {
  readonly enabled: boolean;
  readonly trust: SecretSourcesTrust;
}

export const DEFAULT_CLI_SECRET_SOURCES: CliSecretSourcesOptions = {
  enabled: true,
  trust: { mode: 'approved', hash: undefined },
};

export function cliSecretSourcesOptions(values: {
  readonly noSources?: boolean;
  readonly trustAny?: boolean;
  readonly trustHash?: string;
}): CliSecretSourcesOptions {
  if (values.trustAny === true && values.trustHash !== undefined) {
    throw new UsageError('--trust-secret-sources and --trust-secret-sources-hash cannot be combined');
  }
  if (values.trustHash !== undefined && !/^[0-9a-f]{64}$/.test(values.trustHash)) {
    throw new UsageError(
      '--trust-secret-sources-hash takes the 64-character hash that `wirebench secrets list` prints',
    );
  }
  const trust: SecretSourcesTrust =
    values.trustAny === true
      ? { mode: 'any' }
      : values.trustHash !== undefined
        ? { mode: 'hash', hash: values.trustHash }
        : DEFAULT_CLI_SECRET_SOURCES.trust;
  return { enabled: values.noSources !== true, trust };
}

/** The three flags, read from a `parseArgs` result. */
export function secretSourcesOptionsFrom(values: Readonly<Record<string, unknown>>): CliSecretSourcesOptions {
  const hash = values['trust-secret-sources-hash'];
  return cliSecretSourcesOptions({
    noSources: values['no-secret-sources'] === true,
    trustAny: values['trust-secret-sources'] === true,
    ...(typeof hash === 'string' ? { trustHash: hash } : {}),
  });
}

function untrustedHint(hash: string | undefined): string {
  return `Pass --trust-secret-sources-hash ${hash ?? ''} to trust exactly this mapping (wirebench secrets list prints it), or --trust-secret-sources.`;
}

export function cliSecrets(
  needs: readonly SecretNeed[],
  env: NodeJS.ProcessEnv,
  workspace: Workspace | undefined,
  options: CliSecretSourcesOptions,
  cache: SourceCache,
  mask?: (text: string) => string,
): EnvSecrets {
  const fromEnv = createEnvSecrets(needs, env);
  const shared = workspace?.secretSources;
  if (!options.enabled || shared === undefined || Object.keys(shared).length === 0) {
    return fromEnv;
  }
  const handedOut = new Set<string>();
  const fromSources = sourceGetter(() => Promise.resolve(undefined), {
    sources: effectiveSecretSources(shared, undefined),
    sharedHash: secretSourcesHash(shared),
    trust: options.trust,
    cache,
    cacheMs: Number.POSITIVE_INFINITY,
    onValue: (value) => handedOut.add(value),
    env,
    untrustedHint,
    ...(mask !== undefined ? { mask } : {}),
  });
  return {
    getSecret: async (ref) => (await fromEnv.getSecret(ref)) ?? fromSources(ref),
    values: () => [...fromEnv.values(), ...handedOut],
  };
}
