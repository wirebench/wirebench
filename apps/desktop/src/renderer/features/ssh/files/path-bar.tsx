import { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { crumbsOf, resolveTyped } from './format.js';

export interface PathBarProps {
  /** The folder listed; `''` before the first listing. */
  readonly path: string;
  /** What `~` means. */
  readonly home: string;
  /** Lists a folder; `false` when it was refused (the pane shows why, under the bar). */
  readonly onNavigate: (path: string) => Promise<boolean>;
  /** Bumped to turn the bar into a text field and focus it (⌘L, `sftp.focusPathBar`). */
  readonly editRequest: number;
}

/**
 * The pane's place: crumbs to click, and on a click beside them or ⌘L a text field where Enter goes to the
 * typed folder (`~` is home, a relative path is under the current folder) and Escape puts the crumbs back.
 * A refused path keeps the field open with what was typed.
 */
export function PathBar({ path, home, onNavigate, editRequest }: PathBarProps) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(path);
  const input = useRef<HTMLInputElement>(null);
  // Read when an edit request lands, not again on each listing.
  const pathNow = useRef(path);
  pathNow.current = path;

  const startEditing = (): void => {
    setText(path);
    setEditing(true);
  };

  useEffect(() => {
    if (editRequest === 0) return;
    setText(pathNow.current);
    setEditing(true);
  }, [editRequest]);

  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={input}
        aria-label="Folder path"
        data-testid="files-path-input"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setEditing(false);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            void onNavigate(resolveTyped(text, home, path)).then((ok) => {
              if (ok) setEditing(false);
            });
          }
        }}
        onBlur={() => {
          setEditing(false);
        }}
        className="h-7 min-w-0 flex-1 rounded border border-accent bg-surface-sunken px-2 font-mono text-sm text-fg-default outline-none"
      />
    );
  }

  const crumbs = path === '' ? [] : crumbsOf(path);
  return (
    <div
      role="group"
      aria-label="Folder path"
      data-testid="files-path-bar"
      onClick={(e) => {
        if (e.target === e.currentTarget) startEditing();
      }}
      className="flex h-7 min-w-0 flex-1 cursor-text items-center overflow-hidden rounded border border-hairline px-1 text-sm"
    >
      {crumbs.map((crumb, index) => (
        <span key={crumb.path} className="flex shrink-0 items-center">
          {index > 1 && <ChevronRight size={12} aria-hidden="true" className="text-fg-faint" />}
          <button
            type="button"
            onClick={() => {
              void onNavigate(crumb.path);
            }}
            className={`rounded px-1 hover:bg-surface-hover ${
              index === crumbs.length - 1 ? 'text-fg-default' : 'text-fg-muted'
            }`}
          >
            {crumb.label}
          </button>
        </span>
      ))}
      <span aria-hidden="true" className="h-full min-w-4 flex-1" onClick={startEditing} />
    </div>
  );
}
