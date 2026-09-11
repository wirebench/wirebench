/**
 * The Interface editor ("Show Interface Viewer"): a read-mostly view of one imported WSDL —
 * what it declares (Overview), where it can be called (Endpoints), its documents (WSDL Content),
 * its schema components (Schema) and its WS-I Basic Profile report (WS-I).
 *
 * Everything it shows comes from main's cached `ImportResult` through `definition.documents` /
 * `definition.schemaIndex`; the renderer neither fetches nor reads files.
 */

import { useEffect } from 'react';
import { Tabs, type TabItem } from '../../components/tabs.js';
import { WsiReport } from '../console/wsi-report.js';
import { Button } from '../../components/button.js';
import { useProjectStore } from '../../state/project.js';
import { useWsiStore } from '../../state/wsi.js';
import { EndpointsTab } from './endpoints-tab.js';
import { useInterfaceEditorStore, type InterfaceTabId } from './interface-editor-state.js';
import { OverviewTab } from './overview-tab.js';
import { SchemaTab } from './schema-tab.js';
import { WsdlContentTab } from './wsdl-content-tab.js';

export interface InterfaceEditorProps {
  readonly interfaceId: string;
}

const TABS: readonly TabItem<InterfaceTabId>[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'endpoints', label: 'Endpoints' },
  { id: 'wsdl', label: 'WSDL Content' },
  { id: 'schema', label: 'Schema' },
  { id: 'wsi', label: 'WS-I' },
];

/**
 * The WS-I tab: a Run button over the shared report component the console also shows. The store
 * holds exactly one report, so this tab says whose it is — and, when the last run was another
 * interface's (or an exchange's), shows an empty state instead of someone else's findings.
 */
function WsiTab({ interfaceId }: { readonly interfaceId: string }) {
  const checkWsdl = useWsiStore((state) => state.checkWsdl);
  const subject = useWsiStore((state) => state.subject);
  const name = useProjectStore((state) => state.interfaces[interfaceId]?.name);
  const owned = subject?.kind === 'wsdl' && subject.interfaceId === interfaceId;

  return (
    <div data-testid="interface-wsi" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline p-2">
        <p data-testid="interface-wsi-subject" className="truncate text-sm text-fg-muted">
          {owned ? `Report for ${subject.label}` : `No report for ${name ?? 'this interface'} yet`}
        </p>
        <Button
          variant="primary"
          data-testid="interface-wsi-run"
          onClick={() => {
            void checkWsdl(interfaceId);
          }}
        >
          Run WS-I check
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {owned ? (
          <WsiReport />
        ) : (
          <p className="p-3 text-sm text-fg-subtle" data-testid="interface-wsi-empty">
            No report for this interface yet — Run a WS-I Basic Profile check to see one here.
          </p>
        )}
      </div>
    </div>
  );
}

export function InterfaceEditor({ interfaceId }: InterfaceEditorProps) {
  const tab = useInterfaceEditorStore((state) => state.tabs[interfaceId] ?? 'overview');
  const setTab = useInterfaceEditorStore((state) => state.setTab);
  const load = useInterfaceEditorStore((state) => state.load);
  const name = useProjectStore((state) => state.interfaces[interfaceId]?.name);
  // A re-import stamps a new `loadedAt` on the summary, which re-runs `load` and refetches
  // everything the viewer has cached for the old bytes.
  const loadedAt = useProjectStore((state) => state.interfaces[interfaceId]?.loadedAt);

  useEffect(() => {
    void load(interfaceId, loadedAt);
  }, [load, interfaceId, loadedAt]);

  return (
    <section
      data-testid="interface-editor"
      aria-label={`Interface ${name ?? ''}`}
      className="flex h-full min-h-0 flex-col"
    >
      <div className="flex shrink-0 items-center justify-between border-b border-hairline">
        <Tabs label="Interface views" items={TABS} active={tab} onSelect={(next) => setTab(interfaceId, next)} />
        <span className="truncate px-2 text-xs text-fg-faint">{name}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'overview' ? (
          <OverviewTab interfaceId={interfaceId} />
        ) : tab === 'endpoints' ? (
          <EndpointsTab interfaceId={interfaceId} />
        ) : tab === 'wsdl' ? (
          <WsdlContentTab interfaceId={interfaceId} />
        ) : tab === 'schema' ? (
          <SchemaTab interfaceId={interfaceId} />
        ) : (
          <WsiTab interfaceId={interfaceId} />
        )}
      </div>
    </section>
  );
}
