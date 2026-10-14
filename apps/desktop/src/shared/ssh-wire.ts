import { z } from 'zod';
import { SSH_IMPORT_FORMATS, SSH_MAX_PANES, SSH_OS_IDS } from './ssh-defaults.js';

/**
 * Wire shapes of the SSH area. A credential is its secret NAME only: never a `${secret:NAME}` token, never a
 * value, a private key or a passphrase. The renderer does not import `@wirebench/ssh`, so the model is
 * mirrored here with zod alone.
 */

export const sshProblemSchema = z.object({ code: z.string(), message: z.string(), path: z.string().optional() });

export const sshAuthWireSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('password'), secret: z.string() }),
  z.strictObject({
    kind: z.literal('key'),
    secret: z.string(),
    /** The secret holding the key's OpenSSH user certificate (#421); by convention `<secret>_cert`. */
    certificateSecret: z.string().optional(),
    passphraseSecret: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal('agent') }),
]);

export const sshSettingsWireSchema = z.strictObject({
  user: z.string().optional(),
  port: z.number().optional(),
  jump: z.string().optional(),
  auth: sshAuthWireSchema.optional(),
  keepAlive: z.number().optional(),
  connectTimeout: z.number().optional(),
  forwardAgent: z.boolean().optional(),
});

const forwardTypeWireSchema = z.enum(['local', 'remote', 'dynamic']);

/** A forwarding rule as written in hosts.yaml (it holds no credential), or its off form `{ id, enabled: false }`. */
export const forwardEntryWireSchema = z.union([
  z.strictObject({ id: z.string(), enabled: z.literal(false) }),
  z.strictObject({
    id: z.string(),
    type: forwardTypeWireSchema,
    port: z.number(),
    bind: z.string().optional(),
    target: z.string().optional(),
    autoStart: z.boolean().optional(),
    enabled: z.boolean().optional(),
  }),
]);

/** A variable as the form edits it: literal text, or the NAME of a secret (never a token, never a value). */
export const envVarWireSchema = z.union([
  z.strictObject({ name: z.string(), value: z.string() }),
  z.strictObject({ name: z.string(), secret: z.string() }),
]);

/** A level's own `terminal:` block in hosts.yaml; a field left out inherits. */
export const terminalEntryWireSchema = z.strictObject({
  scheme: z.string().optional(),
  fontSize: z.number().optional(),
});

export const hostEntryWireSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  tags: z.array(z.string()),
  protected: z.boolean().optional(),
  ssh: sshSettingsWireSchema,
  env: z.array(envVarWireSchema).optional(),
  terminal: terminalEntryWireSchema.optional(),
  forwards: z.array(forwardEntryWireSchema).optional(),
});

export interface HostEntryWire {
  id: string;
  name: string;
  address: string;
  tags: string[];
  protected?: boolean | undefined;
  ssh: SshSettingsWire;
  env?: EnvVarWire[] | undefined;
  terminal?: TerminalEntryWire | undefined;
  forwards?: ForwardEntryWire[] | undefined;
}
export interface GroupEntryWire {
  id: string;
  name: string;
  tags: string[];
  protected?: boolean | undefined;
  ssh: SshSettingsWire;
  env?: EnvVarWire[] | undefined;
  terminal?: TerminalEntryWire | undefined;
  forwards?: ForwardEntryWire[] | undefined;
  groups: GroupEntryWire[];
  hosts: HostEntryWire[];
}

export const groupEntryWireSchema: z.ZodType<GroupEntryWire> = z.lazy(() =>
  z.strictObject({
    id: z.string(),
    name: z.string(),
    tags: z.array(z.string()),
    protected: z.boolean().optional(),
    ssh: sshSettingsWireSchema,
    env: z.array(envVarWireSchema).optional(),
    terminal: terminalEntryWireSchema.optional(),
    forwards: z.array(forwardEntryWireSchema).optional(),
    groups: z.array(groupEntryWireSchema),
    hosts: z.array(hostEntryWireSchema),
  }),
);

export const hostsFileWireSchema = z.strictObject({
  version: z.literal(1),
  groups: z.array(groupEntryWireSchema),
  hosts: z.array(hostEntryWireSchema),
});

const prov = <T extends z.ZodType>(value: T) =>
  z.object({ value, from: z.union([z.literal('host'), z.literal('default'), z.object({ group: z.string() })]) });

const forwardFromWireSchema = z.union([z.literal('host'), z.object({ group: z.string() })]);

/** A rule after inheritance: defaults filled, where it came from, and which level switched it off. */
export const resolvedForwardWireSchema = z.object({
  rule: z.object({
    id: z.string(),
    type: forwardTypeWireSchema,
    port: z.number(),
    bind: z.string(),
    target: z.object({ host: z.string(), port: z.number() }).optional(),
    autoStart: z.boolean(),
  }),
  from: forwardFromWireSchema,
  enabled: z.boolean(),
  offBy: forwardFromWireSchema.optional(),
});

/** A variable after inheritance: text or a secret name, and the level it came from (nearest wins per name). */
export const resolvedEnvVarWireSchema = z.object({
  name: z.string(),
  value: z.string().optional(),
  secret: z.string().optional(),
  from: forwardFromWireSchema,
});

export const resolvedHostWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  tags: z.array(z.string()),
  path: z.array(z.string()),
  protected: prov(z.boolean()),
  ssh: z.object({
    user: prov(z.string().optional()),
    port: prov(z.number()),
    auth: prov(sshAuthWireSchema.optional()),
    jump: prov(z.string().optional()),
    keepAlive: prov(z.number()),
    connectTimeout: prov(z.number()),
    forwardAgent: prov(z.boolean()),
  }),
  incomplete: z.object({ field: z.enum(['user', 'auth']) }).optional(),
  forwards: z.array(resolvedForwardWireSchema),
  env: z.array(resolvedEnvVarWireSchema),
  /** Nearest level wins per field; `default` with no value means Preferences → Terminal applies. */
  terminal: z.object({ scheme: prov(z.string().optional()), fontSize: prov(z.number().optional()) }).optional(),
});

export const sshListHostsResponseSchema = z.object({
  file: hostsFileWireSchema,
  resolved: z.array(resolvedHostWireSchema),
  problems: z.array(sshProblemSchema),
});

export const sshSaveHostsRequestSchema = z.strictObject({ file: hostsFileWireSchema });

export type SshAuthWire = z.infer<typeof sshAuthWireSchema>;
export type SshSettingsWire = z.infer<typeof sshSettingsWireSchema>;
export type HostsFileWire = z.infer<typeof hostsFileWireSchema>;
export type ResolvedHostWire = z.infer<typeof resolvedHostWireSchema>;
export type ForwardEntryWire = z.infer<typeof forwardEntryWireSchema>;
export type EnvVarWire = z.infer<typeof envVarWireSchema>;
export type TerminalEntryWire = z.infer<typeof terminalEntryWireSchema>;
export type ResolvedEnvVarWire = z.infer<typeof resolvedEnvVarWireSchema>;
export type ResolvedForwardWire = z.infer<typeof resolvedForwardWireSchema>;
export type SshProblemWire = z.infer<typeof sshProblemSchema>;
export type SshListHostsResponse = z.infer<typeof sshListHostsResponseSchema>;

/** One name a host can reference: stored on this machine for the workspace, and/or mapped by a secret source. */
export const sshSecretNameSchema = z.object({ name: z.string(), local: z.boolean(), external: z.boolean() });
export const sshSecretNamesResponseSchema = z.object({ names: z.array(sshSecretNameSchema) });
/** A write-only value for a workspace-scoped name; the value never comes back. */
export const sshSetSecretRequestSchema = z.strictObject({ name: z.string(), value: z.string() });
export type SshSecretNameWire = z.infer<typeof sshSecretNameSchema>;

/** Opens a shell on a host; the answer is the session id the terminal addresses from then on. */
/** An id the renderer picks per connect, so its `ssh.connectProgress` events reach the screen showing it (#528). */
export const sshAttemptIdSchema = z.string().min(1).max(100);

export const sshConnectRequestSchema = z.strictObject({
  hostId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  attemptId: sshAttemptIdSchema.optional(),
});
/**
 * `agentForwarding` is left out when the host does not forward the agent. `on`: granted; `refused`: the
 * server said no; `no-agent`: no local agent runs. The last two open the shell without it.
 */
export const sshConnectResponseSchema = z.object({
  sessionId: z.string(),
  agentForwarding: z.enum(['on', 'refused', 'no-agent']).optional(),
});
/** `data` is base64: terminal bytes are not always valid UTF-8. */
export const sshWriteRequestSchema = z.strictObject({ sessionId: z.string(), data: z.string() });
/** One keystroke batch for every pane a broadcast reaches: at most the panes a tab holds. */
export const sshWriteManyRequestSchema = z.strictObject({
  sessionIds: z.array(z.string()).min(1).max(SSH_MAX_PANES),
  data: z.string(),
});
/** The ids written nothing: dead, unknown or another window's. */
export const sshWriteManyResponseSchema = z.object({ skipped: z.array(z.string()) });
export const sshResizeRequestSchema = z.strictObject({
  sessionId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const sshCloseRequestSchema = z.strictObject({ sessionId: z.string() });
/** Records a host key after the user's click; `replace` is a second, separate confirmation for a changed key. */
export const sshTrustRequestSchema = z.strictObject({
  host: z.string(),
  keyType: z.string(),
  fingerprint: z.string(),
  replace: z.boolean().default(false),
});

export const sshDataEventSchema = z.object({ sessionId: z.string(), data: z.string() });
export const sshExitEventSchema = z.object({
  sessionId: z.string(),
  code: z.number().nullable(),
  signal: z.string().optional(),
  /** `lost`: the network took the connection (the renderer may reconnect); `exit`: the shell ended; `closed`: closed here. */
  reason: z.enum(['exit', 'lost', 'closed']),
});
export const sshStateEventSchema = z.object({ sessionId: z.string(), state: z.enum(['open', 'closed']) });

/** A hop's stages, in order: lookup, TCP, the server identifying itself, its key, sign-in, the shell or SFTP. */
export const SSH_CONNECT_PHASES = ['resolve', 'tcp', 'banner', 'host-key', 'auth', 'shell'] as const;
const hopWhere = {
  /** 0-based; the target is `hops - 1`. */
  hop: z.number().int().nonnegative(),
  hops: z.number().int().positive(),
  /** The hop's `address:port`. */
  host: z.string(),
  /** Milliseconds since the epoch. */
  at: z.number(),
};
/** One stage starting or ending, or one handshake log line; none holds a password, passphrase or key. */
export const sshConnectProgressWireSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('phase'),
    phase: z.enum(SSH_CONNECT_PHASES),
    state: z.enum(['start', 'done']),
    ...hopWhere,
    detail: z.string().optional(),
  }),
  z.object({
    kind: z.literal('log'),
    ...hopWhere,
    line: z.string(),
    /** The line says what failed (drawn in red). */
    error: z.literal(true).optional(),
  }),
]);
export const sshConnectProgressEventSchema = z.object({
  attemptId: z.string(),
  event: sshConnectProgressWireSchema,
});

export type SshConnectRequest = z.infer<typeof sshConnectRequestSchema>;
export type SshConnectPhase = (typeof SSH_CONNECT_PHASES)[number];
export type SshConnectProgressWire = z.infer<typeof sshConnectProgressWireSchema>;
export type SshConnectProgressEvent = z.infer<typeof sshConnectProgressEventSchema>;
export type SshConnectResponse = z.infer<typeof sshConnectResponseSchema>;
export type SshWriteRequest = z.infer<typeof sshWriteRequestSchema>;
export type SshWriteManyRequest = z.infer<typeof sshWriteManyRequestSchema>;
export type SshWriteManyResponse = z.infer<typeof sshWriteManyResponseSchema>;
export type SshResizeRequest = z.infer<typeof sshResizeRequestSchema>;
export type SshCloseRequest = z.infer<typeof sshCloseRequestSchema>;
export type SshTrustRequest = z.infer<typeof sshTrustRequestSchema>;

/** A host key the user trusted, as `ssh-known-hosts.json` keeps it: one per host and key type. */
export const sshKnownHostSchema = z.object({
  /** `address:port` */
  host: z.string(),
  keyType: z.string(),
  fingerprint: z.string(),
});
export const sshKnownHostsResponseSchema = z.object({ entries: z.array(sshKnownHostSchema) });
/** Forgets one trusted key: the next connection to that host asks again. */
export const sshForgetHostKeyRequestSchema = z.strictObject({ host: z.string(), keyType: z.string() });
export type SshKnownHostWire = z.infer<typeof sshKnownHostSchema>;

export const sshOsIdSchema = z.enum(SSH_OS_IDS);
export type SshOsId = z.infer<typeof sshOsIdSchema>;
export { SSH_OS_IDS };

/** What a connect found the host to run: the id the icon uses, and its own name and version for text. */
export const sshDetectedOsSchema = z.object({
  id: sshOsIdSchema,
  name: z.string(),
  version: z.string().optional(),
});
/**
 * What is known of one server's OS on this machine, keyed like the known hosts (`address:port` of the
 * host connected to): `detected` by the last connect, `chosen` by the user, which wins.
 */
export const sshHostOsSchema = z.object({
  detected: sshDetectedOsSchema.optional(),
  chosen: sshOsIdSchema.optional(),
});
export const sshHostOsResponseSchema = z.object({ entries: z.record(z.string(), sshHostOsSchema) });
/** `os: null` drops the choice, going back to what was detected. */
export const sshSetHostOsRequestSchema = z.strictObject({ host: z.string(), os: sshOsIdSchema.nullable() });
export type SshDetectedOsWire = z.infer<typeof sshDetectedOsSchema>;
export type SshHostOsWire = z.infer<typeof sshHostOsSchema>;

/**
 * Importing hosts from an OpenSSH client config or another client's session list (`format`, default
 * `ssh-config`). The renderer never sends a path: `user-config` is `~/.ssh/config` resolved in main (an
 * OpenSSH config only), `pick` runs the native picker. Key rows travel by an opaque `ref`; their paths stay
 * in main, and a key's contents never cross.
 */
export const sshImportPreviewRequestSchema = z.strictObject({
  source: z.enum(['user-config', 'pick']),
  format: z.enum(SSH_IMPORT_FORMATS).optional(),
});

export const sshPlannedAuthWireSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('key'), ref: z.string() }),
]);
export const sshPlannedSettingsWireSchema = z.strictObject({
  user: z.string().optional(),
  port: z.number().optional(),
  jump: z.string().optional(),
  auth: sshPlannedAuthWireSchema.optional(),
  keepAlive: z.number().optional(),
  connectTimeout: z.number().optional(),
  forwardAgent: z.boolean().optional(),
});
export const sshPlannedHostWireSchema = z.strictObject({
  alias: z.string(),
  id: z.string(),
  idChangedFrom: z.string().optional(),
  status: z.enum(['new', 'duplicate', 'created-for-jump', 'skipped']),
  duplicateOf: z.string().optional(),
  reason: z.string().optional(),
  address: z.string(),
  ssh: sshPlannedSettingsWireSchema,
  /** The source folder it lands in, as `Production / Web`; a subgroup of the import's group. */
  folder: z.string().optional(),
  tags: z.array(z.string()).optional(),
  /** How many port forwards come with it. */
  forwards: z.number().optional(),
});
/** No `path`: a key row is named by `ref` and shown by `display` (`~/.ssh/id_ed25519`). */
export const sshPlannedKeyWireSchema = z.strictObject({
  ref: z.string(),
  display: z.string(),
  /** The key's `CertificateFile`, shown the same way; stored as `<secret>_cert` with a stored or existing key. */
  certificate: z.string().optional(),
  hosts: z.array(z.string()),
  proposedSecret: z.string(),
});
export const sshImportReportWireSchema = z.strictObject({
  problems: z.array(z.strictObject({ file: z.string(), line: z.number().optional(), why: z.string() })),
  skipped: z.array(z.strictObject({ file: z.string(), line: z.number(), keyword: z.string(), why: z.string() })),
  ignored: z.array(z.strictObject({ keyword: z.string(), count: z.number() })),
  notes: z.array(z.string()),
});
export const sshImportPreviewSchema = z.strictObject({
  previewId: z.string(),
  /** The file read, as shown to the user. */
  source: z.string(),
  group: z.strictObject({ id: z.string(), name: z.string(), ssh: sshPlannedSettingsWireSchema }),
  hosts: z.array(sshPlannedHostWireSchema),
  keys: z.array(sshPlannedKeyWireSchema),
  report: sshImportReportWireSchema,
});
export const sshImportPreviewResponseSchema = z.union([
  z.strictObject({ cancelled: z.literal(true) }),
  sshImportPreviewSchema,
]);

export const sshKeyChoiceWireSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('agent') }),
  z.strictObject({ kind: z.literal('existing'), secret: z.string() }),
  z.strictObject({ kind: z.literal('store'), secret: z.string() }),
]);
export const sshImportApplyRequestSchema = z.strictObject({
  previewId: z.string(),
  groupName: z.string().trim().min(1),
  importDuplicates: z.array(z.string()),
  keys: z.array(z.strictObject({ ref: z.string(), choice: sshKeyChoiceWireSchema })),
});
export const sshImportApplyResponseSchema = sshListHostsResponseSchema.extend({
  groupId: z.string(),
  /** Secret names the import stored a key under (never their values). */
  stored: z.array(z.string()),
});

export type SshImportPreviewRequest = z.infer<typeof sshImportPreviewRequestSchema>;
export type SshImportPreview = z.infer<typeof sshImportPreviewSchema>;
export type SshImportPreviewResponse = z.infer<typeof sshImportPreviewResponseSchema>;
export type SshPlannedHostWire = z.infer<typeof sshPlannedHostWireSchema>;
export type SshPlannedKeyWire = z.infer<typeof sshPlannedKeyWireSchema>;
export type SshKeyChoiceWire = z.infer<typeof sshKeyChoiceWireSchema>;
export type SshImportApplyRequest = z.infer<typeof sshImportApplyRequestSchema>;
export type SshImportApplyResponse = z.infer<typeof sshImportApplyResponseSchema>;

/**
 * Importing trusted host keys from an OpenSSH known_hosts file (#418). As with the config import, the
 * renderer never sends a path: `user-known-hosts` is `~/.ssh/known_hosts` resolved in main, `pick` runs the
 * native picker. Only hosts in the window's hosts.yaml gain a key.
 */
export const sshKnownHostsImportPreviewRequestSchema = z.strictObject({ source: z.enum(['user-known-hosts', 'pick']) });
export const sshKnownHostsImportRowSchema = z.strictObject({
  /** `address:port`, as the trusted-keys store keeps it. */
  host: z.string(),
  keyType: z.string(),
  fingerprint: z.string(),
  /** The hosts.yaml names of the hosts at that address and port. */
  names: z.array(z.string()),
  line: z.number(),
});
export const sshKnownHostsImportPreviewSchema = z.strictObject({
  previewId: z.string(),
  /** The file read, as shown to the user. */
  source: z.string(),
  add: z.array(sshKnownHostsImportRowSchema),
  /** Keys that differ from a stored one: replaced only when chosen and confirmed. */
  conflicts: z.array(sshKnownHostsImportRowSchema.extend({ previous: z.string() })),
  trusted: z.array(sshKnownHostsImportRowSchema),
  skipped: z.array(
    z.strictObject({
      line: z.number(),
      reason: z.enum(['cert-authority', 'revoked', 'no-host', 'duplicate', 'unreadable']),
    }),
  ),
});
export const sshKnownHostsImportPreviewResponseSchema = z.union([
  z.strictObject({ cancelled: z.literal(true) }),
  sshKnownHostsImportPreviewSchema,
]);
export const sshKnownHostsImportApplyRequestSchema = z.strictObject({
  previewId: z.string(),
  /** The conflicts the user chose to replace, by host and key type. */
  replace: z.array(z.strictObject({ host: z.string(), keyType: z.string() })),
});
export const sshKnownHostsImportApplyResponseSchema = z.strictObject({
  added: z.number(),
  replaced: z.number(),
  /** Stored keys left alone because they were not chosen for replacing. */
  kept: z.number(),
});

export type SshKnownHostsImportPreviewRequest = z.infer<typeof sshKnownHostsImportPreviewRequestSchema>;
export type SshKnownHostsImportPreview = z.infer<typeof sshKnownHostsImportPreviewSchema>;
export type SshKnownHostsImportPreviewResponse = z.infer<typeof sshKnownHostsImportPreviewResponseSchema>;
export type SshKnownHostsImportApplyRequest = z.infer<typeof sshKnownHostsImportApplyRequestSchema>;
export type SshKnownHostsImportApplyResponse = z.infer<typeof sshKnownHostsImportApplyResponseSchema>;
