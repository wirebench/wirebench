/**
 * Reads a workspace folder back into a {@link Workspace}. Mirrors
 * `project/load.ts`, with one deliberate difference: a workspace tolerates
 * more damage than a project does. Neither a malformed environment file nor a
 * project reference that fails its schema aborts the load — each becomes a
 * {@link WorkspaceProblem} and is dropped, so a partially damaged workspace
 * still opens (a broken *project* it references is the main process's problem
 * when it tries to open that project, not this module's).
 */

import { join } from 'node:path';
import { parse as parseYamlDocument } from 'yaml';
import { WorkspaceError } from '../errors.js';
import type { FsLike } from '../project/fs.js';
import { nodeFs, readFileIfExists, readdirIfExists } from '../project/fs.js';
import type { Workspace, WorkspaceEnvironment, WorkspaceProjectRef } from './model.js';
import { WORKSPACE_FORMAT_VERSION } from './model.js';
import { migrateWorkspace } from './migrate.js';
import { WORKSPACE_ENVIRONMENTS_DIR, WORKSPACE_MANIFEST } from './paths.js';
import {
  parseWorkspaceFile,
  workspaceEnvironmentFileSchema,
  workspaceManifestSchema,
  workspaceProjectRefSchema,
} from './schema.js';

/** A recoverable inconsistency found while loading a workspace. */
export interface WorkspaceProblem {
  readonly code: 'environment-file-invalid' | 'project-ref-invalid';
  readonly message: string;
  /** Path relative to the workspace root. */
  readonly file: string;
}

/** Options for {@link loadWorkspace}. */
export interface LoadWorkspaceOptions {
  readonly fs?: FsLike;
}

/** The result of {@link loadWorkspace}: the model plus anything odd about the folder. */
export interface LoadWorkspaceResult {
  readonly workspace: Workspace;
  readonly problems: readonly WorkspaceProblem[];
}

function abs(root: string, relative: string): string {
  return join(root, ...relative.split('/'));
}

/**
 * Parses YAML text, raising `WorkspaceError('workspace-file-invalid')` with
 * the offending file path when the document is malformed. A workspace-scoped
 * equivalent of `project/yaml.ts`'s `parseYaml`, kept local since it must
 * throw a different error class.
 */
function parseYaml(text: string, file: string): unknown {
  try {
    return parseYamlDocument(text);
  } catch (error) {
    throw new WorkspaceError('workspace-file-invalid', `Malformed YAML in ${file}`, {
      details: { file, issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }] },
      cause: error,
    });
  }
}

async function readYaml(fs: FsLike, root: string, relative: string): Promise<unknown> {
  const buffer = await readFileIfExists(fs, abs(root, relative));
  return buffer === undefined ? undefined : parseYaml(buffer.toString('utf8'), relative);
}

/** Orders entities by their persisted `order`, falling back to a stable name comparison. */
function byOrder<T extends { readonly order: number; readonly name: string }>(a: T, b: T): number {
  return a.order - b.order || a.name.localeCompare(b.name);
}

function optional<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Loads every `environments/<slug>.yaml`. A file that is not valid YAML or
 * does not match {@link workspaceEnvironmentFileSchema} is reported as an
 * `environment-file-invalid` problem and skipped, rather than aborting the
 * whole load.
 */
async function loadEnvironments(
  fs: FsLike,
  root: string,
  problems: WorkspaceProblem[],
): Promise<WorkspaceEnvironment[]> {
  const environments: WorkspaceEnvironment[] = [];
  for (const entry of await readdirIfExists(fs, abs(root, WORKSPACE_ENVIRONMENTS_DIR))) {
    if (!entry.isFile || !entry.name.endsWith('.yaml')) {
      continue;
    }
    const relative = `${WORKSPACE_ENVIRONMENTS_DIR}/${entry.name}`;
    let document: unknown;
    try {
      document = await readYaml(fs, root, relative);
    } catch {
      problems.push({
        code: 'environment-file-invalid',
        message: `"${relative}" is not valid YAML and was skipped`,
        file: relative,
      });
      continue;
    }
    const result = workspaceEnvironmentFileSchema.safeParse(document);
    if (!result.success) {
      problems.push({
        code: 'environment-file-invalid',
        message: `"${relative}" does not match the environment schema and was skipped`,
        file: relative,
      });
      continue;
    }
    const parsed = result.data;
    environments.push({
      id: parsed.id,
      name: parsed.name,
      slug: entry.name.slice(0, -'.yaml'.length),
      order: parsed.order,
      properties: parsed.properties,
      endpoints: parsed.endpoints,
      disabledProperties: parsed.disabled ?? [],
    });
  }
  return environments.sort(byOrder);
}

/**
 * Validates the raw `projects` array of a manifest one entry at a time, so a
 * single malformed reference becomes a `project-ref-invalid` problem instead
 * of failing the whole manifest.
 */
function loadProjectRefs(rawProjects: unknown, problems: WorkspaceProblem[]): WorkspaceProjectRef[] {
  const refs: WorkspaceProjectRef[] = [];
  if (!Array.isArray(rawProjects)) {
    return refs;
  }
  for (const raw of rawProjects) {
    const result = workspaceProjectRefSchema.safeParse(raw);
    if (!result.success) {
      problems.push({
        code: 'project-ref-invalid',
        message: `A project reference in ${WORKSPACE_MANIFEST} does not match the expected shape`,
        file: WORKSPACE_MANIFEST,
      });
      continue;
    }
    const parsed = result.data;
    refs.push(
      parsed.source === 'linked'
        ? { id: parsed.id, slug: parsed.slug, source: parsed.source, path: parsed.path }
        : { id: parsed.id, slug: parsed.slug, source: parsed.source },
    );
  }
  return refs;
}

/**
 * Loads the workspace stored in the directory `root`.
 *
 * @throws WorkspaceError `workspace-not-found` when there is no
 * `workspace.yaml`, `workspace-format-too-new` for a newer format version,
 * `workspace-file-invalid` for malformed or schema-violating YAML (with the
 * offending file in `details`).
 */
export async function loadWorkspace(root: string, options?: LoadWorkspaceOptions): Promise<LoadWorkspaceResult> {
  const fs = options?.fs ?? nodeFs;
  const manifestDocument = await readYaml(fs, root, WORKSPACE_MANIFEST);
  if (manifestDocument === undefined) {
    throw new WorkspaceError('workspace-not-found', `No ${WORKSPACE_MANIFEST} in ${root}`, {
      details: { file: WORKSPACE_MANIFEST, root },
    });
  }
  const migrated = migrateWorkspace(manifestDocument, WORKSPACE_MANIFEST);

  const problems: WorkspaceProblem[] = [];
  const projects = loadProjectRefs(migrated['projects'], problems);

  const manifest = parseWorkspaceFile(workspaceManifestSchema, { ...migrated, projects: [] }, WORKSPACE_MANIFEST);

  const workspace: Workspace = {
    formatVersion: WORKSPACE_FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    ...optional('description', manifest.description),
    createdAt: manifest.createdAt,
    properties: manifest.properties,
    disabledProperties: manifest.disabled ?? [],
    ...optional('activeEnvironmentId', manifest.activeEnvironmentId),
    projects,
    environments: await loadEnvironments(fs, root, problems),
  };
  return { workspace, problems };
}
