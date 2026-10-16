/**
 * The snippet picker inside a terminal (spec D9.5, ⌘; or Ctrl+;): a small fuzzy list over the pane, with the
 * palette's matcher. Enter runs the snippet into this terminal, ⌥Enter inserts it (typed without Enter); a run
 * that must ask goes through the run dialog, as a row's Run does. Escape gives the focus back to the shell.
 */
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Command } from 'cmdk';
import { formatKeybinding } from '@shared/keybinding-format.js';
import { detectPlatform } from '../../../lib/platform.js';
import { quickOpenSnippetEntries } from '../../../shell/quick-open.js';
import { startRun } from './run.js';
import { loadSnippets, showSnippets } from './snippet-actions.js';
import { useSnippetsStore } from './snippets-store.js';

export function TerminalPicker({ onClose }: { readonly onClose: () => void }) {
  useEffect(() => {
    void loadSnippets();
  }, []);
  const snippets = useSnippetsStore((s) => s.snippets);
  const entries = useMemo(() => quickOpenSnippetEntries(snippets), [snippets]);
  // The row cmdk has selected, by key: ⌥Enter acts on it, which cmdk's own Enter does not tell apart.
  const [selected, setSelected] = useState('');

  const run = (key: string, insert: boolean): void => {
    const id = entries.find((entry) => entry.key === key)?.snippetId;
    const item = snippets.find((s) => s.id === id);
    onClose();
    if (item !== undefined) startRun(item, insert ? { enter: false } : {});
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && event.altKey) {
      event.preventDefault();
      event.stopPropagation();
      if (selected !== '') run(selected, true);
    }
  };

  return (
    <div
      className="absolute top-2 left-1/2 z-[1] w-[min(420px,90%)] -translate-x-1/2 overflow-hidden rounded-lg border border-hairline-strong bg-surface-overlay shadow-2xl"
      data-testid="snippet-picker"
    >
      <Command loop label="Snippets" value={selected} onValueChange={setSelected} onKeyDown={onKeyDown}>
        <Command.Input
          autoFocus
          data-testid="snippet-picker-input"
          placeholder={`Run snippet · ${formatKeybinding('Alt+Enter', detectPlatform())} inserts`}
          className="h-9 w-full border-b border-hairline bg-transparent px-3 text-md text-fg-default outline-none placeholder:text-fg-faint"
        />
        <Command.List className="max-h-[240px] overflow-auto p-1">
          {entries.length === 0 ? (
            <div
              className="flex items-center justify-between gap-3 px-3 py-4 text-sm text-fg-subtle"
              data-testid="snippet-picker-empty"
            >
              <span>No snippets yet. Add one under Snippets in the SSH menu.</span>
              <button
                type="button"
                className="shrink-0 rounded border border-hairline px-2 py-0.5 text-sm whitespace-nowrap text-fg-default hover:bg-surface-raised"
                onClick={() => {
                  onClose();
                  showSnippets();
                  useSnippetsStore.getState().openEditor({ mode: 'new' });
                }}
              >
                New snippet
              </button>
            </div>
          ) : (
            <Command.Empty className="px-3 py-4 text-center text-sm text-fg-subtle">No matching snippet.</Command.Empty>
          )}
          {entries.map((entry) => (
            <Command.Item
              key={entry.key}
              value={entry.key}
              keywords={[entry.value]}
              data-testid="snippet-picker-item"
              data-name={entry.label}
              onSelect={() => {
                run(entry.key, false);
              }}
              className="flex cursor-default items-center justify-between gap-3 rounded-md px-2 py-1.5 text-md text-fg-muted data-[selected=true]:bg-surface-selected data-[selected=true]:text-fg-default"
            >
              <span className="truncate">{entry.label}</span>
              <span className="truncate font-mono text-xs text-fg-subtle">{entry.detail}</span>
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </div>
  );
}
