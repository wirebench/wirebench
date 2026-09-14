/**
 * The path line above an editor's toolbar: where the thing being edited lives, and its own name,
 * renamed in place on a double-click.
 *
 * Presentational only — it is handed the trail, the name and a commit callback — so the SOAP
 * request editor and the REST one show the same line without either owning the other's model.
 */
import { Fragment, useState } from 'react';

export interface BreadcrumbProps {
  /** Accessible name of the nav landmark, e.g. `Request path`. */
  readonly label: string;
  /** The segments before the name, outermost first. Empty segments are the caller's to filter. */
  readonly trail: readonly string[];
  /** The name of the thing being edited, shown last and renameable. */
  readonly name: string;
  /** Called with a trimmed, changed, non-empty name. Omit to make the name read-only. */
  readonly onRename?: (name: string) => void;
  /** Rendered at the far right — the SOAP version, an HTTP method, a definition badge. */
  readonly badge?: React.ReactNode;
  /** Prefix for this line's testids: `<prefix>`, `<prefix>-name`, `<prefix>-name-input`. */
  readonly testidPrefix: string;
}

/** One breadcrumb line. */
export function Breadcrumb({ label, trail, name, onRename, badge, testidPrefix }: BreadcrumbProps) {
  const [editing, setEditing] = useState(false);

  const commit = (value: string): void => {
    setEditing(false);
    const next = value.trim();
    if (next.length > 0 && next !== name) {
      onRename?.(next);
    }
  };

  return (
    <nav aria-label={label} data-testid={testidPrefix} className="flex h-8 shrink-0 items-center gap-3 px-3">
      <ol className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {trail.map((segment, index) => (
          <Fragment key={index}>
            <li className="min-w-0 truncate text-fg-subtle" title={segment}>
              {segment}
            </li>
            <li aria-hidden="true" className="shrink-0 text-fg-faint">
              /
            </li>
          </Fragment>
        ))}
        <li aria-current="page" className="min-w-0 font-medium text-fg-default">
          {editing ? (
            <input
              autoFocus
              aria-label="Request name"
              data-testid={`${testidPrefix}-name-input`}
              defaultValue={name}
              onFocus={(event) => {
                event.currentTarget.select();
              }}
              onBlur={(event) => {
                commit(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commit(event.currentTarget.value);
                } else if (event.key === 'Escape') {
                  // Stop here: Escape must not also reach the editor's cancel-send handler.
                  event.preventDefault();
                  event.stopPropagation();
                  setEditing(false);
                }
              }}
              className="w-64 max-w-full rounded bg-surface-base px-1 text-sm outline-none ring-1 ring-accent"
            />
          ) : (
            <span
              data-testid={`${testidPrefix}-name`}
              {...(onRename !== undefined ? { title: 'Double-click to rename' } : {})}
              className={`block truncate ${onRename !== undefined ? 'cursor-text' : ''}`}
              onDoubleClick={() => {
                if (onRename !== undefined) {
                  setEditing(true);
                }
              }}
            >
              {name}
            </span>
          )}
        </li>
      </ol>
      {badge}
    </nav>
  );
}
