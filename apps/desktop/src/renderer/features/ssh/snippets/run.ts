/**
 * Running a snippet into a terminal (spec D4, D6, D9.4): what a run shows first, the terminals it can type
 * into, and the call to main. The renderer only ever names the snippet, its revision and the values of its
 * declared variables; main reads the saved script and types it, secrets included.
 */
import { create } from 'zustand';
import { showToast } from '../../../components/toast.js';
import type { SnippetListItemWire } from '../../../../shared/snippets-wire.js';
import type { ResolvedHostWire } from '../../../../shared/ssh-wire.js';
import { useEditorsStore } from '../../../state/editors.js';
import { ipc } from '../../../state/ipc-client.js';
import { useProblemsStore } from '../../../state/problems.js';
import { openInNewTab } from '../connect.js';
import { useHostsStore } from '../hosts-store.js';
import { activeTerminal, focusedPaneOf } from '../panes/pane-actions.js';
import { leaves } from '../panes/pane-tree.js';
import { bracketedPaste } from '../terminal-modes.js';
import { lastOutputAt, watchOutput } from '../terminal-session.js';
import { lastTargets, rememberRun } from './snippets-prefs.js';
import type { HostTarget } from './snippets-prefs.js';
import { useSnippetsStore } from './snippets-store.js';

export type { HostTarget } from './snippets-prefs.js';

/** A terminal tab: a run types into `paneId`'s session, or the tab's focused pane's without one. */
export interface TerminalTarget {
  readonly kind: 'terminal';
  readonly tabId: string;
  readonly paneId?: string;
  /** The host it was on when chosen: names it in the report should the tab close before the run. */
  readonly hostId?: string;
}

/** An open terminal a run can type into: a pane of a terminal tab with a live session. */
export interface OpenTerminal {
  /** Tells the panes of one tab apart: `<tabId> <paneId>`. */
  readonly key: string;
  readonly tabId: string;
  readonly paneId: string;
  readonly hostId: string;
  /** The host's name; in a tab with several live panes, the tab's name first ("Box pair · box-2"). */
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

/**
 * The terminals a run can type into: every live pane of every terminal tab, not only the focused one, so each
 * pane of a split tab can be picked (S07). The tab used most recently first, its focused pane leading.
 */
export function openTerminals(): OpenTerminal[] {
  const hosts = useHostsStore.getState();
  const use = (tabId: string): number => hosts.terminalTabUse[tabId] ?? 0;
  const found: (OpenTerminal & { readonly focused: boolean })[] = [];
  for (const tab of useEditorsStore.getState().tabs) {
    if (tab.kind !== 'ssh-terminal' || tab.panes === undefined) continue;
    const focused = focusedPaneOf(tab.id, tab.panes);
    const live = leaves(tab.panes).filter((leaf) => {
      const pane = hosts.panes[leaf.paneId];
      return pane?.state === 'open' && pane.sessionId !== undefined;
    });
    for (const leaf of live) {
      const hostId = hosts.panes[leaf.paneId]?.hostId ?? leaf.hostId;
      const host = hosts.resolved.find((h) => h.id === hostId);
      const name = host?.name ?? hostId;
      found.push({
        key: `${tab.id} ${leaf.paneId}`,
        tabId: tab.id,
        paneId: leaf.paneId,
        hostId,
        label: live.length > 1 ? `${tab.title} · ${name}` : name,
        protected: host?.protected.value === true,
        focused: leaf.paneId === focused,
      });
    }
  }
  return found
    .sort((a, b) => use(b.tabId) - use(a.tabId) || Number(b.focused) - Number(a.focused))
    .map(({ focused, ...terminal }) => {
      void focused;
      return terminal;
    });
}

/** The pane a run into `tabId` types into: `paneId` while it is still in the tab, else the tab's focused one. */
function paneOf(tabId: string, paneId?: string): { paneId: string; hostId: string } | undefined {
  const tab = useEditorsStore.getState().tabs.find((t) => t.id === tabId && t.kind === 'ssh-terminal');
  if (tab?.panes === undefined) return undefined;
  const wanted = paneId ?? focusedPaneOf(tabId, tab.panes);
  const leaf = leaves(tab.panes).find((l) => l.paneId === wanted);
  return leaf === undefined ? undefined : { paneId: leaf.paneId, hostId: leaf.hostId };
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
  opts: { enter?: false; skip?: number; paneId?: string } = {},
): Promise<void> {
  const paneId = paneOf(tabId, opts.paneId)?.paneId;
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

/** Pure: hosts for the chosen targets, de-duplicated, in tree order. A target that no longer exists adds none. */
export function expandTargets(targets: readonly HostTarget[], hosts: readonly ResolvedHostWire[]): ResolvedHostWire[] {
  return hosts.filter((h) =>
    targets.some(
      (t) =>
        (t.kind === 'host' && t.id === h.id) ||
        (t.kind === 'group' && h.path.includes(t.id)) ||
        (t.kind === 'tag' && h.tags.includes(t.id)),
    ),
  );
}

/** How long a new session must stay quiet after printing before it is written to, and the most to wait. */
export const READY_QUIET_MS = 250;
export const READY_MAX_MS = 10_000;

/** Resolves when the session has printed and then been quiet for `quietMs`, or after `maxMs`. */
export function whenReady(sessionId: string, opts: { quietMs?: number; maxMs?: number } = {}): Promise<void> {
  const quietMs = opts.quietMs ?? READY_QUIET_MS;
  const maxMs = opts.maxMs ?? READY_MAX_MS;
  return new Promise((resolve) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const done = (): void => {
      clearTimeout(quiet);
      clearTimeout(cap);
      off();
      resolve();
    };
    const cap = setTimeout(done, maxMs);
    const off = watchOutput(sessionId, () => {
      clearTimeout(quiet);
      quiet = setTimeout(done, quietMs);
    });
    // Output that came before this call counts: the quiet runs from it.
    const printed = lastOutputAt(sessionId);
    if (printed !== undefined) quiet = setTimeout(done, Math.max(0, quietMs - (Date.now() - printed)));
  });
}

/** What a run on several targets came to, by host id. */
export interface RunReport {
  readonly ok: readonly string[];
  readonly failed: readonly { readonly hostId: string; readonly message: string }[];
}

const hostName = (hostId: string): string =>
  useHostsStore.getState().resolved.find((h) => h.id === hostId)?.name ?? hostId;

/** The one-line toast for a run: "Ran on 3 of 4 hosts · api-4: authentication failed". */
export function runSummary(report: RunReport): string {
  const total = report.ok.length + report.failed.length;
  const failures = report.failed.map((f) => ` · ${hostName(f.hostId)}: ${f.message}`).join('');
  if (report.failed.length > 0) return `Ran on ${String(report.ok.length)} of ${String(total)} hosts${failures}`;
  const [only] = report.ok;
  return total === 1 && only !== undefined ? `Ran on ${hostName(only)}` : `Ran on ${String(total)} hosts`;
}

/**
 * Waits for a terminal tab's pane (`paneId`, else its focused one) to have a live session, through its connect:
 * a trust prompt or a sign-in waits for the user. `fresh` is a tab the run just opened, whose pane has no state
 * until it mounts; an existing pane that is neither open nor connecting is not waited for.
 *
 * @returns whether the session was already open (then it is written to at once)
 * @throws SnippetRunError when the tab closes, or the connect ends without a session
 */
function sessionOf(tabId: string, fresh: boolean, paneId?: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let sawPrompt = false;
    const offs: (() => void)[] = [];
    const finish = (outcome: { open: boolean } | SnippetRunError): void => {
      for (const off of offs) off();
      if (outcome instanceof SnippetRunError) reject(outcome);
      else resolve(outcome.open);
    };
    const check = (first: boolean): boolean => {
      const target = paneOf(tabId, paneId);
      if (target === undefined) {
        finish(new SnippetRunError('ssh-session-unknown', 'The terminal was closed'));
        return true;
      }
      const hosts = useHostsStore.getState();
      const pane = hosts.panes[target.paneId];
      if (hosts.trustPrompt?.paneId === target.paneId) sawPrompt = true;
      if (pane?.state === 'open' && pane.sessionId !== undefined) {
        finish({ open: first });
        return true;
      }
      if (hosts.connectFailed[target.paneId] === true) {
        // The connect records its reason in Problems right after marking the pane: read it once that is done.
        void Promise.resolve().then(() => {
          finish(new SnippetRunError('ssh-connect-failed', failureMessage(target.hostId, sawPrompt)));
        });
        return true;
      }
      if (pane?.state === 'connecting' || hosts.trustPrompt?.paneId === target.paneId) return false;
      if (fresh && pane === undefined) return false;
      finish(new SnippetRunError('ssh-session-unknown', 'That terminal is not connected'));
      return true;
    };
    if (check(true)) return;
    let settled = false;
    const recheck = (): void => {
      if (!settled) settled = check(false);
    };
    offs.push(useHostsStore.subscribe(recheck), useEditorsStore.subscribe(recheck));
  });
}

function failureMessage(hostId: string, sawPrompt: boolean): string {
  const problem = useProblemsStore
    .getState()
    .items.filter((p) => p.groupId === `ssh:${hostId}`)
    .at(-1)?.problem;
  if (problem !== undefined) return problem.message;
  return sawPrompt ? 'The host key was not trusted' : 'The connection failed';
}

/**
 * Runs the snippet on terminals and hosts (spec D6): groups and tags expand to their hosts, each host runs once
 * (a chosen terminal counts for its host), a host reuses its most recently focused open terminal or opens a new
 * tab through the usual connect path. A new session is written to once it printed and went quiet. Targets run
 * in parallel; one that fails, or that main refuses, is in the report and holds back no other. `skip` is what
 * the user already typed into one terminal (an accepted suggestion): only that terminal skips it.
 */
export async function runOnTargets(
  item: SnippetListItemWire,
  values: Record<string, string>,
  terminals: readonly TerminalTarget[],
  hosts: readonly HostTarget[],
  opts: { enter?: false; skip?: { readonly tabId: string; readonly count: number } } = {},
): Promise<RunReport> {
  const jobs: { hostId: string; tabId: string; paneId?: string; fresh: boolean }[] = [];
  const failed: { hostId: string; message: string }[] = [];
  const taken = new Set<string>();
  for (const terminal of terminals) {
    const hostId = paneOf(terminal.tabId, terminal.paneId)?.hostId ?? terminal.hostId;
    if (hostId === undefined) {
      failed.push({ hostId: terminal.tabId, message: 'The terminal was closed' });
      continue;
    }
    if (taken.has(hostId)) continue;
    taken.add(hostId);
    jobs.push({
      hostId,
      tabId: terminal.tabId,
      ...(terminal.paneId === undefined ? {} : { paneId: terminal.paneId }),
      fresh: false,
    });
  }
  const open = openTerminals();
  for (const host of expandTargets(hosts, useHostsStore.getState().resolved)) {
    if (taken.has(host.id)) continue;
    taken.add(host.id);
    const reuse = open.find((t) => t.hostId === host.id);
    jobs.push(
      reuse === undefined
        ? { hostId: host.id, tabId: openInNewTab(host.id), fresh: true }
        : { hostId: host.id, tabId: reuse.tabId, paneId: reuse.paneId, fresh: false },
    );
  }
  const enter = opts.enter === false ? { enter: false as const } : {};
  const results = await Promise.allSettled(
    jobs.map(async (job) => {
      const wasOpen = await sessionOf(job.tabId, job.fresh, job.paneId);
      if (!wasOpen) {
        const pane = paneOf(job.tabId, job.paneId);
        const sessionId = pane === undefined ? undefined : useHostsStore.getState().panes[pane.paneId]?.sessionId;
        if (sessionId !== undefined) await whenReady(sessionId);
      }
      // An accepted suggestion's typed start is only in the terminal it came from.
      const skip = opts.skip?.tabId === job.tabId ? { skip: opts.skip.count } : {};
      const pane = job.paneId === undefined ? {} : { paneId: job.paneId };
      await runInTerminal(job.tabId, item, values, { ...enter, ...skip, ...pane });
    }),
  );
  const ok: string[] = [];
  results.forEach((result, i) => {
    const job = jobs[i];
    if (job === undefined) return;
    if (result.status === 'fulfilled') ok.push(job.hostId);
    else failed.push({ hostId: job.hostId, message: messageOf(result.reason) });
  });
  rememberRun(item.id, values, hosts);
  return { ok, failed };
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
    runInTerminal(terminal.tabId, item, {}, { ...enter, ...skip, paneId: terminal.paneId }).catch((error: unknown) => {
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
