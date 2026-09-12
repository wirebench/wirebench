import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronsUpDown } from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useUiStore } from '../../state/ui.js';
import type { WorkspaceEnvironmentWire } from '../../../shared/wire-types.js';
import { openEnvironmentTab } from './environment-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/** The label the status bar shows for whichever environment is active. */
export const NO_ENVIRONMENT_LABEL = 'No environment';

/** A stable empty list, so the switcher does not rerender while no workspace is open. */
const NO_ENVIRONMENTS: readonly WorkspaceEnvironmentWire[] = [];

/**
 * Cycles the active environment, `No environment` included, and applies the result. Shared by
 * the `env.next` command and the switcher's keyboard affordance.
 *
 * @param step - `1` for the next environment, `-1` for the previous one.
 */
export async function cycleEnvironment(step = 1): Promise<void> {
  const { workspace, setActiveEnvironment } = useWorkspaceStore.getState();
  const environments = workspace?.environments ?? [];
  if (environments.length === 0) {
    return;
  }
  // `null` (no environment) sits at index 0, so n environments give n+1 stops.
  const ids: (string | null)[] = [null, ...environments.map((environment) => environment.id)];
  const current = ids.indexOf(workspace?.activeEnvironmentId ?? null);
  const next = ids[(current + step + ids.length) % ids.length] ?? null;
  await setActiveEnvironment(next);
}

/** The status bar's environment dropdown: which environment is active, and how to change it. */
export function EnvSwitcher() {
  const environments = useWorkspaceStore((state) => state.workspace?.environments ?? NO_ENVIRONMENTS);
  const activeId = useWorkspaceStore((state) => state.workspace?.activeEnvironmentId);
  const setActiveEnvironment = useWorkspaceStore((state) => state.setActiveEnvironment);
  const open = useUiStore((state) => state.envSwitcherOpen);
  const setOpen = useUiStore((state) => state.setEnvSwitcherOpen);
  const showSidebarView = useUiStore((state) => state.showSidebarView);

  const active = environments.find((environment) => environment.id === activeId);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid="env-switcher"
          aria-label="Active environment"
          className="inline-flex items-center gap-1 rounded px-1 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
        >
          {active?.name ?? NO_ENVIRONMENT_LABEL}
          <ChevronsUpDown size={11} aria-hidden="true" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={4}
          className="min-w-48 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {environments.map((environment) => (
            <DropdownMenu.Item
              key={environment.id}
              className={ITEM_CLASS}
              onSelect={() => {
                void setActiveEnvironment(environment.id);
              }}
            >
              <Check
                size={12}
                aria-hidden="true"
                className={environment.id === activeId ? 'text-accent' : 'text-transparent'}
              />
              {environment.name}
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Item
            className={ITEM_CLASS}
            onSelect={() => {
              void setActiveEnvironment(null);
            }}
          >
            <Check
              size={12}
              aria-hidden="true"
              className={activeId === undefined ? 'text-accent' : 'text-transparent'}
            />
            {NO_ENVIRONMENT_LABEL}
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
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
