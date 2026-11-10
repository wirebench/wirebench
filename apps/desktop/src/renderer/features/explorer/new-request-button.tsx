/**
 * **New request** in the Explorer's header: a request in the selected API, the API of the selected request or
 * folder, or the API of the request open in front. With none of those it opens a list of the workspace's APIs
 * to pick one from, since a request is always made in an API.
 */
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { FilePlus } from 'lucide-react';
import { useMemo } from 'react';
import type { KindId } from '@shared/kinds/kind-module.js';
import { IconButton } from '../../components/icon-button.js';
import { Tooltip } from '../../components/tooltip.js';
import { kindTarget } from '../../commands/command-helpers.js';
import { kindExplorer } from '../../kinds/index.js';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore, type ProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import type { TabContainer } from '../../kinds/tab-contribution.js';

/** The kinds whose APIs hold requests, in the order the chooser lists them. */
const REQUEST_KINDS: readonly KindId[] = ['rest', 'grpc', 'websocket', 'mcp'];

/** Where the header's New request creates: the kind and its API (and folder), or nothing to go on. */
export function newRequestTarget(): { readonly kind: KindId; readonly container: TabContainer } | undefined {
  const selection = useUiStore.getState().selection;
  for (const kind of REQUEST_KINDS) {
    if (kindExplorer(kind)?.newRequestIn === undefined) continue;
    const container = kindTarget(kind, selection);
    if (container !== undefined) return { kind, container };
  }
  return undefined;
}

/** Makes a request in `container`, of `kind`. */
function newRequestIn(kind: KindId, container: TabContainer): void {
  kindExplorer(kind)?.newRequestIn?.(container.apiId, container.folderId);
}

/** One API the chooser offers. */
export interface ChooserApi {
  readonly kind: KindId;
  readonly apiId: string;
  readonly name: string;
  readonly project: string;
}

type ChoiceState = Pick<ProjectStore, 'projects' | 'projectOf' | 'apis' | 'grpcApis' | 'wsApis' | 'mcpServers'>;

/** Every API of the open projects a request can be made in, by project then name: what the chooser lists. */
export function requestApiChoices(state: ChoiceState): readonly ChooserApi[] {
  const of = (kind: KindId, map: Readonly<Record<string, { readonly id: string; readonly name: string }>>) =>
    Object.values(map).map((api) => ({
      kind,
      apiId: api.id,
      name: api.name,
      project: state.projects[state.projectOf[api.id] ?? '']?.name ?? '',
    }));
  return [
    ...of('rest', state.apis),
    ...of('grpc', state.grpcApis),
    ...of('websocket', state.wsApis),
    ...of('mcp', state.mcpServers),
  ].sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
}

/** Makes a request in the API a chooser row names. */
export function newRequestInChoice(choice: ChooserApi): void {
  newRequestIn(choice.kind, { apiId: choice.apiId });
}

const MENU_CLASS =
  'z-dropdown max-h-96 min-w-48 overflow-y-auto rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';
const ITEM_CLASS =
  'flex cursor-pointer items-center justify-between gap-4 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

export function NewRequestButton() {
  // Read so the button re-renders as the selection and the tab in front change; the target is read on click.
  useUiStore((state) => state.selection);
  useEditorsStore((state) => state.activeId);
  const projects = useProjectStore((state) => state.projects);
  const projectOf = useProjectStore((state) => state.projectOf);
  const apis = useProjectStore((state) => state.apis);
  const grpcApis = useProjectStore((state) => state.grpcApis);
  const wsApis = useProjectStore((state) => state.wsApis);
  const mcpServers = useProjectStore((state) => state.mcpServers);
  const choices = useMemo(
    () => requestApiChoices({ projects, projectOf, apis, grpcApis, wsApis, mcpServers }),
    [projects, projectOf, apis, grpcApis, wsApis, mcpServers],
  );

  const target = newRequestTarget();
  if (target !== undefined) {
    return (
      <IconButton
        data-testid="explorer-new-request"
        label="New request"
        onClick={() => {
          const now = newRequestTarget();
          if (now !== undefined) newRequestIn(now.kind, now.container);
        }}
      >
        <FilePlus size={14} aria-hidden="true" />
      </IconButton>
    );
  }

  return (
    <DropdownMenu.Root>
      <Tooltip label="New request…">
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            data-testid="explorer-new-request"
            aria-label="New request…"
            className="inline-flex size-7 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-default"
          >
            <FilePlus size={14} aria-hidden="true" />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" className={MENU_CLASS} data-testid="explorer-new-request-menu">
          <DropdownMenu.Label className="px-2 py-1 text-xs text-fg-subtle">New request in…</DropdownMenu.Label>
          {choices.length === 0 ? (
            <DropdownMenu.Item disabled className={`${ITEM_CLASS} text-fg-subtle`}>
              No APIs yet: make one from a project’s New menu
            </DropdownMenu.Item>
          ) : (
            choices.map((choice) => (
              <DropdownMenu.Item key={choice.apiId} className={ITEM_CLASS} onSelect={() => newRequestInChoice(choice)}>
                <span className="truncate">{choice.name}</span>
                <span className="truncate text-xs text-fg-subtle">{choice.project}</span>
              </DropdownMenu.Item>
            ))
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
