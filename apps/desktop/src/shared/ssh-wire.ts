import { z } from 'zod';

/**
 * Wire shapes of the SSH area. A credential is its secret NAME only: never a `${secret:NAME}` token, never a
 * value, a private key or a passphrase. The renderer does not import `@wirebench/ssh`, so the model is
 * mirrored here with zod alone.
 */

export const sshProblemSchema = z.object({ code: z.string(), message: z.string(), path: z.string().optional() });

export const sshAuthWireSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('password'), secret: z.string() }),
  z.strictObject({ kind: z.literal('key'), secret: z.string(), passphraseSecret: z.string().optional() }),
  z.strictObject({ kind: z.literal('agent') }),
]);

export const sshSettingsWireSchema = z.strictObject({
  user: z.string().optional(),
  port: z.number().optional(),
  jump: z.string().optional(),
  auth: sshAuthWireSchema.optional(),
  keepAlive: z.number().optional(),
  connectTimeout: z.number().optional(),
});

export const hostEntryWireSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  tags: z.array(z.string()),
  ssh: sshSettingsWireSchema,
});

export interface HostEntryWire {
  id: string;
  name: string;
  address: string;
  tags: string[];
  ssh: SshSettingsWire;
}
export interface GroupEntryWire {
  id: string;
  name: string;
  tags: string[];
  ssh: SshSettingsWire;
  groups: GroupEntryWire[];
  hosts: HostEntryWire[];
}

export const groupEntryWireSchema: z.ZodType<GroupEntryWire> = z.lazy(() =>
  z.strictObject({
    id: z.string(),
    name: z.string(),
    tags: z.array(z.string()),
    ssh: sshSettingsWireSchema,
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

export const resolvedHostWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  address: z.string(),
  tags: z.array(z.string()),
  path: z.array(z.string()),
  ssh: z.object({
    user: prov(z.string().optional()),
    port: prov(z.number()),
    auth: prov(sshAuthWireSchema.optional()),
    jump: prov(z.string().optional()),
    keepAlive: prov(z.number()),
    connectTimeout: prov(z.number()),
  }),
  incomplete: z.object({ field: z.enum(['user', 'auth']) }).optional(),
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
export type SshProblemWire = z.infer<typeof sshProblemSchema>;
export type SshListHostsResponse = z.infer<typeof sshListHostsResponseSchema>;

/** One name a host can reference: stored on this machine for the workspace, and/or mapped by a secret source. */
export const sshSecretNameSchema = z.object({ name: z.string(), local: z.boolean(), external: z.boolean() });
export const sshSecretNamesResponseSchema = z.object({ names: z.array(sshSecretNameSchema) });
/** A write-only value for a workspace-scoped name; the value never comes back. */
export const sshSetSecretRequestSchema = z.strictObject({ name: z.string(), value: z.string() });
export type SshSecretNameWire = z.infer<typeof sshSecretNameSchema>;

/** Opens a shell on a host; the answer is the session id the terminal addresses from then on. */
export const sshConnectRequestSchema = z.strictObject({
  hostId: z.string(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
export const sshConnectResponseSchema = z.object({ sessionId: z.string() });
/** `data` is base64: terminal bytes are not always valid UTF-8. */
export const sshWriteRequestSchema = z.strictObject({ sessionId: z.string(), data: z.string() });
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
});
export const sshStateEventSchema = z.object({ sessionId: z.string(), state: z.enum(['open', 'closed']) });

export type SshConnectRequest = z.infer<typeof sshConnectRequestSchema>;
export type SshWriteRequest = z.infer<typeof sshWriteRequestSchema>;
export type SshResizeRequest = z.infer<typeof sshResizeRequestSchema>;
export type SshCloseRequest = z.infer<typeof sshCloseRequestSchema>;
export type SshTrustRequest = z.infer<typeof sshTrustRequestSchema>;

/**
 * Importing hosts from an OpenSSH client config. The renderer never sends a path: `user-config` is
 * `~/.ssh/config` resolved in main, `pick` runs the native picker. Key rows travel by an opaque `ref`;
 * their paths stay in main, and a key's contents never cross.
 */
export const sshImportPreviewRequestSchema = z.strictObject({ source: z.enum(['user-config', 'pick']) });

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
});
/** No `path`: a key row is named by `ref` and shown by `display` (`~/.ssh/id_ed25519`). */
export const sshPlannedKeyWireSchema = z.strictObject({
  ref: z.string(),
  display: z.string(),
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
