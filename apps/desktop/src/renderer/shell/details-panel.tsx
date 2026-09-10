import { useState } from 'react';
import { Tabs } from '../components/tabs.js';
import { PropertyTable } from '../features/properties/property-table.js';
import { useGlobalsStore } from '../state/globals.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';

type DetailsTab = 'selection' | 'globals';

const TABS = [
  { id: 'selection', label: 'Details' },
  { id: 'globals', label: 'Global properties' },
] as const satisfies readonly { id: DetailsTab; label: string }[];

/** The Project row's inspector: the properties every request in the project can expand. */
function ProjectProperties() {
  const properties = useProjectStore((state) => state.project?.properties);
  const setProjectProperty = useProjectStore((state) => state.setProjectProperty);
  const removeProjectProperty = useProjectStore((state) => state.removeProjectProperty);

  return (
    <>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-fg-subtle uppercase">Project properties</h3>
      <PropertyTable
        label="Project properties"
        properties={properties ?? {}}
        onSet={(name, value) => {
          void setProjectProperty(name, value);
        }}
        onRemove={(name) => {
          void removeProjectProperty(name);
        }}
      />
    </>
  );
}

/** The user's `${#Global#…}` properties — available whether or not a project is open. */
function GlobalProperties() {
  const properties = useGlobalsStore((state) => state.properties);
  const set = useGlobalsStore((state) => state.set);
  const remove = useGlobalsStore((state) => state.remove);

  return (
    <>
      <h3 className="mb-2 text-xs font-medium tracking-wider text-fg-subtle uppercase">Global properties</h3>
      <PropertyTable
        label="Global properties"
        properties={properties}
        onSet={(name, value) => {
          void set(name, value);
        }}
        onRemove={(name) => {
          void remove(name);
        }}
      />
    </>
  );
}

/** The right-hand inspector: properties of whatever is selected, plus the global property table. */
export function DetailsPanel() {
  const selection = useUiStore((state) => state.selection);
  const [tab, setTab] = useState<DetailsTab>('selection');

  return (
    <aside
      data-testid="details-panel"
      aria-label="Details"
      className="flex h-full min-w-0 flex-col border-l border-hairline bg-surface-base"
    >
      <div className="flex h-row shrink-0 items-center border-b border-hairline">
        <Tabs label="Details tabs" items={TABS} active={tab} onSelect={setTab} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        {tab === 'globals' ? (
          <GlobalProperties />
        ) : selection?.kind === 'project' ? (
          <ProjectProperties />
        ) : (
          <>
            <p className="text-md text-fg-muted">Nothing selected</p>
            <p className="mt-1 text-sm text-fg-subtle">Select a node in the Explorer to edit its properties here.</p>
          </>
        )}
      </div>
    </aside>
  );
}
