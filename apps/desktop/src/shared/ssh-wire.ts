import { z } from 'zod';

/**
 * Wire shapes of the SSH area. A credential is its secret NAME only: never a `${secret:NAME}` token, never a
 * value, a private key or a passphrase. The renderer does not import `@wirebench/ssh`, so the model is
 * mirrored here with zod alone.
 */

export const sshProblemSchema = z.object({ code: z.string(), message: z.string(), path: z.string().optional() });

export const sshAuthWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('password'), secret: z.string() }),
  z.object({ kind: z.literal('key'), secret: z.string(), passphraseSecret: z.string().optional() }),
  z.object({ kind: z.literal('agent') }),
]);

export const sshSettingsWireSchema = z.object({
  user: z.string().optional(),
  port: z.number().optional(),
  jump: z.string().optional(),
  auth: sshAuthWireSchema.optional(),
  keepAlive: z.number().optional(),
  connectTimeout: z.number().optional(),
});

export const hostEntryWireSchema = z.object({
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
  z.object({
    id: z.string(),
    name: z.string(),
    tags: z.array(z.string()),
    ssh: sshSettingsWireSchema,
    groups: z.array(groupEntryWireSchema),
    hosts: z.array(hostEntryWireSchema),
  }),
);

export const hostsFileWireSchema = z.object({
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

export const sshSaveHostsRequestSchema = z.object({ file: hostsFileWireSchema });

export type SshAuthWire = z.infer<typeof sshAuthWireSchema>;
export type SshSettingsWire = z.infer<typeof sshSettingsWireSchema>;
export type HostsFileWire = z.infer<typeof hostsFileWireSchema>;
export type ResolvedHostWire = z.infer<typeof resolvedHostWireSchema>;
export type SshProblemWire = z.infer<typeof sshProblemSchema>;
export type SshListHostsResponse = z.infer<typeof sshListHostsResponseSchema>;
