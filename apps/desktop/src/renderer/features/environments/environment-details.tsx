/**
 * The open environment, in the right slide-over (where the Code panel shows for a request): its
 * name, where it lives, whether it is protected and how many variables it sets, and the two
 * settings that change how it is offered — its **Colour** (#345) and, for a workspace environment,
 * which projects it **Applies to** (#468). The page beside it keeps the name, the Active toggle and
 * the variables. The right rail's icon, its close icon and Escape put the panel away.
 */
import type { ReactNode } from 'react';
import { create } from 'zustand';
import { EnvironmentColour } from './environment-look.js';
import { queueEnvironmentPatch } from './environment-queue.js';
import type { WorkspaceEnvironmentWire, WorkspaceProjectWire } from '../../../shared/wire-base.js';
import { useEditorsStore } from '../../state/editors.js';
import { appliesToProject } from '../../state/environment-scope.js';
import { selectEnvironment, useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/** Whether the panel is wanted. Open by default, so an environment's colour is in view when it opens. */
export const useEnvironmentDetailsStore = create<{
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
}>((set) => ({
  open: true,
  setOpen: (open) => {
    set({ open });
  },
}));

/**
 * The real environment the Environments area's tab in front edits: `undefined` on Globals,
 * Workspace, another area, or no tab. Opening a row is what opens its tab, so this covers both.
 */
export function useOpenEnvironmentId(): string | undefined {
  return useEditorsStore((state) => {
    if (state.displayedSet !== 'environments') return undefined;
    const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
    if (tab?.kind !== 'environment') return undefined;
    const id = tab.environmentId;
    return id === undefined || id === 'globals' || id === 'workspace' ? undefined : id;
  });
}

/** Whether the panel is in front: an environment that still exists is open, and the panel was not put away. */
export function useEnvironmentDetailsShown(): boolean {
  const environmentId = useOpenEnvironmentId();
  const open = useEnvironmentDetailsStore((state) => state.open);
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

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    // The label above the value in a panel narrower than 360px, beside it from there.
    <div className="grid grid-cols-1 items-baseline gap-x-2 gap-y-1 py-1.5 @min-[360px]:grid-cols-[6.5rem_1fr]">
      <span className="text-xs text-fg-subtle">{label}</span>
      <div className="min-w-0 text-sm text-fg-default">{children}</div>
    </div>
  );
}

const SCOPE_OPTION_CLASS = 'flex items-center gap-1.5 text-sm text-fg-default';

/**
 * A workspace environment's **Applies to** (#468): every project, or the ones ticked. Narrowing
 * starts from every project of the workspace, so nothing drops out of a switcher until a box is
 * cleared; clearing every box is allowed and leaves the environment in no project. Each edit is
 * built from the environment as it stands when its turn comes, so an id this machine does not know
 * (a project a teammate has and this machine has not pulled) is kept.
 */
function AppliesTo({
  environment,
  projects,
}: {
  readonly environment: WorkspaceEnvironmentWire;
  readonly projects: readonly WorkspaceProjectWire[];
}) {
  const scoped = environment.projects !== undefined;
  const groupName = `applies-to-${environment.id}`;
  return (
    <fieldset data-testid="environment-applies-to" className="flex min-w-0 flex-col gap-1.5">
      <legend className="sr-only">Applies to</legend>
      <label className={SCOPE_OPTION_CLASS}>
        <input
          type="radio"
          name={groupName}
          checked={!scoped}
          onChange={() => {
            void queueEnvironmentPatch(environment.id, (current) =>
              current.projects === undefined ? undefined : { projects: null },
            );
          }}
        />
        All projects
      </label>
      <label className={SCOPE_OPTION_CLASS}>
        <input
          type="radio"
          name={groupName}
          checked={scoped}
          onChange={() => {
            void queueEnvironmentPatch(environment.id, (current) =>
              current.projects !== undefined ? undefined : { projects: projects.map((project) => project.id) },
            );
          }}
        />
        Selected projects
      </label>
      {scoped && (
        <ul className="flex flex-col gap-1 pl-5">
          {projects.map((project) => (
            <li key={project.id}>
              <label className={SCOPE_OPTION_CLASS}>
                <input
                  type="checkbox"
                  aria-label={`Applies to ${project.name}`}
                  checked={appliesToProject(environment, project.id)}
                  onChange={(event) => {
                    const include = event.currentTarget.checked;
                    void queueEnvironmentPatch(environment.id, (current) => {
                      // Queued behind a switch to All projects: that choice stands, a tick must
                      // not narrow it back to one project.
                      if (current.projects === undefined) {
                        return undefined;
                      }
                      const list = current.projects;
                      if (include === list.includes(project.id)) {
                        return undefined;
                      }
                      return {
                        projects: include ? [...list, project.id] : list.filter((id) => id !== project.id),
                      };
                    });
                  }}
                />
                <span className="min-w-0 truncate">{project.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

/** The slide-over's content: the open environment's details, or nothing when none is open. */
export function EnvironmentDetailsPanel() {
  const environmentId = useOpenEnvironmentId();
  return environmentId === undefined ? null : <EnvironmentDetails environmentId={environmentId} />;
}

/** One environment's details: a workspace environment, or a linked project's own. */
export function EnvironmentDetails({ environmentId }: { readonly environmentId: string }) {
  const workspaceEnvironment = useWorkspaceStore((state) =>
    state.workspace?.environments.find((candidate) => candidate.id === environmentId),
  );
  const projects = useWorkspaceStore((state) => state.workspace?.projects ?? NO_PROJECTS);
  const projectEnvironment = useProjectStore((state) => selectEnvironment(state, environmentId));
  const projectId = useProjectStore((state) => state.projectOf[environmentId]);

  const environment = workspaceEnvironment ?? projectEnvironment;
  if (environment === undefined) {
    return <p className="text-sm text-fg-subtle">This environment no longer exists.</p>;
  }
  const owningProjectName = projects.find((candidate) => candidate.id === projectId)?.name ?? 'This project';
  const variableCount = Object.keys(environment.properties).length;

  // The writes the page made before the panel: a workspace environment's patches are queued (so
  // each is built from the environment as it stands), a linked project's go through its store.
  const update = (patch: { readonly color?: string | null; readonly protected?: boolean }): void => {
    if (workspaceEnvironment !== undefined) {
      void queueEnvironmentPatch(environmentId, () => patch);
    } else if (projectId !== undefined) {
      void useProjectStore.getState().updateEnvironment(projectId, environmentId, patch);
    }
  };

  return (
    <div data-testid="environment-details" className="flex flex-col divide-y divide-hairline">
      <Row label="Name">
        <span data-testid="environment-details-name" className="break-words">
          {environment.name}
        </span>
      </Row>
      <Row label="Scope">
        {workspaceEnvironment !== undefined ? 'Workspace environment' : `${owningProjectName} — linked project`}
      </Row>
      <Row label="Variables">
        <span data-testid="environment-details-variables">
          {variableCount === 1 ? '1 variable' : `${String(variableCount)} variables`}
        </span>
      </Row>
      <Row label="Protected">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            aria-label="Protected"
            data-testid="environment-protected"
            checked={environment.protected === true}
            onChange={() => {
              update({ protected: environment.protected !== true });
            }}
          />
          Ask before every send
        </label>
      </Row>
      <Row label="Colour">
        <EnvironmentColour
          name={environment.name}
          color={environment.color}
          onColor={(color) => {
            update({ color });
          }}
        />
      </Row>
      <Row label="Applies to">
        {workspaceEnvironment !== undefined ? (
          <AppliesTo environment={workspaceEnvironment} projects={projects} />
        ) : (
          // A linked project's own environment belongs to that project; there is no scope to choose.
          <span data-testid="environment-applies-to-fixed" className="text-fg-subtle">
            {owningProjectName} only
          </span>
        )}
      </Row>
    </div>
  );
}
