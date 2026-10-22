import { PanelBottomClose } from 'lucide-react';
import { IconButton } from '../components/icon-button.js';
import { Tabs } from '../components/tabs.js';
import { HttpLog } from '../features/console/http-log.js';
import { WsiReport } from '../features/console/wsi-report.js';
import { ProblemsView } from '../features/problems/problems-view.js';
import { countProblems, useProblemsStore } from '../state/problems.js';
import { useProjectStore } from '../state/project.js';
import type { ConsoleTab } from '../state/ui-state.js';
import { useUiStore } from '../state/ui.js';
import { useWsiStore } from '../state/wsi.js';

const TABS: readonly { id: ConsoleTab; label: string }[] = [
  { id: 'http-log', label: 'HTTP Log' },
  { id: 'problems', label: 'Problems' },
  { id: 'ws-i-report', label: 'WS-I Report' },
  { id: 'errors', label: 'Errors' },
];

const EMPTY_COPY: Readonly<Record<ConsoleTab, string>> = {
  'http-log': 'Sent requests appear here with their raw exchange and timings.',
  problems: 'Schema and WS-I findings appear here. No problems found.',
  'ws-i-report': 'Run a WS-I Basic Profile check on an interface to see its report here.',
  errors: 'Errors from imports, sends, and validation are collected here.',
};

/**
 * The bottom console: HTTP Log, Problems and Errors, plus WS-I Report once a WS-I check has run
 * (#731 X17): before that it held nothing but an empty state. Only Errors is still an empty state.
 */
export function ConsolePanel() {
  const hasSoapInterface = useProjectStore((state) => Object.keys(state.interfaces).length > 0);
  const wsiRan = useWsiStore((state) => state.status !== 'idle');
  const showWsi = hasSoapInterface && wsiRan;
  const chosenTab = useUiStore((state) => state.console.activeTab);
  // A WS-I tab left active by a workspace that had SOAP falls back to the log rather than vanish.
  const activeTab = chosenTab === 'ws-i-report' && !showWsi ? 'http-log' : chosenTab;
  const showConsoleTab = useUiStore((state) => state.showConsoleTab);
  const collapseConsole = useUiStore((state) => state.collapseConsole);
  // The same count as the status bar's "N problems" (#745): lint findings and failed SSH connects
  // are left out, so the badge never says something failed when only style advice came in.
  const problemCount = useProblemsStore((state) => countProblems(state.items).problems);
  const tabs = TABS.filter((tab) => tab.id !== 'ws-i-report' || showWsi).map((tab) =>
    tab.id === 'problems' && problemCount > 0 ? { ...tab, badge: String(problemCount) } : tab,
  );

  return (
    <section
      data-testid="console"
      aria-label="Console"
      className="flex h-full min-h-0 flex-col border-t border-hairline bg-surface-base"
    >
      <div className="flex h-row shrink-0 items-center justify-between border-b border-hairline pr-2">
        <Tabs label="Console tabs" items={tabs} active={activeTab} onSelect={showConsoleTab} />
        <IconButton
          label="Collapse Console"
          data-testid="console-collapse"
          onClick={() => {
            collapseConsole();
          }}
        >
          <PanelBottomClose size={14} aria-hidden="true" />
        </IconButton>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto p-3 font-mono text-sm text-fg-subtle">
        {activeTab === 'problems' ? (
          <ProblemsView />
        ) : activeTab === 'http-log' ? (
          <HttpLog />
        ) : activeTab === 'ws-i-report' ? (
          <WsiReport />
        ) : (
          EMPTY_COPY[activeTab]
        )}
      </div>
    </section>
  );
}
