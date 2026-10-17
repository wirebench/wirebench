import { Fragment, useState, type ReactElement } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import type { CommandId } from '@shared/commands.js';
import { formatKeybinding } from '@shared/keybinding-format.js';
import { shortcutFor } from '../../lib/keybindings.js';
import type { Platform } from '../../lib/platform.js';

const ITEM_CLASS =
  'flex cursor-pointer items-center gap-6 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';
const CONTENT_CLASS = 'z-dropdown min-w-56 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';

/** What the menu does; each is the same handler its shortcut, toolbar button or command runs. */
export interface TerminalMenuActions {
  readonly copy: () => void;
  readonly paste: () => void;
  readonly selectAll: () => void;
  readonly find: () => void;
  readonly clear: () => void;
  readonly splitRight: () => void;
  readonly splitDown: () => void;
  readonly runSnippet: () => void;
  readonly openFiles: () => void;
  readonly reconnect: () => void;
}

/** How the pane stands when the menu opens. */
export interface TerminalMenuState {
  /** The terminal has text selected, so Copy has something to copy. */
  readonly hasSelection: boolean;
  /** The pane's session is open, so what is typed or pasted has somewhere to go. */
  readonly connected: boolean;
  /** Whether the host has Files (SFTP); a Telnet host does not (#425). Offered unless false. */
  readonly files?: boolean;
}

export interface TerminalMenuItem {
  readonly key: keyof TerminalMenuActions;
  readonly label: string;
  /** The chord that does the same, as the platform writes it. */
  readonly shortcut?: string;
  readonly disabled: boolean;
  readonly run: () => void;
}

/** The clipboard chords a terminal answers: ⌘C/⌘V/⌘A on a Mac; elsewhere with Shift, as Ctrl+C is the shell's. */
const CLIPBOARD_CHORDS: Readonly<Record<'copy' | 'paste' | 'selectAll', { mac: string; other: string }>> = {
  copy: { mac: 'Mod+C', other: 'Mod+Shift+C' },
  paste: { mac: 'Mod+V', other: 'Mod+Shift+V' },
  selectAll: { mac: 'Mod+A', other: 'Mod+Shift+A' },
};

function clipboardShortcut(action: keyof typeof CLIPBOARD_CHORDS, platform: Platform): string {
  const chords = CLIPBOARD_CHORDS[action];
  return formatKeybinding(platform === 'mac' ? chords.mac : chords.other, platform);
}

/**
 * Ctrl+Shift+C / V / A off a Mac: the terminal's copy, paste and select all, which the shell never sees. On a
 * Mac ⌘C and ⌘V are the Edit menu's and ⌘A is the terminal's own, so nothing is taken there.
 */
export function clipboardChord(event: KeyboardEvent, platform: Platform): 'copy' | 'paste' | 'selectAll' | undefined {
  if (platform === 'mac' || !event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return undefined;
  switch (event.key.toLowerCase()) {
    case 'c':
      return 'copy';
    case 'v':
      return 'paste';
    case 'a':
      return 'selectAll';
    default:
      return undefined;
  }
}

/**
 * The terminal pane's right-click menu, as data: clipboard and find, then the pane's layout, then what the
 * host offers. Pure but for reading the commands' bindings, so a rebind shows here too.
 */
export function terminalMenuGroups(
  platform: Platform,
  state: TerminalMenuState,
  actions: TerminalMenuActions,
): readonly (readonly TerminalMenuItem[])[] {
  const item = (
    key: keyof TerminalMenuActions,
    label: string,
    shortcut: string | undefined,
    disabled = false,
  ): TerminalMenuItem => ({ key, label, ...(shortcut === undefined ? {} : { shortcut }), disabled, run: actions[key] });
  const command = (id: CommandId): string | undefined => shortcutFor(id, platform);
  return [
    [
      item('copy', 'Copy', clipboardShortcut('copy', platform), !state.hasSelection),
      item('paste', 'Paste', clipboardShortcut('paste', platform), !state.connected),
      item('selectAll', 'Select all', clipboardShortcut('selectAll', platform)),
    ],
    [item('find', 'Find…', formatKeybinding('Mod+F', platform)), item('clear', 'Clear', undefined)],
    [
      item('splitRight', 'Split right', command('ssh.splitRight')),
      item('splitDown', 'Split down', command('ssh.splitDown')),
    ],
    [
      item('runSnippet', 'Run snippet…', command('ssh.snippetPicker'), !state.connected),
      ...(state.files === false ? [] : [item('openFiles', 'Open files', command('ssh.openFiles'))]),
      item('reconnect', 'Reconnect', undefined),
    ],
  ];
}

/** Right-click on `children` opens the terminal menu; the pane's state is read as it opens. */
export function TerminalContextMenu({
  platform,
  state,
  actions,
  children,
}: {
  readonly platform: Platform;
  /** Asked each time the menu opens. */
  readonly state: () => TerminalMenuState;
  readonly actions: TerminalMenuActions;
  readonly children: ReactElement;
}) {
  const [opened, setOpened] = useState<TerminalMenuState>({ hasSelection: false, connected: false });
  return (
    <ContextMenu.Root
      // Not modal: a modal menu traps the focus as it closes, taking it back from the find query Find… focused.
      modal={false}
      onOpenChange={(open) => {
        if (open) setOpened(state());
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className={CONTENT_CLASS}
          data-testid="terminal-menu"
          // Each action puts the focus where it belongs (the find query, the terminal, a dialog).
          onCloseAutoFocus={(event) => {
            event.preventDefault();
          }}
        >
          {terminalMenuGroups(platform, opened, actions).map((group, index) => (
            <Fragment key={group[0]?.key ?? index}>
              {index > 0 && <ContextMenu.Separator className="my-1 h-px bg-hairline" />}
              {group.map((entry) => (
                <ContextMenu.Item key={entry.key} className={ITEM_CLASS} disabled={entry.disabled} onSelect={entry.run}>
                  <span className="flex-1">{entry.label}</span>
                  {entry.shortcut !== undefined && (
                    <span className="text-xs text-fg-subtle" aria-hidden="true">
                      {entry.shortcut}
                    </span>
                  )}
                </ContextMenu.Item>
              ))}
            </Fragment>
          ))}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
