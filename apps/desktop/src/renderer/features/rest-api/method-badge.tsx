/**
 * The HTTP method badge that precedes a REST request's name in the explorer, in history rows, and
 * in the request editor's breadcrumbs and responses.
 *
 * Styled like Postman: sleek, compact coloured text aligned to a fixed column, with no bulky
 * filled background, keeping the explorer tree clean and readable.
 * An optional `variant="chip"` renders the filled pill badge if needed.
 */

/** The six colours §7.1 fixes, by uppercased method name. */
const METHOD_TEXT_CLASS: Readonly<Record<string, string>> = {
  GET: 'text-method-get',
  POST: 'text-method-post',
  PUT: 'text-method-put',
  PATCH: 'text-method-patch',
  DELETE: 'text-method-delete',
};

const METHOD_CHIP_CLASS: Readonly<Record<string, string>> = {
  GET: 'bg-method-get',
  POST: 'bg-method-post',
  PUT: 'bg-method-put',
  PATCH: 'bg-method-patch',
  DELETE: 'bg-method-delete',
};

/** How much of a custom method the badge shows before it is cut short. */
const MAX_LABEL = 7;

/**
 * The short forms the explorer's narrow method column uses, so a name never starts three
 * characters further right on a DELETE row than on a GET row. The row's title still carries the
 * method in full, as does `data-method`.
 */
const SHORT_LABEL: Readonly<Record<string, string>> = {
  DELETE: 'DEL',
  OPTIONS: 'OPT',
  CONNECT: 'CONN',
};

/** The longest label the compact column shows before it is cut short. */
const MAX_COMPACT_LABEL = 5;

/** One method as the compact column spells it: `DELETE` is `DEL`, `GET` and `PATCH` unchanged. */
export function compactMethodLabel(method: string): string {
  const label = method.toUpperCase();
  const short = SHORT_LABEL[label];
  if (short !== undefined) return short;
  return label.length > MAX_COMPACT_LABEL ? `${label.slice(0, 4)}…` : label;
}

export interface MethodBadgeProps {
  readonly method: string;
  /** Adds the method to the accessible name, for a row whose text alone would not carry it. */
  readonly title?: string;
  readonly className?: string;
  /** Visual variant: 'text' (Postman-style, default) or 'chip' (filled pill). */
  readonly variant?: 'text' | 'chip';
  /** Spells long methods short, for the explorer's fixed-width method column. */
  readonly compact?: boolean;
}

/** The colour class for one method, exported so the tests can pin the mapping without the DOM. */
export function methodColorClass(method: string): string {
  return METHOD_TEXT_CLASS[method.toUpperCase()] ?? 'text-method-other';
}

/** The chip background class for one method. */
export function methodChipClass(method: string): string {
  return METHOD_CHIP_CLASS[method.toUpperCase()] ?? 'bg-method-other';
}

/** One method badge. */
export function MethodBadge({ method, title, className, variant = 'text', compact = false }: MethodBadgeProps) {
  const label = method.toUpperCase();
  const truncatedLabel = compact
    ? compactMethodLabel(label)
    : label.length > MAX_LABEL
      ? `${label.slice(0, MAX_LABEL)}…`
      : label;

  if (variant === 'chip') {
    return (
      <span
        data-testid="method-badge"
        data-method={label}
        {...(title !== undefined ? { title } : {})}
        className={`shrink-0 rounded px-1 font-mono text-xs leading-tight text-fg-on-accent ${methodChipClass(method)} ${className ?? ''}`}
      >
        {truncatedLabel}
      </span>
    );
  }

  return (
    <span
      data-testid="method-badge"
      data-method={label}
      {...(title !== undefined ? { title } : {})}
      className={`shrink-0 font-mono ${compact ? 'text-2xs' : 'text-xs'} font-bold leading-none ${methodColorClass(method)} ${className ?? ''}`}
    >
      {truncatedLabel}
    </span>
  );
}
