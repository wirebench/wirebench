/** One entry in a pane's view strip. Disabled entries name the task that will enable them. */
export interface ViewTabItem {
  readonly id: string;
  readonly label: string;
  readonly disabledReason?: string;
}

export interface ViewTabsProps {
  readonly label: string;
  readonly items: readonly ViewTabItem[];
  readonly active: string;
  /** Called with an enabled tab's id when clicked. Omit to render the strip non-interactively. */
  readonly onSelect?: (id: string) => void;
}

/**
 * The `XML · Form · Outline · Raw` strip. Only XML is live in v0; the rest are rendered
 * disabled rather than hidden so the shape of the pane is honest about what is coming.
 * The reason rides on `title` rather than a Radix tooltip: a disabled control never receives
 * the pointer events a tooltip trigger needs, and the strip must work outside a provider.
 */
export function ViewTabs({ label, items, active, onSelect }: ViewTabsProps) {
  return (
    <div role="tablist" aria-label={label} className="flex h-row shrink-0 items-center gap-1 px-2">
      {items.map((item) => {
        const disabled = item.disabledReason !== undefined;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={item.id === active}
            aria-disabled={disabled}
            disabled={disabled}
            onClick={() => onSelect?.(item.id)}
            {...(item.disabledReason !== undefined ? { title: item.disabledReason } : {})}
            className={`rounded-sm px-2 text-xs ${
              item.id === active ? 'bg-surface-active text-fg-default' : 'text-fg-subtle'
            } ${disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-surface-hover'}`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
