/**
 * Writes a workspace straight onto disk, so a perf spec can measure opening a *large* one
 * without spending minutes driving the UI to build it.
 *
 * Everything here goes through the engine's own public API — `createProject`,
 * `createInterface`, `saveProject`, `createWorkspace`, `saveWorkspace` — so the bytes on disk
 * are exactly what the app itself would have written, rather than a hand-rolled approximation
 * that could drift from the real format and quietly stop measuring anything.
 *
 * The interfaces point at a fixture server for their definition: opening the workspace makes
 * the app hydrate them over HTTP, the same way it would against a real service.
 */
import { mkdir } from 'node:fs/promises';
import {
  createInterface,
  createProject,
  createWorkspace,
  saveProject,
  saveWorkspace,
  workspaceDir,
  workspaceProjectDir,
} from '@wirebench/engine';
import type { WorkspaceProjectRef } from '@wirebench/engine';

export interface SeedWorkspaceOptions {
  /** The profile the workspace is seeded into — the app's `userData` directory. */
  readonly userDataDir: string;
  readonly name: string;
  /** How many internal projects the workspace holds. */
  readonly projects: number;
  /** How many interfaces each of those projects holds. */
  readonly interfacesPerProject: number;
  /** Where every interface's definition is fetched from (a fixture server's `wsdlUrl`). */
  readonly definitionUrl: string;
  /** The address every interface declares — never sent to, but it has to be somewhere real. */
  readonly endpointUrl: string;
}

/** A seeded workspace, as the picker will list it. */
export interface SeededWorkspace {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  /** The ids of the projects written, in manifest order — how a spec addresses their rows. */
  readonly projectIds: readonly string[];
}

/**
 * Seeds one workspace of `projects` internal projects, each with `interfacesPerProject`
 * interfaces, and returns what it created. The profile itself is left with no
 * `workspace-state.json`, so the app still starts on the picker.
 */
export async function seedWorkspace(options: SeedWorkspaceOptions): Promise<SeededWorkspace> {
  const workspace = createWorkspace(options.name);
  const dir = workspaceDir(options.userDataDir, workspace.id);
  const refs: WorkspaceProjectRef[] = [];

  for (let index = 0; index < options.projects; index += 1) {
    const number = String(index + 1).padStart(2, '0');
    const slug = `project-${number}`;
    const project = createProject(`Project ${number}`);
    const interfaces = Array.from({ length: options.interfacesPerProject }, (_unused, position) =>
      createInterface(`Service ${number}-${String(position + 1)}`, {
        slug: `service-${number}-${String(position + 1)}`,
        order: position,
        definitionUrl: options.definitionUrl,
        endpoints: [
          {
            id: `endpoint-${number}-${String(position + 1)}`,
            name: 'default',
            url: options.endpointUrl,
            authMode: 'complement',
          },
        ],
      }),
    );
    const projectDir = workspaceProjectDir(dir, slug);
    await mkdir(projectDir, { recursive: true });
    await saveProject({ ...project, interfaces }, projectDir);
    refs.push({ id: project.id, slug, source: 'internal' });
  }

  await saveWorkspace({ ...workspace, projects: refs }, dir);
  return { id: workspace.id, name: workspace.name, dir, projectIds: refs.map((ref) => ref.id) };
}
