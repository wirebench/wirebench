/**
 * The open environment, in the right slide-over (where the Code panel shows for a request): its
 * name, where it lives, whether it is protected and how many variables it sets, and the two
 * settings that change how it is offered — its **Colour** (#345) and whether it is protected. For a
 * workspace environment it also reads which projects it **Applies to** (#468); the choice itself is
 * made in the Projects panel (#393), which **Choose projects…** opens in its place. The page beside
 * it keeps the name, the Active toggle and the variables. The right rail's icon, its close icon and
 * Escape put the panel away.
 */
import type { ReactNode } from 'react';
import { EnvironmentColour } from './environment-look.js';
import { queueEnvironmentPatch } from './environment-queue.js';
import type { WorkspaceEnvironmentWire, WorkspaceProjectWire } from '../../../shared/wire-base.js';
import { useEditorsStore } from '../../state/editors.js';
import { appliesToProject } from '../../state/environment-scope.js';
import { selectEnvironment, useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';

/**
 * Whether the panel is wanted. Kept with the window layout (`slideOver.environmentDetailsOpen`), as
 * Host details is, so it stays as it was left when you come back to an environment, after a restart
 * too. Open until it is first put away, so an environment's colour is in view when it opens.
 */
export function useEnvironmentDetailsOpen(): boolean {
  return useUiStore((state) => state.slideOver.environmentDetailsOpen !== false);
}

/** {@link useEnvironmentDetailsOpen}, read outside React. */
export function environmentDetailsOpen(): boolean {
  return useUiStore.getState().slideOver.environmentDetailsOpen !== false;
}

/** Shows or puts away the panel, and remembers it. */
export function setEnvironmentDetailsOpen(open: boolean): void {
  useUiStore.getState().setEnvironmentDetailsOpen(open);
}

/**
 * The real environment the tab in front edits: `undefined` on Globals, Workspace, the SSH area,
 * another kind of tab, or no tab. Opening a row is what opens its tab, so this covers both.
 */
export function useOpenEnvironmentId(): string | undefined {
  return useEditorsStore((state) => {
    if (state.displayedSet !== 'explorer') return undefined;
    const tab = state.tabs.find((candidate) => candidate.id === state.activeId);
    if (tab?.kind !== 'environment') return undefined;
    const id = tab.environmentId;
    return id === undefined || id === 'globals' || id === 'workspace' ? undefined : id;
  });
}

/**
 * Whether the panel is in front: an environment that still exists is open, the panel was not put
 * away, and the Projects panel (#393) is not showing in its place.
 */
export function useEnvironmentDetailsShown(): boolean {
  const environmentId = useOpenEnvironmentId();
  const wanted = useEnvironmentDetailsOpen();
  const projectsInstead = useUiStore((state) => state.slideOver.environmentProjectsOpen === true);
  const open = wanted && !projectsInstead;
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

/**
 * What a workspace environment's **Applies to** reads (#468): every project, the ticked ones by
 * name, or *No project*. The choice itself is made in the Projects panel (#393).
 */
function appliesToSummary(environment: WorkspaceEnvironmentWire, projects: readonly WorkspaceProjectWire[]): string {
  if (environment.projects === undefined) return 'All projects';
  const names = projects.filter((project) => appliesToProject(environment, project.id)).map((project) => project.name);
  return names.length === 0 ? 'No project' : names.join(', ');
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
          <div className="flex min-w-0 flex-col items-start gap-1">
            <span data-testid="environment-applies-to" className="break-words">
              {appliesToSummary(workspaceEnvironment, projects)}
            </span>
            <button
              type="button"
              data-testid="environment-choose-projects"
              className="text-xs text-accent hover:underline"
              onClick={() => {
                useUiStore.getState().setEnvironmentProjectsOpen(true);
              }}
            >
              Choose projects…
            </button>
          </div>
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
