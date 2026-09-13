/**
 * Public surface of the workspace module: a workspace's model, its on-disk
 * schema and file-system layout, and the load/save/migrate functions that
 * move between the two. Mirrors the shape of `project/` one level up (see
 * `workspace/model.ts` for what a workspace is), collected here so
 * `src/index.ts` can re-export the whole module with one pair of blocks.
 */

export { WORKSPACE_FORMAT_VERSION, createWorkspace, createWorkspaceEnvironment } from './model.js';
export type { Workspace, WorkspaceEnvironment, WorkspaceProjectRef } from './model.js';

export {
  parseWorkspaceFile,
  workspaceEnvironmentFileSchema,
  workspaceManifestSchema,
  workspaceProjectRefSchema,
} from './schema.js';
export type { WorkspaceEnvironmentFile, WorkspaceManifestFile, WorkspaceProjectRefFile } from './schema.js';

export {
  WORKSPACES_DIR,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_MANIFEST,
  WORKSPACE_PROJECTS_DIR,
  WORKSPACE_STATE_FILE,
  workspaceDir,
  workspaceEnvironmentFile,
  workspaceManifestFile,
  workspaceProjectDir,
  assertPathSegment,
} from './paths.js';

export { workspaceFiles } from './serialize.js';
export type { WorkspaceFiles, WorkspaceFilesOptions } from './serialize.js';

export { loadWorkspace } from './load.js';
export type { LoadWorkspaceOptions, LoadWorkspaceResult, WorkspaceProblem } from './load.js';

export { saveWorkspace } from './save.js';
export type { SaveWorkspaceOptions } from './save.js';

export { migrateWorkspace } from './migrate.js';

export { reidentifyProject } from './reidentify.js';

export {
  resolveWorkspaceApiBaseUrl,
  linkedEnvironment,
  resolveWorkspaceEndpoint,
  resolveWorkspaceScopes,
} from './environments.js';
