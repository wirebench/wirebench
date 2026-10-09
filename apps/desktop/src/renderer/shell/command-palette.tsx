import { useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import type { CommandCategory, CommandDefinition } from '@shared/commands.js';
import { explorerActions } from '../features/explorer/explorer-actions.js';
import { openTerminalFor } from '../features/ssh/connect.js';
import { useHostsStore } from '../features/ssh/hosts-store.js';
import type { CommandContext } from '../lib/commands.js';
import { listCommands, runCommand } from '../lib/commands.js';
import { effectiveShortcut, formatKeybinding } from '../lib/keybindings.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';
import type { QuickOpenEntry } from './quick-open.js';
import { quickOpenEntries, quickOpenHostEntries } from './quick-open.js';

/** Which list the palette is showing: every command (⌘K), operations/requests/hosts (⌘P), or only hosts. */
export type PaletteMode = 'commands' | 'quick-open' | 'hosts';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly context: CommandContext;
  /** Defaults to the command list; `quick-open` is ⌘P's operations/requests/hosts list, `hosts` the host picker. */
  readonly mode?: PaletteMode;
}

type Definition = CommandDefinition<CommandContext>;

const GROUP_CLASS =
  '[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-faint [&_[cmdk-group-heading]]:uppercase';

/** One host row: select connects, or brings forward the terminal already open for it. */
function HostItem({
  entry,
  onOpenChange,
}: {
  readonly entry: QuickOpenEntry;
  readonly onOpenChange: (open: boolean) => void;
}) {
  return (
    <Command.Item
      value={entry.value}
      data-testid="quick-open-host"
      onSelect={() => {
        onOpenChange(false);
        if (entry.hostId !== undefined) openTerminalFor(entry.hostId);
      }}
      className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
    >
      <span className="truncate">{entry.label}</span>
      <span className="truncate text-xs text-fg-subtle">{entry.detail}</span>
    </Command.Item>
  );
}

function groupByCategory(commands: readonly Definition[]): readonly (readonly [CommandCategory, Definition[]])[] {
  const groups = new Map<CommandCategory, Definition[]>();
  for (const command of commands) {
    const bucket = groups.get(command.category);
    if (bucket === undefined) {
      groups.set(command.category, [command]);
    } else {
      bucket.push(command);
    }
  }
  return [...groups.entries()];
}

/**
 * ⌘K / ⌘⇧P — everything the app can do, listed from the same registry that drives the
 * keybindings — and ⌘P, the same dialog in quick-open mode over operations and requests.
 */
export function CommandPalette({ open, onOpenChange, context, mode = 'commands' }: CommandPaletteProps) {
  // `listCommands` is filtered by `when`, whose predicates (e.g. "a workspace is open") read
  // stores that are *not* part of `context` (workspace, selection-adjacent project state, …), so
  // `context`'s own identity can stay unchanged across a state change that should still affect
  // what is listed. `open` is in the dependency list for exactly that reason: every reopen
  // re-evaluates `when` against the current world, rather than reusing whatever was computed the
  // last time `context` itself happened to change identity — which, before this, only reliably
  // happened once, coincidentally, from a library's mount-time resize callback.
  const groups = useMemo(() => groupByCategory(listCommands(context)), [context, open]);
  const interfaces = useProjectStore((state) => state.interfaces);
  const requests = useProjectStore((state) => state.requests);
  const projectOf = useProjectStore((state) => state.projectOf);
  const projects = useProjectStore((state) => state.projects);
  const projectNames = useMemo(
    () => Object.fromEntries(Object.entries(projects).map(([id, project]) => [id, project.name])),
    [projects],
  );
  const entries = useMemo(
    () => (mode === 'quick-open' ? quickOpenEntries(interfaces, requests, projectOf, projectNames) : []),
    [mode, interfaces, requests, projectOf, projectNames],
  );
  // A switched-off ssh area contributes no hosts, in quick-open or in the host picker.
  const sshEnabled = useUiStore((state) => state.enabledAreas.includes('ssh'));
  const resolvedHosts = useHostsStore((state) => state.resolved);
  const hostEntries = useMemo(
    () => (sshEnabled && mode !== 'commands' ? quickOpenHostEntries(resolvedHosts) : []),
    [sshEnabled, mode, resolvedHosts],
  );
  const quickOpen = mode === 'quick-open';
  const hostsOnly = mode === 'hosts';
  const picker = quickOpen || hostsOnly;
  const title = hostsOnly ? 'Connect to host' : quickOpen ? 'Go to operation or request' : 'Command palette';

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[18%] left-1/2 z-50 w-[min(560px,90vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-hairline-strong bg-surface-overlay shadow-2xl"
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {/* Keyed on the mode so a switch (⌘K to the host picker) starts with an empty search. */}
          <Command
            key={mode}
            loop
            label={hostsOnly ? 'Hosts' : quickOpen ? 'Operations, requests and hosts' : 'Commands'}
          >
            <Command.Input
              autoFocus
              data-testid={picker ? 'quick-open-input' : 'command-palette-input'}
              placeholder={picker ? title : 'Search or run a command'}
              className="h-10 w-full border-b border-hairline bg-transparent px-3 text-md text-fg-default outline-none placeholder:text-fg-faint"
            />
            <Command.List className="max-h-[320px] overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">
                {hostsOnly
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
                    onSelect={() => {
                      onOpenChange(false);
                      if (entry.kind === 'request') {
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
              {picker && hostEntries.length > 0 && (
                <Command.Group heading="Hosts" className={GROUP_CLASS}>
                  {hostEntries.map((entry) => (
                    <HostItem key={entry.key} entry={entry} onOpenChange={onOpenChange} />
                  ))}
                </Command.Group>
              )}
              {!picker &&
                groups.map(([category, commands]) => (
                  <Command.Group key={category} heading={category} className={GROUP_CLASS}>
                    {commands.map((command) => {
                      const shortcut = effectiveShortcut(command);
                      return (
                        <Command.Item
                          key={command.id}
                          value={`${command.category} ${command.label}`}
                          onSelect={() => {
                            onOpenChange(false);
                            void runCommand(command.id, context);
                          }}
                          className="flex cursor-default items-center justify-between rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
                        >
                          <span>{command.label}</span>
                          {shortcut !== undefined && (
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
