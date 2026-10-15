import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import type { CommandCategory } from '@shared/commands.js';
import { explorerActions } from '../features/explorer/explorer-actions.js';
import { RENDERER_KINDS, rendererKind } from '../kinds/index.js';
import { connectQuick, openInNewTab, openTerminalFor, saveQuickAsHost } from '../features/ssh/connect.js';
import { parseQuickTarget, quickTargetName } from '../features/ssh/quick-hosts.js';
import { filesTitle, openFiles } from '../features/ssh/files/open-files.js';
import { flattenGroups, useHostsStore } from '../features/ssh/hosts-store.js';
import { refreshLayouts, useLayoutsStore } from '../features/ssh/panes/layouts-store.js';
import { openLayout } from '../features/ssh/panes/open-layout.js';
import { routeOf } from '../features/ssh/forwarding/forward-format.js';
import { startForward, stopForward } from '../features/ssh/forwarding/forward-actions.js';
import { useForwardsStore } from '../features/ssh/forwarding/forwards-store.js';
import { useRecentConnections } from '../features/ssh/recent-connections.js';
import { startRun } from '../features/ssh/snippets/run.js';
import { loadSnippets } from '../features/ssh/snippets/snippet-actions.js';
import { useSnippetsStore } from '../features/ssh/snippets/snippets-store.js';
import type { CommandContext } from '../lib/commands.js';
import { listPaletteCommands, runCommand, type PaletteCommand } from '../lib/commands.js';
import { effectiveShortcut, formatKeybinding } from '../lib/keybindings.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';
import { paletteFilter, paletteKeywords } from './palette-filter.js';
import type { QuickOpenEntry } from './quick-open.js';
import {
  quickOpenEntries,
  quickOpenHostEntries,
  quickOpenKindEntries,
  quickOpenLayoutEntries,
  quickOpenSnippetEntries,
  splitRecentHosts,
} from './quick-open.js';

/**
 * Which list the palette is showing: every command (⌘K), operations/requests/hosts (⌘P), or only hosts, to
 * connect to (`hosts`), to open in another terminal tab (`new-tab-hosts`) or to open the Files tab of
 * (`files-hosts`), or only the saved terminal layouts (`layouts`), or the port forwards to start (every rule that
 * is on, `start-forward`) or to stop (every one this window runs or has failed, `stop-forward`), or only the
 * snippets, to run (`snippets`).
 */
export type PaletteMode =
  | 'commands'
  | 'quick-open'
  | 'hosts'
  | 'new-tab-hosts'
  | 'files-hosts'
  | 'layouts'
  | 'start-forward'
  | 'stop-forward'
  | 'snippets';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly context: CommandContext;
  /** Defaults to the command list; `quick-open` is ⌘P's operations/requests/hosts list, `hosts` the host picker. */
  readonly mode?: PaletteMode;
}

const GROUP_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-faint [&_[cmdk-group-heading]]:uppercase';

/**
 * One host row: select connects, or brings forward the terminal already open for it; a `files` row opens
 * (or brings forward) the host's Files tab instead, and a `newTab` row always opens another terminal tab.
 */
function HostItem({
  entry,
  onOpenChange,
  files = false,
  newTab = false,
}: {
  readonly entry: QuickOpenEntry;
  readonly onOpenChange: (open: boolean) => void;
  readonly files?: boolean;
  readonly newTab?: boolean;
}) {
  return (
    <Command.Item
      // The Files rows of ⌘P sit beside the host rows, so their value differs and says "files".
      value={files ? `${entry.value} files` : entry.value}
      data-testid={files ? 'quick-open-host-files' : 'quick-open-host'}
      onSelect={() => {
        onOpenChange(false);
        if (entry.hostId === undefined) return;
        if (files) openFiles(entry.hostId);
        else if (newTab) openInNewTab(entry.hostId);
        else openTerminalFor(entry.hostId);
      }}
      className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
    >
      <span className="truncate">{files ? filesTitle(entry.label) : entry.label}</span>
      <span className="truncate text-xs text-fg-subtle">{entry.detail}</span>
    </Command.Item>
  );
}

/** One snippet row: select runs it into the terminal in front, or opens the run dialog when the run must ask. */
function SnippetItem({
  entry,
  onOpenChange,
  quickOpen,
}: {
  readonly entry: QuickOpenEntry;
  readonly onOpenChange: (open: boolean) => void;
  readonly quickOpen: boolean;
}) {
  return (
    <Command.Item
      // ⌘P mixes snippets with hosts and requests, so there the value says "snippet".
      value={quickOpen ? `${entry.value} snippet` : entry.value}
      data-testid="palette-snippet"
      data-name={entry.label}
      onSelect={() => {
        onOpenChange(false);
        const item = useSnippetsStore.getState().snippets.find((s) => s.id === entry.snippetId);
        if (item !== undefined) startRun(item);
      }}
      className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
    >
      <span className="truncate">{entry.label}</span>
      <span className="truncate font-mono text-xs text-fg-subtle">{entry.detail}</span>
    </Command.Item>
  );
}

function groupByCategory(rows: readonly PaletteCommand[]): readonly (readonly [CommandCategory, PaletteCommand[]])[] {
  const groups = new Map<CommandCategory, PaletteCommand[]>();
  for (const row of rows) {
    const bucket = groups.get(row.command.category);
    if (bucket === undefined) {
      groups.set(row.command.category, [row]);
    } else {
      bucket.push(row);
    }
  }
  return [...groups.entries()];
}

/** What {@link rankGroups} scores an item by. */
interface PaletteNamed {
  readonly category: string;
  readonly label: string;
}

/**
 * The groups with the best match first, for a non-empty search. cmdk ranks the items inside a group
 * but leaves the groups in the order they were rendered (alphabetical by category), so "HTTP Log"
 * used to select a Secrets command over View's Show HTTP Log. Each group scores as its best item,
 * by the same filter, value and keywords the items are matched on; ties keep order.
 *
 * @param nameOf - A group item's command, for groups of palette rows rather than of commands.
 */
export function rankGroups<T, G extends readonly [CommandCategory, readonly T[]]>(
  groups: readonly G[],
  search: string,
  nameOf: (item: T) => PaletteNamed = (item) => item as PaletteNamed,
): readonly G[] {
  if (search.trim() === '') {
    return groups;
  }
  const score = (named: PaletteNamed): number =>
    paletteFilter(`${named.category} ${named.label}`, search, paletteKeywords(named));
  const best = (items: G[1]): number => Math.max(0, ...items.map((item) => score(nameOf(item))));
  return groups
    .map((group, index) => ({ group, index, score: best(group[1]) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ group }) => group);
}

/**
 * ⌘K / ⌘⇧P — everything the app can do, listed from the same registry that drives the
 * keybindings — and ⌘P, the same dialog in quick-open mode over operations and requests.
 */
export function CommandPalette({ open, onOpenChange, context, mode = 'commands' }: CommandPaletteProps) {
  // `listPaletteCommands` is filtered by `when`, whose predicates (e.g. "a workspace is open") read
  // stores that are *not* part of `context` (workspace, selection-adjacent project state, …), so
  // `context`'s own identity can stay unchanged across a state change that should still affect
  // what is listed. `open` is in the dependency list for exactly that reason: every reopen
  // re-evaluates `when` against the current world, rather than reusing whatever was computed the
  // last time `context` itself happened to change identity — which, before this, only reliably
  // happened once, coincidentally, from a library's mount-time resize callback.
  const groups = useMemo(() => groupByCategory(listPaletteCommands(context)), [context, open]);
  const [search, setSearch] = useState('');
  // A new mode or a reopen starts from an empty search, as the keyed `Command` below does.
  useEffect(() => {
    setSearch('');
  }, [mode, open]);
  const rankedGroups = useMemo(
    () => rankGroups(groups, search, (row: PaletteCommand) => row.command),
    [groups, search],
  );
  const interfaces = useProjectStore((state) => state.interfaces);
  const requests = useProjectStore((state) => state.requests);
  const projectOf = useProjectStore((state) => state.projectOf);
  const projects = useProjectStore((state) => state.projects);
  const projectNames = useMemo(
    () => Object.fromEntries(Object.entries(projects).map(([id, project]) => [id, project.name])),
    [projects],
  );
  // Every other kind's saved requests, each kind listing its own (a switched-off kind lists none).
  const project = useProjectStore((state) => state);
  const enabledKinds = useUiStore((state) => state.enabledKinds);
  const kindRequests = useMemo(
    () =>
      mode === 'quick-open'
        ? RENDERER_KINDS.filter((kind) => enabledKinds.includes(kind.kind)).flatMap((kind) =>
            quickOpenKindEntries(kind.kind, kind.requests.quickOpen?.(project) ?? [], {
              folders: project.folders,
              projectOf,
              projectNames,
            }),
          )
        : [],
    [mode, enabledKinds, project, projectOf, projectNames],
  );
  const entries = useMemo(
    () => (mode === 'quick-open' ? quickOpenEntries(interfaces, requests, projectOf, projectNames, kindRequests) : []),
    [mode, interfaces, requests, projectOf, projectNames, kindRequests],
  );
  // A switched-off ssh area contributes no hosts, in quick-open or in the host picker.
  const sshEnabled = useUiStore((state) => state.enabledAreas.includes('ssh'));
  const resolvedHosts = useHostsStore((state) => state.resolved);
  const hostsFile = useHostsStore((state) => state.file);
  const hostEntries = useMemo(
    () =>
      sshEnabled && (mode === 'quick-open' || mode === 'hosts' || mode === 'new-tab-hosts' || mode === 'files-hosts')
        ? quickOpenHostEntries(
            resolvedHosts,
            new Map(flattenGroups(hostsFile).map(({ group }) => [group.id, group.name] as const)),
          )
        : [],
    [sshEnabled, mode, resolvedHosts, hostsFile],
  );
  // The saved layouts: ⌘P lists them under their own heading, and Open Layout… lists only them.
  const layoutsWanted = sshEnabled && (mode === 'quick-open' || mode === 'layouts');
  useEffect(() => {
    if (open && layoutsWanted) refreshLayouts();
  }, [open, layoutsWanted]);
  const layouts = useLayoutsStore((state) => state.layouts);
  const layoutEntries = useMemo(
    () =>
      layoutsWanted
        ? quickOpenLayoutEntries(layouts, (hostId) => resolvedHosts.find((host) => host.id === hostId)?.name ?? hostId)
        : [],
    [layoutsWanted, layouts, resolvedHosts],
  );
  // Start port forward… lists every rule that is on as `host · rule`; Stop port forward… what this window has.
  const forwardStates = useForwardsStore((state) => state.byKey);
  const forwardEntries = useMemo(() => {
    if (!sshEnabled) return [];
    const nameOf = (hostId: string): string => resolvedHosts.find((host) => host.id === hostId)?.name ?? hostId;
    if (mode === 'start-forward') {
      return resolvedHosts.flatMap((host) =>
        host.forwards
          .filter((forward) => forward.enabled)
          .map((forward) => ({
            key: `${host.id}/${forward.rule.id}`,
            hostId: host.id,
            ruleId: forward.rule.id,
            label: `${host.name} · ${forward.rule.id}`,
            detail: routeOf(forward.rule),
          })),
      );
    }
    if (mode === 'stop-forward') {
      return Object.entries(forwardStates).map(([key, state]) => ({
        key,
        hostId: state.hostId,
        ruleId: state.ruleId,
        label: `${nameOf(state.hostId)} · ${state.ruleId}`,
        detail: `${state.status.state} on ${String(state.port)}`,
      }));
    }
    return [];
  }, [sshEnabled, mode, resolvedHosts, forwardStates]);
  // The saved snippets: ⌘P lists them under their own heading, and Run Snippet… lists only them.
  const snippetsWanted = sshEnabled && (mode === 'quick-open' || mode === 'snippets');
  useEffect(() => {
    if (open && snippetsWanted) void loadSnippets();
  }, [open, snippetsWanted]);
  const snippets = useSnippetsStore((state) => state.snippets);
  const snippetEntries = useMemo(
    () => (snippetsWanted ? quickOpenSnippetEntries(snippets) : []),
    [snippetsWanted, snippets],
  );
  // The hosts connected to lately lead, under their own heading.
  const recentConnections = useRecentConnections();
  const { recent: recentHosts, rest: otherHosts } = useMemo(
    () =>
      splitRecentHosts(
        hostEntries,
        recentConnections.map((entry) => entry.hostId),
      ),
    [hostEntries, recentConnections],
  );
  const quickOpen = mode === 'quick-open';
  const filesPicker = mode === 'files-hosts';
  const newTabPicker = mode === 'new-tab-hosts';
  const layoutsPicker = mode === 'layouts';
  const forwardPicker = mode === 'start-forward' || mode === 'stop-forward';
  const snippetsPicker = mode === 'snippets';
  const hostsOnly = mode === 'hosts' || filesPicker || newTabPicker;
  const picker = quickOpen || hostsOnly || layoutsPicker || forwardPicker || snippetsPicker;
  // A search that names a server (`user@host:port`) can connect to it without saving it first (#537).
  const quickTarget = sshEnabled && (mode === 'hosts' || newTabPicker) ? parseQuickTarget(search) : undefined;
  const title = snippetsPicker
    ? 'Run snippet'
    : forwardPicker
      ? mode === 'start-forward'
        ? 'Start port forward'
        : 'Stop port forward'
      : layoutsPicker
        ? 'Open layout'
        : filesPicker
          ? 'Open files on host'
          : newTabPicker
            ? 'Open host in new tab'
            : hostsOnly
              ? 'Connect to host'
              : quickOpen
                ? 'Go to operation or request'
                : 'Command palette';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[18%] left-1/2 w-[min(560px,90vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-hairline-strong bg-surface-overlay shadow-2xl"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {/* Keyed on the mode so a switch (⌘K to the host picker) starts with an empty search. */}
          <Command
            key={mode}
            loop
            // The commands rank a search naming their group first; the pickers keep cmdk's own order.
            {...(picker ? {} : { filter: paletteFilter })}
            label={
              snippetsPicker
                ? 'Snippets'
                : forwardPicker
                  ? 'Port forwards'
                  : layoutsPicker
                    ? 'Layouts'
                    : hostsOnly
                      ? 'Hosts'
                      : quickOpen
                        ? 'Operations, requests and hosts'
                        : 'Commands'
            }
          >
            <Command.Input
              autoFocus
              onValueChange={setSearch}
              data-testid={picker ? 'quick-open-input' : 'command-palette-input'}
              placeholder={picker ? title : 'Search or run a command'}
              className="h-10 w-full border-b border-hairline bg-transparent px-3 text-md text-fg-default outline-none placeholder:text-fg-faint"
            />
            <Command.List className="max-h-[320px] overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">
                {snippetsPicker
                  ? 'No matching snippet.'
                  : forwardPicker
                    ? 'No matching forward.'
                    : layoutsPicker
                      ? 'No matching layout.'
                      : hostsOnly
                        ? 'No matching host.'
                        : quickOpen
                          ? 'No matching operation or request.'
                          : 'No matching command.'}
              </Command.Empty>
              {quickOpen &&
                entries.map((entry) => (
                  <Command.Item
                    key={entry.key}
                    value={entry.value}
                    data-testid="quick-open-item"
                    data-kind={entry.requestKind ?? 'soap'}
                    onSelect={() => {
                      onOpenChange(false);
                      if (entry.requestKind !== undefined && entry.requestId !== undefined) {
                        rendererKind(entry.requestKind).requests.open(entry.requestId);
                      } else if (entry.kind === 'request') {
                        explorerActions.openRequest(entry.requestId);
                      } else {
                        explorerActions.newRequest(entry.interfaceId, entry.bindingName, entry.operationName);
                      }
                    }}
                    className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                  >
                    <span className="truncate">{entry.label}</span>
                    <span className="truncate text-xs text-fg-subtle">{entry.detail}</span>
                  </Command.Item>
                ))}
              {quickTarget !== undefined && (
                <Command.Group heading="Server" className={GROUP_CLASS}>
                  {/* Valued with the search itself, so cmdk keeps both rows whatever was typed. */}
                  <Command.Item
                    value={`${search} connect`}
                    data-testid="quick-connect"
                    onSelect={() => {
                      onOpenChange(false);
                      connectQuick(quickTarget, newTabPicker);
                    }}
                    className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                  >
                    <span className="truncate">{`Connect to ${quickTargetName(quickTarget)}`}</span>
                    <span className="truncate text-xs text-fg-subtle">not saved · SSH agent</span>
                  </Command.Item>
                  <Command.Item
                    value={`${search} save as host`}
                    data-testid="quick-connect-save"
                    onSelect={() => {
                      onOpenChange(false);
                      saveQuickAsHost(quickTarget);
                    }}
                    className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                  >
                    <span className="truncate">Save as host…</span>
                  </Command.Item>
                </Command.Group>
              )}
              {picker && recentHosts.length > 0 && (
                <Command.Group heading="Recent" className={GROUP_CLASS}>
                  {recentHosts.map((entry) => (
                    <HostItem
                      key={entry.key}
                      entry={entry}
                      onOpenChange={onOpenChange}
                      files={filesPicker}
                      newTab={newTabPicker}
                    />
                  ))}
                </Command.Group>
              )}
              {picker && otherHosts.length > 0 && (
                <Command.Group heading="Hosts" className={GROUP_CLASS}>
                  {otherHosts.map((entry) => (
                    <HostItem
                      key={entry.key}
                      entry={entry}
                      onOpenChange={onOpenChange}
                      files={filesPicker}
                      newTab={newTabPicker}
                    />
                  ))}
                </Command.Group>
              )}
              {layoutEntries.length > 0 && (
                <Command.Group heading="Layouts" className={GROUP_CLASS}>
                  {layoutEntries.map((entry) => (
                    <Command.Item
                      key={entry.key}
                      value={`${entry.value} layout`}
                      data-testid="quick-open-layout"
                      onSelect={() => {
                        onOpenChange(false);
                        const layout = layouts.find((each) => each.id === entry.layoutId);
                        if (layout !== undefined) openLayout(layout);
                      }}
                      className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                    >
                      <span className="truncate">{entry.label}</span>
                      <span className="truncate text-xs text-fg-subtle">{entry.detail}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {forwardEntries.length > 0 && (
                <Command.Group heading="Port forwards" className={GROUP_CLASS}>
                  {forwardEntries.map((entry) => (
                    <Command.Item
                      key={entry.key}
                      value={`${entry.label} ${entry.detail}`}
                      data-testid="palette-forward"
                      onSelect={() => {
                        onOpenChange(false);
                        if (mode === 'start-forward') void startForward(entry.hostId, entry.ruleId);
                        else void stopForward(entry.hostId, entry.ruleId);
                      }}
                      className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                    >
                      <span className="truncate">{entry.label}</span>
                      <span className="truncate font-mono text-xs text-fg-subtle">{entry.detail}</span>
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
              {snippetEntries.length > 0 && (
                <Command.Group heading="Snippets" className={GROUP_CLASS}>
                  {snippetEntries.map((entry) => (
                    <SnippetItem key={entry.key} entry={entry} onOpenChange={onOpenChange} quickOpen={quickOpen} />
                  ))}
                </Command.Group>
              )}
              {quickOpen && hostEntries.length > 0 && (
                <Command.Group heading="Files" className={GROUP_CLASS}>
                  {hostEntries.map((entry) => (
                    <HostItem key={`files:${entry.key}`} entry={entry} onOpenChange={onOpenChange} files />
                  ))}
                </Command.Group>
              )}
              {!picker &&
                rankedGroups.map(([category, rows]) => (
                  <Command.Group key={category} heading={category} className={GROUP_CLASS}>
                    {rows.map(({ command, disabledReason }) => {
                      const shortcut = effectiveShortcut(command);
                      return (
                        <Command.Item
                          key={command.id}
                          value={`${command.category} ${command.label}`}
                          keywords={paletteKeywords(command)}
                          // A command that cannot run here stays listed, greyed, saying why.
                          disabled={disabledReason !== undefined}
                          data-testid="palette-command"
                          onSelect={() => {
                            onOpenChange(false);
                            void runCommand(command.id, context);
                          }}
                          className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[disabled=true]:text-fg-faint data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                        >
                          <span className="min-w-0 truncate">{command.label}</span>
                          {disabledReason !== undefined && (
                            <span className="min-w-0 truncate text-xs text-fg-faint">{disabledReason}</span>
                          )}
                          {disabledReason === undefined && shortcut !== undefined && (
                            <span className="font-mono text-xs text-fg-subtle">
                              {formatKeybinding(shortcut, context.platform)}
                            </span>
                          )}
                        </Command.Item>
                      );
                    })}
                  </Command.Group>
                ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
