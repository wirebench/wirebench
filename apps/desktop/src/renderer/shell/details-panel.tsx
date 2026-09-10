import { Tabs } from '../components/tabs.js';
import { CodePanel } from '../features/details/code-panel.js';
import { EndpointProperties } from '../features/details/endpoint-properties.js';
import { InterfaceProperties } from '../features/details/interface-properties.js';
import { RequestProperties } from '../features/details/request-properties.js';
import { PropertyTable } from '../features/properties/property-table.js';
import { useEditorsStore } from '../state/editors.js';
import { useGlobalsStore } from '../state/globals.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';
import type { Selection } from '../state/ui.js';
import type { DetailsTab } from '../state/ui-state.js';

const TABS = [
  { id: 'selection', label: 'Details' },
  { id: 'globals', label: 'Global properties' },
  { id: 'code', label: 'Code' },
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

/**
 * What the Details panel is inspecting. The explorer's selection wins when it names something
 * this panel understands; otherwise the panel follows the active request editor, so opening a
 * request tab and looking right shows that request rather than "Nothing selected".
 */
function SelectionDetails({
  selection,
  activeRequestId,
}: {
  selection: Selection | undefined;
  activeRequestId: string | undefined;
}) {
  if (selection?.kind === 'project') {
    return <ProjectProperties />;
  }
  if (selection?.kind === 'request' && selection.requestId !== undefined) {
    return <RequestProperties requestId={selection.requestId} />;
  }
  if (selection?.kind === 'interface' && selection.interfaceId !== undefined) {
    return <InterfaceProperties interfaceId={selection.interfaceId} />;
  }
  if (selection?.kind === 'endpoint' && selection.interfaceId !== undefined && selection.address !== undefined) {
    return <EndpointProperties interfaceId={selection.interfaceId} address={selection.address} />;
  }
  if (activeRequestId !== undefined) {
    return <RequestProperties requestId={activeRequestId} />;
  }
  return (
    <>
      <p className="text-md text-fg-muted">Nothing selected</p>
      <p className="mt-1 text-sm text-fg-subtle">Select a node in the Explorer to edit its properties here.</p>
    </>
  );
}

/** The request draft behind the active editor tab, or `undefined` when none is a request tab. */
function useActiveRequestId(): string | undefined {
  return useEditorsStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.requestId);
}

/** The right-hand inspector: properties of whatever is selected, plus the global property table. */
export function DetailsPanel() {
  const selection = useUiStore((state) => state.selection);
  const activeRequestId = useActiveRequestId();
  // The tab lives in the ui store (and so in localStorage): "Show code" has to be able to open
  // this panel on the Code tab from anywhere, and the choice should survive a relaunch.
  const tab = useUiStore((state) => state.details.tab);
  const setTab = useUiStore((state) => state.setDetailsTab);

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
        ) : tab === 'code' ? (
          <CodePanel />
        ) : (
          <SelectionDetails selection={selection} activeRequestId={activeRequestId} />
        )}
      </div>
    </aside>
  );
}
