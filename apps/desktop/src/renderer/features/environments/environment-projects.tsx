/**
 * The **Projects** panel (#393): which of the workspace's projects the open environment applies
 * to, in the right slide-over, apart from the environment's other details (#581). It holds the
 * selection and nothing else: **All projects** at the top, then one checkbox per project.
 *
 * The rule is #468's: `projects` absent applies the environment to every project, the ones added
 * later included; a list applies it to exactly those, so a project added later stays out until it
 * is ticked; `[]` applies it to none. Each edit is queued and built from the environment as it
 * stands (`queueEnvironmentPatch`), so an id this machine does not know (a project a teammate has
 * and this machine has not pulled) is kept.
 */
import type { WorkspaceEnvironmentWire, WorkspaceProjectWire } from '@shared/wire-base.js';
import { appliesToProject } from '../../state/environment-scope.js';
import { selectEnvironment, useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useOpenEnvironmentId } from './environment-details.js';
import { queueEnvironmentPatch } from './environment-queue.js';

/** Whether the panel is wanted; kept with the window layout like Environment details. Absent reads as hidden. */
export function useEnvironmentProjectsOpen(): boolean {
  return useUiStore((state) => state.slideOver.environmentProjectsOpen === true);
}

/** {@link useEnvironmentProjectsOpen}, read outside React. */
export function environmentProjectsOpen(): boolean {
  return useUiStore.getState().slideOver.environmentProjectsOpen === true;
}

/** Shows or puts away the panel, and remembers it. Showing it puts Environment details away: there is one slide-over. */
export function setEnvironmentProjectsOpen(open: boolean): void {
  useUiStore.getState().setEnvironmentProjectsOpen(open);
}

/** Whether the panel is in front: an environment that still exists is open, and the panel was asked for. */
export function useEnvironmentProjectsShown(): boolean {
  const environmentId = useOpenEnvironmentId();
  const open = useEnvironmentProjectsOpen();
  const inWorkspace = useWorkspaceStore(
    (state) =>
      environmentId !== undefined &&
      state.workspace?.environments.some((candidate) => candidate.id === environmentId) === true,
  );
  const inProject = useProjectStore(
    (state) => environmentId !== undefined && selectEnvironment(state, environmentId) !== undefined,
  );
  return open && (inWorkspace || inProject);
}

/** Stable empty projects, so the selector does not hand back a new array on every render. */
const NO_PROJECTS: readonly WorkspaceProjectWire[] = [];

const OPTION_CLASS = 'flex min-w-0 items-center gap-2 py-1 text-sm text-fg-default';

/** The slide-over's content: the open environment's project selection, or nothing when none is open. */
export function EnvironmentProjectsPanel() {
  const environmentId = useOpenEnvironmentId();
  return environmentId === undefined ? null : <EnvironmentProjects environmentId={environmentId} />;
}

/** One environment's project selection: a workspace environment's, or a linked project's own (fixed). */
export function EnvironmentProjects({ environmentId }: { readonly environmentId: string }) {
  const environment = useWorkspaceStore((state) =>
    state.workspace?.environments.find((candidate) => candidate.id === environmentId),
  );
  const projects = useWorkspaceStore((state) => state.workspace?.projects ?? NO_PROJECTS);
  const projectEnvironment = useProjectStore((state) => selectEnvironment(state, environmentId));
  const owningProjectId = useProjectStore((state) => state.projectOf[environmentId]);

  if (environment === undefined) {
    if (projectEnvironment === undefined) {
      return <p className="text-sm text-fg-subtle">This environment no longer exists.</p>;
    }
    // A linked project's own environment belongs to that project; there is no selection to make.
    const owner = projects.find((candidate) => candidate.id === owningProjectId)?.name ?? 'its project';
    return (
      <p data-testid="environment-projects-fixed" className="text-sm text-fg-subtle">
        {projectEnvironment.name} belongs to {owner} only.
      </p>
    );
  }
  return <ProjectSelection environment={environment} projects={projects} />;
}

function ProjectSelection({
  environment,
  projects,
}: {
  readonly environment: WorkspaceEnvironmentWire;
  readonly projects: readonly WorkspaceProjectWire[];
}) {
  const all = environment.projects === undefined;
  const count = all ? projects.length : projects.filter((project) => appliesToProject(environment, project.id)).length;

  const setAll = (): void => {
    void queueEnvironmentPatch(environment.id, (current) =>
      current.projects === undefined ? undefined : { projects: null },
    );
  };
  // Narrowing starts from every project of the workspace, so nothing drops out of a switcher
  // until a box is cleared.
  const narrow = (): void => {
    void queueEnvironmentPatch(environment.id, (current) =>
      current.projects !== undefined ? undefined : { projects: projects.map((project) => project.id) },
    );
  };
  const setProject = (projectId: string, include: boolean): void => {
    void queueEnvironmentPatch(environment.id, (current) => {
      // Under All projects, clearing a box narrows to every other project; ticking one changes nothing.
      if (current.projects === undefined) {
        return include
          ? undefined
          : { projects: projects.map((project) => project.id).filter((id) => id !== projectId) };
      }
      const list = current.projects;
      if (include === list.includes(projectId)) {
        return undefined;
      }
      return { projects: include ? [...list, projectId] : list.filter((id) => id !== projectId) };
    });
  };

  return (
    <fieldset data-testid="environment-projects" className="flex min-w-0 flex-col">
      <legend className="pb-2 text-xs text-fg-subtle">Which projects {environment.name} applies to</legend>
      <label className={OPTION_CLASS}>
        <input
          type="checkbox"
          aria-label="All projects"
          data-testid="environment-projects-all"
          checked={all}
          onChange={(event) => {
            if (event.currentTarget.checked) setAll();
            else narrow();
          }}
        />
        <span className="min-w-0">
          All projects
          <span className="block text-xs text-fg-subtle">Projects added later included</span>
        </span>
      </label>
      <ul className="mt-2 flex flex-col border-t border-hairline pt-2">
        {projects.map((project) => (
          <li key={project.id}>
            <label className={OPTION_CLASS}>
              <input
                type="checkbox"
                aria-label={`Applies to ${project.name}`}
                checked={all || appliesToProject(environment, project.id)}
                onChange={(event) => {
                  setProject(project.id, event.currentTarget.checked);
                }}
              />
              <span className="min-w-0 truncate">{project.name}</span>
            </label>
          </li>
        ))}
      </ul>
      <p data-testid="environment-projects-summary" className="pt-2 text-xs text-fg-subtle">
        {all
          ? 'Applies to every project.'
          : count === 0
            ? 'Applies to no project.'
            : `Ticked projects only: a project added later is not included until it is ticked.`}
      </p>
    </fieldset>
  );
}
