/**
 * The HTTP method chip that precedes a REST request's name in the explorer, in history rows and in
 * the request editor's URL bar.
 *
 * A filled chip rather than coloured text: it then carries one foreground (`fg-on-accent`) on one
 * background per method, which is a single contrast pair per colour instead of one per row surface,
 * and it stays legible on a selected or hovered row without a second palette.
 *
 * A method this build has never heard of is not an error — a REST client sends what it is told — so
 * it gets the neutral grey and its own text, truncated to keep the row's geometry.
 */

/** The six colours §7.1 fixes, by uppercased method name. */
const METHOD_CLASS: Readonly<Record<string, string>> = {
  GET: 'bg-method-get',
  POST: 'bg-method-post',
  PUT: 'bg-method-put',
  PATCH: 'bg-method-patch',
  DELETE: 'bg-method-delete',
};

/** How much of a custom method the chip shows before it is cut short. */
const MAX_LABEL = 7;

export interface MethodBadgeProps {
  readonly method: string;
  /** Adds the method to the accessible name, for a row whose text alone would not carry it. */
  readonly title?: string;
  readonly className?: string;
}

/** The colour class for one method, exported so the tests can pin the mapping without the DOM. */
export function methodColorClass(method: string): string {
  return METHOD_CLASS[method.toUpperCase()] ?? 'bg-method-other';
}

/** One method chip. */
export function MethodBadge({ method, title, className }: MethodBadgeProps) {
  const label = method.toUpperCase();
  return (
    <span
      data-testid="method-badge"
      data-method={label}
      {...(title !== undefined ? { title } : {})}
      className={`shrink-0 rounded px-1 font-mono text-xs leading-tight text-fg-on-accent ${methodColorClass(method)} ${className ?? ''}`}
    >
      {label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL)}…` : label}
    </span>
  );
}
