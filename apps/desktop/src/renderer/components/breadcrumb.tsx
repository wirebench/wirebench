/**
 * The path line above an editor's toolbar: where the thing being edited lives, and its own name,
 * renamed in place on a double-click.
 *
 * Presentational only — it is handed the trail, the name and a commit callback — so the SOAP
 * request editor and the REST one show the same line without either owning the other's model.
 */
import { Fragment, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';

/**
 * A trail this long or longer folds its middle (#686 E23): project / … / name. Four, so a SOAP
 * request (project / interface / operation) and a REST request one folder down keep their line.
 */
const FOLD_FROM = 4;

/** One part of a drawn trail: a segment, or the middle segments folded behind "…". */
export type TrailPart =
  | { readonly kind: 'segment'; readonly text: string; readonly whole: boolean }
  | { readonly kind: 'folded'; readonly segments: readonly string[] };

/**
 * The trail as drawn. A short one is every segment, each free to truncate. From {@link FOLD_FROM}
 * segments on, the first stays whole and the rest fold into one "…" whose menu lists them, so a
 * request four folders down reads "Payments / … / Name" rather than "Pay… / Swa… / v2… / le… / le…".
 */
export function foldedTrail(trail: readonly string[]): readonly TrailPart[] {
  if (trail.length < FOLD_FROM) {
    return trail.map((text) => ({ kind: 'segment', text, whole: false }));
  }
  const [first = '', ...rest] = trail;
  return [
    { kind: 'segment', text: first, whole: true },
    { kind: 'folded', segments: rest },
  ];
}

/** The "…" of a folded trail: a menu of the segments it stands for, outermost first. */
function FoldedSegments({
  segments,
  testidPrefix,
}: {
  readonly segments: readonly string[];
  readonly testidPrefix: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          data-testid={`${testidPrefix}-folded`}
          aria-label={`Show the ${String(segments.length)} folded path segments`}
          title={segments.join(' / ')}
          className="rounded px-1 text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
        >
          …
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className="z-dropdown min-w-40 max-w-96 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
        >
          {segments.map((segment, index) => (
            <DropdownMenu.Item
              key={index}
              data-testid={`${testidPrefix}-folded-segment`}
              // Indented one step per level, so the menu reads as the path it folds.
              style={{ paddingLeft: `${String(8 + index * 12)}px` }}
              className="truncate rounded py-1.5 pr-2 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted"
            >
              {segment}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

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
        {foldedTrail(trail).map((part, index) => (
          <Fragment key={index}>
            {part.kind === 'segment' ? (
              <li
                className={`${part.whole ? 'max-w-64 shrink-0' : 'min-w-0'} truncate text-fg-subtle`}
                title={part.text}
              >
                {part.text}
              </li>
            ) : (
              <li className="shrink-0">
                <FoldedSegments segments={part.segments} testidPrefix={testidPrefix} />
              </li>
            )}
            <li aria-hidden="true" className="shrink-0 text-fg-faint">
              /
            </li>
          </Fragment>
        ))}
        <li
          aria-current="page"
          className={`${trail.length >= FOLD_FROM ? 'max-w-[50%] shrink-0' : 'min-w-0'} font-medium text-fg-default`}
        >
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
