import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Braces, Check, ChevronDown } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { switcherEnvironments, switcherGroups, type SwitcherGroups } from '../../state/environment-scope.js';
import { selectActiveEnvironmentId, useWorkspaceStore } from '../../state/workspace.js';
import { currentProjectId, useCurrentProjectId } from '../../state/workspace-tabs.js';
import { useUiStore } from '../../state/ui.js';
import type { WorkspaceEnvironmentWire } from '../../../shared/wire-base.js';
import { EnvBadge } from './env-badge.js';
import { openEnvironmentTab, setProjectEnvironment } from './environment-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

const GROUP_LABEL_CLASS = 'px-2 pt-1.5 pb-0.5 text-xs font-medium text-fg-subtle';

/** The label shown for "nothing is active", in the trigger and as the last menu entry. */
export const NO_ENVIRONMENT_LABEL = 'No environment';

/** What the trigger reads while no project tab has been focused yet: there is nothing to switch. */
export const NO_PROJECT_LABEL = 'No project';

/** Stable empty groups, so the switcher does not rerender while there is nothing to offer. */
const NO_GROUPS: SwitcherGroups = { allProjects: [], project: [] };

/**
 * Cycles the current project's active environment (#468) through the environments that apply to
 * it, `No environment` included, and applies the result. Shared by the `env.next` command and the
 * switcher's keyboard affordance. Does nothing while there is no current project.
 *
 * @param step - `1` for the next environment, `-1` for the previous one.
 */
export async function cycleEnvironment(step = 1): Promise<void> {
  const state = useWorkspaceStore.getState();
  const projectId = currentProjectId();
  if (state.workspace === null || projectId === undefined) {
    return;
  }
  // The menu's order: every-project environments, then the project's own.
  const environments = switcherEnvironments(state.workspace, projectId);
  if (environments.length === 0) {
    return;
  }
  // `null` (no environment) sits at index 0, so n environments give n+1 stops.
  const ids: (string | null)[] = [null, ...environments.map((environment) => environment.id)];
  const current = ids.indexOf(selectActiveEnvironmentId(state, projectId) ?? null);
  const next = ids[(current + step + ids.length) % ids.length] ?? null;
  await setProjectEnvironment(projectId, next);
}

/**
 * The title bar's environment dropdown: which environment is active, and how to change it. It
 * sits beside the theme toggle rather than in the status bar because the active environment
 * decides where a Send goes — that belongs where the user looks before sending, not in the
 * strip they read after.
 */
export function EnvSwitcher() {
  // The current project's environments, grouped, and its active one (#468).
  const projectId = useCurrentProjectId();
  const workspace = useWorkspaceStore((state) => state.workspace);
  const groups = useMemo(
    () => (workspace === null || projectId === undefined ? NO_GROUPS : switcherGroups(workspace, projectId)),
    [workspace, projectId],
  );
  const projectName = workspace?.projects.find((project) => project.id === projectId)?.name;
  const activeId = useWorkspaceStore((state) => selectActiveEnvironmentId(state, projectId));
  const open = useUiStore((state) => state.envSwitcherOpen);
  const setOpen = useUiStore((state) => state.setEnvSwitcherOpen);
  const showSidebarView = useUiStore((state) => state.showSidebarView);

  const environments = [...groups.allProjects, ...groups.project];
  const active = environments.find((environment) => environment.id === activeId);
  // Until a project tab has been focused there is no project for a pick to apply to.
  const disabled = projectId === undefined;
  // An open request made while disabled is dropped, not kept: otherwise focusing a project tab
  // later would pop the menu open unasked (Radix resets it only on user interaction).
  useEffect(() => {
    if (disabled && open) {
      setOpen(false);
    }
  }, [disabled, open, setOpen]);

  const select = (environmentId: string | null): void => {
    if (projectId !== undefined) {
      void setProjectEnvironment(projectId, environmentId);
    }
  };

  const item = (environment: WorkspaceEnvironmentWire) => (
    <DropdownMenu.Item
      key={environment.id}
      className={ITEM_CLASS}
      onSelect={() => {
        select(environment.id);
      }}
    >
      <Check
        size={12}
        aria-hidden="true"
        className={environment.id === activeId ? 'text-accent' : 'text-transparent'}
      />
      <EnvBadge color={environment.color} guarded={environment.protected === true} />
      {environment.name}
    </DropdownMenu.Item>
  );

  const group = (label: string, members: readonly WorkspaceEnvironmentWire[]) =>
    members.length === 0 ? null : (
      <DropdownMenu.Group>
        <DropdownMenu.Label data-testid="env-switcher-group" className={GROUP_LABEL_CLASS}>
          {label}
        </DropdownMenu.Label>
        {members.map(item)}
      </DropdownMenu.Group>
    );

  return (
    <DropdownMenu.Root open={open && !disabled} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="env-switcher"
          disabled={disabled}
          aria-label={projectName === undefined ? 'Active environment' : `Active environment for ${projectName}`}
          title={disabled ? 'Open a request to choose its project\u2019s environment' : undefined}
          // `wb-no-drag`: the title bar drags the window, so every control on it has to opt out.
          className="wb-no-drag inline-flex h-row max-w-64 items-center gap-1.5 rounded-md border border-hairline bg-surface-raised px-2 text-xs text-fg-muted transition-colors hover:border-hairline-strong hover:text-fg-default disabled:cursor-default disabled:opacity-60 disabled:hover:border-hairline disabled:hover:text-fg-muted"
        >
          <Braces size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
          {disabled ? (
            <span className="min-w-0 truncate">{NO_PROJECT_LABEL}</span>
          ) : (
            <>
              {/* The project a pick applies to: each project keeps its own active environment. */}
              <span data-testid="env-switcher-project" className="max-w-24 min-w-0 truncate text-fg-subtle">
                {projectName}
              </span>
              <span aria-hidden="true" className="text-fg-subtle">
                ·
              </span>
              <EnvBadge color={active?.color} guarded={active?.protected === true} />
              <span className="min-w-0 truncate">{active?.name ?? NO_ENVIRONMENT_LABEL}</span>
            </>
          )}
          <ChevronDown size={11} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          className="z-dropdown min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {group('All projects', groups.allProjects)}
          {group(projectName ?? 'This project', groups.project)}
          {environments.length > 0 && <DropdownMenu.Separator className="my-1 h-px bg-hairline" />}
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              select(null);
            }}
          >
            <Check
              size={12}
              aria-hidden="true"
              className={activeId === undefined ? 'text-accent' : 'text-transparent'}
            />
            {NO_ENVIRONMENT_LABEL}
          </DropdownMenu.Item>
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              showSidebarView('environments');
              // Also opens the active environment's editor tab, when there is one — the sidebar
              // list alone does not show its contents.
              const target = activeId ?? environments[0]?.id;
              if (target !== undefined) {
                openEnvironmentTab({ kind: 'environment', id: target });
              }
            }}
          >
            Manage environments…
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
