/**
 * The Explorer's Start page: what shows in the editor while no tab is open. It never only describes the
 * empty space — it offers the next step. A project with nothing in it yet offers the three ways to put
 * something there; otherwise the page offers a new request, an import, and the way to another workspace.
 */
import { Box, Send } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ActionEmptyState } from '../../components/empty-state.js';
import { kindTarget } from '../../commands/command-helpers.js';
import { useProjectStore, type ProjectSnapshot } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { WorkspaceProjectWire } from '../../../shared/wire-base.js';
import { explorerActions } from './explorer-actions.js';
import { projectRowActions } from './project-actions.js';
import { buildExplorerTree } from './tree-nodes.js';
import { workspaceActions } from '../workspace/workspace-actions.js';

/** Stable empty projects, so the page does not rerender while no workspace is open. */
const NO_PROJECTS: readonly WorkspaceProjectWire[] = [];

/** Whether a project's tree would show nothing under its row: no API, interface, sequence, mock or webhook. */
export function projectIsEmpty(state: ProjectSnapshot, projectId: string): boolean {
  const [root] = buildExplorerTree(
    [{ id: projectId, name: '', source: 'internal', dir: '', status: 'ready' }],
    state.order,
    state.interfaces,
    Object.values(state.requests),
    state.rest,
    undefined,
    state.grpc,
    state.ws,
    state.sequenceLists,
    undefined,
    state.webhooks,
    {},
    state.mockLists,
    { [projectId]: state.projects[projectId]?.unsupported ?? [] },
    state.mcp,
  );
  return (root?.children ?? []).length === 0;
}

/**
 * The project the page speaks for: the one selected in the Explorer, or the workspace's only project. With
 * several projects and none selected there is no one project to talk about.
 */
function targetProject(
  projects: readonly WorkspaceProjectWire[],
  selection: { readonly kind: string; readonly id: string } | undefined,
): WorkspaceProjectWire | undefined {
  if (selection?.kind === 'project') return projects.find((project) => project.id === selection.id);
  return projects.length === 1 ? projects[0] : undefined;
}

/** The REST API a new request lands in: the selection's, else the first one in the target project or workspace. */
function restApiFor(
  state: ProjectSnapshot,
  projects: readonly WorkspaceProjectWire[],
  target: WorkspaceProjectWire | undefined,
  selection: ReturnType<typeof useUiStore.getState>['selection'],
): string | undefined {
  const selected = kindTarget('rest', selection)?.apiId;
  if (selected !== undefined) return selected;
  for (const project of target === undefined ? projects : [target]) {
    const api = state.rest[project.id]?.apis[0];
    if (api !== undefined) return api.id;
  }
  return undefined;
}

export function StartPage() {
  const projects = useWorkspaceStore((state) => state.workspace?.projects ?? NO_PROJECTS);
  const hasWorkspace = useWorkspaceStore((state) => state.workspace !== null);
  const selection = useUiStore((state) => state.selection);
  const openImportDialog = useUiStore((state) => state.openImportDialog);
  const target = targetProject(projects, selection);
  const name = useProjectStore((state) =>
    target === undefined ? undefined : (state.projects[target.id]?.name ?? target.name),
  );
  const empty = useProjectStore(
    (state) => target !== undefined && target.status === 'ready' && projectIsEmpty(state, target.id),
  );
  const restApiId = useProjectStore((state) => restApiFor(state, projects, target, selection));
  const noProjects = hasWorkspace && projects.length === 0;

  if (target !== undefined && empty) {
    const projectId = target.id;
    return (
      <ActionEmptyState
        icon={Box}
        testId="start-empty-project"
        text={`${name ?? 'This project'} has no APIs yet. Add one, or import a definition or a cURL command.`}
      >
        <Button
          variant="primary"
          onClick={() => {
            explorerActions.newApi(projectId);
          }}
        >
          New REST API…
        </Button>
        <Button
          onClick={() => {
            projectRowActions.importInto(projectId);
          }}
        >
          Import definition…
        </Button>
        <Button
          onClick={() => {
            explorerActions.importCurlIntoNewApi(projectId);
          }}
        >
          Import cURL…
        </Button>
      </ActionEmptyState>
    );
  }

  return (
    <ActionEmptyState icon={Send} testId="start-actions" text="Open a request from the Explorer, or start from here.">
      {restApiId !== undefined && (
        <Button
          variant="primary"
          onClick={() => {
            const container = kindTarget('rest', useUiStore.getState().selection);
            explorerActions.newRestRequest(container?.apiId ?? restApiId, container?.folderId);
          }}
        >
          New request
        </Button>
      )}
      {/* An empty workspace offers what the Explorer's own empty state offers, in its order (#686 E20). */}
      {noProjects && (
        <Button
          variant="primary"
          onClick={() => {
            workspaceActions.newProject();
          }}
        >
          New project
        </Button>
      )}
      <Button
        variant={restApiId === undefined && !noProjects ? 'primary' : 'secondary'}
        onClick={() => {
          openImportDialog();
        }}
      >
        Import…
      </Button>
      {hasWorkspace && (
        <Button
          onClick={() => {
            // Deferred a tick, as the palette's Switch Workspace… is: the click's own focus handling would
            // otherwise close the dropdown it opens.
            setTimeout(() => {
              useUiStore.getState().setWorkspaceSwitcherOpen(true);
            }, 0);
          }}
        >
          Switch workspace…
        </Button>
      )}
    </ActionEmptyState>
  );
}
