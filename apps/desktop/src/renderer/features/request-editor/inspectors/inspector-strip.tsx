import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Tabs } from '../../../components/tabs.js';
import { useEditorsStore, type InspectorId, type InspectorPane } from '../../../state/editors.js';

/**
 * A square icon control for the inspectors. Deliberately not the shell's tooltip-backed
 * `IconButton`: the panes render outside the shell's `TooltipProvider` under test (the same
 * reason `toolbar.tsx` hand-rolls its own), and an inspector must not depend on one.
 */
export function InspectorIconButton({
  label,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex size-6 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-fg-default disabled:cursor-not-allowed disabled:opacity-40"
      {...rest}
    >
      {children}
    </button>
  );
}

/** One tab in a SOAP pane's tab strip. */
export interface InspectorItem {
  readonly id: InspectorId;
  readonly label: string;
}

export interface PaneTabsProps {
  /** Keys the persisted selection, together with `pane`. */
  readonly requestId: string;
  readonly pane: InspectorPane;
  readonly label: string;
  readonly items: readonly InspectorItem[];
  /** Rendered at the right end of the strip, whichever tab is showing (the response status). */
  readonly trailing?: ReactNode;
  /** Renders the selected tab's content, which fills the rest of the pane. */
  readonly render: (inspector: InspectorId) => ReactNode;
}

/**
 * A SOAP pane's tab strip, along the top edge as the REST editor has it: the envelope is one tab
 * (Body) beside the inspectors, and the selected tab fills the pane underneath. The selection
 * lives in the editors store, keyed per request and per pane, so switching editor tabs and coming
 * back finds the pane as it was left.
 */
export function PaneTabs({ requestId, pane, label, items, trailing, render }: PaneTabsProps) {
  const active = useEditorsStore((state) => state.inspectorFor(requestId, pane));
  const setInspector = useEditorsStore((state) => state.setInspector);

  const selected = items.some((item) => item.id === active) ? active : (items[0]?.id ?? 'body');

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline">
        {/* Ten tabs do not fit a split pane; the strip scrolls rather than wrapping. */}
        <div className="min-w-0 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <div className="w-max">
            <Tabs
              label={label}
              items={items}
              active={selected}
              onSelect={(id) => {
                setInspector(requestId, pane, id);
              }}
            />
          </div>
        </div>
        {trailing !== undefined && <div className="min-w-0 flex-1">{trailing}</div>}
      </div>
      <div
        role="tabpanel"
        aria-label={items.find((item) => item.id === selected)?.label}
        data-testid={`inspector-panel-${pane}`}
        className={`flex min-h-0 flex-1 flex-col ${selected === 'body' ? 'overflow-hidden' : 'overflow-auto'}`}
      >
        {render(selected)}
      </div>
    </>
  );
}

/** Stand-in for an inspector another task owns, so the strip's shape is honest about what is coming. */
export function InspectorPlaceholder({ task, name }: { readonly task: number; readonly name: string }) {
  return (
    <p className="p-3 text-sm text-fg-subtle">
      {name} arrives in Task {task}.
    </p>
  );
}
