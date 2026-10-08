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

/** What a setting resolves to when no host or group sets it; the resolver in `@wirebench/ssh` must agree (tested). */
export const SSH_DEFAULTS = { port: 22, keepAlive: 15, connectTimeout: 20 } as const;

export const SSH_SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
