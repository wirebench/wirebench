import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { focusExplorer } from './explorer-tree-actions.js';
import { getExplorerTree } from './explorer-api.js';
import { useExplorerFilterStore } from './explorer-filter.js';

/**
 * The filter field under the Explorer's header: shown by its header button or the filter shortcut, and while it
 * holds text. Escape empties it and hands focus back to the tree; ↓ moves into the rows it left.
 */
export function ExplorerFilterField() {
  const open = useExplorerFilterStore((state) => state.open);
  const text = useExplorerFilterStore((state) => state.text);
  const focusRequest = useExplorerFilterStore((state) => state.focusRequest);
  const setText = useExplorerFilterStore((state) => state.setText);
  const clear = useExplorerFilterStore((state) => state.clear);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open && focusRequest > 0) {
      input.current?.focus();
      input.current?.select();
    }
  }, [open, focusRequest]);

  if (!open && text === '') return null;

  const leave = (): void => {
    clear();
    focusExplorer();
  };

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-hairline px-2">
      <input
        ref={input}
        type="search"
        aria-label="Filter the Explorer"
        data-testid="explorer-filter"
        placeholder="Filter"
        value={text}
        onChange={(event) => setText(event.currentTarget.value)}
        onBlur={() => {
          if (text === '') clear();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            leave();
          } else if (event.key === 'ArrowDown') {
            const tree = getExplorerTree();
            const first = tree?.firstNode;
            if (tree !== null && tree !== undefined && first !== null && first !== undefined) {
              event.preventDefault();
              tree.focus(first, { scroll: true });
              focusExplorer();
            }
          }
        }}
        className="h-6 min-w-0 flex-1 rounded bg-surface-base px-1.5 text-sm text-fg-default outline-none ring-1 ring-hairline-strong placeholder:text-fg-faint focus:ring-accent"
      />
      {text !== '' && (
        <button
          type="button"
          aria-label="Clear the filter"
          onClick={leave}
          className="inline-flex size-6 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
