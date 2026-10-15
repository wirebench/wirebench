import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

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

/** The room the More button's chevron and gap take beyond its label. */
const CHEVRON_PX = 18;

const TAB_CLASS = 'inline-flex shrink-0 items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm transition-colors';
const SELECTED_CLASS = 'border-accent text-fg-default';
const UNSELECTED_CLASS = 'border-transparent text-fg-subtle hover:bg-surface-hover hover:text-fg-muted';
/** Shows an element's `data-text` without putting it in the DOM's text. */
const MEASURE_TEXT = 'before:content-[attr(data-text)]';
const ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

export interface FitInput {
  /** Each tab's natural width, in order. */
  readonly widths: readonly number[];
  /** The width the strip has. */
  readonly available: number;
  /** The width of the More button showing "More". */
  readonly moreWidth: number;
  /** The selected tab's index; when it overflows, the More button shows its name instead. */
  readonly activeIndex: number;
}

/**
 * How many tabs, from the left, fit in the strip. All of them when they fit; otherwise as many as
 * leave room for the More button, which is as wide as the name it shows.
 */
export function fitTabs({ widths, available, moreWidth, activeIndex }: FitInput): number {
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= available) {
    return widths.length;
  }
  let used = total;
  for (let count = widths.length - 1; count > 0; count -= 1) {
    used -= widths[count] ?? 0;
    const trigger = activeIndex >= count ? (widths[activeIndex] ?? 0) + CHEVRON_PX : moreWidth;
    if (used + trigger <= available) {
      return count;
    }
  }
  return 0;
}

/**
 * A flat, underline-free tab strip driven by roving `aria-selected` state. Deliberately not
 * Radix Tabs: the panels these control live in different regions of the shell.
 *
 * The strip never grows wider than its container: tabs that don't fit move into a trailing More
 * menu, whose button shows the selected tab's name when that tab is one of them. A hidden copy of
 * the strip measures each tab's natural width, so the fit follows labels and badges as they change.
 */
export function Tabs<T extends string>({ label, items, active, onSelect }: TabsProps<T>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<number | undefined>(undefined);
  const [widths, setWidths] = useState<readonly number[]>([]);
  const [moreWidth, setMoreWidth] = useState(0);

  const signature = items.map((item) => `${item.label}\u0000${item.badge ?? ''}`).join('\u0001');
  useLayoutEffect(() => {
    const row = measureRef.current;
    if (row === null) {
      return;
    }
    const children = [...row.children] as HTMLElement[];
    const next = children.slice(0, -1).map((child) => child.offsetWidth);
    setWidths((previous) =>
      previous.length === next.length && previous.every((width, index) => width === next[index]) ? previous : next,
    );
    setMoreWidth(children.at(-1)?.offsetWidth ?? 0);
  }, [signature]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const measure = (): void => {
      setAvailable(container.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, []);

  const activeIndex = items.findIndex((item) => item.id === active);
  const count =
    available === undefined || widths.length !== items.length
      ? items.length
      : fitTabs({ widths, available, moreWidth, activeIndex });
  const shown = items.slice(0, count);
  const hidden = items.slice(count);
  const activeHidden = hidden.find((item) => item.id === active);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = items[(activeIndex + step + items.length) % items.length];
    if (next !== undefined) {
      onSelect(next.id);
    }
  }

  return (
    // A column whose hidden second row is every tab at its natural width: that row is what the
    // strip asks a flex parent for, so it can grow back once there is room again.
    <div ref={containerRef} className="flex min-w-0 flex-col overflow-hidden">
      <div className="flex h-row min-w-0 items-stretch">
        <div role="tablist" aria-label={label} onKeyDown={onKeyDown} className="flex min-w-0 items-stretch">
          {shown.map((item) => {
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
                className={`${TAB_CLASS} ${selected ? SELECTED_CLASS : UNSELECTED_CLASS}`}
              >
                {item.label}
                {item.badge !== undefined && <span className="font-mono text-xs text-fg-faint">{item.badge}</span>}
              </button>
            );
          })}
        </div>
        {hidden.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                data-testid="tabs-more"
                aria-label={activeHidden !== undefined ? `${activeHidden.label}, more ${label}` : `More ${label}`}
                className={`${TAB_CLASS} gap-1 ${activeHidden !== undefined ? SELECTED_CLASS : UNSELECTED_CLASS}`}
              >
                {activeHidden !== undefined ? activeHidden.label : 'More'}
                {activeHidden?.badge !== undefined && (
                  <span className="font-mono text-xs text-fg-faint">{activeHidden.badge}</span>
                )}
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="bottom"
                align="end"
                sideOffset={4}
                className="z-50 min-w-40 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
              >
                <DropdownMenu.RadioGroup
                  value={activeHidden?.id ?? ''}
                  onValueChange={(id) => {
                    const picked = hidden.find((item) => item.id === id);
                    if (picked !== undefined) {
                      onSelect(picked.id);
                    }
                  }}
                >
                  {hidden.map((item) => (
                    <DropdownMenu.RadioItem key={item.id} value={item.id} className={ITEM_CLASS}>
                      <span className={item.id === active ? 'text-accent' : ''}>{item.label}</span>
                      {item.badge !== undefined && (
                        <span className="font-mono text-xs text-fg-faint">{item.badge}</span>
                      )}
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
      </div>
      {/* Natural widths, measured out of sight: every tab, then the More button showing "More". */}
      <div ref={measureRef} aria-hidden="true" className="pointer-events-none invisible flex h-0 w-max overflow-hidden">
        {/* The text comes from `attr()`, so it is not in the document's text for queries to find. */}
        {items.map((item) => (
          <span key={item.id} data-text={item.label} className={`${TAB_CLASS} ${MEASURE_TEXT}`}>
            {item.badge !== undefined && (
              <span data-text={item.badge} className={`font-mono text-xs ${MEASURE_TEXT}`} />
            )}
          </span>
        ))}
        <span data-text="More" className={`${TAB_CLASS} gap-1 ${MEASURE_TEXT}`}>
          <ChevronDown size={12} aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}
