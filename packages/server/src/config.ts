/**
 * The server's configuration: environment variables in, one validated `ServerConfig` out. The
 * variable table below is the single source for `wirebench-server config check`, for
 * `scripts/docs-server-config.ts` (the README's table) and for the zod schema, so the three can
 * never disagree. Values are never echoed: a problem names the variable and the rule it broke.
 */
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

// zod 4's `.default()` short-circuits the rest of the chain: a default applied after `.transform`
// or `.pipe` is returned as-is, unparsed. Both helpers below take the default as a string and
// apply it before the transform, so a defaulted value comes out the far side transformed exactly
// like a supplied one.
const booleanText = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(defaultValue)
    .transform((value) => value === 'true' || value === '1');

const integerText = (min: number, max: number, defaultValue?: string) => {
  const text = z.string().regex(/^\d+$/, 'must be a whole number');
  return (defaultValue === undefined ? text : text.default(defaultValue))
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));
};

/** A public URL is an origin: scheme, host, optional port; nothing after it. */
const originText = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === '/' && url.search === '' && url.hash === '' && !value.endsWith('/');
  }, 'must be an origin such as https://wirebench.example.com, with no path, query or trailing slash');

const inputSchema = z.object({
  databaseUrl: z.string().min(1),
  publicUrl: originText,
  dataDir: z.string().min(1).default('/data'),
  host: z.string().min(1).default('0.0.0.0'),
  port: integerText(1, 65_535, '8080'),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  trustProxy: booleanText('false'),
  gitPath: z.string().min(1).optional(),
  bodyLimitMb: integerText(1, 1024, '32'),
  allowInsecurePublicUrl: booleanText('false'),
  localAuth: booleanText('true'),
  oidcIssuer: z.string().url().optional(),
  oidcClientId: z.string().min(1).optional(),
  oidcClientSecret: z.string().min(1).optional(),
  oidcScopes: z
    .string()
    .min(1)
    .default('openid email profile')
    .transform((value) => value.split(/\s+/).filter((scope) => scope.length > 0)),
  oidcDisplayName: z.string().min(1).max(60).default('OIDC'),
  tokenIdleDays: integerText(1, 3650, '30'),
  tokenMaxDays: integerText(1, 3650, '180'),
  invitationDays: integerText(1, 365, '7'),
});

type ConfigKey = keyof z.input<typeof inputSchema>;

export interface ServerConfig extends z.output<typeof inputSchema> {
  /** The package version, for `/api/v1/meta` and `--version`. */
  readonly version: string;
}

/** One documented environment variable. */
export interface ConfigVariable {
  readonly env: string;
  readonly key: ConfigKey;
  readonly required: boolean;
  /** Printed in the README as the default; absent when there is none. */
  readonly defaultText?: string;
  /** Never printed, never logged. */
  readonly secret: boolean;
  readonly description: string;
}

export const CONFIG_VARIABLES: readonly ConfigVariable[] = [
  {
    env: 'WIREBENCH_SERVER_DATABASE_URL',
    key: 'databaseUrl',
    required: true,
    secret: true,
    description: 'PostgreSQL connection string.',
  },
  {
    env: 'WIREBENCH_SERVER_PUBLIC_URL',
    key: 'publicUrl',
    required: true,
    secret: false,
    description: 'The `https://…` origin clients use; no path, query or trailing slash.',
  },
  {
    env: 'WIREBENCH_SERVER_DATA_DIR',
    key: 'dataDir',
    required: false,
    defaultText: '/data',
    secret: false,
    description: 'Repositories and temporary files.',
  },
  {
    env: 'WIREBENCH_SERVER_HOST',
    key: 'host',
    required: false,
    defaultText: '0.0.0.0',
    secret: false,
    description: 'Listen address.',
  },
  {
    env: 'WIREBENCH_SERVER_PORT',
    key: 'port',
    required: false,
    defaultText: '8080',
    secret: false,
    description: 'Listen port.',
  },
  {
    env: 'WIREBENCH_SERVER_LOG_LEVEL',
    key: 'logLevel',
    required: false,
    defaultText: 'info',
    secret: false,
    description: 'Log level: fatal, error, warn, info, debug or trace.',
  },
  {
    env: 'WIREBENCH_SERVER_TRUST_PROXY',
    key: 'trustProxy',
    required: false,
    defaultText: 'false',
    secret: false,
    description: 'Honour `X-Forwarded-*` headers and incoming request ids.',
  },
  {
    env: 'WIREBENCH_SERVER_GIT_PATH',
    key: 'gitPath',
    required: false,
    secret: false,
    description: 'Explicit git binary; otherwise `PATH` is searched.',
  },
  {
    env: 'WIREBENCH_SERVER_BODY_LIMIT_MB',
    key: 'bodyLimitMb',
    required: false,
    defaultText: '32',
    secret: false,
    description: 'Maximum request body in MiB.',
  },
  {
    env: 'WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL',
    key: 'allowInsecurePublicUrl',
    required: false,
    defaultText: 'false',
    secret: false,
    description: 'Permit an `http://` public URL (development only).',
  },
  {
    env: 'WIREBENCH_SERVER_LOCAL_AUTH',
    key: 'localAuth',
    required: false,
    defaultText: 'true',
    secret: false,
    description: 'Offer local accounts (email and password).',
  },
  {
    env: 'WIREBENCH_SERVER_OIDC_ISSUER',
    key: 'oidcIssuer',
    required: false,
    secret: false,
    description: 'OIDC issuer URL; setting it turns OIDC sign-in on. Discovery runs at start-up.',
  },
  {
    env: 'WIREBENCH_SERVER_OIDC_CLIENT_ID',
    key: 'oidcClientId',
    required: false,
    secret: false,
    description: 'Client id registered at the issuer. Required with the issuer.',
  },
  {
    env: 'WIREBENCH_SERVER_OIDC_CLIENT_SECRET',
    key: 'oidcClientSecret',
    required: false,
    secret: true,
    description: 'Client secret registered at the issuer. Required with the issuer.',
  },
  {
    env: 'WIREBENCH_SERVER_OIDC_SCOPES',
    key: 'oidcScopes',
    required: false,
    defaultText: 'openid email profile',
    secret: false,
    description: 'Scopes requested from the issuer, space-separated.',
  },
  {
    env: 'WIREBENCH_SERVER_OIDC_DISPLAY_NAME',
    key: 'oidcDisplayName',
    required: false,
    defaultText: 'OIDC',
    secret: false,
    description: 'The label of the *Continue with …* button in the app.',
  },
  {
    env: 'WIREBENCH_SERVER_TOKEN_IDLE_DAYS',
    key: 'tokenIdleDays',
    required: false,
    defaultText: '30',
    secret: false,
    description: 'A device token unused for this long expires.',
  },
  {
    env: 'WIREBENCH_SERVER_TOKEN_MAX_DAYS',
    key: 'tokenMaxDays',
    required: false,
    defaultText: '180',
    secret: false,
    description: 'A device token older than this expires whatever its use.',
  },
  {
    env: 'WIREBENCH_SERVER_INVITATION_DAYS',
    key: 'invitationDays',
    required: false,
    defaultText: '7',
    secret: false,
    description: 'How long an invitation or password-reset link stays valid.',
  },
];

/** One thing wrong with the environment, phrased without the offending value. */
export interface ConfigProblem {
  readonly variable: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly code = 'server-config-invalid';
  // A plain field rather than a constructor parameter property: `scripts/docs-server-config.ts`
  // loads this file straight from source, and Node's type stripping rejects parameter properties.
  readonly problems: readonly ConfigProblem[];
  constructor(problems: readonly ConfigProblem[]) {
    super(problems.map((p) => `${p.variable}: ${p.message}`).join('\n'));
    this.problems = problems;
    this.name = 'ConfigError';
  }
}

function inputFrom(env: NodeJS.ProcessEnv): Partial<Record<ConfigKey, string>> {
  const input: Partial<Record<ConfigKey, string>> = {};
  for (const variable of CONFIG_VARIABLES) {
    const value = env[variable.env];
    if (value !== undefined && value !== '') {
      input[variable.key] = value;
    }
  }
  return input;
}

function envOf(key: string): string {
  const found = CONFIG_VARIABLES.find((variable) => variable.key === key);
  /* c8 ignore next 3 -- every schema key has a table row; the test above enforces it */
  if (found === undefined) {
    throw new Error(`no environment variable documented for ${key}`);
  }
  return found.env;
}

/** Parses `env` into a config or throws a {@link ConfigError} naming every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv, version: string): ServerConfig {
  const input = inputFrom(env);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = String(issue.path[0]);
      return { variable: envOf(key), message: input[key as ConfigKey] === undefined ? 'is required' : issue.message };
    });
    throw new ConfigError(problems);
  }
  const config = parsed.data;
  // Judged on the parsed protocol, which URL lower-cases: a prefix test on the raw text let
  // `HTTP://…` and `ftp://…` through without the insecure flag.
  const publicUrl = new URL(config.publicUrl);
  const allowed = publicUrl.protocol === 'https:' || (publicUrl.protocol === 'http:' && config.allowInsecurePublicUrl);
  if (!allowed) {
    throw new ConfigError([
      {
        variable: 'WIREBENCH_SERVER_PUBLIC_URL',
        message: 'must be https://; set WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL=true for an http:// development URL',
      },
    ]);
  }
  // Cross-field rules zod cannot express per key: the two IdP credentials travel with the issuer,
  // an http:// issuer is a development-only choice like an http:// public URL, and a server with
  // no way to sign in at all is a misconfiguration, not a quiet server (identity spec §4.1).
  const problems: ConfigProblem[] = [];
  if (config.oidcIssuer !== undefined) {
    for (const [key, variable] of [
      ['oidcClientId', 'WIREBENCH_SERVER_OIDC_CLIENT_ID'],
      ['oidcClientSecret', 'WIREBENCH_SERVER_OIDC_CLIENT_SECRET'],
    ] as const) {
      if (config[key] === undefined)
        problems.push({ variable, message: 'is required when WIREBENCH_SERVER_OIDC_ISSUER is set' });
    }
    const issuer = new URL(config.oidcIssuer);
    if (!(issuer.protocol === 'https:' || (issuer.protocol === 'http:' && config.allowInsecurePublicUrl))) {
      problems.push({
        variable: 'WIREBENCH_SERVER_OIDC_ISSUER',
        message:
          'must be https://; set WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL=true for an http:// development issuer',
      });
    }
  }
  if (!config.localAuth && config.oidcIssuer === undefined) {
    problems.push({
      variable: 'WIREBENCH_SERVER_LOCAL_AUTH',
      message:
        'identity-no-method: at least one sign-in method must be on; set it to true or set WIREBENCH_SERVER_OIDC_ISSUER',
    });
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return {
    ...config,
    publicUrl: publicUrl.origin,
    // Absolute for every consumer: git reads a relative core.hooksPath from the worktree root, not
    // from the directory the server started in.
    dataDir: isAbsolute(config.dataDir) ? config.dataDir : resolve(config.dataDir),
    version,
  };
}

export type ConfigStatus = 'set' | 'defaulted' | 'missing' | 'invalid';

/** What `config check` prints: one row per variable, never a value. */
export function describeConfig(env: NodeJS.ProcessEnv): readonly { variable: string; status: ConfigStatus }[] {
  const input = inputFrom(env);
  return CONFIG_VARIABLES.map((variable) => {
    const raw = input[variable.key];
    if (raw === undefined) {
      return {
        variable: variable.env,
        status: variable.required || variable.defaultText === undefined ? 'missing' : 'defaulted',
      };
    }
    const field = inputSchema.shape[variable.key];
    return { variable: variable.env, status: field.safeParse(raw).success ? 'set' : 'invalid' };
  });
}
