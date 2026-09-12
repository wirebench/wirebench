import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Braces, Check, ChevronDown } from 'lucide-react';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useUiStore } from '../../state/ui.js';
import type { WorkspaceEnvironmentWire } from '../../../shared/wire-types.js';
import { openEnvironmentTab } from './environment-actions.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/** The label shown for "nothing is active", in the trigger and as the last menu entry. */
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

/**
 * The title bar's environment dropdown: which environment is active, and how to change it. It
 * sits beside the theme toggle rather than in the status bar because the active environment
 * decides where a Send goes — that belongs where the user looks before sending, not in the
 * strip they read after.
 */
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
          // `wb-no-drag`: the title bar drags the window, so every control on it has to opt out.
          className="wb-no-drag inline-flex h-row max-w-48 items-center gap-1.5 rounded-md border border-hairline bg-surface-raised px-2 text-xs text-fg-muted transition-colors hover:border-hairline-strong hover:text-fg-default"
        >
          <Braces size={12} aria-hidden="true" className="shrink-0 text-fg-subtle" />
          <span className="min-w-0 truncate">{active?.name ?? NO_ENVIRONMENT_LABEL}</span>
          <ChevronDown size={11} aria-hidden="true" className="shrink-0 text-fg-subtle" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
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
