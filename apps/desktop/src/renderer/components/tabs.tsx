import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Rendered after the label, e.g. a problem count. */
  readonly badge?: string;
  /** Stays in the strip however narrow it gets, e.g. a tab carrying a verdict the user must see. */
  readonly pinned?: boolean;
  /** `danger` colours the badge, and marks the More button while the tab is hidden behind it. */
  readonly tone?: 'danger';
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
  /** Which tabs never overflow (by index); their room is taken first. */
  readonly pinned?: readonly boolean[];
}

/**
 * How many of the unpinned tabs, from the left, fit in the strip beside the pinned ones. All of
 * them when they fit; otherwise as many as leave room for the More button, which is as wide as the
 * name it shows.
 */
export function fitTabs({ widths, available, moreWidth, activeIndex, pinned = [] }: FitInput): number {
  const free = widths.filter((_, index) => pinned[index] !== true);
  const room = available - widths.reduce((sum, width, index) => sum + (pinned[index] === true ? width : 0), 0);
  // The selected tab's place among the unpinned ones; a pinned selected tab never sits in More.
  const freeActive =
    pinned[activeIndex] === true
      ? -1
      : widths.slice(0, activeIndex).filter((_, index) => pinned[index] !== true).length;
  const total = free.reduce((sum, width) => sum + width, 0);
  if (total <= room) {
    return free.length;
  }
  let used = total;
  for (let count = free.length - 1; count > 0; count -= 1) {
    used -= free[count] ?? 0;
    const trigger = freeActive >= count ? (free[freeActive] ?? 0) + CHEVRON_PX : moreWidth;
    if (used + trigger <= room) {
      return count;
    }
  }
  return 0;
}

/**
 * What the More button adds after "More" for the hidden tabs that hold something (#732 X07): the one
 * tab and its count ("Assertions 1"), or how many hold something. Set-up work behind More is then not
 * out of sight.
 */
export function moreSummary<T extends string>(hidden: readonly TabItem<T>[]): string | undefined {
  const held = hidden.filter((item) => item.badge !== undefined && item.tone !== 'danger');
  const only = held[0];
  if (only === undefined) return undefined;
  return held.length === 1 ? `${only.label} ${only.badge ?? ''}` : `${String(held.length)} in use`;
}

/** The badge's classes: faint, or the danger colour for a tab that reports a failure. */
function badgeClass(item: { readonly tone?: 'danger' }): string {
  return `font-mono text-xs ${item.tone === 'danger' ? 'text-status-danger' : 'text-fg-faint'}`;
}

/**
 * A flat, underline-free tab strip driven by roving `aria-selected` state. Deliberately not
 * Radix Tabs: the panels these control live in different regions of the shell.
 *
 * The strip never grows wider than its container: tabs that don't fit move into a trailing More
 * menu, whose button shows the selected tab's name when that tab is one of them. A hidden copy of
 * the strip measures each tab's natural width, so the fit follows labels and badges as they change.
 * A pinned tab always stays in the strip, and a hidden `danger` tab puts a count on the More button,
 * so a failure is never out of sight.
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
      : fitTabs({ widths, available, moreWidth, activeIndex, pinned: items.map((item) => item.pinned === true) });
  // The first `count` unpinned tabs stay, with every pinned one, in their own order.
  const shown: TabItem<T>[] = [];
  const hidden: TabItem<T>[] = [];
  let free = 0;
  for (const item of items) {
    if (item.pinned === true || free < count) {
      shown.push(item);
    } else {
      hidden.push(item);
    }
    if (item.pinned !== true) {
      free += 1;
    }
  }
  const activeHidden = hidden.find((item) => item.id === active);
  const summary = activeHidden === undefined ? moreSummary(hidden) : undefined;
  // Room for the longest summary the More button could show, so it never pushes the strip over.
  const widestSummary = moreSummary(items);
  const alerts = hidden.filter((item) => item.tone === 'danger' && item.id !== active).length;

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
                {item.badge !== undefined && <span className={badgeClass(item)}>{item.badge}</span>}
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
                aria-label={`${activeHidden !== undefined ? `${activeHidden.label}, more ${label}` : `More ${label}`}${
                  summary !== undefined ? `, ${summary}` : ''
                }${alerts > 0 ? `, ${String(alerts)} with failures` : ''}`}
                className={`${TAB_CLASS} gap-1 ${activeHidden !== undefined ? SELECTED_CLASS : UNSELECTED_CLASS}`}
              >
                {activeHidden !== undefined ? activeHidden.label : 'More'}
                {summary !== undefined && (
                  <span data-testid="tabs-more-summary" className="font-mono text-xs text-fg-faint">
                    · {summary}
                  </span>
                )}
                {activeHidden?.badge !== undefined && (
                  <span className={badgeClass(activeHidden)}>{activeHidden.badge}</span>
                )}
                {alerts > 0 && (
                  <span
                    data-testid="tabs-more-alerts"
                    className="inline-flex items-center gap-1 font-mono text-xs text-status-danger"
                  >
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-status-danger" />
                    {alerts}
                  </span>
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
                      {item.badge !== undefined && <span className={badgeClass(item)}>{item.badge}</span>}
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
        <span
          data-text={widestSummary === undefined ? 'More' : `More · ${widestSummary}`}
          className={`${TAB_CLASS} gap-1 ${MEASURE_TEXT}`}
        >
          <ChevronDown size={12} aria-hidden="true" />
        </span>
      </div>
    </div>
  );
}
