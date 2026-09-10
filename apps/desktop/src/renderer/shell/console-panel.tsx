import { X } from 'lucide-react';
import { IconButton } from '../components/icon-button.js';
import { Tabs } from '../components/tabs.js';
import { ProblemsView } from '../features/problems/problems-view.js';
import type { ConsoleTab } from '../state/ui-state.js';
import { useUiStore } from '../state/ui.js';

const TABS = [
  { id: 'http-log', label: 'HTTP Log' },
  { id: 'problems', label: 'Problems' },
  { id: 'ws-i-report', label: 'WS-I Report' },
  { id: 'errors', label: 'Errors' },
] as const satisfies readonly { id: ConsoleTab; label: string }[];

const EMPTY_COPY: Readonly<Record<ConsoleTab, string>> = {
  'http-log': 'Sent requests appear here with their raw exchange and timings.',
  problems: 'Schema and WS-I findings appear here. No problems found.',
  'ws-i-report': 'Run a WS-I Basic Profile check on an interface to see its report here.',
  errors: 'Errors from imports, sends, and validation are collected here.',
};

/** The bottom console: four tabs, each an empty state until its producer ships. */
export function ConsolePanel() {
  const activeTab = useUiStore((state) => state.console.activeTab);
  const showConsoleTab = useUiStore((state) => state.showConsoleTab);
  const toggleConsole = useUiStore((state) => state.toggleConsole);

  return (
    <section
      data-testid="console"
      aria-label="Console"
      className="flex h-full min-h-0 flex-col border-t border-hairline bg-surface-base"
    >
      <div className="flex h-row shrink-0 items-center justify-between border-b border-hairline pr-2">
        <Tabs label="Console tabs" items={TABS} active={activeTab} onSelect={showConsoleTab} />
        <IconButton label="Hide console" onClick={toggleConsole}>
          <X size={14} aria-hidden="true" />
        </IconButton>
      </div>
      <div role="tabpanel" className="min-h-0 flex-1 overflow-auto p-3 font-mono text-sm text-fg-subtle">
        {activeTab === 'problems' ? <ProblemsView /> : EMPTY_COPY[activeTab]}
      </div>
    </section>
  );
}
