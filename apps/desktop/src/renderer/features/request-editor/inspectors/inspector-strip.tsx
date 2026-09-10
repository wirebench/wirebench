import { ChevronDown, ChevronUp } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
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

/** One entry in a pane's inspector strip. */
export interface InspectorItem {
  readonly id: InspectorId;
  readonly label: string;
}

export interface InspectorStripProps {
  /** Keys the persisted selection and collapsed state, together with `pane`. */
  readonly requestId: string;
  readonly pane: InspectorPane;
  readonly label: string;
  readonly items: readonly InspectorItem[];
  /** Renders the selected inspector's body. Only called while the panel is expanded. */
  readonly render: (inspector: InspectorId) => ReactNode;
}

/**
 * The inspector strip that sits under a pane's editor: a tab per inspector along the bottom
 * edge, with the selected inspector's panel opening *above* it (SoapUI's layout). Both the
 * selection and whether the panel is open live in the editors store, keyed per request and
 * per pane, so switching tabs and coming back finds the strip as it was left.
 */
export function InspectorStrip({ requestId, pane, label, items, render }: InspectorStripProps) {
  const active = useEditorsStore((state) => state.inspectorFor(requestId, pane));
  const collapsed = useEditorsStore((state) => state.inspectorCollapsedFor(requestId, pane));
  const setInspector = useEditorsStore((state) => state.setInspector);
  const setCollapsed = useEditorsStore((state) => state.setInspectorCollapsed);

  const selected = items.some((item) => item.id === active) ? active : (items[0]?.id ?? 'headers');
  const tabId = (inspector: InspectorId): string => `inspector-tab-${pane}-${requestId}-${inspector}`;
  const panelId = `inspector-panel-${pane}-${requestId}`;

  return (
    <div className="flex shrink-0 flex-col border-t border-hairline">
      {!collapsed && (
        <div
          role="tabpanel"
          id={panelId}
          aria-labelledby={tabId(selected)}
          data-testid={`inspector-panel-${pane}`}
          className="max-h-64 min-h-24 overflow-auto border-b border-hairline"
        >
          {render(selected)}
        </div>
      )}
      <div className="flex items-center justify-between">
        <div role="tablist" aria-label={label} className="flex h-row items-center gap-1 px-2">
          {items.map((item) => {
            const isActive = item.id === selected && !collapsed;
            return (
              <button
                key={item.id}
                id={tabId(item.id)}
                type="button"
                role="tab"
                aria-selected={isActive}
                {...(isActive ? { 'aria-controls': panelId } : {})}
                onClick={() => {
                  if (item.id === selected && !collapsed) {
                    setCollapsed(requestId, pane, true);
                    return;
                  }
                  setInspector(requestId, pane, item.id);
                }}
                className={`rounded-sm px-2 text-xs ${
                  isActive ? 'bg-surface-active text-fg-default' : 'text-fg-subtle'
                } hover:bg-surface-hover`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        <div className="px-1">
          <InspectorIconButton
            label={collapsed ? `Show ${label}` : `Hide ${label}`}
            onClick={() => {
              setCollapsed(requestId, pane, !collapsed);
            }}
          >
            {collapsed ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
          </InspectorIconButton>
        </div>
      </div>
    </div>
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
