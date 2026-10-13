/**
 * Running a snippet into a terminal (spec D4, D6, D9.4): what a run shows first, the terminals it can type
 * into, and the call to main. The renderer only ever names the snippet, its revision and the values of its
 * declared variables; main reads the saved script and types it, secrets included.
 */
import { create } from 'zustand';
import { showToast } from '../../../components/toast.js';
import type { SnippetListItemWire } from '../../../../shared/snippets-wire.js';
import { useEditorsStore } from '../../../state/editors.js';
import { ipc } from '../../../state/ipc-client.js';
import { useHostsStore } from '../hosts-store.js';
import { activeTerminal, focusedPaneOf } from '../panes/pane-actions.js';
import { bracketedPaste } from '../terminal-modes.js';
import { lastTargets, rememberRun } from './snippets-prefs.js';
import { useSnippetsStore } from './snippets-store.js';

export type { HostTarget } from './snippets-prefs.js';

/** A terminal tab: a run types into its focused pane's session. */
export interface TerminalTarget {
  readonly kind: 'terminal';
  readonly tabId: string;
}

/** An open terminal a run can type into: a tab whose focused pane has a live session. */
export interface OpenTerminal {
  readonly tabId: string;
  readonly paneId: string;
  readonly hostId: string;
  /** The host's name. */
  readonly label: string;
  readonly protected: boolean;
}

/** A run main refused, or one that could not start; `message` is for the user. */
export class SnippetRunError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SnippetRunError';
  }
}

/** Pure: what a run shows first (spec R6, D9.4). */
export function needsDialog(
  item: SnippetListItemWire,
  targets: { terminals: number; hosts: number; anyProtected: boolean },
): 'none' | 'variables' | 'dialog' {
  if (item.confirm || targets.anyProtected || targets.terminals + targets.hosts !== 1) return 'dialog';
  return item.variables.length > 0 ? 'variables' : 'none';
}

/** Pure: a value that would type an extra line or a control key (main refuses it too). */
export function invalidValue(value: string): boolean {
  return [...value].some((c) => {
    const code = c.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  });
}

/** The terminal tabs a run can type into, the one used most recently first. */
export function openTerminals(): OpenTerminal[] {
  const hosts = useHostsStore.getState();
  const use = (tabId: string): number => hosts.terminalTabUse[tabId] ?? 0;
  const found: OpenTerminal[] = [];
  for (const tab of useEditorsStore.getState().tabs) {
    if (tab.kind !== 'ssh-terminal' || tab.panes === undefined) continue;
    const paneId = focusedPaneOf(tab.id, tab.panes);
    const pane = paneId === undefined ? undefined : hosts.panes[paneId];
    if (paneId === undefined || pane?.state !== 'open' || pane.sessionId === undefined) continue;
    const host = hosts.resolved.find((h) => h.id === pane.hostId);
    found.push({
      tabId: tab.id,
      paneId,
      hostId: pane.hostId,
      label: host?.name ?? pane.hostId,
      protected: host?.protected.value === true,
    });
  }
  return found.sort((a, b) => use(b.tabId) - use(a.tabId));
}

/**
 * Types the snippet into one terminal tab's current session (its focused pane), with xterm's bracketed-paste
 * mode, and remembers the values. `snippet-changed` re-reads the list, so the next run shows what is saved.
 *
 * @throws SnippetRunError when the terminal has no live session, or main refuses the run
 */
export async function runInTerminal(
  tabId: string,
  item: SnippetListItemWire,
  values: Record<string, string>,
  opts: { enter?: false; skip?: number } = {},
): Promise<void> {
  const tab = useEditorsStore.getState().tabs.find((t) => t.id === tabId && t.kind === 'ssh-terminal');
  const paneId = tab?.panes === undefined ? undefined : focusedPaneOf(tabId, tab.panes);
  const pane = paneId === undefined ? undefined : useHostsStore.getState().panes[paneId];
  if (paneId === undefined || pane?.state !== 'open' || pane.sessionId === undefined) {
    throw new SnippetRunError('ssh-session-unknown', 'That terminal is not connected');
  }
  const result = await ipc().ssh.runSnippet({
    sessionId: pane.sessionId,
    snippetId: item.id,
    revision: item.revision,
    values,
    bracketed: bracketedPaste(paneId),
    ...(opts.enter === false ? { enter: false as const } : {}),
    ...(opts.skip === undefined || opts.skip === 0 ? {} : { skip: opts.skip }),
  });
  if (!result.ok) {
    if (result.error.code === 'snippet-changed') {
      useSnippetsStore
        .getState()
        .refresh()
        .catch(() => undefined); // the next change or the view's own read tries again
      throw new SnippetRunError('snippet-changed', 'This snippet changed since it was shown');
    }
    throw new SnippetRunError(result.error.code, result.error.message);
  }
  rememberRun(item.id, values, lastTargets(item.id));
}

/** The run dialog's request: which snippet, Run or Insert, and the terminal in front when there is one. */
export interface RunRequest {
  readonly snippetId: string;
  readonly enter?: false;
  /** `variables`: only the values for the terminal in front; `dialog`: values, target and preview. */
  readonly mode: 'variables' | 'dialog';
  readonly tabId?: string;
  /** Characters already typed into `tabId` (an accepted suggestion); only a run into that tab skips them. */
  readonly skip?: number;
}

export const useRunDialogStore = create<{ request: RunRequest | null }>(() => ({ request: null }));

export function closeRunDialog(): void {
  useRunDialogStore.setState({ request: null });
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Run (or Insert, with `enter: false`) from a row, the editor, a command or an accepted suggestion: into the
 * terminal in front at once when nothing needs asking (spec R6), else through the run dialog. `ask` always
 * shows the dialog; `skip` is how much of the snippet the user already typed into the terminal in front.
 */
export function startRun(item: SnippetListItemWire, opts: { enter?: false; ask?: boolean; skip?: number } = {}): void {
  const front = activeTerminal();
  const terminal = front === undefined ? undefined : openTerminals().find((t) => t.tabId === front.tabId);
  const mode = needsDialog(item, {
    terminals: terminal === undefined ? 0 : 1,
    hosts: 0,
    anyProtected: terminal?.protected === true,
  });
  const enter = opts.enter === false ? { enter: false as const } : {};
  const skip = opts.skip === undefined || terminal === undefined ? {} : { skip: opts.skip };
  if (opts.ask !== true && mode === 'none' && terminal !== undefined) {
    runInTerminal(terminal.tabId, item, {}, { ...enter, ...skip }).catch((error: unknown) => {
      showToast(`${item.name}: ${messageOf(error)}`);
    });
    return;
  }
  useRunDialogStore.setState({
    request: {
      snippetId: item.id,
      ...enter,
      mode: opts.ask !== true && mode === 'variables' ? 'variables' : 'dialog',
      ...(terminal === undefined ? {} : { tabId: terminal.tabId }),
      ...skip,
    },
  });
}

/** The tab a dialog run typed into comes to the front, so the user sees what was typed. */
export function showTerminal(tabId: string): void {
  useEditorsStore.getState().activate(tabId);
}

export type { SnippetListItemWire };
