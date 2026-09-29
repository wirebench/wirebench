/**
 * Finding the workspace a project folder sits inside, shared by `wirebench run` and the ops layer:
 * the workspace's environments and properties apply to a project inside it, as in the app.
 */
import { access, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isWirebenchError, loadWorkspace, workspaceProjectDir } from '@wirebench/engine';
import type { RunWorkspace } from '@wirebench/engine';

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The directory's real path, or its resolved one when it has none (a path that does not exist). */
async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The workspace `projectDir` sits inside: the nearest `workspace.yaml` above it, provided that
 * workspace lists this folder among its projects (an internal one under its `projects/`, or a
 * linked one by path). A `workspace.yaml` that does not list it, or is not a workspace at all (the
 * name is common enough for another tool's file), is reported through `warn` and applies nothing.
 */
export async function enclosingWorkspace(
  projectDir: string,
  warn: (line: string) => void,
): Promise<RunWorkspace | undefined> {
  const project = await realOrResolved(projectDir);
  for (let dir = dirname(project); ; dir = dirname(dir)) {
    const manifest = join(dir, 'workspace.yaml');
    if (await exists(manifest)) {
      let loaded: Awaited<ReturnType<typeof loadWorkspace>>;
      try {
        loaded = await loadWorkspace(dir);
      } catch (error) {
        if (!isWirebenchError(error)) {
          throw error;
        }
        warn(
          `${manifest} is not a workspace this run can read (${error.code}: ${error.message}); its environments and properties do not apply`,
        );
        return undefined;
      }
      for (const problem of loaded.problems) {
        warn(`${problem.code}: ${problem.message} (${problem.file})`);
      }
      for (const ref of loaded.workspace.projects) {
        const refDir =
          ref.source === 'linked' && ref.path !== undefined ? ref.path : workspaceProjectDir(dir, ref.slug);
        if ((await realOrResolved(refDir)) === project) {
          return { workspace: loaded.workspace, projectSlug: ref.slug };
        }
      }
      warn(`${manifest} does not list this project; its environments and properties do not apply`);
      return undefined;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}
