export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Rendered after the label, e.g. a problem count. */
  readonly badge?: string;
}

export interface TabsProps<T extends string> {
  readonly label: string;
  readonly items: readonly TabItem<T>[];
  readonly active: T;
  readonly onSelect: (id: T) => void;
}

/**
 * A flat, underline-free tab strip driven by roving `aria-selected` state. Deliberately not
 * Radix Tabs: the panels these control live in different regions of the shell.
 */
export function Tabs<T extends string>({ label, items, active, onSelect }: TabsProps<T>) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const index = items.findIndex((item) => item.id === active);
    const next = items[(index + step + items.length) % items.length];
    if (next !== undefined) {
      onSelect(next.id);
    }
  }

  return (
    <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex h-row items-stretch">
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onSelect(item.id);
            }}
            className={`inline-flex items-center gap-2 border-b-2 px-3 text-sm transition-colors ${
              selected
                ? 'border-accent text-fg-default'
                : 'border-transparent text-fg-subtle hover:bg-surface-hover hover:text-fg-muted'
            }`}
          >
            {item.label}
            {item.badge !== undefined && <span className="font-mono text-xs text-fg-faint">{item.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
