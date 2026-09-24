/**
 * The server's configuration: environment variables in, one validated `ServerConfig` out. The
 * variable table below is the single source for `wirebench-server config check`, for
 * `scripts/docs-server-config.ts` (the README's table) and for the zod schema, so the three can
 * never disagree. Values are never echoed: a problem names the variable and the rule it broke.
 */
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
];

/** One thing wrong with the environment, phrased without the offending value. */
export interface ConfigProblem {
  readonly variable: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly code = 'server-config-invalid';
  constructor(readonly problems: readonly ConfigProblem[]) {
    super(problems.map((p) => `${p.variable}: ${p.message}`).join('\n'));
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
  if (config.publicUrl.startsWith('http://') && !config.allowInsecurePublicUrl) {
    throw new ConfigError([
      {
        variable: 'WIREBENCH_SERVER_PUBLIC_URL',
        message: 'must be https://; set WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL=true for development',
      },
    ]);
  }
  return { ...config, version };
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
