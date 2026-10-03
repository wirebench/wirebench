/**
 * The server's configuration: environment variables in, one validated `ServerConfig` out. The
 * variable table below is the single source for `wirebench-server config check`, for
 * `scripts/docs-server-config.ts` (the README's table) and for the zod schema, so the three can
 * never disagree. Values are never echoed: a problem names the variable and the rule it broke.
 */
import { isIP } from 'node:net';
import { isAbsolute, resolve } from 'node:path';
import { isCanonicalBase64 } from '@wirebench/engine';
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

/** An AES-256 key: 32 bytes, base64-encoded (webhook-signatures §3.1). */
const keyText = z
  .string()
  .refine(
    (value) => isCanonicalBase64(value) && Buffer.from(value, 'base64').length === 32,
    'must be 32 bytes, base64-encoded',
  );

/** `localhost`, `127.0.0.0/8` or `::1`: where a plain-http collector may listen (issue #209). */
export function isLoopback(hostname: string): boolean {
  const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (host.toLowerCase() === 'localhost') return true;
  if (isIP(host) === 4) return host.startsWith('127.');
  return isIP(host) === 6 && host === '::1';
}

/** The schemes an audit forward URL may use; `http:` only on a loopback host. */
export const AUDIT_FORWARD_SCHEMES = ['syslog+tcp:', 'syslog+tls:', 'https:', 'http:'] as const;

/**
 * Where audit events are forwarded: `syslog+tcp://host:port`, `syslog+tls://host:port`, `https://…`,
 * or `http://…` on a loopback host. The messages never quote the URL.
 */
const auditForwardUrlText = z.string().superRefine((value, ctx) => {
  const fail = (message: string) => {
    ctx.addIssue({ code: 'custom', message });
  };
  if (!URL.canParse(value)) return fail('must be a URL');
  const url = new URL(value);
  if (!(AUDIT_FORWARD_SCHEMES as readonly string[]).includes(url.protocol))
    return fail('must be syslog+tcp://host:port, syslog+tls://host:port or https://…');
  if (url.hostname === '') return fail('must name a host');
  if (url.username !== '' || url.password !== '')
    return fail('must not carry credentials; use WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN for https://');
  if (url.protocol === 'http:' && !isLoopback(url.hostname))
    return fail('must be https://; http:// is accepted only for localhost, 127.0.0.0/8 or ::1');
  if (url.protocol.startsWith('syslog') && url.port === '') return fail('a syslog URL must name a port');
  return undefined;
});

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
  hooksEnabled: booleanText('true'),
  hooksBodyLimitMb: integerText(1, 32, '1'),
  hooksKeep: integerText(1, 10_000, '500'),
  hooksMaxAgeDays: integerText(1, 365, '7'),
  auditMaxAgeDays: integerText(30, 3650, '365'),
  hooksRatePerSecond: integerText(1, 1_000, '10'),
  hooksBurst: integerText(1, 10_000, '50'),
  hooksPerWorkspace: integerText(1, 1_000, '50'),
  hooksSecretKey: keyText.optional(),
  auditForwardUrl: auditForwardUrlText.optional(),
  auditForwardToken: z.string().min(1).optional(),
  auditForwardCaFile: z.string().min(1).optional(),
  // Counted in UTF-8 bytes, the form the HMAC uses.
  auditChainKey: z
    .string()
    .refine((value) => Buffer.byteLength(value, 'utf8') >= 32, 'must be at least 32 bytes')
    .optional(),
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
  {
    env: 'WIREBENCH_SERVER_HOOKS_ENABLED',
    key: 'hooksEnabled',
    required: false,
    defaultText: 'true',
    secret: false,
    description: 'Serve catch URLs: the public `/hooks/…` route and the webhook management API.',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB',
    key: 'hooksBodyLimitMb',
    required: false,
    defaultText: '1',
    secret: false,
    description:
      'How much of a caught request body is stored, in MiB (1–32). A longer body is cut and marked truncated.',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_KEEP',
    key: 'hooksKeep',
    required: false,
    defaultText: '500',
    secret: false,
    description: 'Captures kept per catch URL (1–10000); the oldest go first.',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS',
    key: 'hooksMaxAgeDays',
    required: false,
    defaultText: '7',
    secret: false,
    description: 'Captures older than this many days are deleted (1–365).',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND',
    key: 'hooksRatePerSecond',
    required: false,
    defaultText: '10',
    secret: false,
    description: 'Requests per second a catch URL accepts once its burst is spent (1–1000); past it, `429`.',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_BURST',
    key: 'hooksBurst',
    required: false,
    defaultText: '50',
    secret: false,
    description: 'Requests a catch URL accepts at once before the rate applies (1–10000).',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_PER_WORKSPACE',
    key: 'hooksPerWorkspace',
    required: false,
    defaultText: '50',
    secret: false,
    description: 'Catch URLs a workspace may hold (1–1000).',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_SECRET_KEY',
    key: 'hooksSecretKey',
    required: false,
    secret: true,
    description:
      'Encrypts catch URL signature secrets at rest: 32 random bytes, base64-encoded (`openssl rand -base64 32`). Unset, signature settings are refused.',
  },
  {
    env: 'WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS',
    key: 'auditMaxAgeDays',
    required: false,
    defaultText: '365',
    secret: false,
    description: 'Audit events older than this many days are deleted (30–3650).',
  },
  {
    env: 'WIREBENCH_SERVER_AUDIT_FORWARD_URL',
    key: 'auditForwardUrl',
    required: false,
    secret: false,
    description:
      'Forward every audit event (Enterprise): `syslog+tcp://host:port`, `syslog+tls://host:port` or `https://…` (`http://` only on a loopback host). Unset, nothing is forwarded.',
  },
  {
    env: 'WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN',
    key: 'auditForwardToken',
    required: false,
    secret: true,
    description: 'Sent as `Authorization: Bearer …` with each HTTPS batch. Refused with a syslog URL.',
  },
  {
    env: 'WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE',
    key: 'auditForwardCaFile',
    required: false,
    secret: false,
    description:
      'A PEM bundle added to the system roots for `syslog+tls` and `https` forwarding. Certificates are always verified.',
  },
  {
    env: 'WIREBENCH_SERVER_AUDIT_CHAIN_KEY',
    key: 'auditChainKey',
    required: false,
    secret: true,
    description:
      'Seals audit events into a keyed hash chain that `admin audit verify` checks: at least 32 bytes, kept outside the database and never changed. Unset, nothing is sealed.',
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
  // Judged on the parsed scheme, which URL lower-cases and trims, like the public URL above.
  const forwardScheme = config.auditForwardUrl === undefined ? undefined : new URL(config.auditForwardUrl).protocol;
  if (config.auditForwardToken !== undefined) {
    if (forwardScheme === undefined)
      problems.push({
        variable: 'WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN',
        message: 'is set but WIREBENCH_SERVER_AUDIT_FORWARD_URL is not; set the URL or unset the token',
      });
    else if (forwardScheme.startsWith('syslog'))
      problems.push({
        variable: 'WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN',
        message: 'is for https:// forwarding only; unset it with a syslog URL',
      });
  }
  if (config.auditForwardCaFile !== undefined) {
    if (forwardScheme === undefined)
      problems.push({
        variable: 'WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE',
        message: 'is set but WIREBENCH_SERVER_AUDIT_FORWARD_URL is not; set the URL or unset the CA file',
      });
    else if (forwardScheme === 'http:')
      problems.push({
        variable: 'WIREBENCH_SERVER_AUDIT_FORWARD_CA_FILE',
        message: 'is for syslog+tls:// and https:// forwarding only; unset it with an http:// URL',
      });
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
