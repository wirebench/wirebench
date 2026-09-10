import { useMemo } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Command } from 'cmdk';
import type { CommandCategory, CommandDefinition } from '@shared/commands.js';
import type { CommandContext } from '../lib/commands.js';
import { listCommands, runCommand } from '../lib/commands.js';
import { formatKeybinding } from '../lib/keybindings.js';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly context: CommandContext;
}

type Definition = CommandDefinition<CommandContext>;

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

/** ⌘K. Everything the app can do, listed from the same registry that drives the keybindings. */
export function CommandPalette({ open, onOpenChange, context }: CommandPaletteProps) {
  // `listCommands` is filtered by `when`, so reopening after a state change re-evaluates it.
  const groups = useMemo(() => groupByCategory(listCommands(context)), [context]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-[18%] left-1/2 z-50 w-[min(560px,90vw)] -translate-x-1/2 overflow-hidden rounded-lg border border-hairline-strong bg-surface-overlay shadow-2xl"
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Command loop label="Commands">
            <Command.Input
              autoFocus
              placeholder="Search or run a command"
              className="h-10 w-full border-b border-hairline bg-transparent px-3 text-md text-fg-default outline-none placeholder:text-fg-faint"
            />
            <Command.List className="max-h-[320px] overflow-auto p-1">
              <Command.Empty className="px-3 py-6 text-center text-sm text-fg-subtle">
                No matching command.
              </Command.Empty>
              {groups.map(([category, commands]) => (
                <Command.Group
                  key={category}
                  heading={category}
                  className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-fg-faint [&_[cmdk-group-heading]]:uppercase"
                >
                  {commands.map((command) => (
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
                      {command.shortcut !== undefined && (
                        <span className="font-mono text-xs text-fg-subtle">
                          {formatKeybinding(command.shortcut, context.platform)}
                        </span>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
