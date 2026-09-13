/**
 * Zod schemas for every YAML document in a workspace folder.
 *
 * Mirrors `project/schema.ts`'s discipline: every object schema is
 * `z.looseObject` (unknown keys accepted and ignored on load — see that
 * file's doc comment for the "additive bumps formatVersion" policy this
 * implies), and `formatVersion` stays a `z.literal` so an out-of-range value
 * is still caught explicitly (see `migrate.ts`).
 */

import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { WorkspaceError } from '../errors.js';
import { WORKSPACE_FORMAT_VERSION } from './model.js';

const nonEmpty = z.string().min(1);
const propertyMapSchema = z.record(z.string(), z.string());

const workspaceProjectRefInternalSchema = z.looseObject({
  id: nonEmpty,
  slug: nonEmpty,
  source: z.literal('internal'),
});

/** A linked project ref's `path` must be absolute — a workspace never stores a path relative to itself. */
const workspaceProjectRefLinkedSchema = z
  .looseObject({
    id: nonEmpty,
    slug: nonEmpty,
    source: z.literal('linked'),
    path: nonEmpty,
  })
  .refine((value) => isAbsolute(value.path), {
    message: 'a linked project reference path must be absolute',
    path: ['path'],
  });

/** One `workspace.yaml` `projects` entry, as persisted. */
export const workspaceProjectRefSchema = z.discriminatedUnion('source', [
  workspaceProjectRefInternalSchema,
  workspaceProjectRefLinkedSchema,
]);

/** `workspace.yaml`. */
export const workspaceManifestSchema = z.looseObject({
  formatVersion: z.literal(WORKSPACE_FORMAT_VERSION),
  id: nonEmpty,
  name: z.string(),
  description: z.string().optional(),
  createdAt: nonEmpty,
  properties: propertyMapSchema,
  /** Names of `properties` entries switched off; absent means none. See `model.ts`. */
  disabled: z.array(z.string()).optional(),
  projects: z.array(workspaceProjectRefSchema),
});

/** `environments/<slug>.yaml`. */
export const workspaceEnvironmentFileSchema = z.looseObject({
  id: nonEmpty,
  name: z.string(),
  order: z.number().int(),
  properties: propertyMapSchema,
  endpoints: z.record(z.string(), z.string()),
  /** Names of `properties` entries switched off; absent means none. */
  disabled: z.array(z.string()).optional(),
});

/** `local.yaml`: machine-local state, never part of the shared tree. See `local-state.ts`. */
export const workspaceLocalStateSchema = z.object({
  version: z.literal(1),
  activeEnvironmentId: z.string().optional(),
});

/** `share.yaml`'s `git` block: settings for a git-backed share. See `share.ts`. */
const gitShareSettingsSchema = z.object({
  remote: z.string().optional(),
  branch: nonEmpty,
  autoFetchSeconds: z.number().int().min(0),
  commitOnSave: z.boolean(),
  pushOnSave: z.boolean(),
});

/**
 * `share.yaml`: absent means a local workspace. `path`, when set, must be absolute — it is only
 * ever written from a native folder picker. `kind: 'git'` requires `git`; `kind: 'server'`
 * requires `server`.
 */
export const workspaceShareSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['folder', 'git', 'server']),
    path: z
      .string()
      .optional()
      .refine((value) => value === undefined || isAbsolute(value), { message: 'path must be absolute' }),
    git: gitShareSettingsSchema.optional(),
    server: z.object({ url: nonEmpty, workspaceId: nonEmpty }).optional(),
  })
  .refine((value) => value.kind !== 'git' || value.git !== undefined, {
    message: 'kind: git requires a git block',
    path: ['git'],
  })
  .refine((value) => value.kind !== 'server' || value.server !== undefined, {
    message: 'kind: server requires a server block',
    path: ['server'],
  });

/** The manifest document as persisted. */
export type WorkspaceManifestFile = z.infer<typeof workspaceManifestSchema>;
/** One `projects` entry as persisted. */
export type WorkspaceProjectRefFile = z.infer<typeof workspaceProjectRefSchema>;
/** An environment document as persisted. */
export type WorkspaceEnvironmentFile = z.infer<typeof workspaceEnvironmentFileSchema>;

/**
 * Validates `value` against `schema`, raising
 * `WorkspaceError('workspace-file-invalid')` carrying the file path and the
 * individual zod issues when it does not match. Mirrors `project/schema.ts`'s
 * `parseFile`, distinct only in which error class it throws.
 */
export function parseWorkspaceFile<T>(schema: z.ZodType<T>, value: unknown, file: string): T {
  const result = schema.safeParse(value);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
  throw new WorkspaceError('workspace-file-invalid', `Invalid workspace file ${file}`, {
    details: { file, issues },
  });
}
