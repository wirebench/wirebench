/** The right-hand inspector: properties of whatever is selected in the shell. */
export function DetailsPanel() {
  return (
    <aside
      data-testid="details-panel"
      aria-label="Details"
      className="flex h-full min-w-0 flex-col border-l border-hairline bg-surface-base"
    >
      <h2 className="flex h-row shrink-0 items-center px-3 text-xs font-medium tracking-wider text-fg-subtle uppercase">
        Details
      </h2>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <p className="text-md text-fg-muted">Nothing selected</p>
        <p className="mt-1 text-sm text-fg-subtle">Select a node in the Explorer to edit its properties here.</p>
      </div>
    </aside>
  );
}
